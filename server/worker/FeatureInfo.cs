using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.5 feature_info (read-only, unguarded): how a feature is defined, to understand a warning/error the API only reports as
// a code. Every feature: type, error/warning, suppression, parents, children, its What's Wrong entry and the faces it makes.
// Extrusions: end conditions, depths, direction, merge, thin, end/direction references (read inside AccessSelections, always
// released). Sketches: support, status, contours, profile validation (CheckFeatureUse) and plane in model coordinates
// (none for 3D sketches). Reference planes: origin and normal.
// v3.5 review (Codex, high): end references use swSelectionReferenceTypes_e (not swSelectType_e), both direction references,
// partial data kept when one part fails, What's Wrong read checked.
partial class Worker {
 static string[] FiNames(object arr){return ((object[])arr??new object[0]).OfType<IFeature>().Select(f=>f.Name).ToArray();}
 static double[] FiRound(IEnumerable<double> v,int dec){return v.Select(x=>Math.Round(x,dec)).ToArray();}
 // PlaneParams: normal(3) + point(3, m); CylinderParams: origin(3, m) + axis(3) + radius(m)
 static object FiPlane(double[] p){return new{normal=FiRound(p.Take(3),6),point_mm=FiRound(p.Skip(3).Take(3).Select(x=>x*1000),4)};}
 static object FiCyl(double[] p){return new{origin_mm=FiRound(p.Take(3).Select(x=>x*1000),4),axis=FiRound(p.Skip(3).Take(3),6),radius_mm=Math.Round(p[6]*1000,4)};}
 static object FiFrame(double[] ad){return new{origin_mm=FiRound(new[]{ad[9],ad[10],ad[11]}.Select(x=>x*1000),4),x_axis=FiRound(ad.Take(3),6),normal=FiRound(ad.Skip(6).Take(3),6)};}
 static object FiRef(object r,int t,Type kind){if(r==null)return null;string what=r is IFeature?"feature "+((IFeature)r).Name:r is IBody2?"body "+((IBody2)r).Name:r is IFace2?"face":r is IEdge?"edge":r is IVertex?"vertex":r is ISketchSegment?"sketch segment":r is ISketchPoint?"sketch point":r.GetType().Name;return new{what=what,type=Enum.GetName(kind,t)??t.ToString()};}
 static bool TryFeatureInfo(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="feature_info")return false;
  var f=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"name"));if(f==null)throw new Exception("Feature not found: "+Str(a,"name"));
  bool warn;int code=f.GetErrorCode2(out warn);
  var info=new Dictionary<string,object>{{"name",f.Name},{"type",f.GetTypeName2()},{"error_code",code},{"error_name",Enum.GetName(typeof(swFeatureError_e),code)},{"is_warning",warn},{"suppressed",f.IsSuppressed()},{"parents",FiNames(f.GetParents())},{"children",FiNames(f.GetChildren())}};
  object def=null;try{def=f.GetDefinition();}catch(Exception e0){info["definition"]="err: "+e0.Message;}
  var ex=def as IExtrudeFeatureData2;
  if(ex!=null){
   try{
    Func<bool,object> dir=fw=>new{end_condition=Enum.GetName(typeof(swEndConditions_e),ex.GetEndCondition(fw)),depth_mm=ex.GetDepth(fw)*1000,draft=ex.GetDraftWhileExtruding(fw)};
    info["extrude"]=new{dir1=dir(true),dir2=ex.BothDirections?dir(false):null,both_directions=ex.BothDirections,reverse=ex.ReverseDirection,merge=ex.Merge,thin=ex.IsThinFeature(),from=Enum.GetName(typeof(swExtrudeFrom_e),ex.FromType),auto_select=ex.AutoSelect,feature_scope=ex.FeatureScope};
   }catch(Exception e1){info["extrude"]="err: "+e1.Message;}
   // references need selection access (it rolls the model back temporarily): always released
   bool access=false;
   try{
    access=ex.AccessSelections(d,null);
    if(!access)info["references"]="not available (AccessSelections refused, e.g. suppressed feature)";
    else{
     int rt1=0,rt2=0;object e1r=null,e2r=null;try{e1r=ex.GetEndConditionReference(true,out rt1);}catch{}if(ex.BothDirections)try{e2r=ex.GetEndConditionReference(false,out rt2);}catch{}
     object dr1=null,dr2=null;int dt1=0,dt2=0,dn=0;try{dn=ex.GetDirectionReference(out dr1,out dt1,out dr2,out dt2);}catch{}
     info["references"]=new{end1=FiRef(e1r,rt1,typeof(swSelectionReferenceTypes_e)),end2=FiRef(e2r,rt2,typeof(swSelectionReferenceTypes_e)),direction_count=dn,direction1=FiRef(dr1,dt1,typeof(swSelectType_e)),direction2=FiRef(dr2,dt2,typeof(swSelectType_e))};
    }
   }catch(Exception e2){info["references"]="err: "+e2.Message;}
   finally{if(access)try{ex.ReleaseSelectionAccess();}catch{}}
  }
  var rp=f.GetSpecificFeature2() as IRefPlane;
  if(rp!=null){try{info["ref_plane"]=FiFrame((double[])rp.Transform.ArrayData);}catch(Exception e6){info["ref_plane"]="err: "+e6.Message;}}
  var sk=f.GetSpecificFeature2() as ISketch;
  if(sk!=null){
   bool is3d=false;try{is3d=sk.Is3D();}catch{}
   object refEnt=null;int refType=0;try{refEnt=sk.GetReferenceEntity(ref refType);}catch{}
   string on=refEnt is IFeature?((IFeature)refEnt).Name:refEnt is IFace2?"cara":refEnt==null?"?":refEnt.GetType().Name;
   int contours=0;try{foreach(ISketchContour ct in (object[])sk.GetSketchContours()??new object[0]){contours++;}}catch{}
   var checks=new Dictionary<string,object>();
   foreach(var u in new[]{swSketchCheckFeatureProfileUsage_e.swSketchCheckFeature_BOSSEXTRUDE,swSketchCheckFeatureProfileUsage_e.swSketchCheckFeature_CUTEXTRUDE}){
    string k=u.ToString().Replace("swSketchCheckFeature_","");
    try{int open=0,closed=0;int st=sk.CheckFeatureUse((int)u,ref open,ref closed);checks[k]=new{status=Enum.GetName(typeof(swSketchCheckFeatureStatus_e),st)??st.ToString(),open_contours=open,closed_contours=closed};}
    catch(Exception e2){checks[k]="err: "+e2.Message;}
   }
   info["is_3d"]=is3d;
   if(is3d)info["sketch_plane"]=null;
   else try{info["sketch_plane"]=FiFrame((double[])((IMathTransform)sk.ModelToSketchTransform.Inverse()).ArrayData);}catch(Exception e5){info["sketch_plane"]="err: "+e5.Message;}
   info["profile_check"]=checks;
   info["sketch"]=new{status=sk.GetConstrainedStatus(),on=on,reference_type=Enum.GetName(typeof(swSelectType_e),refType)??refType.ToString(),segments=((object[])sk.GetSketchSegments()??new object[0]).Length,contours=contours,construction=((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>().Count(s=>s.ConstructionGeometry)};
  }
  try{var fl=new List<object>();foreach(IFace2 fc in (object[])f.GetFaces()??new object[0]){var su=(ISurface)fc.GetSurface();
    fl.Add(new{area_mm2=Math.Round(fc.GetArea()*1e6,4),plane=su.IsPlane()?FiPlane((double[])su.PlaneParams):null,cylinder=su.IsCylinder()?FiCyl((double[])su.CylinderParams):null});}
   info["faces"]=fl;}catch(Exception e4){info["faces"]="err: "+e4.Message;}
  try{object fs,cs,ws;bool ok=d.Extension.GetWhatsWrong(out fs,out cs,out ws);var fa=Items(fs??new object[0]).ToArray();var ca=Items(cs??new object[0]).ToArray();var wa=Items(ws??new object[0]).ToArray();
   if((!ok&&d.Extension.GetWhatsWrongCount()>0)||ca.Length!=fa.Length||wa.Length!=fa.Length)info["whats_wrong"]="not available (incomplete read)";
   else{var mine=new List<object>();for(int i=0;i<fa.Length;i++){var ff=fa[i] as IFeature;if(ff!=null&&ff.Name==f.Name){int cc=Convert.ToInt32(ca[i]);mine.Add(new{code=cc,code_name=Enum.GetName(typeof(swFeatureError_e),cc),warning=Convert.ToBoolean(wa[i])});}}info["whats_wrong"]=mine;}
  }catch(Exception e3){info["whats_wrong"]="err: "+e3.Message;}
  result=info;return true;
 }
}
