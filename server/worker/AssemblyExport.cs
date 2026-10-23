using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

partial class Worker {
 // History order, unlike AllFeatures (which uses a stack).
 static List<IFeature> AssemblyIrFeatures(IModelDoc2 d){
  var r=new List<IFeature>();var f=(IFeature)d.FirstFeature();
  while(f!=null){r.Add(f);f=(IFeature)f.GetNextFeature();}return r;
 }
 static double[] AssemblyIrNumbers(object a){return a==null?new double[0]:Items(a).Select(Convert.ToDouble).ToArray();}
 static bool AssemblyIrFinite(double[] a){return a.All(x=>!double.IsNaN(x)&&!double.IsInfinity(x));}
 static double AssemblyIrDistance(double[] a,double[] b){return Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(a[i]-b[i],2)));}
 static bool AssemblyIrSame(object a,object b){return a!=null&&b!=null&&(ReferenceEquals(a,b)||sw.IsSame(a,b)==(int)swObjectEquality.swObjectSame);}
 static double[] AssemblyIrPoint(double[] p,IMathTransform t){
  if(t==null)throw new Exception("Transform2 no disponible");
  return (double[])((IMathPoint)((IMathPoint)((IMathUtility)sw.GetMathUtility()).CreatePoint(p)).MultiplyTransform(t)).ArrayData;
 }
 static double[] AssemblyIrClosest(object entity,double[] p,bool edge){
  var q=AssemblyIrNumbers(edge?((IEdge)entity).GetClosestPointOn(p[0],p[1],p[2]):((IFace2)entity).GetClosestPointOn(p[0],p[1],p[2]));
  return q.Length>=3&&AssemblyIrFinite(q)?q.Take(3).ToArray():null;
 }
 static object AssemblyIrUnsupported(string reason,List<string> warnings,string where){return AssemblyIrUnsupported(reason,warnings,where,null);}
 // v3.7 review: owner = "assembly" (geometry of the assembly itself) or the component the reference belongs to, so a build
 // only replaces true anchors to the assembly and never a mate between two parts
 static object AssemblyIrUnsupported(string reason,List<string> warnings,string where,string owner){
  warnings.Add(where+": "+reason);return new{kind="unsupported",reason=reason,owner=owner};
 }
 static bool AssemblyIrRelated(object a,object target,object local,IComponent2 c,IModelDoc2 part){
  if(AssemblyIrSame(a,target)||AssemblyIrSame(a,local))return true;
  try{if(AssemblyIrSame(c.GetCorresponding(a),target))return true;}catch{}
  try{if(part!=null&&AssemblyIrSame(part.Extension.GetCorrespondingEntity2(a),local))return true;}catch{}
  return false;
 }
 // Exactly the two independent coordinate-context tests used by SelectMateEntity, plus target identity.
 static bool AssemblyIrSelectable(double[] lp,IComponent2 c,List<object> all,bool edge,object target,object local,IModelDoc2 part){
  var wp=AssemblyIrPoint(lp,c.Transform2);
  Func<double[],List<object>> hits=p=>all.Where(e=>{var q=AssemblyIrClosest(e,p,edge);return q!=null&&AssemblyIrDistance(q,p)<=1e-5;}).ToList();
  var hl=hits(lp);var hw=hits(wp);bool same=lp.Zip(wp,(x,y)=>Math.Abs(x-y)).Max()<1e-9;
  var pick=hl.Count>0&&hw.Count>0&&!same?null:(hl.Count>0?hl:hw);
  if(pick==null||pick.Count!=1||!AssemblyIrRelated(pick[0],target,local,c,part))return false;
  // Also prove that this is a point on the target in PART coordinates when its local counterpart exists.
  if(local!=null){var q=AssemblyIrClosest(local,lp,edge);if(q==null||AssemblyIrDistance(lp,q)>1e-5||!AssemblyIrInterior(local,lp,edge))return false;}
  return true;
 }
 static bool AssemblyIrInterior(object source,double[] p,bool edge){
  if(edge){var cp=((IEdge)source).GetCurveParams3() as ICurveParamData;if(cp==null)return false;
   var a=AssemblyIrNumbers(cp.StartPoint);var b=AssemblyIrNumbers(cp.EndPoint);
   return a.Length>=3&&b.Length>=3&&AssemblyIrDistance(p,a)>1e-5&&AssemblyIrDistance(p,b)>1e-5;}
  foreach(IEdge e in (object[])((IFace2)source).GetEdges()??new object[0]){var q=AssemblyIrClosest(e,p,true);if(q==null||AssemblyIrDistance(p,q)<=1e-5)return false;}
  return true;
 }
 static List<double[]> AssemblyIrSamples(object source,bool edge){
  var points=new List<double[]>();
  if(edge){var e=(IEdge)source;var cp=e.GetCurveParams3() as ICurveParamData;var curve=e.GetCurve() as ICurve;
   if(cp==null||curve==null)throw new Exception("Parámetros de curva no disponibles");
   var p=AssemblyIrNumbers(curve.Evaluate2((cp.UMinValue+cp.UMaxValue)/2,0));
   if(p.Length>=3&&AssemblyIrFinite(p))points.Add(p.Take(3).ToArray());return points;}
  points.AddRange(AssemblyIrFaceSamples((IFace2)source));
  return points;
 }
 // v3.8 speed: lazy, largest triangle first. find only needs the FIRST sample that selects the face alone; the old version
 // projected every triangle (one COM call each, thousands on a plate with many holes) and sliced the tessellation with Skip
 // (quadratic): 1.7 s for the first plane find of the pegboard lid
 static IEnumerable<double[]> AssemblyIrFaceSamples(IFace2 face){
  var tess=AssemblyIrNumbers(face.GetTessTriangles(true));
  var triangles=new List<KeyValuePair<double,double[]>>();
  for(int i=0;i+8<tess.Length;i+=9){
   var a=new[]{tess[i],tess[i+1],tess[i+2]};var b=new[]{tess[i+3],tess[i+4],tess[i+5]};var c=new[]{tess[i+6],tess[i+7],tess[i+8]};
   if(!AssemblyIrFinite(a)||!AssemblyIrFinite(b)||!AssemblyIrFinite(c))continue;
   var u=b.Zip(a,(x,y)=>x-y).ToArray();var v=c.Zip(a,(x,y)=>x-y).ToArray();
   double area=Math.Sqrt(Math.Pow(u[1]*v[2]-u[2]*v[1],2)+Math.Pow(u[2]*v[0]-u[0]*v[2],2)+Math.Pow(u[0]*v[1]-u[1]*v[0],2));
   if(area>0)triangles.Add(new KeyValuePair<double,double[]>(area,Enumerable.Range(0,3).Select(k=>(a[k]+b[k]+c[k])/3).ToArray()));
  }
  foreach(var triangle in triangles.OrderByDescending(x=>x.Key)){
   var p=AssemblyIrClosest(face,triangle.Value,false);if(p!=null)yield return p;
  }
 }
 static object AssemblyIrEntity(IMateEntity2 me,IModelDoc2 d,HashSet<string> ids,List<string> warnings,string where){
  var c=me.ReferenceComponent as IComponent2;object target=me.Reference;
  bool root=c==null||string.Equals(c.GetPathName(),d.GetPathName(),StringComparison.OrdinalIgnoreCase);
  var feature=target as IFeature;
  if(feature==null&&target is IRefPlane){
   var owner=root?d:c.GetModelDoc2() as IModelDoc2;
   if(owner!=null)feature=AssemblyIrFeatures(owner).FirstOrDefault(f=>f.GetTypeName2()=="RefPlane"&&AssemblyIrSame(f.GetSpecificFeature2(),target));
  }
  if(feature!=null&&feature.GetTypeName2()=="RefPlane"){
   if(root)return new{assembly_plane=feature.Name};
   if(!ids.Contains(c.Name2))return AssemblyIrUnsupported("Plano de un componente anidado no exportable como instancia independiente: "+c.Name2,warnings,where,c.Name2);
   return new{component=c.Name2,plane=feature.Name};
  }
  bool edge=target is IEdge;
  if(!(target is IFace2)&&!edge)return AssemblyIrUnsupported("Referencia no soportada (vértice/eje/origen u otra; tipo "+me.ReferenceType2+")",warnings,where,root?"assembly":c.Name2);
  if(root)return AssemblyIrUnsupported("Geometría de ensamble sin componente de pieza",warnings,where,"assembly");
  if(!ids.Contains(c.Name2))return AssemblyIrUnsupported("Componente anidado no exportable como instancia independiente: "+c.Name2,warnings,where,c.Name2);
  if(c.Transform2==null)return AssemblyIrUnsupported("Transform2 no disponible",warnings,where,c.Name2);
  var part=c.GetModelDoc2() as IModelDoc2;object local=null;
  if(part!=null)try{local=d.Extension.GetCorrespondingEntity2(target);}catch{}
  if(local!=null&&!(edge?local is IEdge:local is IFace2))local=null;
  if(local==null&&part!=null&&part.GetType()==1&&((IConfiguration)part.ConfigurationManager.ActiveConfiguration).Name==c.ReferencedConfiguration){
   foreach(IBody2 body in (object[])((IPartDoc)part).GetBodies2((int)swBodyType_e.swSolidBody,false)??new object[0]){
    foreach(var entity in (object[])(edge?body.GetEdges():body.GetFaces())??new object[0]){
     bool matches=AssemblyIrSame(entity,target);try{matches|=AssemblyIrSame(c.GetCorresponding(entity),target);}catch{}
     if(matches){if(local!=null&&!AssemblyIrSame(local,entity))return AssemblyIrUnsupported("Correspondencia local ambigua",warnings,where,c.Name2);local=entity;}
    }
   }
  }
  if(local==null)return AssemblyIrUnsupported("No se pudo verificar la entidad correspondiente en coordenadas de pieza",warnings,where,c.Name2);
  var all=new List<object>();object info;
  foreach(IBody2 b in (object[])c.GetBodies3((int)swBodyType_e.swSolidBody,out info)??new object[0])all.AddRange(edge?((object[])b.GetEdges()??new object[0]):((object[])b.GetFaces()??new object[0]));
  if(all.Count==0)return AssemblyIrUnsupported("Sin cuerpos sólidos resueltos",warnings,where,c.Name2);
  var inverse=(IMathTransform)c.Transform2.Inverse();
  // Try the referenced geometry (possibly assembly space), then the proven local counterpart.
  foreach(var source in new[]{target,local})foreach(var p in edge?AssemblyIrSamples(source,true):AssemblyIrFaceSamples((IFace2)source)){
   if(!AssemblyIrInterior(source,p,edge))continue;
   // A document-mapped entity is local. Otherwise prove the context rather than guessing it.
   var candidates=new List<double[]>{p};if(ReferenceEquals(source,target))candidates.Add(AssemblyIrPoint(p,inverse));
   var valid=new List<double[]>();
   foreach(var lp in candidates){if(valid.Any(q=>AssemblyIrDistance(q,lp)<1e-9))continue;
    if(AssemblyIrSelectable(lp,c,all,edge,target,local,d))valid.Add(lp);}
   if(valid.Count==1)return new{component=c.Name2,local_point_mm=valid[0].Select(x=>x*1000).ToArray(),kind=edge?"edge":"face"};
  }
  return AssemblyIrUnsupported("Ningún punto interior identifica exactamente una entidad en un contexto inequívoco de pieza/ensamble",warnings,where,c.Name2);
 }
 static object AssemblyIrMate(IFeature f,IModelDoc2 d,HashSet<string> ids,List<string> warnings){
  var m=(IMate2)f.GetSpecificFeature2();string type=MateTypes.Where(kv=>kv.Value==m.Type).Select(kv=>kv.Key).FirstOrDefault()??"unsupported";
  string align=m.Alignment==(int)swMateAlign_e.swMateAlignALIGNED?"aligned":m.Alignment==(int)swMateAlign_e.swMateAlignANTI_ALIGNED?"anti_aligned":"closest";
  var r=new Dictionary<string,object>{{"name",f.Name},{"type",type},{"align",align},{"flip",m.Flipped},{"suppressed",f.IsSuppressed()}};
  if(type=="unsupported"){r["type_number"]=m.Type;warnings.Add(f.Name+": tipo no soportado "+m.Type);}
  if(m.Alignment!=(int)swMateAlign_e.swMateAlignALIGNED&&m.Alignment!=(int)swMateAlign_e.swMateAlignANTI_ALIGNED&&m.Alignment!=(int)swMateAlign_e.swMateAlignCLOSEST){
   r["type"]="unsupported";r["type_number"]=m.Type;warnings.Add(f.Name+": alineación no soportada "+m.Alignment);}
  if(type=="distance"||type=="angle"){
   double value=double.NaN;object def=f.GetDefinition();
   var dist=def as IDistanceMateFeatureData;var angle=def as IAngleMateFeatureData;
   try{if(type=="distance"&&dist!=null)value=dist.Distance;if(type=="angle"&&angle!=null)value=angle.Angle;}catch{}
   if(double.IsNaN(value)){var dd=(IDisplayDimension)f.GetFirstDisplayDimension();var dim=dd==null?null:(IDimension)dd.GetDimension2(0);if(dim!=null)value=dim.SystemValue;}
   if(double.IsNaN(value)||double.IsInfinity(value))warnings.Add(f.Name+": no se pudo leer la cota de "+type);
   else r[type=="distance"?"distance_mm":"angle_deg"]=value*(type=="distance"?1000:180/Math.PI);
  }
  if(type=="screw"){
   var def=f.GetDefinition() as IScrewMateFeatureData;
   if(def==null)warnings.Add(f.Name+": paso del tornillo no disponible");
   else{double v=def.RevolutionVal;double pitch=def.RevolutionType==(int)swScrewMateDistanceOptions_e.swDistancePerRevolution?v*1000:1000/v;
    if(pitch>0&&!double.IsInfinity(pitch)&&!double.IsNaN(pitch))r["pitch_mm"]=pitch;else warnings.Add(f.Name+": paso del tornillo no exportable");
    if(def.Reverse){r["type"]="unsupported";r["type_number"]=m.Type;warnings.Add(f.Name+": screw Reverse no aceptado por add_mate");}}
  }
  if(type=="concentric"){
   var def=f.GetDefinition() as IConcentricMateFeatureData;if(def!=null)r["lock_rotation"]=def.LockRotation;
  }
  var entities=new List<object>();
  for(int i=0;i<m.GetMateEntityCount();i++)try{entities.Add(AssemblyIrEntity(m.MateEntity(i),d,ids,warnings,f.Name+" entity "+i));}
   catch(Exception e){entities.Add(AssemblyIrUnsupported(e.Message,warnings,f.Name+" entity "+i));}
  r["entities"]=entities;return r;
 }
 static bool TryAssemblyExport(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="assembly_export")return false;var asm=RequireAssembly(d);var warnings=new List<string>();var components=new List<object>();var ids=new HashSet<string>();
  // Subassemblies remain intact files. Flattening descendants here would insert their geometry twice.
  foreach(IComponent2 c in (object[])asm.GetComponents(true)??new object[0]){
   string path=c.GetPathName();var t=c.Transform2 as IMathTransform;var transform=t==null?null:AssemblyIrNumbers(t.ArrayData);
   var r=new Dictionary<string,object>{{"id",c.Name2},{"file",Path.GetFileName(path)},{"path",path},{"fixed",c.IsFixed()},{"transform",transform},{"configuration",c.ReferencedConfiguration}};
   ids.Add(c.Name2);
   if(c.IsSuppressed()||transform==null||transform.Length!=16||!AssemblyIrFinite(transform)||string.IsNullOrEmpty(path)||!File.Exists(path)){
    r["unsupported"]="Componente suprimido, virtual, no resuelto o sin transformación/archivo disponible";warnings.Add(c.Name2+": "+r["unsupported"]);}
   components.Add(r);
  }
  var mates=new List<object>();var systems=new List<object>();
  foreach(var f in AssemblyIrFeatures(d)){
   if(f.GetTypeName2()=="MateGroup"){
    var sf=(IFeature)f.GetFirstSubFeature();while(sf!=null){
     if(sf.GetSpecificFeature2() is IMate2)try{mates.Add(AssemblyIrMate(sf,d,ids,warnings));}
      catch(Exception e){warnings.Add(sf.Name+": "+e.Message);mates.Add(new{name=sf.Name,type="unsupported",reason=e.Message,entities=new object[0]});}
     sf=(IFeature)sf.GetNextSubFeature();
    }
   }
   if(f.GetTypeName2()=="CoordSys")try{var t=CsTransform(d,f.Name);systems.Add(new{name=f.Name,origin_mm=t.Skip(9).Take(3).Select(x=>x*1000).ToArray(),x_axis=t.Take(3).ToArray(),y_axis=t.Skip(3).Take(3).ToArray()});}
    catch(Exception e){warnings.Add(f.Name+": sistema de coordenadas no exportable: "+e.Message);}
  }
  // Reuse document_units get, adapting its mass_properties view to the IR/set contract.
  var units=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(UnitsInfo(d)));var props=(Dictionary<string,object>)units["mass_properties"];
  var canonicalUnits=new{mass_length=props["length"],mass=props["mass"],volume=props["volume"],decimals=props["decimals"]};
  string name=Path.GetFileNameWithoutExtension(d.GetPathName());if(string.IsNullOrEmpty(name))name=Path.GetFileNameWithoutExtension(d.GetTitle());
  foreach(char ch in Path.GetInvalidFileNameChars())name=name.Replace(ch,'_');
  var plan=new{ir="assembly-ir/1",name=name,components=components.ToArray(),mates=mates.ToArray(),coordinate_systems=systems.ToArray(),units=canonicalUnits,expect=new Dictionary<string,object>(),warnings=warnings.ToArray()};
  string folder=Path.Combine(Root,"assembly_ir");Directory.CreateDirectory(folder);File.WriteAllText(Path.Combine(folder,name+".json"),Json.Serialize(plan),new UTF8Encoding(false));
  result=plan;return true;
 }
}
