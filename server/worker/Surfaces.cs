using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.19 the Surfaces tab (Superficies), one op "surface" with an action:
//  extrude, revolve, planar, loft, sweep, offset, ruled, fill      make surface bodies
//  trim, untrim, extend, knit, delete_face, delete_hole, replace_face  edit them
//  thicken, thicken_cut, cut_with_surface                          turn them into (or against) solid
//  inspect (read only)                                             every body, its area and its OPEN edges: a gap that stops a
//                                                                  knit from forming a solid is found before knitting
// Points are part coordinates in mm; a point picks the face, edge or surface body it lies on (0.05 mm faces, 0.5 mm edges).
partial class Worker {
 static IBody2[] BodiesOf(IModelDoc2 d,int type){return ((object[])((IPartDoc)d).GetBodies2(type,true)??new object[0]).Cast<IBody2>().ToArray();}
 static double DistTo(object cpo,double[] q){var cp=cpo as double[];if(cp==null||cp.Length<3)return double.MaxValue;return Math.Sqrt(Math.Pow(cp[0]-q[0],2)+Math.Pow(cp[1]-q[1],2)+Math.Pow(cp[2]-q[2],2));}
 static double FaceDistMm(IFace2 f,double[] pmm){var q=pmm.Select(v=>v/1000).ToArray();return DistTo(f.GetClosestPointOn(q[0],q[1],q[2]),q)*1000;}
 static double BodyDistMm(IBody2 b,double[] pmm){double best=double.MaxValue;foreach(IFace2 f in (object[])b.GetFaces()??new object[0])best=Math.Min(best,FaceDistMm(f,pmm));return best;}
 // nearest face of any body (solid first, then surface) through the point
 static IFace2 AnyFaceAt(IModelDoc2 d,double[] pmm,string what){
  IFace2 best=null;double bd=0.05;
  foreach(var b in BodiesOf(d,0).Concat(BodiesOf(d,1)))foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){double dd=FaceDistMm(f,pmm);if(dd<bd){bd=dd;best=f;}}
  if(best==null)throw new Exception("No face passes through "+what+" ["+string.Join(", ",pmm)+"] (0.05 mm)");return best;
 }
 static IEdge AnyEdgeAt(IModelDoc2 d,double[] pmm,string what){
  var q=pmm.Select(v=>v/1000).ToArray();var all=new List<KeyValuePair<double,IEdge>>();
  foreach(var b in BodiesOf(d,0).Concat(BodiesOf(d,1)))foreach(IEdge e in (object[])b.GetEdges()??new object[0])all.Add(new KeyValuePair<double,IEdge>(DistTo(e.GetClosestPointOn(q[0],q[1],q[2]),q)*1000,e));
  var s=all.OrderBy(x=>x.Key).ToList();if(s.Count==0||s[0].Key>0.5)throw new Exception("No edge within 0.5 mm of "+what+" ["+string.Join(", ",pmm)+"]");
  if(s.Count>1&&s[1].Key-s[0].Key<0.005)throw new Exception(what+" ["+string.Join(", ",pmm)+"] touches two edges (a corner): move it to the middle of the edge");
  return s[0].Value;
 }
 static IBody2 SheetAt(IModelDoc2 d,double[] pmm,string what){
  var hit=BodiesOf(d,1).Select(b=>new{b,dist=BodyDistMm(b,pmm)}).OrderBy(x=>x.dist).FirstOrDefault();
  if(hit==null||hit.dist>0.05)throw new Exception("No surface body passes through "+what+" ["+string.Join(", ",pmm)+"]; surface bodies: "+string.Join(", ",BodiesOf(d,1).Select(b=>b.Name)));
  return hit.b;
 }
 static List<double[]> Pts(Dictionary<string,object> a,string k){return a.ContainsKey(k)?Items(a[k]).Select(o=>Xyz(o,k)).ToList():new List<double[]>();}
 static void Mark(IModelDoc2 d,object e,int mark,string what){
  var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mark;bool ok=e is IBody2?((IBody2)e).Select2(true,sd):e is IEntity?((IEntity)e).Select4(true,sd):false;
  if(!ok)throw new Exception("Cannot select "+what);
 }
 // the edge parameters come back negated on reversed edges: keep the candidate that really lies on the edge
 static double[] EdgeMidMm(IEdge e){try{var cp=(double[])e.GetCurveParams2();var c=(ICurve)e.GetCurve();double t=(cp[6]+cp[7])/2;double[] p=null;double best=double.MaxValue;
   foreach(double tt in new[]{t,-t}){var q=(double[])c.Evaluate2(tt,0);var on=(double[])e.GetClosestPointOn(q[0],q[1],q[2]);double dd=on==null?double.MaxValue:Math.Sqrt(Math.Pow(on[0]-q[0],2)+Math.Pow(on[1]-q[1],2)+Math.Pow(on[2]-q[2],2));if(dd<best){best=dd;p=q;}}
   return new[]{Math.Round(p[0]*1000,3),Math.Round(p[1]*1000,3),Math.Round(p[2]*1000,3)};}catch{return null;}}
 static object SurfaceReport(IModelDoc2 d){
  var sheets=new List<object>();int open=0;
  foreach(var b in BodiesOf(d,1)){
   var edges=((object[])b.GetEdges()??new object[0]).Cast<IEdge>().ToList();
   var free=edges.Where(e=>{var two=(object[])e.GetTwoAdjacentFaces2();return two==null||two.Count(x=>x!=null)<2;}).ToList();open+=free.Count;
   double area=((object[])b.GetFaces()??new object[0]).Sum(f=>((IFace2)f).GetArea())*1e6;
   sheets.Add(new{name=b.Name,faces=b.GetFaceCount(),area_mm2=Math.Round(area,2),open_edges=free.Count,open_edge_points_mm=free.Take(12).Select(EdgeMidMm).Where(x=>x!=null).ToArray(),closed=free.Count==0});
  }
  var solids=BodiesOf(d,0);
  return new{surface_bodies=sheets,solid_bodies=solids.Select(b=>b.Name).ToArray(),volume_mm3=solids.Length>0?PartVolumeMm3(d):0,
   open_edges=open,
   note=sheets.Count==0?"No surface bodies.":open==0?"Every surface body is closed: knit with form_solid makes a solid.":"Open edges are where surfaces do not meet (gaps or missing faces): a knit with form_solid only makes a solid when, after knitting, none is left."};
 }
 static bool TrySurface(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="surface")return false;
  if(d.GetType()!=1)throw new Exception("surface works on a managed PART");
  string act=Str(a,"action");
  if(act=="inspect"){result=SurfaceReport(d);return true;}
  var had=FeatureNames(d);int s0=BodiesOf(d,0).Length,h0=BodiesOf(d,1).Length;double v0=s0>0?PartVolumeMm3(d):0;
  var fm=d.FeatureManager;var tried=new List<string>();object made=null;
  Func<string,IFeature> sketch=n=>{var s=SketchFeature(d,n);return s;};
  try{
   d.ClearSelection2(true);
   switch(act){
    case "extrude":{
     var sk=sketch(Str(a,"sketch"));if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);
     bool mid=Flag(a,"mid_plane"),both=a.ContainsKey("depth2_mm");if(mid&&both)throw new Exception("mid_plane and depth2_mm are exclusive");
     bool cap=Flag(a,"cap_ends");
     // v3.20 end: blind (default), mid_plane, up_to_surface or offset_from_surface (the face through up_to_point_mm)
     string end=a.ContainsKey("end")?Str(a,"end"):mid?"mid_plane":"blind";
     int t1=end=="blind"?(int)swEndConditions_e.swEndCondBlind:end=="mid_plane"?(int)swEndConditions_e.swEndCondMidPlane:end=="up_to_surface"?(int)swEndConditions_e.swEndCondUpToSurface:end=="offset_from_surface"?(int)swEndConditions_e.swEndCondOffsetFromSurface:-1;
     if(t1<0)throw new Exception("end: blind, mid_plane, up_to_surface or offset_from_surface");
     bool upTo=end=="up_to_surface"||end=="offset_from_surface";
     if(upTo&&(both||mid))throw new Exception(end+" goes one way: no depth2_mm or mid_plane");
     if(upTo&&!a.ContainsKey("up_to_point_mm"))throw new Exception(end+" needs up_to_point_mm, a point on the face to stop at");
     IFace2 target=upTo?AnyFaceAt(d,Xyz(a["up_to_point_mm"],"up_to_point_mm"),"up_to_point_mm"):null;
     double d1=end=="offset_from_surface"?Num(a,"offset_mm")/1000:upTo?0:Num(a,"depth_mm")/1000;
     // the face of an up-to end is a second selection; which mark it wants is not documented for surfaces: try 1, then 0
     foreach(int mark in upTo?new[]{1,0}:new[]{0}){
      d.ClearSelection2(true);if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);if(upTo){Mark(d,target,mark,"up_to face");tried.Add(end+" face mark "+mark);}
      fm.FeatureExtruRefSurface3(!both,Flag(a,"reverse"),0,0,t1,0,d1,both?Num(a,"depth2_mm")/1000:0,false,false,false,false,0,0,Flag(a,"offset_reverse"),false,false,false,cap,cap,false,false);
      if(NewFeature(d,had)!=null)break;}
     break;}
    case "revolve":{
     var sk=sketch(Str(a,"sketch"));var segs=((object[])((ISketch)sk.GetSpecificFeature2()).GetSketchSegments()??new object[0]).Cast<ISketchSegment>();
     if(segs.Count(s=>s.ConstructionGeometry&&s is ISketchLine)!=1)throw new Exception("The sketch needs exactly one construction line (construction=true) as the axis");
     if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);
     made=fm.InsertRevolvedRefSurface((a.ContainsKey("angle_deg")?Num(a,"angle_deg"):360)*Math.PI/180,Flag(a,"reverse"),0,0);
     break;}
    case "planar":{
     if(a.ContainsKey("sketch")){var sk=sketch(Str(a,"sketch"));if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);}
     else{var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("planar needs sketch or edge_points_mm (a closed loop of edges)");foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),0,"edge");}
     made=d.InsertPlanarRefSurface();break;}
    case "loft":{
     var pr=Items(a["profiles"]).Select(Convert.ToString).ToList();if(pr.Count<2)throw new Exception("loft needs at least 2 profiles");
     foreach(var n in pr)if(!sketch(n).Select2(true,1))throw new Exception("Cannot select profile "+n);
     if(a.ContainsKey("guides"))foreach(var g in Items(a["guides"]).Select(Convert.ToString))if(!Feature(d,g).Select2(true,2))throw new Exception("Cannot select guide "+g);
     d.InsertLoftRefSurface2(Flag(a,"closed"),false,false,1.0,0,0);break;}
    case "sweep":{
     if(!sketch(Str(a,"profile")).Select2(true,1))throw new Exception("Cannot select the profile sketch");
     if(!Feature(d,Str(a,"path")).Select2(true,4))throw new Exception("Cannot select the path");
     if(a.ContainsKey("guides"))foreach(var g in Items(a["guides"]).Select(Convert.ToString))if(!Feature(d,g).Select2(true,2))throw new Exception("Cannot select guide "+g);
     made=fm.InsertSweepSurface3(false,0,false,false,0,0,0,true,true,0,true,false,0,0);break;}
    case "offset":{
     var fp=Pts(a,"face_points_mm");if(fp.Count==0)throw new Exception("offset needs face_points_mm");foreach(var p in fp)Mark(d,AnyFaceAt(d,p,"face_points_mm"),0,"face");
     d.InsertOffsetSurface(a.ContainsKey("distance_mm")?Num(a,"distance_mm")/1000:0,Flag(a,"reverse"));break;}
    case "ruled":{
     var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("ruled needs edge_points_mm");foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),0,"edge");
     string ty=a.ContainsKey("ruled_type")?Str(a,"ruled_type"):"normal";int t=ty=="tangent"?1:ty=="normal"?2:ty=="tapered"?3:ty=="perpendicular"?4:ty=="sweep"?5:-1;if(t<0)throw new Exception("ruled_type: tangent, normal, tapered, perpendicular or sweep");
     made=fm.InsertRuledSurfaceFromEdge2(t,Num(a,"distance_mm")/1000,false,Flag(a,"reverse"),false,(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):0)*Math.PI/180,false,0,0,0,false);break;}
    case "fill":{
     var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("fill needs edge_points_mm (the closed boundary)");var edges=ep.Select(p=>AnyEdgeAt(d,p,"edge_points_mm")).ToList();
     int opt=(Flag(a,"form_solid")?(int)swFeatureFillSurfaceOptions_e.swTryToFormSolid:0)|(Flag(a,"knit")?(int)swFeatureFillSurfaceOptions_e.swMergeResult:0);
     foreach(int mark in new[]{1,0}){d.ClearSelection2(true);foreach(var e in edges)Mark(d,e,mark,"edge");tried.Add("fill mark "+mark);
      made=fm.InsertFillSurface2(2,opt,edges.Cast<object>().ToArray(),edges.Select(x=>0).ToArray(),null,null);if(made!=null||NewFeature(d,had)!=null)break;}
     break;}
    case "knit":{
     var bp=Pts(a,"body_points_mm");var bodies=bp.Count>0?bp.Select(p=>SheetAt(d,p,"body_points_mm")).Distinct().ToList():BodiesOf(d,1).ToList();
     if(bodies.Count<1)throw new Exception("No surface bodies to knit");
     double tol=a.ContainsKey("gap_tolerance_mm")?Num(a,"gap_tolerance_mm")/1000:0;
     // SolidWorks help: select with mark 1; knit tolerance between 0.0001 and 0.1 mm (gap_tolerance_mm, default 0.01 mm)
     double ktol=tol>0?Math.Min(Math.Max(tol,1e-7),1e-4):1e-5;
     foreach(int mk in new[]{1,0})foreach(string sel in new[]{"body","face","feature"}){
      if(made!=null||NewFeature(d,had)!=null)break;
      d.ClearSelection2(true);
      try{
       if(sel=="body")foreach(var b in bodies)Mark(d,b,mk,"surface body "+b.Name);
       else if(sel=="face")foreach(var b in bodies)foreach(var fc in ((object[])b.GetFaces()??new object[0]))Mark(d,fc,mk,"face of "+b.Name);
       else foreach(var f in bodies.SelectMany(b=>((object[])b.GetFeatures()??new object[0]).Cast<IFeature>().Reverse().Take(1)).GroupBy(f=>f.Name).Select(g=>g.First()))if(!f.Select2(true,mk))throw new Exception("cannot select "+f.Name);
      }catch(Exception ex){tried.Add(sel+" mark "+mk+": "+ex.Message);continue;}
      made=fm.InsertSewRefSurface(tol>0,Flag(a,"form_solid"),Flag(a,"merge_faces",true),ktol,tol>0?ktol:0);
      string tg=sel+" mark "+mk;
      if(made!=null||NewFeature(d,had)!=null){tried.Add(tg+": ok");break;}
      tried.Add(tg+": null");
     }
     break;}
    case "thicken":case "thicken_cut":{
     var b=SheetAt(d,Xyz(a["body_point_mm"],"body_point_mm"),"body_point_mm");
     string side=a.ContainsKey("side")?Str(a,"side"):"side1";int dir=side=="side1"?0:side=="side2"?1:side=="both"?2:-1;if(dir<0)throw new Exception("side: side1, side2 or both");
     double t=a.ContainsKey("thickness_mm")?Num(a,"thickness_mm")/1000:0;bool fill=Flag(a,"fill_volume");if(t<=0&&!fill)throw new Exception("thickness_mm > 0 (or fill_volume for a closed surface)");
     // selection by body or by its face, mark 0 or 1: the help does not say which one the thicken commands read
     foreach(int mk in new[]{0,1})foreach(string sel in new[]{"body","face"}){
      if(made!=null||NewFeature(d,had)!=null)break;
      d.ClearSelection2(true);
      try{if(sel=="body")Mark(d,b,mk,"surface body "+b.Name);else foreach(var fc in (object[])b.GetFaces())Mark(d,fc,mk,"face of "+b.Name);}catch(Exception ex){tried.Add(sel+" mark "+mk+": "+ex.Message);continue;}
      made=act=="thicken"?fm.FeatureBossThicken(t,dir,0,fill,true,true,true):fm.FeatureCutThicken(t,dir,0,fill,true,true);
      tried.Add(sel+" mark "+mk+": "+(made!=null||NewFeature(d,had)!=null?"ok":"null"));
     }
     break;}
    case "cut_with_surface":{
     var b=SheetAt(d,Xyz(a["body_point_mm"],"body_point_mm"),"body_point_mm");Mark(d,b,0,"surface body "+b.Name);
     int err;made=fm.InsertCutSurface(Flag(a,"reverse"),0,true,true,null,out err);if(made==null&&err!=0)tried.Add("error "+err);break;}
    case "extend":{
     var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("extend needs edge_points_mm");foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),0,"edge");
     d.InsertExtendSurface(Flag(a,"linear"),(int)swSurfaceExtendEndCond_e.swSurfaceExtendEndCondDistance,Num(a,"distance_mm")/1000);break;}
    case "delete_face":{
     var fp=Pts(a,"face_points_mm");if(fp.Count==0)throw new Exception("delete_face needs face_points_mm");foreach(var p in fp)Mark(d,AnyFaceAt(d,p,"face_points_mm"),0,"face");
     string m=a.ContainsKey("mode")?Str(a,"mode"):"delete";int o=m=="delete"?0:m=="patch"?1:m=="fill"?2:m=="fill_tangent"?3:-1;if(o<0)throw new Exception("mode: delete, patch, fill or fill_tangent");
     made=d.Extension.InsertDeleteFace(o);break;}
    case "delete_hole":{
     var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("delete_hole needs edge_points_mm (one edge of each hole)");foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),0,"edge");
     made=fm.InsertDeleteHoleForSurface();break;}
    case "untrim":{
     var f=AnyFaceAt(d,Xyz(a["face_point_mm"],"face_point_mm"),"face_point_mm");Mark(d,f,0,"face");
     made=fm.InsertUntrimSurface2(0,1,0,true,false);break;}
    case "replace_face":{
     foreach(var p in Pts(a,"face_points_mm"))Mark(d,AnyFaceAt(d,p,"face_points_mm"),1,"face to replace");
     Mark(d,SheetAt(d,Xyz(a["body_point_mm"],"body_point_mm"),"body_point_mm"),2,"replacement surface");
     d.InsertFeatureReplaceFace();break;}
    case "trim":{made=Trim(d,a,tried);break;}
    default:throw new Exception("Unknown surface action "+act);
   }
  }finally{d.ClearSelection2(true);}
  var nf=made as IFeature??NewFeature(d,had);
  if(nf==null)throw new Exception("Surface "+act+" failed"+(tried.Count>0?" (tried: "+string.Join("; ",tried)+")":"")+": "+Why(act));
  d.EditRebuild3();
  // the TryToFormSolid argument can come back ignored: turn it on in the feature definition when the knit is closed
  if(act=="knit"&&Flag(a,"form_solid")&&BodiesOf(d,0).Length<=s0)try{
   var kd=nf.GetDefinition() as ISurfaceKnitFeatureData;
   if(kd!=null){tried.Add("form solid flag in the feature: "+kd.UseTryToFormSolid);kd.UseTryToFormSolid=true;bool ok=nf.ModifyDefinition(kd,d,null);d.EditRebuild3();tried.Add("form solid by ModifyDefinition: "+(ok&&BodiesOf(d,0).Length>s0?"ok":"no"));}
  }catch(Exception ex){tried.Add("ModifyDefinition: "+ex.Message);}
  int s1=BodiesOf(d,0).Length,h1=BodiesOf(d,1).Length;double v1=s1>0?PartVolumeMm3(d):0;
  result=new{action=act,feature=nf.Name,type=nf.GetTypeName2(),new_features=FeatureNames(d).Except(had).ToArray(),solid_bodies_before=s0,solid_bodies_after=s1,surface_bodies_before=h0,surface_bodies_after=h1,
   volume_before_mm3=v0,volume_after_mm3=v1,formed_solid=act=="knit"&&Flag(a,"form_solid")?(object)(s1>s0):null,tried=tried.Count>0?tried.ToArray():null,surfaces=SurfaceReport(d),inspection=Checked(d)};
  if(act=="knit"&&Flag(a,"form_solid")&&s1<=s0)throw new Exception("Knit made "+nf.Name+" but no solid: the surfaces are not closed. "+SurfJson(SurfaceReport(d))+" tried: "+string.Join("; ",tried));
  return true;
 }
 static string SurfJson(object o){try{return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(o);}catch{return "";}}
 static string Why(string act){
  switch(act){
   case "extrude":return "the sketch must be valid (open or closed) and not already used";
   case "revolve":return "the profile must stay on one side of its construction line";
   case "planar":return "the sketch or the edges must be ONE closed, flat loop (inner loops make holes)";
   case "knit":return "the surfaces must share their edges (within gap_tolerance_mm)";
   case "thicken":case "thicken_cut":return "the thickness may not fit the curvature, or the cut does not reach the body";
   case "cut_with_surface":return "the surface must cross the whole solid; reverse keeps the other side";
   case "trim":return "the tool must cross the surface, and every keep point must lie on a piece";
   case "fill":return "the edges must form one closed boundary";
   default:return "check the selection";
  }
 }
 // Trim (Recortar superficie): tools = surfaces, a plane or a sketch; mutual = the selected surfaces trim each other.
 // The API is two calls: PreTrimSurface splits the targets into temporary pieces, PostTrimSurface keeps the selected ones.
 // How the pieces must be selected is not settled by the docs, so the variants are tried in order and the first that works stays.
 static object Trim(IModelDoc2 d,Dictionary<string,object> a,List<string> tried){
  var fm=d.FeatureManager;bool mutual=Flag(a,"mutual");
  var keep=Pts(a,"keep_points_mm");if(keep.Count==0)throw new Exception("trim needs keep_points_mm: a point on each piece to keep");
  var toolBodies=Pts(a,"tool_points_mm").Select(p=>SheetAt(d,p,"tool_points_mm")).Distinct().ToList();
  IFeature toolSketch=a.ContainsKey("tool_sketch")?SketchFeature(d,Str(a,"tool_sketch")):null;
  IFeature toolPlane=null;if(a.ContainsKey("tool_plane_index")){int i=Convert.ToInt32(a["tool_plane_index"]),k=0;foreach(var f in AllFeatures(d))if(f.GetTypeName2()=="RefPlane"){if(k==i){toolPlane=f;break;}k++;}if(toolPlane==null)throw new Exception("No plane "+i);}
  if(!mutual&&toolBodies.Count+(toolSketch!=null?1:0)+(toolPlane!=null?1:0)==0)throw new Exception("trim needs a tool (tool_points_mm, tool_sketch or tool_plane_index) or mutual=true");
  var targets=Pts(a,"target_points_mm").Select(p=>SheetAt(d,p,"target_points_mm")).Distinct().ToList();
  // mutual: the selected surfaces are tools and targets at once; standard: without target_points_mm every other surface is a target
  if(mutual)targets=toolBodies.Concat(targets).GroupBy(b=>b.Name).Select(g=>g.First()).ToList();
  else if(targets.Count==0)targets=BodiesOf(d,1).Where(b=>!toolBodies.Any(t=>t.Name==b.Name)).ToList();
  var tools=mutual?targets:toolBodies;
  // SolidWorks own example (Create Trimmed Surface Feature): tool selected, PreTrimSurface(mutual, TRUE, false, false), then each
  // piece picked by SelectByID2("", "SURFACEBODY", a point on it, append) and PostTrimSurface(knit)
  var before=targets.Select(t=>new{name=t.Name,area=((object[])t.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea())*1e6}).ToList();
  foreach(int mark in new[]{0})foreach(bool removePicked in new[]{false,true})foreach(string toolBy in new[]{"feature","body"})foreach(string pick in new[]{"body","face","point"}){
   if(removePicked&&pick=="point")continue;
   bool linear=false,clearFirst=true;
   string tag="mark "+mark+", tool by "+toolBy+", pieces by "+pick+(removePicked?", remove picked":"");
   try{
    d.ClearSelection2(true);
    if(toolSketch!=null&&!toolSketch.Select2(true,0))throw new Exception("Cannot select tool sketch");
    if(toolPlane!=null&&!toolPlane.Select2(true,0))throw new Exception("Cannot select tool plane");
    foreach(var t in tools){if(toolBy=="body")Mark(d,t,0,"tool "+t.Name);else{var tf=((object[])t.GetFeatures()??new object[0]).Cast<IFeature>().LastOrDefault();if(tf==null||!tf.Select2(true,0))throw new Exception("Cannot select the feature of "+t.Name);}}
    if(!fm.PreTrimSurface(mutual,true,linear,removePicked)){tried.Add(tag+": PreTrimSurface false");continue;}
    var pieces=new List<IBody2>();foreach(var t in targets){var pb=fm.GetPreTrimmedBodies((Body2)t) as object[];if(pb!=null)pieces.AddRange(pb.Cast<IBody2>());}
    if(pieces.Count==0){tried.Add(tag+": no pieces");continue;}
    var lost=keep.Where(k=>!pieces.Any(p=>BodyDistMm(p,k)<0.05)).ToList();
    if(lost.Count>0)throw new Exception("keep point "+string.Join(",",lost[0])+" is on none of the "+pieces.Count+" pieces");
    if(clearFirst)d.ClearSelection2(true);
    if(pick=="point"){foreach(var k in keep)if(!d.Extension.SelectByID2("","SURFACEBODY",k[0]/1000,k[1]/1000,k[2]/1000,true,mark,null,0))throw new Exception("nothing selectable at "+string.Join(",",k));}
    else foreach(var p in pieces.Where(p=>keep.Any(k=>BodyDistMm(p,k)<0.05)!=removePicked)){
     if(pick=="body")Mark(d,p,mark,"piece");
     else if(pick=="face")Mark(d,p.GetFirstFace(),mark,"face of a piece");
     else{var fc=((object[])p.GetFaces()).Cast<IFace2>().First();var bx=(double[])fc.GetBox();var q=new double[]{(bx[0]+bx[3])/2,(bx[1]+bx[4])/2,(bx[2]+bx[5])/2};var cp=(double[])fc.GetClosestPointOn(q[0],q[1],q[2]);
      if(!d.Extension.SelectByID2("","FACE",cp[0],cp[1],cp[2],true,mark,null,0))throw new Exception("nothing selectable on the piece");}}
    var f=fm.PostTrimSurface(Flag(a,"knit",true)) as IFeature;
    if(f!=null){tried.Add(tag+": ok ("+pieces.Count+" pieces)");d.EditRebuild3();
     // the trim can report success and leave a target whole (seen with a closed cylinder in a mutual trim): say so
     foreach(var bt in before)foreach(var nb in BodiesOf(d,1))if(nb.Name==bt.name&&Math.Abs(((object[])nb.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea())*1e6-bt.area)<0.01)tried.Add("WARNING: "+bt.name+" was not trimmed (same area "+Math.Round(bt.area,2)+" mm2)");
     return f;}
    tried.Add(tag+": PostTrimSurface null ("+pieces.Count+" pieces)");
   }catch(Exception ex){if(ex.Message.StartsWith("keep point"))throw;tried.Add(tag+": "+ex.Message);}
  }
  return null;
 }
}
