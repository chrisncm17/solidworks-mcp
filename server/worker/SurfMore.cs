using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 more of the Surfaces tab: Boundary Surface (Superficie limite) and Flatten (Aplanar), and the plane of a planar tool surface.
partial class Worker {
 // the plane of a one-face planar surface body: normal and a point, in meters; null when it is not one flat face
 static double[][] PlanarFaceOf(IBody2 b){
  var fs=((object[])b.GetFaces()??new object[0]).Cast<IFace2>().ToList();if(fs.Count!=1)return null;
  var s=(ISurface)fs[0].GetSurface();if(s==null||!s.IsPlane())return null;var p=(double[])s.PlaneParams;
  return new[]{new[]{p[0],p[1],p[2]},new[]{p[3],p[4],p[5]}};
 }
 // the tool face covers the targets where its plane cuts them: every corner of their box, put on the plane, lies on the face
 static bool CoversTargets(IBody2 tool,double[][] pl,List<IBody2> targets){
  var f=((object[])tool.GetFaces()).Cast<IFace2>().First();var n=pl[0];var o=pl[1];
  foreach(var t in targets){var b=(double[])t.GetBodyBox();
   for(int i=0;i<8;i++){var q=new[]{(i&1)==0?b[0]:b[3],(i&2)==0?b[1]:b[4],(i&4)==0?b[2]:b[5]};
    double s=(q[0]-o[0])*n[0]+(q[1]-o[1])*n[1]+(q[2]-o[2])*n[2];var r=new[]{q[0]-s*n[0],q[1]-s*n[1],q[2]-s*n[2]};
    if(DistTo(f.GetClosestPointOn(r[0],r[1],r[2]),r)>1e-5)return false;}}
  return true;
 }

