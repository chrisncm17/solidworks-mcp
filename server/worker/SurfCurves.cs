using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.23 the Curves menu of the Surfaces tab: curve through XYZ points, composite curve and projected curve. They are the 3D
// guides and paths that boundary, loft and sweep take by name.
partial class Worker {
 // length and ends of a reference curve feature (curve through points, composite, projected, helix), or null
 static object CurveInfo(IFeature f){
  try{
   var rc=f.GetSpecificFeature2() as IReferenceCurve;if(rc==null)return null;
   var segs=((object[])rc.GetSegments()??new object[0]).OfType<IEdge>().ToList();if(segs.Count==0)return null;
   double len=0;var ends=new List<double[]>();
   foreach(var e in segs){var c=(ICurve)e.GetCurve();var cp=(double[])e.GetCurveParams2();len+=c.GetLength3(Math.Min(cp[6],cp[7]),Math.Max(cp[6],cp[7]));
    ends.Add(new[]{cp[0],cp[1],cp[2]});ends.Add(new[]{cp[3],cp[4],cp[5]});}
   // the ends of the chain are the vertex points that appear once
   var once=ends.Where(p=>ends.Count(q=>Math.Abs(q[0]-p[0])+Math.Abs(q[1]-p[1])+Math.Abs(q[2]-p[2])<1e-8)==1).Select(p=>p.Select(v=>Math.Round(v*1000,3)).ToArray()).ToArray();
   return new{segments=segs.Count,length_mm=Math.Round(len*1000,4),closed=once.Length==0,ends_mm=once};
  }catch{return null;}
 }

 // Curve Through XYZ Points: points_mm in order (at least 2); closed=true returns to the first point
 static IFeature CurvePoints(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  var pts=Pts(a,"points_mm");if(pts.Count<2)throw new Exception("curve_points needs points_mm with at least 2 points [x, y, z] in mm");
  for(int i=1;i<pts.Count;i++)if(Math.Sqrt(Enumerable.Range(0,3).Sum(k=>Math.Pow(pts[i][k]-pts[i-1][k],2)))<1e-6)throw new Exception("points_mm "+(i-1)+" and "+i+" are the same point");
  if(Flag(a,"closed")){if(pts.Count<3)throw new Exception("a closed curve needs at least 3 points");pts.Add(pts[0]);}
  d.InsertCurveFileBegin();
  foreach(var p in pts)if(!d.InsertCurveFilePoint(p[0]/1000,p[1]/1000,p[2]/1000)){d.InsertCurveFileEnd();throw new Exception("SolidWorks refused the point ["+string.Join(", ",p)+"]");}
  bool ok=d.InsertCurveFileEnd();var f=NewFeature(d,had);
  tried.Add("curve through "+pts.Count+" points: "+(ok&&f!=null?f.Name:"nothing"));
  return ok?f:null;
 }

