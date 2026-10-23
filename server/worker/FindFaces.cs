using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.7 find_faces: faces of a component described by what the drawing says instead of a point: kind cylinder (diameter_mm,
// axis) or plane (normal, offset_mm), optionally near_mm (part coordinates) or index to pick among several. Returns candidates
// with an interior point (PART coordinates) that lies on that face only, ready for add_mate {component, local_point_mm}.
// assembly_batch resolves mate entities {component, find:{...}} with the same code; an ambiguous description fails listing
// the candidates instead of guessing.
partial class Worker {
 class FaceCand{public double[] point;public string kind;public double? diameter_mm;public double[] axis;public double[] axis_point_mm;public double[] axis_start_mm;public double[] axis_end_mm;public double[] normal;public double? offset_mm;public double area_mm2;public double score;public FaceRec rec;public double[] Point(){if(point==null&&rec!=null)point=RecPoint(rec);return point;}}
 static double[] FfNum(object o){return Items(o).Select(Convert.ToDouble).ToArray();}
 static double FfDot(double[] a,double[] b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
 static double[] FfUnit(double[] a){double n=Math.Sqrt(FfDot(a,a));return n<1e-12?a:new[]{a[0]/n,a[1]/n,a[2]/n};}
 static List<FaceCand> FindFaceCandidates(IComponent2 c,Dictionary<string,object> f){
  var part=c.GetModelDoc2() as IModelDoc2;if(part==null||part.GetType()!=1)throw new Exception(c.Name2+": find needs a resolved part component");
  // v3.7 review: the part document's bodies are those of ITS active configuration; refuse instead of reading another one
  string act=null;try{act=((IConfiguration)part.ConfigurationManager.ActiveConfiguration).Name;}catch{}
  if(!string.IsNullOrEmpty(c.ReferencedConfiguration)&&act!=null&&act!=c.ReferencedConfiguration)throw new Exception(c.Name2+": uses configuration "+c.ReferencedConfiguration+" but the part is open in "+act+"; find would read the wrong geometry");
  string kind=f.ContainsKey("kind")?Str(f,"kind"):(f.ContainsKey("diameter_mm")?"cylinder":"plane");
  if(kind!="cylinder"&&kind!="plane")throw new Exception("find.kind must be cylinder or plane");
  double tol=f.ContainsKey("tol_mm")?Num(f,"tol_mm"):0.02;
  var outl=new List<FaceCand>();
  foreach(var r in PartFaces(part,act)){
   if(r.kind!=kind)continue;
   var cand=new FaceCand{kind=kind};
   if(kind=="cylinder"){
    if(f.ContainsKey("diameter_mm")&&Math.Abs(r.dia-Num(f,"diameter_mm"))>tol)continue;
    if(f.ContainsKey("axis")&&Math.Abs(Math.Abs(FfDot(r.ax,FfUnit(FfNum(f["axis"]))))-1)>1e-6)continue;
    RecTess(r);cand.diameter_mm=Math.Round(r.dia,4);cand.axis=r.ax.Select(v=>Math.Round(v,6)).ToArray();cand.axis_point_mm=r.axp;cand.axis_start_mm=r.axs;cand.axis_end_mm=r.axe;}
   else{
    if(f.ContainsKey("normal")){var want=FfUnit(FfNum(f["normal"]));if(FfDot(r.n,want)<1-1e-6)continue;}
    if(f.ContainsKey("offset_mm")&&Math.Abs(r.off-Num(f,"offset_mm"))>tol)continue;
    cand.normal=r.n.Select(v=>Math.Round(v,6)).ToArray();cand.offset_mm=Math.Round(r.off,4);}
   // v3.7 review: a face without a selectable interior point is KEPT (point null) so it still counts as an ambiguity
   if(f.ContainsKey("near_mm")){var q=FfNum(f["near_mm"]);
    if(kind=="cylinder"){var o=cand.axis_point_mm;var ax=r.ax;var dd=new[]{q[0]-o[0],q[1]-o[1],q[2]-o[2]};double t=FfDot(dd,ax);double rad2=Math.Max(0,FfDot(dd,dd)-t*t),outside=0;
     // full-precision axis r.ax (the rounded output axis is not unit). Coaxial cylinders (the two journals of a roller) share the axis: also count how far the point lies outside the cylinder span
     if(cand.axis_start_mm!=null&&cand.axis_end_mm!=null){var s0=cand.axis_start_mm;var e0=cand.axis_end_mm;double ts=FfDot(new[]{s0[0]-o[0],s0[1]-o[1],s0[2]-o[2]},ax),te=FfDot(new[]{e0[0]-o[0],e0[1]-o[1],e0[2]-o[2]},ax);outside=Math.Max(0,Math.Max(Math.Min(ts,te)-t,t-Math.Max(ts,te)));}
     cand.score=Math.Sqrt(rad2+outside*outside);}   // distance to the axis line, plus the distance beyond the cylinder ends
    else{var cp=(double[])r.face.GetClosestPointOn(q[0]/1000,q[1]/1000,q[2]/1000);   // distance to the FACE itself, not to a sample point
     cand.score=cp==null?double.MaxValue:Math.Sqrt(Math.Pow(q[0]-cp[0]*1000,2)+Math.Pow(q[1]-cp[1]*1000,2)+Math.Pow(q[2]-cp[2]*1000,2));}}
   cand.area_mm2=r.Area();cand.rec=r;outl.Add(cand);
  }
  return outl.OrderBy(x=>x.score).ThenByDescending(x=>x.area_mm2).ToList();
 }
 // v3.8 face cache: every cylinder/plane face of a part file is read ONCE (geometry, area, interior point) and reused by every
 // find of every instance (the 24 mates of 4 bolt sets used to re-read the plate 24 times). Key = file + configuration + last
 // write time; a part with unsaved changes is never cached.
 class FaceRec{public IFace2 face;public string kind;public double dia;public double[] ax;public double[] axp;public double[] axs;public double[] axe;public double[] n;public double off;public double area;public bool areaDone;public double Area(){if(!areaDone){area=Math.Round(face.GetArea()*1e6,3);areaDone=true;}return area;}public double[] point;public bool pointDone,tessDone;public List<IFace2> all;public List<double[]> boxes;}
 // v3.8 speed: the interior point (tested against every other face: quadratic) and the cylinder span (tessellation) are
 // computed only for faces that pass the find filters, once, and then cached with the rest (preflight of the pegboard: 9.5 s)
 static double[] RecPoint(FaceRec r){
  if(r.pointDone)return r.point;r.pointDone=true;
  foreach(var s in AssemblyIrFaceSamples(r.face)){
   if(!AssemblyIrInterior(r.face,s,false))continue;
   // v3.8 speed: only faces whose box contains the sample can hold it (boxes read once per part)
   if(r.boxes==null)r.boxes=r.all.Select(o=>(double[])o.GetBox()).ToList();
   int hits=r.all.Where((o,ix)=>{var b=r.boxes[ix];const double t=2e-5;return b==null||(s[0]>=b[0]-t&&s[0]<=b[3]+t&&s[1]>=b[1]-t&&s[1]<=b[4]+t&&s[2]>=b[2]-t&&s[2]<=b[5]+t);}).Count(o=>{var cp=(double[])o.GetClosestPointOn(s[0],s[1],s[2]);return cp!=null&&Math.Sqrt(Math.Pow(cp[0]-s[0],2)+Math.Pow(cp[1]-s[1],2)+Math.Pow(cp[2]-s[2],2))<=1e-5;});
   if(hits==1){r.point=s.Select(v=>Math.Round(v*1000,6)).ToArray();break;}
  }
  return r.point;
 }
 static void RecTess(FaceRec r){
  if(r.tessDone||r.kind!="cylinder")return;r.tessDone=true;var p=(double[])((ISurface)r.face.GetSurface()).CylinderParams;
  try{var tv=(float[])r.face.GetTessTriangles(true);if(tv!=null&&tv.Length>=3){double lo=double.MaxValue,hi=double.MinValue;for(int k=0;k+2<tv.Length;k+=3){double tt=(tv[k]-p[0])*r.ax[0]+(tv[k+1]-p[1])*r.ax[1]+(tv[k+2]-p[2])*r.ax[2];lo=Math.Min(lo,tt);hi=Math.Max(hi,tt);}
   r.axs=new[]{p[0]+lo*r.ax[0],p[1]+lo*r.ax[1],p[2]+lo*r.ax[2]}.Select(v=>Math.Round(v*1000,4)).ToArray();r.axe=new[]{p[0]+hi*r.ax[0],p[1]+hi*r.ax[1],p[2]+hi*r.ax[2]}.Select(v=>Math.Round(v*1000,4)).ToArray();}}catch{}
 }
 static readonly Dictionary<string,List<FaceRec>> faceCache=new Dictionary<string,List<FaceRec>>();
 static int faceCacheHits=0,faceCacheMisses=0;
 static List<FaceRec> PartFaces(IModelDoc2 part,string act){
  string path=part.GetPathName(),key=null;
  try{if(!part.GetSaveFlag()&&!string.IsNullOrEmpty(path)&&System.IO.File.Exists(path))key=path.ToLowerInvariant()+"|"+act+"|"+System.IO.File.GetLastWriteTimeUtc(path).Ticks;}catch{}
  List<FaceRec> recs;
  // the cached faces are live COM objects: if the part was closed and reopened they are gone, so read it again
  if(key!=null&&faceCache.TryGetValue(key,out recs)){bool alive=true;try{if(recs.Count>0)recs[0].face.GetArea();}catch{alive=false;}if(alive){faceCacheHits++;return recs;}faceCache.Remove(key);}
  faceCacheMisses++;
  var faces=((object[])((IPartDoc)part).GetBodies2((int)swBodyType_e.swSolidBody,false)??new object[0]).Cast<IBody2>().SelectMany(b=>((object[])b.GetFaces()??new object[0]).Cast<IFace2>()).ToList();
  recs=new List<FaceRec>();
  foreach(var fc in faces){
   var su=(ISurface)fc.GetSurface();var r=new FaceRec{face=fc,all=faces};   // area on demand (only faces that pass a find filter)
   if(su.IsCylinder()){var p=(double[])su.CylinderParams;r.kind="cylinder";r.dia=p[6]*2000;r.ax=FfUnit(new[]{p[3],p[4],p[5]});r.axp=new[]{p[0],p[1],p[2]}.Select(v=>Math.Round(v*1000,4)).ToArray();}   // span (RecTess) and interior point (RecPoint) on demand
   else if(su.IsPlane()){var p=(double[])su.PlaneParams;var n=FfUnit(new[]{p[0],p[1],p[2]});if(fc.FaceInSurfaceSense())n=n.Select(v=>-v).ToArray();r.kind="plane";r.n=n;r.off=FfDot(n,new[]{p[3],p[4],p[5]})*1000;}
   recs.Add(r);
  }
  if(key!=null){if(faceCache.Count>200)faceCache.Clear();faceCache[key]=recs;}
  return recs;
 }
 // resolve one {component, find} entity to {component, local_point_mm, kind:"face"}
 static List<long[]> findTimes=new List<long[]>();
 static Dictionary<string,object> ResolveFind(IModelDoc2 d,Dictionary<string,object> e){
  var fw=System.Diagnostics.Stopwatch.StartNew();var ft=new long[4];findTimes.Add(ft);
  var comp=((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==Str(e,"component"));
  if(comp==null)throw new Exception("find: component "+Str(e,"component")+" not found");
  ft[0]=fw.ElapsedMilliseconds;var f=(Dictionary<string,object>)e["find"];var cands=FindFaceCandidates(comp,f);ft[1]=fw.ElapsedMilliseconds;
  if(cands.Count==0)throw new Exception("find: no "+(f.ContainsKey("kind")?Str(f,"kind"):"face")+" of "+comp.Name2+" matches "+Json.Serialize(f));
  FaceCand pick;
  if(f.ContainsKey("index")){int i=Convert.ToInt32(f["index"]);if(i<0||i>=cands.Count)throw new Exception("find.index out of range (0.."+(cands.Count-1)+")");pick=cands[i];}
  else if(cands.Count==1||(f.ContainsKey("near_mm")&&(cands.Count<2||cands[1].score-cands[0].score>0.5)))pick=cands[0];
  else throw new Exception("find: "+cands.Count+" faces of "+comp.Name2+" match "+Json.Serialize(f)+"; add near_mm or index. Candidates: "+Json.Serialize(cands.Take(8).Select((c,i)=>new{index=i,c.diameter_mm,c.axis,c.axis_point_mm,c.normal,c.offset_mm,c.area_mm2,local_point_mm=c.Point()}).ToArray()));
  if(pick.Point()==null)throw new Exception("find: the matching face of "+comp.Name2+" has no point that selects only that face (area "+pick.area_mm2+" mm2); use another face or a plane");
  ft[2]=fw.ElapsedMilliseconds;var r=e.Where(kv=>kv.Key!="find").ToDictionary(kv=>kv.Key,kv=>kv.Value);r["local_point_mm"]=pick.Point().Cast<object>().ToList();r["kind"]="face";ft[3]=fw.ElapsedMilliseconds;return r;
 }
 static bool TryFindFaces(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="find_faces")return false;
  if(d.GetType()!=2)throw new Exception("find_faces needs an assembly (component faces)");
  if(!a.ContainsKey("component")){
   // v3.7: every component in ONE call (sw_find_origin); each part file is analysed once and reused for its instances
   var spec=a.Where(kv=>kv.Key!="document_id").ToDictionary(kv=>kv.Key,kv=>kv.Value);var byFile=new Dictionary<string,List<FaceCand>>(StringComparer.OrdinalIgnoreCase);var all=new List<object>();
   foreach(IComponent2 c0 in (object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]){
    string path=c0.GetPathName()??"";if(!path.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase)||c0.IsSuppressed())continue;
    List<FaceCand> cs;if(!byFile.TryGetValue(path+"|"+c0.ReferencedConfiguration,out cs)){try{cs=FindFaceCandidates(c0,spec);}catch{cs=new List<FaceCand>();}byFile[path+"|"+c0.ReferencedConfiguration]=cs;}
    all.Add(new{component=c0.Name2,count=cs.Count,candidates=cs.Take(60).Select((x,i)=>new{index=i,x.kind,x.diameter_mm,x.axis,x.axis_point_mm,x.axis_start_mm,x.axis_end_mm,x.normal,x.offset_mm,x.area_mm2,local_point_mm=x.Point()}).ToArray()});
   }
   result=new{components=all,note="PART coordinates per component."};return true;
  }
  // v3.7 review: resolve:true -> the {component, find} entity resolved exactly like assembly_batch (assembly_build batch:false)
  if(Flag(a,"resolve")){result=ResolveFind(d,new Dictionary<string,object>{{"component",Str(a,"component")},{"find",a["find"]}});return true;}
  var comp=((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==Str(a,"component"));
  if(comp==null)throw new Exception("component not found: "+Str(a,"component"));
  var f=a.Where(kv=>kv.Key!="document_id"&&kv.Key!="component").ToDictionary(kv=>kv.Key,kv=>kv.Value);
  var c=FindFaceCandidates(comp,f);
  result=new{component=comp.Name2,count=c.Count,candidates=c.Take(30).Select((x,i)=>new{index=i,x.kind,x.diameter_mm,x.axis,x.axis_point_mm,x.axis_start_mm,x.axis_end_mm,x.normal,x.offset_mm,x.area_mm2,local_point_mm=x.Point(),distance_to_near_mm=Math.Round(x.score,4)}).ToArray(),
   note="Coordinates are PART coordinates. Use {component, find:{...}} in sw_assembly_build plans or local_point_mm in sw_add_mate."};
  return true;
 }
}