 // Boundary Surface: curves in direction 1 (profiles: sketches, open or closed, in order) and optional direction 2 (guides), or
 // edges of existing surfaces (edge_points_mm, each point one curve of direction 1). InsertNetBlend2 Type 0 = surface. How the
 // curves must be selected is not settled by the docs, so the variants are tried and the first that makes a new surface body stays.
 static object SurfBoundary(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  var fm=d.FeatureManager;var sm=(ISelectionMgr)d.SelectionManager;
  var prof=a.ContainsKey("profiles")?Items(a["profiles"]).Select(Convert.ToString).ToList():new List<string>();
  var guides=a.ContainsKey("guides")?Items(a["guides"]).Select(Convert.ToString).ToList():new List<string>();
  var edges=Pts(a,"edge_points_mm").Select(p=>AnyEdgeAt(d,p,"edge_points_mm")).ToList();
  int n1=prof.Count+edges.Count;if(n1<2)throw new Exception("boundary needs 2 or more curves in direction 1: profiles (sketches) or edge_points_mm (edges)");
  if(prof.Count>0&&edges.Count>0)throw new Exception("boundary: give profiles or edge_points_mm, not both");
  int h0=BodiesOf(d,1).Length;
  int s0=BodiesOf(d,0).Length;
  // InsertNetBlend Type 2 = surface (measured: Type 0 made a solid boss from the same circles)
  foreach(short ty in new short[]{2})foreach(string how in new[]{"contour","sketch"})foreach(bool indexed in new[]{true,false})foreach(bool v2 in new[]{true,false}){
   if(edges.Count>0&&how=="contour")continue;
   string tag="type "+ty+", "+(edges.Count>0?"edges":how)+(indexed?" marks 8192*i":" marks 1/2")+(v2?" NetBlend2":" NetBlend");
   try{
    d.ClearSelection2(true);
    Action<object,int,string> sel=(o,mark,what)=>{var sd=(SelectData)sm.CreateSelectData();sd.Mark=mark;bool ok;
     if(o is IEdge)ok=((IEntity)o).Select4(true,sd);
     else{var s=SketchFeature(d,(string)o);
      if(how=="contour"){var ct=((object[])((ISketch)s.GetSpecificFeature2()).GetSketchContours()??new object[0]).Cast<ISketchContour>().FirstOrDefault();ok=ct!=null&&ct.Select2(true,sd);
       if(!ok){var ch=((ISketch)s.GetSpecificFeature2()).GetSketchSegments() as object[];ok=ch!=null&&ch.Length>0&&ch.Cast<ISketchSegment>().All(g=>g.Select4(true,sd));}}
      else ok=d.Extension.SelectByID2(s.Name,"SKETCH",0,0,0,true,mark,null,0);}
     if(!ok)throw new Exception("cannot select "+what);};
    int i=0;foreach(var p in prof){sel(p,indexed?1+8192*(i+1):1,"profile "+p);i++;}
    foreach(var e in edges){sel(e,indexed?1+8192*(i+1):1,"edge "+(i+1));i++;}
    for(int g=0;g<guides.Count;g++)sel(guides[g],indexed?2+8192*(g+1):2,"guide "+guides[g]);
    for(short k=0;k<n1;k++)fm.SetNetBlendCurveData(0,k,(short)swBoundaryBossTangencyType_e.swBoundaryBossTangency_None,0,1,true);
    for(short k=0;k<guides.Count;k++)fm.SetNetBlendCurveData(1,k,(short)swBoundaryBossTangencyType_e.swBoundaryBossTangency_None,0,1,true);
    fm.SetNetBlendDirectionData(0,(short)swBoundaryBossCurveInfluenceType_e.swBoundaryBossCurve_GlobalInfluence,0,false,false);
    if(guides.Count>0)fm.SetNetBlendDirectionData(1,(short)swBoundaryBossCurveInfluenceType_e.swBoundaryBossCurve_GlobalInfluence,0,false,false);
    var f=(v2?fm.InsertNetBlend2(ty,(short)n1,(short)guides.Count,false,0.0001,false,false,true,true,false,-1,-1,false,-1,false,false,-1,false,-1,false,false)
     :fm.InsertNetBlend(ty,(short)n1,(short)guides.Count,false,0.0001,false,false,true,true,false,-1,-1,false,-1,false,false,-1,false,-1,false)) as IFeature;
    d.ClearSelection2(true);
    f=f??NewFeature(d,had);
    if(f!=null&&BodiesOf(d,1).Length>h0){tried.Add(tag+": ok");return f;}
    if(f!=null){bool w;int ec=f.GetErrorCode2(out w);tried.Add(tag+": "+f.Name+" ["+f.GetTypeName2()+", error "+ec+", solids "+s0+"->"+BodiesOf(d,0).Length+"] made no surface body, deleted");d.ClearSelection2(true);if(f.Select2(false,0))d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}
    else tried.Add(tag+": null");
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }

 // Flatten (Aplanar): faces (face_points_mm) laid flat from a vertex or point on an edge that stays put (up_to_point_mm, optional);
 // tears=true lets it open gaps where the surface cannot stretch flat. Variants of the selection marks are tried.
 static object SurfFlatten(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  var fm=d.FeatureManager;
  var fp=Pts(a,"face_points_mm");if(fp.Count==0)throw new Exception("flatten needs face_points_mm (the faces to lay flat)");
  var faces=fp.Select(p=>AnyFaceAt(d,p,"face_points_mm")).ToList();
  object anchor=null;
  if(a.ContainsKey("up_to_point_mm")){var p=Xyz(a["up_to_point_mm"],"up_to_point_mm");var q=p.Select(v=>v/1000).ToArray();
   IVertex best=null;double bd=1e9;
   foreach(var f in faces)foreach(IEdge e in (object[])f.GetEdges()??new object[0])foreach(var v in new[]{e.GetStartVertex(),e.GetEndVertex()}.OfType<IVertex>()){double dd=DistTo(v.GetPoint(),q);if(dd<bd){bd=dd;best=v;}}
   if(best!=null&&bd<5e-4)anchor=best;else anchor=AnyEdgeAt(d,p,"up_to_point_mm");}
  else{var e0=((object[])faces[0].GetEdges()??new object[0]).Cast<IEdge>().FirstOrDefault();var v0=e0!=null?e0.GetStartVertex() as IVertex:null;anchor=(object)v0??e0;}
  if(anchor==null)throw new Exception("flatten needs a vertex or edge to hold (up_to_point_mm)");
  int h0=BodiesOf(d,1).Length;
  foreach(int fmk in new[]{1,0})foreach(int amk in new[]{2,1,0}){
   string tag="faces mark "+fmk+", "+(anchor is IVertex?"vertex":"edge")+" mark "+amk;
   try{
    d.ClearSelection2(true);foreach(var f in faces)Mark(d,f,fmk,"face");Mark(d,anchor,amk,"vertex to hold");
    var r=fm.InsertFlattenSurface2(a.ContainsKey("accuracy")?Convert.ToInt32(a["accuracy"]):5,Flag(a,"tears")) as IFeature;d.ClearSelection2(true);
    r=r??NewFeature(d,had);
    if(r!=null&&BodiesOf(d,1).Length>h0){tried.Add(tag+": ok");return r;}
    if(r!=null){tried.Add(tag+": "+r.Name+" made no surface body, deleted");if(r.Select2(false,0))d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}
    else tried.Add(tag+": null");
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }
}