 // select every segment of a sketch (some commands take a sketch only as its entities)
 static int MarkSketchSegments(IModelDoc2 d,IFeature skf,int mark){
  var sk=skf.GetSpecificFeature2() as ISketch;if(sk==null)return 0;int n=0;
  var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mark;
  foreach(var s in ((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>())if(!s.ConstructionGeometry&&s.Select4(true,sd))n++;
  return n;
 }

 // Composite Curve: curves (names of sketches, helixes or other curves) and edge_points_mm (model edges), end to end. Ways
 // tried: the features (measured: whole sketches join at mark 1, mark 0 is refused), their sketch segments by name as EXTSKETCHSEGMENT, then marks 0/2/4
 static IFeature CurveComposite(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  var names=a.ContainsKey("curves")?Items(a["curves"]).Select(Convert.ToString).ToList():new List<string>();var ep=Pts(a,"edge_points_mm");
  if(names.Count+ep.Count==0)throw new Exception("curve_composite needs curves (sketch or curve names) and/or edge_points_mm");
  var feats=names.Select(n=>Feature(d,n)).ToList();bool anySketch=feats.Any(f=>f.GetSpecificFeature2() is ISketch);
  foreach(string way in new[]{"features","segments by name","segments"})foreach(int mk in new[]{1,0,2,4}){
   if(way!="features"&&!anySketch)continue;
   string tag="composite of the "+way+" (mark "+mk+")";
   try{d.ClearSelection2(true);
    foreach(var f in feats){var sk=f.GetSpecificFeature2() as ISketch;
     if(way=="features"||sk==null){if(!f.Select2(true,mk))throw new Exception("Cannot select "+f.Name);continue;}
     var segs=((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>().Where(x=>!x.ConstructionGeometry).ToList();if(segs.Count==0)throw new Exception(f.Name+" has no segments");
     foreach(var g in segs){bool ok;
      if(way=="segments by name")ok=d.Extension.SelectByID2(g.GetName()+"@"+f.Name,"EXTSKETCHSEGMENT",0,0,0,true,mk,null,0);
      else{var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mk;ok=g.Select4(true,sd);}
      if(!ok)throw new Exception("Cannot select "+g.GetName()+"@"+f.Name);}}
    foreach(var p in ep)Mark(d,AnyEdgeAt(d,p,"edge_points_mm"),mk,"edge");
    int nsel=((ISelectionMgr)d.SelectionManager).GetSelectedObjectCount2(-1);
    bool ok2=d.InsertCompositeCurve();d.ClearSelection2(true);var nf=NewFeature(d,had);
    if(nf!=null){tried.Add(tag+": "+nf.Name);return nf;}
    if(mk==1)tried.Add(tag+": "+(ok2?"no feature":"refused")+" ("+nsel+" selected)");
   }catch(Exception ex){if(mk==1)tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }

 // Projected Curve: sketch onto the faces at face_points_mm (along the sketch normal), or sketch onto onto_sketch (the two
 // sketches extruded along their normals meet in a 3D curve). reverse flips the projection direction onto faces
 static IFeature CurveProjected(IModelDoc2 d,Dictionary<string,object> a,HashSet<string> had,List<string> tried){
  if(!a.ContainsKey("sketch"))throw new Exception("curve_projected needs sketch, and face_points_mm or onto_sketch");
  var skf=SketchFeature(d,Str(a,"sketch"));var fp=Pts(a,"face_points_mm");IFeature onto=a.ContainsKey("onto_sketch")?SketchFeature(d,Str(a,"onto_sketch")):null;
  if(fp.Count==0&&onto==null)throw new Exception("curve_projected needs face_points_mm (sketch on faces) or onto_sketch (sketch on sketch)");
  if(fp.Count>0&&onto!=null)throw new Exception("give face_points_mm or onto_sketch, not both");
  bool rev=Flag(a,"reverse");
  var variants=new List<int[]>();// {sketch mark, target mark, reverse}
  foreach(int r in rev?new[]{1,0}:new[]{0,1})foreach(var m in new[]{new[]{0,0},new[]{1,2},new[]{4,1},new[]{0,1}}){if(onto!=null&&r==1)continue;variants.Add(new[]{m[0],m[1],r});}
  foreach(var v in variants){string tag="projected (marks "+v[0]+"/"+v[1]+(v[2]==1?", reversed":"")+")";
   try{d.ClearSelection2(true);
    if(!skf.Select2(true,v[0]))throw new Exception("Cannot select "+skf.Name);
    if(onto!=null){if(!onto.Select2(true,v[1]))throw new Exception("Cannot select "+onto.Name);}
    else foreach(var p in fp)Mark(d,AnyFaceAt(d,p,"face_points_mm"),v[1],"face");
    var f=d.InsertProjectedSketch2(v[2]) as IFeature;d.ClearSelection2(true);f=f??NewFeature(d,had);
    if(f==null){tried.Add(tag+": nothing");continue;}
    d.EditRebuild3();var info=CurveInfo(f);bool warn;int err=f.GetErrorCode2(out warn);
    if(err!=0||info==null){tried.Add(tag+": "+f.Name+(err!=0?" error "+err:" has no curve")+", deleted");DropFeature(d,f);continue;}
    tried.Add(tag+": "+f.Name);return f;
   }catch(Exception ex){tried.Add(tag+": "+ex.Message);d.ClearSelection2(true);}
  }
  return null;
 }
}
