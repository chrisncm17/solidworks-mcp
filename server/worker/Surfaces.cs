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
  var hits=new List<IFace2>();
  foreach(var b in BodiesOf(d,0).Concat(BodiesOf(d,1)))foreach(IFace2 f in (object[])b.GetFaces()??new object[0])if(FaceDistMm(f,pmm)<0.05)hits.Add(f);
  if(hits.Count==0)throw new Exception("No face passes through "+what+" ["+string.Join(", ",pmm)+"] (0.05 mm)");
  // v3.25 GetClosestPointOn can ignore a face's trim (a ring after sw_split_line "passes through" the point in its hole):
  // when several faces pass, the one whose display mesh is nearest to the point wins
  return hits.Count==1?hits[0]:hits.OrderBy(f=>TessDistMm(f,pmm)).First();
 }
 static double TessDistMm(IFace2 f,double[] pmm){
  var t=f.GetTessTriangles(true) as float[];if(t==null||t.Length<9)return double.MaxValue;
  double best=double.MaxValue,px=pmm[0]/1000,py=pmm[1]/1000,pz=pmm[2]/1000;
  for(int i=0;i+8<t.Length;i+=9)best=Math.Min(best,PointTriDist(px,py,pz,t[i],t[i+1],t[i+2],t[i+3],t[i+4],t[i+5],t[i+6],t[i+7],t[i+8]));
  return best*1000;
 }
 // distance from p to triangle abc (closest point by Voronoi regions, Ericson, Real-Time Collision Detection 5.1.5)
 static double PointTriDist(double px,double py,double pz,double ax,double ay,double az,double bx,double by,double bz,double cx,double cy,double cz){
  double abx=bx-ax,aby=by-ay,abz=bz-az,acx=cx-ax,acy=cy-ay,acz=cz-az,apx=px-ax,apy=py-ay,apz=pz-az;
  double d1=abx*apx+aby*apy+abz*apz,d2=acx*apx+acy*apy+acz*apz;double qx,qy,qz;
  if(d1<=0&&d2<=0){qx=ax;qy=ay;qz=az;}
  else{double bpx=px-bx,bpy=py-by,bpz=pz-bz,d3=abx*bpx+aby*bpy+abz*bpz,d4=acx*bpx+acy*bpy+acz*bpz;
   if(d3>=0&&d4<=d3){qx=bx;qy=by;qz=bz;}
   else{double vc=d1*d4-d3*d2;
    if(vc<=0&&d1>=0&&d3<=0){double v=d1/(d1-d3);qx=ax+v*abx;qy=ay+v*aby;qz=az+v*abz;}
    else{double cpx=px-cx,cpy=py-cy,cpz=pz-cz,d5=abx*cpx+aby*cpy+abz*cpz,d6=acx*cpx+acy*cpy+acz*cpz;
     if(d6>=0&&d5<=d6){qx=cx;qy=cy;qz=cz;}
     else{double vb=d5*d2-d1*d6;
      if(vb<=0&&d2>=0&&d6<=0){double w=d2/(d2-d6);qx=ax+w*acx;qy=ay+w*acy;qz=az+w*acz;}
      else{double va=d3*d6-d5*d4;
       if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){double w=(d4-d3)/((d4-d3)+(d5-d6));qx=bx+w*(cx-bx);qy=by+w*(cy-by);qz=bz+w*(cz-bz);}
       else{double den=1/(va+vb+vc),v=vb*den,w=vc*den;qx=ax+abx*v+acx*w;qy=ay+aby*v+acy*w;qz=az+abz*v+acz*w;}}}}}}
  return Math.Sqrt((px-qx)*(px-qx)+(py-qy)*(py-qy)+(pz-qz)*(pz-qz));
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
  if(act=="loft_check"){var lg=GuideSpecs(d,a);result=LoftCheck(d,Items(a["profiles"]).Select(o=>SketchFeature(d,Convert.ToString(o))).ToList(),lg);return true;}
  // v3.26 hide / show surface bodies (helper surfaces such as the tools of a split line): the same as Ocultar in the tree, saved
  // with the part. show also finds hidden bodies.
  if(act=="hide"||act=="show"){
   var bp=Pts(a,"body_points_mm");if(bp.Count==0)throw new Exception(act+" needs body_points_mm (a point on each surface body)");
   var all=((object[])((IPartDoc)d).GetBodies2(1,false)??new object[0]).Cast<IBody2>().ToList();
   var hit=bp.Select(p=>{var h=all.Select(b=>new{b,dd=BodyDistMm(b,p)}).OrderBy(x=>x.dd).FirstOrDefault();if(h==null||h.dd>0.05)throw new Exception("No surface body passes through body_points_mm ["+string.Join(", ",p)+"]");return h.b;}).GroupBy(b=>b.Name).Select(g=>g.First()).ToList();
   foreach(var b in hit)b.HideBody(act=="hide");
   d.SetSaveFlag();d.GraphicsRedraw2();
   result=new{action=act,bodies=hit.Select(b=>b.Name).ToArray(),visible_surface_bodies=BodiesOf(d,1).Length,note="Unsaved until sw_save."};return true;}
  var had=FeatureNames(d);int s0=BodiesOf(d,0).Length,h0=BodiesOf(d,1).Length;double v0=s0>0?PartVolumeMm3(d):0;
  var fm=d.FeatureManager;var tried=new List<string>();object made=null;List<IFeature> loftProfiles=null,loftGuides=null;
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
     // v3.24 guides first: a guide made from segments of another sketch opens and closes a sketch, which clears the selection
     loftGuides=GuideFeatures(d,a,tried);loftProfiles=pr.Select(n=>sketch(n)).ToList();d.ClearSelection2(true);
     foreach(var n in loftProfiles)if(!n.Select2(true,1))throw new Exception("Cannot select profile "+n.Name);
     foreach(var g in loftGuides)if(!g.Select2(true,2))throw new Exception("Cannot select guide "+g.Name);
     // v3.21 start/end tangency normal to the profile: two lofts that share a profile with "normal" there meet without a crease
     Func<string,int> tang=k=>{string v=a.ContainsKey(k)?Str(a,k):"none";if(v=="none")return (int)swTangencyType_e.swTangencyNone;if(v=="normal")return (int)swTangencyType_e.swTangencyNormalToProfile;throw new Exception(k+": none or normal");};
     d.InsertLoftRefSurface2(Flag(a,"closed"),false,false,1.0,(short)tang("start_tangency"),(short)tang("end_tangency"));break;}
    case "sweep":{
     var sg=GuideFeatures(d,a,tried);d.ClearSelection2(true);
     if(!sketch(Str(a,"profile")).Select2(true,1))throw new Exception("Cannot select the profile sketch");
     if(!Feature(d,Str(a,"path")).Select2(true,4))throw new Exception("Cannot select the path");
     foreach(var g in sg)if(!g.Select2(true,2))throw new Exception("Cannot select guide "+g.Name);
     made=fm.InsertSweepSurface3(false,0,false,false,0,0,0,true,true,0,true,false,0,0);break;}
    case "offset":{
     var fp=Pts(a,"face_points_mm");if(fp.Count==0)throw new Exception("offset needs face_points_mm");foreach(var p in fp)Mark(d,AnyFaceAt(d,p,"face_points_mm"),0,"face");
     d.InsertOffsetSurface(a.ContainsKey("distance_mm")?Num(a,"distance_mm")/1000:0,Flag(a,"reverse"));break;}
    case "ruled":{
     var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("ruled needs edge_points_mm");foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),0,"edge");
     string ty=a.ContainsKey("ruled_type")?Str(a,"ruled_type"):"normal";int t=ty=="tangent"?1:ty=="normal"?2:ty=="tapered"?3:ty=="perpendicular"?4:ty=="sweep"?5:-1;if(t<0)throw new Exception("ruled_type: tangent, normal, tapered, perpendicular or sweep");
     made=RuledFromEdges(d,ep,t,Num(a,"distance_mm")/1000,Flag(a,"reverse"),(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):0)*Math.PI/180,had,tried,"ruled "+ty);
     if(made==null&&t==2)made=RuledNormalByWall(d,ep,Num(a,"distance_mm")/1000,Flag(a,"reverse"),had,tried);
     if(made==null&&t==2)made=RuledNormalBand(d,ep,Num(a,"distance_mm"),Flag(a,"reverse"),had,tried);
     if(made==null)throw new Exception("Ruled surface failed (tried: "+string.Join("; ",tried)+"): the edges must be edges of a face or surface; tapered and perpendicular need a direction");break;}
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
     // v3.22 mark 1 first: it is the one that worked every time (Agarradera); mark 0 stays as the fallback
     foreach(int mk in new[]{1,0})foreach(string sel in new[]{"body","face"}){
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
     // v3.22 deleting every face of a surface body fails without a word: delete that body instead
     var picked=new List<IFace2>();foreach(var p in fp)picked.Add(AnyFaceAt(d,p,"face_points_mm"));
     Func<object,object,bool> same=(x,y)=>sw.IsSame(x,y)==(int)swObjectEquality.swObjectSame;
     var hit=new List<IBody2>();foreach(var x in picked){var bb=(IBody2)x.GetBody();if(bb!=null&&!hit.Any(q=>same(q,bb)))hit.Add(bb);}
     Func<IBody2,string> bname=bb=>{string n0=null;try{n0=bb.Name;}catch{}return string.IsNullOrEmpty(n0)?"surface body "+(hit.FindIndex(q=>same(q,bb))+1):n0;};
     var whole=hit.Where(bb=>{var all=(object[])bb.GetFaces()??new object[0];return all.Length>0&&all.Cast<IFace2>().All(f=>picked.Any(q=>same(q,f)));}).ToList();
     if(whole.Count>0){if(o!=0)throw new Exception("face_points_mm cover every face of "+string.Join(", ",whole.Select(bname))+": patch/fill needs a face left; use mode delete to remove the whole body");
      if(whole.Count!=hit.Count)throw new Exception("Some points take every face of "+string.Join(", ",whole.Select(bname))+" and others only part of a body: do them in two calls");
      d.ClearSelection2(true);foreach(var bb in whole)Mark(d,bb,0,bname(bb));made=fm.InsertDeleteBody2(false);tried.Add("every face of "+string.Join(", ",whole.Select(bname))+": body deleted (Delete/Keep Body)");break;}
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
    case "trim":{made=Trim(d,a,tried);if(made==null)throw new Exception("Surface trim failed (tried: "+string.Join("; ",tried)+"): "+Why("trim"));break;}
    case "join":{made=JoinSolids(d,a,had,tried);break;}
    case "boundary":{made=SurfBoundary(d,a,had,tried);if(made==null)throw new Exception("Boundary surface failed (tried: "+string.Join("; ",tried)+"): "+Why("boundary"));break;}
    case "flatten":{made=SurfFlatten(d,a,had,tried);if(made==null)throw new Exception("Flatten failed (tried: "+string.Join("; ",tried)+"): "+Why("flatten"));break;}
    case "radiate":{made=SurfRadiate(d,a,had,tried);if(made==null)throw new Exception("Radiate failed (tried: "+string.Join("; ",tried)+"): "+Why("radiate"));break;}
    case "mid_surface":{made=SurfMid(d,a,had,tried);if(made==null)throw new Exception("Mid surface failed (tried: "+string.Join("; ",tried)+"): "+Why("mid_surface"));break;}
    case "freeform":{made=SurfFreeform(d,a,had,tried);if(made==null)throw new Exception("Freeform failed (tried: "+string.Join("; ",tried)+"): "+Why("freeform"));break;}
    case "curve_points":{made=CurvePoints(d,a,had,tried);if(made==null)throw new Exception("Curve through points failed (tried: "+string.Join("; ",tried)+"): "+Why("curve_points"));break;}
    case "curve_composite":{made=CurveComposite(d,a,had,tried);if(made==null)throw new Exception("Composite curve failed (tried: "+string.Join("; ",tried)+"): "+Why("curve_composite"));break;}
    case "curve_projected":{made=CurveProjected(d,a,had,tried);if(made==null)throw new Exception("Projected curve failed (tried: "+string.Join("; ",tried)+"): "+Why("curve_projected"));break;}
    default:throw new Exception("Unknown surface action "+act);
   }
  }finally{d.ClearSelection2(true);}
  var nf=made as IFeature??NewFeature(d,had);
  if(nf==null){string chk="";if(loftGuides!=null&&loftGuides.Count>0)try{chk=" | loft_check: "+Json.Serialize(LoftCheck(d,loftProfiles,loftGuides));}catch(Exception ex){chk=" | loft_check failed: "+ex.Message;}
   throw new Exception("Surface "+act+" failed"+(tried.Count>0?" (tried: "+string.Join("; ",tried)+")":"")+": "+Why(act)+chk);}
  d.EditRebuild3();
  // the TryToFormSolid argument can come back ignored: turn it on in the feature definition when the knit is closed
  if(act=="knit"&&Flag(a,"form_solid")&&BodiesOf(d,0).Length<=s0)try{
   var kd=nf.GetDefinition() as ISurfaceKnitFeatureData;
   if(kd!=null){tried.Add("form solid flag in the feature: "+kd.UseTryToFormSolid);kd.UseTryToFormSolid=true;bool ok=nf.ModifyDefinition(kd,d,null);d.EditRebuild3();tried.Add("form solid by ModifyDefinition: "+(ok&&BodiesOf(d,0).Length>s0?"ok":"no"));}
  }catch(Exception ex){tried.Add("ModifyDefinition: "+ex.Message);}
  int s1=BodiesOf(d,0).Length,h1=BodiesOf(d,1).Length;double v1=s1>0?PartVolumeMm3(d):0;
  result=new{action=act,feature=nf.Name,type=nf.GetTypeName2(),new_features=FeatureNames(d).Except(had).ToArray(),solid_bodies_before=s0,solid_bodies_after=s1,surface_bodies_before=h0,surface_bodies_after=h1,
   volume_before_mm3=v0,volume_after_mm3=v1,curve=act.StartsWith("curve_")?CurveInfo(nf):null,formed_solid=act=="knit"&&Flag(a,"form_solid")?(object)(s1>s0):null,tried=tried.Count>0?tried.ToArray():null,surfaces=SurfaceReport(d),inspection=Checked(d)};
  if(act=="join"&&s1>=s0)throw new Exception("join made "+nf.Name+" but the solids did not merge ("+s0+" before, "+s1+" after): face_point_mm must be inside the area where both bodies touch");
  if(act=="knit"&&Flag(a,"form_solid")&&s1<=s0)throw new Exception("Knit made "+nf.Name+" but no solid: the surfaces are not closed. "+SurfJson(SurfaceReport(d))+" tried: "+string.Join("; ",tried));
  return true;
 }
 // v3.21 join (surfaces-only parts cannot use Combine): two solids that touch on a plane become one. A small square (size_mm,
 // default 1) is sketched on the contact face around face_point_mm, made a planar surface and thickened both ways by
 // thickness_mm (default 0.2) with merge on; inside both bodies it adds no volume and fuses them.
 static object JoinSolids(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  if(!a.ContainsKey("face_point_mm"))throw new Exception("join needs face_point_mm: a point on the plane where the two solids touch, inside the contact area");
  var p=Xyz(a["face_point_mm"],"face_point_mm");
  var touching=BodiesOf(d,0).Where(b=>BodyDistMm(b,p)<0.01).ToList();
  if(touching.Count<2)throw new Exception("face_point_mm touches "+touching.Count+" solid body ("+string.Join(", ",touching.Select(b=>b.Name))+"); it must lie where two solids meet");
  double h=(a.ContainsKey("size_mm")?Num(a,"size_mm"):1)/2000,t=(a.ContainsKey("thickness_mm")?Num(a,"thickness_mm"):0.2)/1000;
  if(h<=0||t<=0)throw new Exception("size_mm and thickness_mm must be > 0");
  var face=PlanarFaceAt(d,p.Select(v=>v/1000).ToArray());
  d.ClearSelection2(true);if(!((IEntity)face).Select4(false,null))throw new Exception("Cannot select the contact face");
  var sm=d.SketchManager;bool db=sm.AddToDB;IFeature skf=null;
  try{
   sm.InsertSketch(true);var sk=(ISketch)sm.ActiveSketch;if(sk==null)throw new Exception("Could not open a sketch on the contact face");skf=(IFeature)sk;
   var mu=(IMathUtility)sw.GetMathUtility();var mp=(MathPoint)mu.CreatePoint(p.Select(v=>v/1000).ToArray());
   var q=(double[])((MathPoint)mp.MultiplyTransform((MathTransform)sk.ModelToSketchTransform)).ArrayData;
   // four lines (CreateCenterRectangle returns null on a face sketch through the API)
   sm.AddToDB=true;var c=new[]{new[]{q[0]-h,q[1]-h},new[]{q[0]+h,q[1]-h},new[]{q[0]+h,q[1]+h},new[]{q[0]-h,q[1]+h}};
   for(int i=0;i<4;i++){var e=c[(i+1)%4];if(sm.CreateLine(c[i][0],c[i][1],0,e[0],e[1],0)==null)throw new Exception("The square was not drawn (side "+i+")");}
  }finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
  tried.Add("sketch "+skf.Name);
  if(!skf.Select2(false,0))throw new Exception("Cannot select "+skf.Name);
  d.InsertPlanarRefSurface();d.ClearSelection2(true);
  var sheet=BodiesOf(d,1).Select(b=>new{b,dist=BodyDistMm(b,p)}).OrderBy(x=>x.dist).FirstOrDefault();
  if(sheet==null||sheet.dist>0.01)throw new Exception("The planar surface of the join was not made");
  tried.Add("planar "+sheet.b.Name);
  object made=null;
  foreach(int mk in new[]{1,0}){
   d.ClearSelection2(true);Mark(d,sheet.b,mk,"surface body "+sheet.b.Name);
   made=d.FeatureManager.FeatureBossThicken(t,2,0,false,true,true,true);tried.Add("thicken body mark "+mk+": "+(made!=null?"ok":"null"));if(made!=null)break;}
  d.ClearSelection2(true);return made;
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
   case "join":return "face_point_mm must be inside the area where the two solids touch, on a flat face";
   case "boundary":return "the curves must be given in order, not cross each other, and guides must touch every profile";
   case "radiate":return "the edges must lie on a plane parallel to tool_plane_index (or be tangent to it) and form one chain";
   case "mid_surface":return "the faces must face each other in pairs at a constant distance (a plate or rib)";
   case "freeform":return "the face must have four sides (or use a planar or untrimmed face); offsets move points of the control curves";
   case "flatten":return "the faces must be one connected patch that can be developed (tears=true lets a doubly curved one open)";
   case "curve_points":return "give at least 2 different points in order";
   case "curve_composite":return "the curves and edges must touch end to end in one chain, with no branches";
   case "curve_projected":return "the sketch must lie over the faces along its normal (try reverse), or the two sketches must be on planes that are not parallel and overlap when extruded";
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
  // v3.22 the same plane numbering as every other tool (counting planes in AllFeatures gave Front for index 2)
  IFeature toolPlane=a.ContainsKey("tool_plane_index")?PlaneByIndex(d,Convert.ToInt32(a["tool_plane_index"])):null;
  if(!mutual&&toolBodies.Count+(toolSketch!=null?1:0)+(toolPlane!=null?1:0)==0)throw new Exception("trim needs a tool (tool_points_mm, tool_sketch or tool_plane_index) or mutual=true");
  var targets=Pts(a,"target_points_mm").Select(p=>SheetAt(d,p,"target_points_mm")).Distinct().ToList();
  // mutual: the selected surfaces are tools and targets at once; standard: without target_points_mm every other surface is a target
  if(mutual)targets=toolBodies.Concat(targets).GroupBy(b=>b.Name).Select(g=>g.First()).ToList();
  // v3.22 mutual with only keep points (no tool or target points) found no surfaces ("no pieces"): use the surfaces that hold the
  // keep points, or every surface when they are fewer than two
  if(mutual&&targets.Count<2){var all=BodiesOf(d,1).ToList();var held=all.Where(b=>keep.Any(k=>BodyDistMm(b,k)<0.05)).ToList();
   targets=targets.Concat(held.Count>=2?held:all).GroupBy(b=>b.Name).Select(g=>g.First()).ToList();
   if(targets.Count<2)throw new Exception("a mutual trim needs two or more surface bodies");}
  else if(targets.Count==0)targets=BodiesOf(d,1).Where(b=>!toolBodies.Any(t=>t.Name==b.Name)).ToList();
  // v3.22 a plane as the tool: a temporary planar surface on it does the trim (a plane alone gives no pieces)
  string tempTool=null;IFeature planeTool=null;
  if(toolPlane!=null&&!mutual){planeTool=toolPlane;var tb=PlaneAsSurface(d,toolPlane,targets,tried);tempTool=tb.Name;toolPlane=null;
   // the new feature leaves the body pointers taken before it stale (GetPreTrimmedBodies gave no pieces): take them again by name
   var tn=new HashSet<string>(targets.Select(t=>t.Name));var tbn=new HashSet<string>(toolBodies.Select(t=>t.Name));tbn.Add(tempTool);
   var now=BodiesOf(d,1).ToList();targets=now.Where(b=>tn.Contains(b.Name)).ToList();toolBodies=now.Where(b=>tbn.Contains(b.Name)).ToList();}
  var tools=mutual?targets:toolBodies;
  var tNames=targets.Select(t=>t.Name).ToList();
  // SolidWorks own example (Create Trimmed Surface Feature): tool selected, PreTrimSurface(mutual, TRUE, false, false), then each
  // piece picked by SelectByID2("", "SURFACEBODY", a point on it, append) and PostTrimSurface(knit)
  // the variants run once, and again with a plane turned into a sketch line when its temporary surface gave no trim
  Func<object> runVariants=()=>{
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
     if(tempTool!=null){DropTempSurface(d,tempTool,tried);d.EditRebuild3();}
     // the trim can report success and leave a target whole (seen with a closed cylinder in a mutual trim): say so
     var whole=new List<string>();foreach(var bt in before)foreach(var nb in BodiesOf(d,1))if(nb.Name==bt.name&&Math.Abs(((object[])nb.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea())*1e6-bt.area)<0.01)whole.Add(bt.name+" (same area "+Math.Round(bt.area,2)+" mm2)");
     // v3.22 a mutual trim that leaves a closed tube whole is undone and made with split lines + delete face
     if(whole.Count>0&&mutual){tried.Add("the trim left "+string.Join(", ",whole)+" whole: undone, split line + delete face instead");DropFeature(d,f);d.EditRebuild3();return null;}
     foreach(var x in whole)tried.Add("WARNING: "+x+" was not trimmed");
     return f;}
    tried.Add(tag+": PostTrimSurface null ("+pieces.Count+" pieces)");
   }catch(Exception ex){if(ex.Message.StartsWith("keep point"))throw;tried.Add(tag+": "+ex.Message);}
  }
  return null;};
  var won=runVariants();if(won!=null)return won;
  // v3.22 a plane across a closed tube: the temporary surface gives two pieces but PostTrimSurface null, while a sketch line on a
  // default plane perpendicular to it (projected along that plane normal it sweeps exactly the tool plane) trims it
  if(tempTool!=null&&planeTool!=null){
   var tn=new HashSet<string>(targets.Select(t=>t.Name));var tbn=new HashSet<string>(toolBodies.Select(t=>t.Name));tbn.Remove(tempTool);
   RemoveTempSurface(d,tempTool,tried);d.EditRebuild3();tempTool=null;
   var line=PlaneAsSketchLine(d,planeTool,targets,tried);
   if(line!=null){var now=BodiesOf(d,1).ToList();targets=now.Where(b=>tn.Contains(b.Name)).ToList();toolBodies=now.Where(b=>tbn.Contains(b.Name)).ToList();
    tools=toolBodies;toolSketch=line;won=runVariants();if(won!=null)return won;}
  }
  // v3.22 a planar tool SURFACE across a closed tube fails the same way; when it covers the targets where its plane cuts them,
  // the whole plane cuts like the surface, so a sketch line for that plane does the trim (the tool surface stays, as in any trim)
  if(!mutual&&planeTool==null&&toolSketch==null&&toolBodies.Count==1){var pl=PlanarFaceOf(toolBodies[0]);
   if(pl!=null&&CoversTargets(toolBodies[0],pl,targets)){
    var tn=new HashSet<string>(targets.Select(t=>t.Name));string tname=toolBodies[0].Name;
    var line=PlaneAsSketchLine(d,pl[0],pl[1],"planar tool surface "+tname,targets,tried);
    if(line!=null){targets=BodiesOf(d,1).Where(b=>tn.Contains(b.Name)).ToList();toolBodies=new List<IBody2>();tools=toolBodies;toolSketch=line;won=runVariants();if(won!=null)return won;}
   }else if(pl!=null)tried.Add("the planar tool surface does not cover the targets where its plane cuts them; make it bigger to use its plane");
  }
  // v3.22 a closed tube: split line + delete face
  // an undone trim leaves the body pointers stale: take the targets again by name
  {var nowT=BodiesOf(d,1).Where(x=>tNames.Contains(x.Name)).ToList();if(nowT.Count>0)targets=nowT;if(mutual)tools=targets;}
  object res=null;try{res=TrimBySplit(d,a,targets,tools,toolSketch,toolPlane,keep,tried);}catch(Exception ex){tried.Add("split line + delete face: "+ex.Message);}
  if(tempTool!=null){DropTempSurface(d,tempTool,tried);d.EditRebuild3();}
  return res;
 }
}
