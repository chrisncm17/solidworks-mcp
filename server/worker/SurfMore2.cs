using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 the rest of the Surfaces tab: Radiate (Superficie radiada), Mid Surface (Superficie media) and Freeform (Forma libre).
// The selection marks are not settled by the docs, so variants are tried and the first that changes the model the right way stays.
partial class Worker {
 // v3.22 Ruled surface from edges: measured, the edges need mark 4 (mark 0, used before, always gave error 1); other marks and both API versions are
 // tried; the first that makes a feature stays
 static IFeature RuledFromEdges(IModelDoc2 d,List<double[]> ep,int ty,double distM,bool rev,double angRad,HashSet<string> had,List<string> tried,string label){
  var fm=d.FeatureManager;Func<double> area=()=>BodiesOf(d,1).Sum(b=>((object[])b.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea()))*1e6;double ar0=area();
  foreach(bool v2 in new[]{true,false})foreach(bool pull in new[]{false,true})foreach(bool con in v2?new[]{false,true}:new[]{false})foreach(int mk in v2?new[]{4,0,1,2,8,16}:new[]{4}){string tag=label+(v2?"":" (v1)")+(pull?" pull flipped":"")+(con?" connected":"")+", edges mark "+mk;
   if(ty==2&&(pull||con||!v2||mk!=4))continue;// normal: every variant measured error 1, one try then the wall way
   try{d.ClearSelection2(true);foreach(var q in ep)Mark(d,AnyEdgeAt(d,q,"edge_points_mm"),mk,"edge");
    var f=(v2?fm.InsertRuledSurfaceFromEdge2(ty,distM,pull,rev,false,angRad,false,0,0,0,con):fm.InsertRuledSurfaceFromEdge(ty,distM,pull,rev,false,angRad,false,0,0,0)) as IFeature;
    d.ClearSelection2(true);f=f??NewFeature(d,had);
    double ar1=area();if(f!=null&&Math.Abs(ar1-ar0)>1e-3){tried.Add(tag+": "+f.Name+" (+"+Math.Round(ar1-ar0,2)+" mm2)");return f;}
    if(f!=null){bool fw;int fe=f.GetErrorCode2(out fw);tried.Add(tag+": "+f.Name+" made no surface"+(fe!=0?" (error "+fe+")":"")+", deleted");DropFeature(d,f);}else tried.Add(tag+": nothing");
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }
 // v3.22 ruled "normal" leaves error 1 for every mark (measured). For an edge of a flat face the normal ruled surface is a
 // wall along the face normal: convert the edges on a sketch on that face and extrude it as a surface distance_mm
 static IFeature RuledNormalByWall(IModelDoc2 d,List<double[]> ep,double distM,bool rev,HashSet<string> had,List<string> tried){
  var e=AnyEdgeAt(d,ep[0],"edge_points_mm");
  var face=((object[])e.GetTwoAdjacentFaces2()??new object[0]).OfType<IFace2>().FirstOrDefault(x=>{var s=(ISurface)x.GetSurface();return s!=null&&s.IsPlane();});
  if(face==null){tried.Add("wall way: the edge has no flat face (for a band around a curved face use radiate)");return null;}
  var sm=d.SketchManager;IFeature skf=null;bool db=sm.AddToDB;
  try{
   d.ClearSelection2(true);Mark(d,face,0,"face");sm.InsertSketch(true);var sk=(ISketch)sm.ActiveSketch;if(sk==null)throw new Exception("no sketch on the face");skf=(IFeature)sk;
   d.ClearSelection2(true);foreach(var q in ep)Mark(d,AnyEdgeAt(d,q,"edge_points_mm"),0,"edge");
   if(!sm.SketchUseEdge3(false,false))throw new Exception("convert entities refused the edges");
   sm.InsertSketch(true);d.ClearSelection2(true);if(!skf.Select2(false,0))throw new Exception("cannot select "+skf.Name);
   d.FeatureManager.FeatureExtruRefSurface3(true,rev,0,0,(int)swEndConditions_e.swEndCondBlind,0,distM,0,false,false,false,false,0,0,false,false,false,false,false,false,false,false);
   var f=NewFeature(d,had);
   if(f!=null){tried.Add("wall way: "+f.Name+" from "+skf.Name+", along the normal of the flat face");return f;}
   tried.Add("wall way: the extrusion made nothing");
  }catch(Exception ex){tried.Add("wall way: "+ex.Message);}
  finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
  if(skf!=null)DropFeature(d,skf);return null;
 }
 static void DropFeature(IModelDoc2 d,IFeature f){d.ClearSelection2(true);if(f!=null&&f.Select2(false,0))d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}

 // Radiate: edges (edge_points_mm) pushed out distance_mm parallel to a plane (tool_plane_index); tangent_propagate follows tangent edges
 static object SurfRadiate(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  var ep=Pts(a,"edge_points_mm");if(ep.Count==0)throw new Exception("radiate needs edge_points_mm (the edges to radiate)");
  if(!a.ContainsKey("tool_plane_index"))throw new Exception("radiate needs tool_plane_index: the plane the surface grows parallel to");
  if(!a.ContainsKey("distance_mm")||Num(a,"distance_mm")<=0)throw new Exception("radiate needs distance_mm > 0");
  var edges=ep.Select(p=>AnyEdgeAt(d,p,"edge_points_mm")).ToList();var plane=PlaneByIndex(d,Convert.ToInt32(a["tool_plane_index"]));
  int h0=BodiesOf(d,1).Length;
  foreach(bool edgesFirst in new[]{true,false})foreach(bool flip in new[]{Flag(a,"reverse")})foreach(int pm in new[]{1,0,2})foreach(int em in new[]{0,1,4}){
   if(pm==em)continue;string tag=(edgesFirst?"edges first, ":"")+"plane mark "+pm+", edges mark "+em+(flip?", flipped":"");
   try{
    d.ClearSelection2(true);edges=ep.Select(p=>AnyEdgeAt(d,p,"edge_points_mm")).ToList();
    if(edgesFirst)foreach(var e in edges)Mark(d,e,em,"edge");
    if(!plane.Select2(true,pm))throw new Exception("cannot select "+plane.Name);
    if(!edgesFirst)foreach(var e in edges)Mark(d,e,em,"edge");
    d.InsertRadiateSurface(Num(a,"distance_mm")/1000,flip,Flag(a,"tangent_propagate"));d.ClearSelection2(true);
    var f=NewFeature(d,had);
    if(f!=null&&BodiesOf(d,1).Length>h0){tried.Add(tag+": ok");return f;}
    tried.Add(tag+": "+(f==null?"nothing":f.Name+" made no surface body, deleted"));DropFeature(d,f);
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  // v3.22 measured in 2026 SP3.2: InsertRadiateSurface makes nothing for any selection order or mark. A radiate surface is
  // the band that leaves the edges inside a plane parallel to the reference plane, on the outer side of the edge
  var t=(double[])((MathTransform)((IRefPlane)plane.GetSpecificFeature2()).Transform).ArrayData;var n=new[]{t[6],t[7],t[8]};
  var p0=ep[0].Select(v=>v/1000).ToArray();var crv=(ICurve)AnyEdgeAt(d,ep[0],"edge_points_mm").GetCurve();
  var ev=(double[])crv.Evaluate2(crv.ReverseEvaluate(p0[0],p0[1],p0[2]),1);var tg=new[]{ev[3],ev[4],ev[5]};
  var u=new[]{n[1]*tg[2]-n[2]*tg[1],n[2]*tg[0]-n[0]*tg[2],n[0]*tg[1]-n[1]*tg[0]};double ul=Math.Sqrt(u.Sum(x=>x*x));
  if(ul<1e-9){tried.Add("the edge is perpendicular to the plane: nothing to radiate");return null;}
  double half=Num(a,"distance_mm")/2000;var src=BodiesOf(d,1).Concat(BodiesOf(d,0)).ToList();double[] bc={0,0,0};
  if(src.Count>0){double[] lo={1e9,1e9,1e9},hi={-1e9,-1e9,-1e9};foreach(var b0 in src){var bb=(double[])b0.GetBodyBox();for(int i=0;i<3;i++){lo[i]=Math.Min(lo[i],bb[i]);hi[i]=Math.Max(hi[i],bb[i+3]);}}bc=new[]{(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2};}
  Func<double,double[]> side=sg=>new[]{ev[0]+sg*u[0]/ul*half,ev[1]+sg*u[1]/ul*half,ev[2]+sg*u[2]/ul*half};
  Func<double[],double> far=q=>Math.Sqrt(Math.Pow(q[0]-bc[0],2)+Math.Pow(q[1]-bc[1],2)+Math.Pow(q[2]-bc[2],2));
  var want=far(side(1))>=far(side(-1))?side(1):side(-1);if(Flag(a,"reverse"))want=far(side(1))>=far(side(-1))?side(-1):side(1);
  return BandInPlane(d,ep,plane,Num(a,"distance_mm"),want,had,tried);
 }

 // v3.22 the band that leaves the edges (edge points ep) inside a plane parallel to plane, distMm wide, on the side that holds
 // the point want (meters): a plane through the edge, the edges converted and offset, open chains closed with two lines, a
 // planar surface. Used by radiate (the API makes nothing) and by ruled normal on a curved edge (error 1 for every mark)
 static IFeature BandInPlane(IModelDoc2 d,List<double[]> ep,IFeature plane,double distMm,double[] want,HashSet<string> had,List<string> tried){
  var t=(double[])((MathTransform)((IRefPlane)plane.GetSpecificFeature2()).Transform).ArrayData;var n=new[]{t[6],t[7],t[8]};
  var p0=ep[0].Select(v=>v/1000).ToArray();
  var before=new HashSet<string>(BodiesOf(d,1).Select(x=>x.Name));
  Func<IFeature,bool> good=f=>{if(f==null)return false;var nb=BodiesOf(d,1).Where(x=>!before.Contains(x.Name)).ToList();
   return nb.Count>0&&nb.All(x=>{var pl=PlanarFaceOf(x);return pl!=null&&Math.Abs(Math.Abs(pl[0][0]*n[0]+pl[0][1]*n[1]+pl[0][2]*n[2])-1)<1e-6;})
    &&nb.Any(x=>((object[])x.GetFaces()).Cast<IFace2>().Any(fc=>{var cp=(double[])fc.GetClosestPointOn(want[0],want[1],want[2]);return cp!=null&&Math.Sqrt(Math.Pow(cp[0]-want[0],2)+Math.Pow(cp[1]-want[1],2)+Math.Pow(cp[2]-want[2],2))<1e-5;}));};
  // the sketch way (InsertRuledSurfaceFromEdge2 also leaves error 1 on these edges, measured): on a plane parallel to the
  // reference through the edge, convert the edges, offset them distance_mm, close an open chain with two lines and make a
  // planar surface of the band; the side whose band holds the outer point stays
  var o=new[]{t[9],t[10],t[11]};double off=(p0[0]-o[0])*n[0]+(p0[1]-o[1])*n[1]+(p0[2]-o[2])*n[2];
  IFeature sp=plane;
  if(Math.Abs(off)>1e-8){sp=null;
   foreach(bool fl in new[]{off<0,off>=0}){
    d.ClearSelection2(true);if(!plane.Select2(false,0))throw new Exception("cannot select "+plane.Name);
    int cst=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance;if(fl)cst|=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_OptionFlip;
    var np=(IFeature)d.FeatureManager.InsertRefPlane(cst,Math.Abs(off),0,0,0,0);d.ClearSelection2(true);if(np==null)continue;
    var t2=(double[])((MathTransform)((IRefPlane)np.GetSpecificFeature2()).Transform).ArrayData;
    if(Math.Abs((p0[0]-t2[9])*n[0]+(p0[1]-t2[10])*n[1]+(p0[2]-t2[11])*n[2])<1e-7){sp=np;break;}
    DropFeature(d,np);}
   if(sp==null){tried.Add("sketch way: no plane through the edge");return null;}
   tried.Add("plane "+sp.Name+" through the edge, parallel to "+plane.Name);}
  Func<double[],double[],bool> same=(p,q)=>Math.Abs(p[0]-q[0])<1e-7&&Math.Abs(p[1]-q[1])<1e-7;
  Func<ISketchSegment,double[][]> ends=sg=>{ISketchPoint p1=null,p2=null;
   if(sg is ISketchLine){p1=(ISketchPoint)((ISketchLine)sg).GetStartPoint2();p2=(ISketchPoint)((ISketchLine)sg).GetEndPoint2();}
   else if(sg is ISketchArc){var ar=(ISketchArc)sg;if(ar.IsCircle()==1)return new double[0][];p1=(ISketchPoint)ar.GetStartPoint2();p2=(ISketchPoint)ar.GetEndPoint2();}
   else throw new Exception("open spline or ellipse edges are not handled by the sketch way");
   return new[]{new[]{p1.X,p1.Y},new[]{p2.X,p2.Y}};};
  Func<List<ISketchSegment>,List<double[]>> free=list=>{var pts=list.SelectMany(ends).ToList();return pts.Where(p=>pts.Count(q=>same(p,q))==1).ToList();};
  foreach(double sg in new[]{1.0,-1.0}){string tag="sketch way, offset "+(sg>0?"+":"-")+distMm+" mm";var sm=d.SketchManager;IFeature skf=null,f=null;bool db=sm.AddToDB;
   try{
    d.ClearSelection2(true);if(!sp.Select2(false,0))throw new Exception("cannot select "+sp.Name);sm.InsertSketch(true);
    var sk=(ISketch)sm.ActiveSketch;if(sk==null)throw new Exception("no sketch opened");skf=(IFeature)sk;
    d.ClearSelection2(true);foreach(var q in ep)Mark(d,AnyEdgeAt(d,q,"edge_points_mm"),0,"edge");
    if(!sm.SketchUseEdge3(false,false))throw new Exception("convert entities refused the edges");
    var orig=((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>().ToList();if(orig.Count==0)throw new Exception("nothing converted");
    d.ClearSelection2(true);foreach(var x in orig)x.Select4(true,null);
    if(!sm.SketchOffset2(sg*distMm/1000,false,true,0,0,false))throw new Exception("offset refused");
    var all=((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>().ToList();if(all.Count<=orig.Count)throw new Exception("offset made nothing");
    var fa=free(all);var fo=free(orig).Where(p=>fa.Any(q=>same(p,q))).ToList();var fx=fa.Where(p=>!fo.Any(q=>same(p,q))).ToList();
    if(fo.Count!=fx.Count)throw new Exception(fo.Count+" free ends against "+fx.Count+" offset ends");
    sm.AddToDB=true;foreach(var p in fo){var q=fx.OrderBy(z=>Math.Pow(z[0]-p[0],2)+Math.Pow(z[1]-p[1],2)).First();fx.Remove(q);if(sm.CreateLine(p[0],p[1],0,q[0],q[1],0)==null)throw new Exception("closing line refused");}
    sm.AddToDB=db;sm.InsertSketch(true);
    d.ClearSelection2(true);if(!skf.Select2(false,0))throw new Exception("cannot select "+skf.Name);d.InsertPlanarRefSurface();d.ClearSelection2(true);
    f=NewFeature(d,had);if(f!=null&&(f.Name==sp.Name||f.Name==skf.Name))f=null;
    if(good(f)){tried.Add(tag+": ok ("+f.Name+" from "+skf.Name+(sp!=plane?" on "+sp.Name:"")+")");return f;}
    tried.Add(tag+": "+(f==null?"no planar surface":f.Name+" on the wrong side, deleted"));
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);}
   finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
   if(f!=null&&!good(f))DropFeature(d,f);if(skf!=null)DropFeature(d,skf);
  }
  if(sp!=plane)DropFeature(d,sp);
  return null;
 }
 // v3.22 ruled normal on a curved edge (a tube rim): the surface normal to the face along the edge is a flat band when the edge
 // lies in a plane that also holds the face normal (edge tangent x face normal is the same everywhere). That band is made
 // like radiate, on a plane of the part parallel to it; the side the face normal points to is tried first
 static IFeature RuledNormalBand(IModelDoc2 d,List<double[]> ep,double distMm,bool rev,HashSet<string> had,List<string> tried){
  var e=AnyEdgeAt(d,ep[0],"edge_points_mm");var p0=ep[0].Select(v=>v/1000).ToArray();
  var face=((object[])e.GetTwoAdjacentFaces2()??new object[0]).OfType<IFace2>().FirstOrDefault();
  if(face==null){tried.Add("band way: no face at the edge");return null;}
  var crv=(ICurve)e.GetCurve();var srf=(ISurface)face.GetSurface();
  Func<double[],double[]> unit=v=>{double l=Math.Sqrt(v.Sum(x=>x*x));return l<1e-12?null:v.Select(x=>x/l).ToArray();};
  Func<double[],double[],double[]> cross=(p,q)=>new[]{p[1]*q[2]-p[2]*q[1],p[2]*q[0]-p[0]*q[2],p[0]*q[1]-p[1]*q[0]};
  Func<double[],double[]> nrmAt=q=>{double[] v;
   // a cylinder or a cone: the normal is radial from the axis (exact); other surfaces ask SolidWorks
   if(srf.IsCylinder()){var c=(double[])srf.CylinderParams;var w=new[]{q[0]-c[0],q[1]-c[1],q[2]-c[2]};double wa=w[0]*c[3]+w[1]*c[4]+w[2]*c[5];v=unit(new[]{w[0]-wa*c[3],w[1]-wa*c[4],w[2]-wa*c[5]});if(v!=null&&!face.FaceInSurfaceSense())v=v.Select(x=>-x).ToArray();return v;}
   var ev=(double[])srf.EvaluateAtPoint(q[0],q[1],q[2]);if(ev==null||ev.Length<6)return null;v=unit(new[]{ev[3],ev[4],ev[5]});if(v!=null&&!face.FaceInSurfaceSense())v=v.Select(x=>-x).ToArray();return v;};
  Func<double,double[][]> at=tp=>{var ev=(double[])crv.Evaluate2(tp,1);return new[]{new[]{ev[0],ev[1],ev[2]},new[]{ev[3],ev[4],ev[5]}};};
  var cp=(double[])e.GetCurveParams2();double t0=cp[6],t1=cp[7];
  double[] n=null;
  foreach(double fr in new[]{0.5,0.1,0.35,0.65,0.9}){var pt=at(t0+(t1-t0)*fr);var fn=nrmAt(pt[0]);if(fn==null){tried.Add("band way: no face normal at the edge");return null;}
   var m=unit(cross(pt[1],fn));if(m==null){tried.Add("band way: the face normal runs along the edge");return null;}
   if(n==null)n=m;else if(Math.Abs(Math.Abs(n[0]*m[0]+n[1]*m[1]+n[2]*m[2])-1)>1e-6){tried.Add("band way: the face normal leaves the plane of the edge, so the normal ruled surface is not flat (no API route; edge tangent x face normal "+string.Join(",",n.Select(x=>Math.Round(x,3)))+" then "+string.Join(",",m.Select(x=>Math.Round(x,3)))+")");return null;}}
  IFeature plane=null;
  foreach(var pf in AllFeatures(d)){if(pf.GetTypeName2()!="RefPlane")continue;var rp=pf.GetSpecificFeature2() as IRefPlane;if(rp==null)continue;
   var tt=(double[])((MathTransform)rp.Transform).ArrayData;if(Math.Abs(Math.Abs(tt[6]*n[0]+tt[7]*n[1]+tt[8]*n[2])-1)<1e-6){plane=pf;break;}}
  if(plane==null){tried.Add("band way: no plane of the part is parallel to the band (normal "+string.Join(",",n.Select(x=>Math.Round(x,4)))+"); add one with sw_ref_plane");return null;}
  var fn0=nrmAt(p0);double half=distMm/2000;
  foreach(int sg in rev?new[]{-1,1}:new[]{1,-1}){var want=new[]{p0[0]+sg*fn0[0]*half,p0[1]+sg*fn0[1]*half,p0[2]+sg*fn0[2]*half};
   tried.Add("band way on "+plane.Name+(sg<0?", against the face normal":", along the face normal"));
   var f=BandInPlane(d,ep,plane,distMm,want,had,tried);if(f!=null)return f;}
  return null;
 }

 // v3.22 mid surface of chosen faces: InsertMidSurfaceExt with faces makes a feature with no body (measured), so each pair is
 // made as an offset of its first face toward the second by position x the gap: exact for flat parallel faces and for
 // coaxial cylinders (the definition of the mid surface)
 static IFeature MidByOffset(IModelDoc2 d,List<double[]> fp,double pos,HashSet<string> had,List<string> tried){
  var made=new List<IFeature>();
  for(int i=0;i+1<fp.Count;i+=2){string tag="pair "+(i/2+1)+" as an offset";
   var A=AnyFaceAt(d,fp[i],"face_points_mm");var B=AnyFaceAt(d,fp[i+1],"face_points_mm");
   var sa=(ISurface)A.GetSurface();var sb=(ISurface)B.GetSurface();var pa=fp[i].Select(v=>v/1000).ToArray();var pb=fp[i+1].Select(v=>v/1000).ToArray();
   double dist;double[] mid;
   if(sa.IsPlane()&&sb.IsPlane()){var qa=(double[])sa.PlaneParams;var qb=(double[])sb.PlaneParams;
    if(Math.Abs(Math.Abs(qa[0]*qb[0]+qa[1]*qb[1]+qa[2]*qb[2])-1)>1e-6){tried.Add(tag+": the faces are not parallel");foreach(var m in made)DropFeature(d,m);return null;}
    double g=(pb[0]-pa[0])*qa[0]+(pb[1]-pa[1])*qa[1]+(pb[2]-pa[2])*qa[2];dist=Math.Abs(g)*pos;mid=new[]{pa[0]+qa[0]*g*pos,pa[1]+qa[1]*g*pos,pa[2]+qa[2]*g*pos};}
   else if(sa.IsCylinder()&&sb.IsCylinder()){var ca=(double[])sa.CylinderParams;var cb=(double[])sb.CylinderParams;
    var ax=new[]{ca[3],ca[4],ca[5]};var w=new[]{cb[0]-ca[0],cb[1]-ca[1],cb[2]-ca[2]};double wa=w[0]*ax[0]+w[1]*ax[1]+w[2]*ax[2];
    bool coax=Math.Abs(Math.Abs(ax[0]*cb[3]+ax[1]*cb[4]+ax[2]*cb[5])-1)<1e-6&&Math.Sqrt(w.Sum(x=>x*x)-wa*wa)<1e-7;
    if(!coax){tried.Add(tag+": the cylinders are not coaxial");foreach(var m in made)DropFeature(d,m);return null;}
    var v=new[]{pa[0]-ca[0],pa[1]-ca[1],pa[2]-ca[2]};double va=v[0]*ax[0]+v[1]*ax[1]+v[2]*ax[2];var rad=new[]{v[0]-va*ax[0],v[1]-va*ax[1],v[2]-va*ax[2]};double rl=Math.Sqrt(rad.Sum(x=>x*x));
    double g=cb[6]-ca[6];dist=Math.Abs(g)*pos;mid=new[]{pa[0]+rad[0]/rl*g*pos,pa[1]+rad[1]/rl*g*pos,pa[2]+rad[2]/rl*g*pos};}
   else{tried.Add(tag+": only flat parallel faces or coaxial cylinders");foreach(var m in made)DropFeature(d,m);return null;}
   IFeature ok=null;
   foreach(bool flip in new[]{false,true}){
    try{var before=new HashSet<string>(BodiesOf(d,1).Select(x=>x.Name));
     d.ClearSelection2(true);Mark(d,AnyFaceAt(d,fp[i],"face_points_mm"),0,"face");d.InsertOffsetSurface(dist,flip);d.ClearSelection2(true);
     var f=NewFeature(d,had);if(f==null){tried.Add(tag+(flip?" flipped":"")+": nothing");continue;}
     bool hit=BodiesOf(d,1).Where(x=>!before.Contains(x.Name)).Any(x=>((object[])x.GetFaces()).Cast<IFace2>().Any(fc=>{var c=(double[])fc.GetClosestPointOn(mid[0],mid[1],mid[2]);return c!=null&&Math.Sqrt(Math.Pow(c[0]-mid[0],2)+Math.Pow(c[1]-mid[1],2)+Math.Pow(c[2]-mid[2],2))<1e-6;}));
     if(hit){ok=f;had.Add(f.Name);tried.Add(tag+": ok ("+f.Name+", "+Math.Round(dist*1000,4)+" mm from the first face)");break;}
     tried.Add(tag+(flip?" flipped":"")+": "+f.Name+" on the wrong side, deleted");DropFeature(d,f);
    }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
   }
   if(ok==null){foreach(var m in made)DropFeature(d,m);return null;}
   made.Add(ok);
  }
  return made.LastOrDefault();
 }

 // Mid Surface: halfway (position 0..1, default 0.5) between face pairs of a solid (face_points_mm, two per pair), or every pair
 // SolidWorks finds on the solid at body_point_mm (or the only solid) when no faces are given
 static object SurfMid(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  double pos=a.ContainsKey("position")?Num(a,"position"):0.5;if(pos<0||pos>1)throw new Exception("position: 0 to 1 (0.5 = halfway)");
  int h0=BodiesOf(d,1).Length;var fp=Pts(a,"face_points_mm");
  if(fp.Count%2==1)throw new Exception("mid_surface face_points_mm go in pairs (two facing faces per pair)");
  var faces=fp.Select(p=>AnyFaceAt(d,p,"face_points_mm")).ToList();
  Func<IFeature,string,object> check=(f,tag)=>{if(f!=null&&BodiesOf(d,1).Length>h0){tried.Add(tag+": ok");return f;}tried.Add(tag+": "+(f==null?"nothing":f.Name+" made no surface body, deleted"));DropFeature(d,f);return null;};
  if(faces.Count>0){var mo=MidByOffset(d,fp,pos,had,tried);if(mo!=null)return mo;}
  if(faces.Count>0){
   foreach(double pv in new[]{pos,pos*100})foreach(int mk in new[]{0,1})foreach(bool pairMarks in new[]{false,true}){
    if(pairMarks&&mk==1)continue;string tag="faces mark "+(pairMarks?"1/2 per pair":mk.ToString())+", position "+pv;
    try{d.ClearSelection2(true);faces=fp.Select(p=>AnyFaceAt(d,p,"face_points_mm")).ToList();for(int i=0;i<faces.Count;i++)Mark(d,faces[i],pairMarks?1+(i%2):mk,"face");
     d.InsertMidSurfaceExt(pv,Flag(a,"knit",true));d.ClearSelection2(true);var r=check(NewFeature(d,had),tag);if(r!=null)return r;
    }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
   }
  }
  var solids=BodiesOf(d,0);if(solids.Length==0)throw new Exception("mid_surface needs a solid body");
  IBody2 body=solids.Length==1?solids[0]:null;
  if(a.ContainsKey("body_point_mm")){var q=Xyz(a["body_point_mm"],"body_point_mm");body=solids.OrderBy(b=>BodyDistMm(b,q)).First();}
  if(body==null)throw new Exception("mid_surface: "+solids.Length+" solids; give body_point_mm or face_points_mm");
  try{d.ClearSelection2(true);var f=d.FeatureManager.InsertMidSurface((Body2)body,(ModelDoc2)d,pos,Flag(a,"knit",true)) as IFeature;d.ClearSelection2(true);
   var r=check(f??NewFeature(d,had),"every face pair of "+body.Name);if(r!=null)return r;
  }catch(Exception ex){tried.Add("every face pair: "+ex.Message);}
  return null;
 }

 // Freeform: one face (face_point_mm) reshaped by control curves; freeform_curves = [{direction 0|1, at 0..1 across the face,
 // points:[{at 0..1 along the curve, offset_mm:[x,y,z]}]}]. The face changes in place (no new body): success = a new feature
 // and a face area that changed.
 static object SurfFreeform(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  if(!a.ContainsKey("face_point_mm"))throw new Exception("freeform needs face_point_mm (the face to reshape)");
  if(!a.ContainsKey("freeform_curves"))throw new Exception("freeform needs freeform_curves: [{direction, at, points:[{at, offset_mm}]}]");
  var p=Xyz(a["face_point_mm"],"face_point_mm");var face=AnyFaceAt(d,p,"face_point_mm");
  var curves=Items(a["freeform_curves"]).Cast<Dictionary<string,object>>().ToList();if(curves.Count==0)throw new Exception("freeform_curves is empty");
  double area0=BodiesOf(d,1).Concat(BodiesOf(d,0)).Sum(b=>((object[])b.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea()))*1e6;
  var fm=d.FeatureManager;
  foreach(int mk in new[]{0,1})foreach(bool v2 in new[]{true,false}){
   string tag="face mark "+mk+(v2?", Freeform2":", Freeform");
   try{
    d.ClearSelection2(true);Mark(d,face,mk,"face");
    foreach(var c in curves){short dir=(short)Convert.ToInt32(c["direction"]);double at=Num(c,"at");
     fm.SetFreeformCurveData(dir,at,0,0,0,0,0,0);
     foreach(var q in Items(c.ContainsKey("points")?c["points"]:new object[0]).Cast<Dictionary<string,object>>()){var o=Xyz(q["offset_mm"],"offset_mm");fm.SetFreeformPointData(dir,at,Num(q,"at"),o[0]/1000,o[1]/1000,o[2]/1000);}}
    var f=(v2?fm.InsertFreeform2(false,false,false,0):fm.InsertFreeform(0,0,0,0,false,false)) as IFeature;d.ClearSelection2(true);
    f=f??NewFeature(d,had);
    double area1=BodiesOf(d,1).Concat(BodiesOf(d,0)).Sum(b=>((object[])b.GetFaces()??new object[0]).Sum(x=>((IFace2)x).GetArea()))*1e6;
    if(f!=null&&Math.Abs(area1-area0)>1e-3){tried.Add(tag+": ok (area "+Math.Round(area0,2)+" -> "+Math.Round(area1,2)+" mm2)");return f;}
    tried.Add(tag+": "+(f==null?"nothing":f.Name+" changed no area, deleted"));DropFeature(d,f);
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }
}
