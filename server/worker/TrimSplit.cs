using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 trim of a closed tube (a hole wall, a full cylinder or cone): PostTrimSurface gives null in every variant. The same result
// by hand in SolidWorks is Split Line + Delete Face, so when the trim fails that is done: the faces of the targets are split where the
// tool crosses them (intersection with a plane or surface, or the projection of a tool sketch) and the new pieces that hold no keep
// point are deleted. The two features stay in the tree (Línea de partición, Eliminar cara).
partial class Worker {
 static object TrimBySplit(IModelDoc2 d,Dictionary<string,object> a,List<IBody2> targets,List<IBody2> tools,IFeature toolSketch,IFeature toolPlane,List<double[]> keep,List<string> tried){
  if(targets.Count==0)return null;
  if(Flag(a,"mutual"))return MutualBySplit(d,targets,keep,tried);
  var fm=d.FeatureManager;
  Func<List<IFace2>> targetFaces=()=>BodiesOf(d,1).Where(b=>keep.Any(k=>BodyDistMm(b,k)<0.05)||targets.Any(t=>t.Name==b.Name)).SelectMany(b=>((object[])b.GetFaces()??new object[0]).Cast<IFace2>()).ToList();
  var faces0=targetFaces();var areas0=faces0.Select(f=>f.GetArea()*1e6).ToList();int n0=faces0.Count;
  var had=new HashSet<string>(FeatureNames(d));IFeature split=null;
  if(toolSketch!=null){
   d.ClearSelection2(true);
   if(toolSketch.Select2(false,4)){foreach(var f in faces0)Mark(d,f,1,"face to split");d.InsertSplitLineProject(false,false);split=NewFeature(d,had);}
   tried.Add("split line by projecting "+toolSketch.Name+": "+(split!=null?"ok":"no"));
  }else{
   foreach(int opt in new[]{0,1})foreach(int tm in new[]{0,1,2,4})foreach(int fmk in new[]{0,1,2,4}){
    if(split!=null)break;if(tm==fmk)continue;
    try{d.ClearSelection2(true);
     if(toolPlane!=null&&!toolPlane.Select2(true,tm))continue;
     foreach(var t in tools)Mark(d,t,tm,"tool "+t.Name);
     foreach(var f in faces0)Mark(d,f,fmk,"face to split");
     var f2=fm.InsertSplitLineIntersect(opt) as IFeature;split=f2??NewFeature(d,had);
     if(split!=null)tried.Add("split line by intersection (option "+opt+", tool mark "+tm+", faces mark "+fmk+"): ok");
    }catch(Exception ex){tried.Add("split line intersection "+opt+"/"+tm+"/"+fmk+": "+ex.Message);}
   }
   if(split==null)tried.Add("split line by intersection: no variant made it");
  }
  d.ClearSelection2(true);
  if(split==null)return null;
  d.EditRebuild3();
  var faces1=targetFaces();
  if(faces1.Count<=n0){tried.Add("the split line divided no face ("+n0+" faces before and after)");return null;}
  // the new pieces (an area no face had before) that hold no keep point go
  var drop=faces1.Where(f=>{double ar=f.GetArea()*1e6;return !areas0.Any(x=>Math.Abs(x-ar)<1e-4*Math.Max(1,x))&&!keep.Any(k=>FaceDistMm(f,k)<0.05);}).ToList();
  var held=faces1.Where(f=>keep.Any(k=>FaceDistMm(f,k)<0.05)).ToList();
  if(drop.Count==0||held.Count==0){tried.Add("after the split: "+drop.Count+" pieces to delete, "+held.Count+" with a keep point; nothing deleted");return null;}
  var had2=new HashSet<string>(FeatureNames(d));
  d.ClearSelection2(true);foreach(var f in drop)Mark(d,f,0,"piece to delete");
  object del=d.Extension.InsertDeleteFace(0);d.ClearSelection2(true);
  var df=del as IFeature??NewFeature(d,had2);
  tried.Add("delete face of "+drop.Count+" piece(s) without a keep point: "+(df!=null?"ok":"no"));
  return df;
 }
}

// v3.22 a reference plane as the trim tool gives no pieces through the API (tube cut along its axis by Right: "no pieces" in every
// variant), while a surface on that plane trims it. So the plane is turned into a temporary planar surface that covers the targets,
// the trim uses it as its tool, and that surface body is deleted afterwards (Delete/Keep Body).
partial class Worker {
 static IBody2 PlaneAsSurface(IModelDoc2 d,IFeature plane,List<IBody2> targets,List<string> tried){
  double[] lo={1e9,1e9,1e9},hi={-1e9,-1e9,-1e9};
  foreach(var t in targets){var b=(double[])t.GetBodyBox();for(int i=0;i<3;i++){lo[i]=Math.Min(lo[i],b[i]);hi[i]=Math.Max(hi[i],b[i+3]);}}
  if(lo[0]>hi[0])throw new Exception("No target surfaces to size the plane");
  double half=Math.Max(Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(hi[i]-lo[i],2))),0.001);
  var c=new[]{(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2};
  var before=BodiesOf(d,1).ToList();var sm=d.SketchManager;bool db=sm.AddToDB;IFeature skf=null;
  d.ClearSelection2(true);if(!plane.Select2(false,0))throw new Exception("Cannot select tool plane "+plane.Name);
  try{
   sm.InsertSketch(true);var sk=(ISketch)sm.ActiveSketch;if(sk==null)throw new Exception("Could not open a sketch on "+plane.Name);skf=(IFeature)sk;
   var mu=(IMathUtility)sw.GetMathUtility();var q=(double[])((MathPoint)((MathPoint)mu.CreatePoint(c)).MultiplyTransform((MathTransform)sk.ModelToSketchTransform)).ArrayData;
   sm.AddToDB=true;var k=new[]{new[]{q[0]-half,q[1]-half},new[]{q[0]+half,q[1]-half},new[]{q[0]+half,q[1]+half},new[]{q[0]-half,q[1]+half}};
   for(int i=0;i<4;i++){var e=k[(i+1)%4];if(sm.CreateLine(k[i][0],k[i][1],0,e[0],e[1],0)==null)throw new Exception("The tool rectangle was not drawn");}
  }finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
  if(!skf.Select2(false,0))throw new Exception("Cannot select "+skf.Name);
  d.InsertPlanarRefSurface();d.ClearSelection2(true);
  var made=BodiesOf(d,1).Where(b=>!before.Any(x=>x.Name==b.Name)).ToList();
  if(made.Count!=1)throw new Exception("The temporary surface on "+plane.Name+" was not made");
  tried.Add("plane "+plane.Name+" made a temporary surface "+made[0].Name+" ("+skf.Name+")");
  return made[0];
 }
 // a sketch line standing for a plane: on a default plane perpendicular to it, along their intersection, long enough to cross the targets
 static IFeature PlaneAsSketchLine(IModelDoc2 d,IFeature plane,List<IBody2> targets,List<string> tried){
  Func<IFeature,double[]> T=f=>(double[])((MathTransform)((IRefPlane)f.GetSpecificFeature2()).Transform).ArrayData;
  Func<double[],double[],double> dot=(p,q)=>p[0]*q[0]+p[1]*q[1]+p[2]*q[2];
  var t=T(plane);return PlaneAsSketchLine(d,new[]{t[6],t[7],t[8]},new[]{t[9],t[10],t[11]},"plane "+plane.Name,targets,tried);
 }
 // v3.22 the same from a normal and a point (meters): a planar tool surface across a closed tube is used as its plane
 static IFeature PlaneAsSketchLine(IModelDoc2 d,double[] n,double[] o,string label,List<IBody2> targets,List<string> tried){
  Func<IFeature,double[]> T=f=>(double[])((MathTransform)((IRefPlane)f.GetSpecificFeature2()).Transform).ArrayData;
  Func<double[],double[],double> dot=(p,q)=>p[0]*q[0]+p[1]*q[1]+p[2]*q[2];
  double[] lo={1e9,1e9,1e9},hi={-1e9,-1e9,-1e9};
  foreach(var b0 in targets){var b=(double[])b0.GetBodyBox();for(int i=0;i<3;i++){lo[i]=Math.Min(lo[i],b[i]);hi[i]=Math.Max(hi[i],b[i+3]);}}
  if(lo[0]>hi[0])return null;
  double half=Math.Max(Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(hi[i]-lo[i],2))),0.001);
  var c=new[]{(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2};
  for(int k=0;k<3;k++){var bp=PlaneByIndex(d,k);if("plane "+bp.Name==label)continue;var bt=T(bp);var m=new[]{bt[6],bt[7],bt[8]};var ob=new[]{bt[9],bt[10],bt[11]};
   if(Math.Abs(dot(m,n))>1e-6)continue;
   var u=new[]{n[1]*m[2]-n[2]*m[1],n[2]*m[0]-n[0]*m[2],n[0]*m[1]-n[1]*m[0]};double ul=Math.Sqrt(dot(u,u));if(ul<1e-9)continue;for(int i=0;i<3;i++)u[i]/=ul;
   double s1=dot(new[]{c[0]-o[0],c[1]-o[1],c[2]-o[2]},n);var c1=new[]{c[0]-s1*n[0],c[1]-s1*n[1],c[2]-s1*n[2]};
   double s2=dot(new[]{c1[0]-ob[0],c1[1]-ob[1],c1[2]-ob[2]},m);var c2=new[]{c1[0]-s2*m[0],c1[1]-s2*m[1],c1[2]-s2*m[2]};
   var sm=d.SketchManager;bool db=sm.AddToDB;IFeature skf=null;
   d.ClearSelection2(true);if(!bp.Select2(false,0))continue;
   try{sm.InsertSketch(true);var sk=(ISketch)sm.ActiveSketch;if(sk==null)continue;skf=(IFeature)sk;
    var mu=(IMathUtility)sw.GetMathUtility();var tf=(MathTransform)sk.ModelToSketchTransform;
    Func<double,double[]> P=sg=>(double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{c2[0]+sg*u[0]*half,c2[1]+sg*u[1]*half,c2[2]+sg*u[2]*half})).MultiplyTransform(tf)).ArrayData;
    var p0=P(-1);var p1=P(1);sm.AddToDB=true;if(sm.CreateLine(p0[0],p0[1],0,p1[0],p1[1],0)==null)throw new Exception("The tool line was not drawn");
   }finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
   tried.Add(label+" made a sketch line "+skf.Name+" on "+bp.Name);return skf;}
  tried.Add("no default plane is perpendicular to "+label+", so it cannot be made a sketch line");return null;
 }
 static void RemoveTempSurface(IModelDoc2 d,string name,List<string> tried){
  var f=AllFeatures(d).FirstOrDefault(x=>x.Name==name);
  if(f!=null){d.ClearSelection2(true);if(f.Select2(false,0))d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed);d.ClearSelection2(true);d.EditRebuild3();}
  if(BodiesOf(d,1).Any(x=>x.Name==name))DropTempSurface(d,name,tried);else tried.Add("temporary surface "+name+" removed with its sketch (it trimmed nothing)");
 }
 static void DropTempSurface(IModelDoc2 d,string name,List<string> tried){
  var b=BodiesOf(d,1).FirstOrDefault(x=>x.Name==name);if(b==null){tried.Add("temporary surface "+name+" already gone");return;}
  d.ClearSelection2(true);Mark(d,b,0,"temporary surface "+name);var f=d.FeatureManager.InsertDeleteBody2(false);d.ClearSelection2(true);
  tried.Add("temporary surface "+name+" deleted: "+(f!=null?"ok":"NO, delete it by hand"));
 }

 // v3.22 mutual trim of closed tubes (PostTrimSurface null or the tube left whole): every body is split where the others cross it,
 // all the splits first so each tool is still whole, then the new pieces of all of them that hold no keep point go in one Delete
 // Face. Like any mutual trim, give a keep point on every piece that stays
 // origin, axis and radius (m) when every face of the body is the same cylinder, else null
 static double[] TubeCylinder(IBody2 b){
  if(b==null)return null;double[] c0=null;
  foreach(var f in ((object[])b.GetFaces()??new object[0]).Cast<IFace2>()){var sf=(ISurface)f.GetSurface();if(!sf.IsCylinder())return null;var c=(double[])sf.CylinderParams;
   if(c0==null){c0=c;continue;}
   var w=new[]{c[0]-c0[0],c[1]-c0[1],c[2]-c0[2]};double wa=w[0]*c0[3]+w[1]*c0[4]+w[2]*c0[5];
   if(Math.Abs(Math.Abs(c0[3]*c[3]+c0[4]*c[4]+c0[5]*c[5])-1)>1e-6||Math.Sqrt(Math.Max(0,w.Sum(x=>x*x)-wa*wa))>1e-7||Math.Abs(c[6]-c0[6])>1e-8)return null;}
  return c0;
 }
 // the normal of a sketch plane in the model
 static double[] SketchNormal(IFeature skf){
  try{var sk=(ISketch)skf.GetSpecificFeature2();var t=(MathTransform)((MathTransform)sk.ModelToSketchTransform).Inverse();var a=(double[])t.ArrayData;return new[]{a[6],a[7],a[8]};}catch{return null;}
 }
 // a sketch with the circle of cylinder c on a part plane normal to its axis, or null
 static IFeature AxisCircleSketch(IModelDoc2 d,double[] c,List<string> tried){
  IFeature plane=null;
  foreach(var pf in AllFeatures(d)){if(pf.GetTypeName2()!="RefPlane")continue;var rp=pf.GetSpecificFeature2() as IRefPlane;if(rp==null)continue;
   var tt=(double[])((MathTransform)rp.Transform).ArrayData;if(Math.Abs(Math.Abs(tt[6]*c[3]+tt[7]*c[4]+tt[8]*c[5])-1)<1e-6){plane=pf;break;}}
  if(plane==null){tried.Add("no part plane is normal to the tube axis ("+string.Join(",",new[]{c[3],c[4],c[5]}.Select(x=>Math.Round(x,4)))+"); add one with sw_ref_plane");return null;}
  var sm=d.SketchManager;bool db=sm.AddToDB;IFeature skf=null;
  try{d.ClearSelection2(true);if(!plane.Select2(false,0))throw new Exception("cannot select "+plane.Name);
   sm.InsertSketch(true);var sk=(ISketch)sm.ActiveSketch;if(sk==null)throw new Exception("no sketch opened on "+plane.Name);skf=(IFeature)sk;
   var mu=(IMathUtility)sw.GetMathUtility();var q=(double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{c[0],c[1],c[2]})).MultiplyTransform((MathTransform)sk.ModelToSketchTransform)).ArrayData;
   sm.AddToDB=true;if(sm.CreateCircleByRadius(q[0],q[1],0,c[6])==null)throw new Exception("the circle was not drawn");
  }catch(Exception ex){tried.Add("circle on "+plane.Name+": "+ex.Message);}
  finally{sm.AddToDB=db;if(sm.ActiveSketch!=null)sm.InsertSketch(true);d.ClearSelection2(true);}
  return skf;
 }
 static object MutualBySplit(IModelDoc2 d,List<IBody2> bodies,List<double[]> keep,List<string> tried){
  var names=bodies.Select(b=>b.Name).Distinct().ToList();if(names.Count<2){tried.Add("mutual split: needs two surfaces");return null;}
  var fm=d.FeatureManager;var made=new List<IFeature>();
  Func<string,IBody2> byName=n=>BodiesOf(d,1).FirstOrDefault(b=>b.Name==n);
  Func<List<IFace2>> allFaces=()=>names.Select(byName).Where(b=>b!=null).SelectMany(b=>((object[])b.GetFaces()??new object[0]).Cast<IFace2>()).ToList();
  Action undo=()=>{for(int i=made.Count-1;i>=0;i--)DropFeature(d,made[i]);};
  var areas0=allFaces().Select(x=>x.GetArea()*1e6).ToList();int n0=areas0.Count;
  // the sketch each body was made from, taken before any split line (a split line also has a sketch parent)
  var sketches=names.Select(n=>{var ob=byName(n);return ob==null?null:((object[])ob.GetFeatures()??new object[0]).Cast<IFeature>().SelectMany(x=>((object[])x.GetParents()??new object[0]).Cast<IFeature>()).FirstOrDefault(x=>x.GetTypeName2()=="ProfileFeature");}).ToList();
  // v3.23 a tube that is not an extrusion (revolve, sweep, or a sketch that is not its section): when every face is the same
  // cylinder, a circle of its radius on a part plane normal to its axis projects to the same intersection curve
  var cyls=names.Select(n=>TubeCylinder(byName(n))).ToList();var temps=new List<IFeature>();
  for(int j=0;j<names.Count;j++)if(sketches[j]!=null&&cyls[j]!=null){var nz=SketchNormal(sketches[j]);var c=cyls[j];
   if(nz==null||Math.Abs(Math.Abs(nz[0]*c[3]+nz[1]*c[4]+nz[2]*c[5])-1)>1e-6){tried.Add(names[j]+": "+sketches[j].Name+" is not its section (not normal to the tube axis)");sketches[j]=null;}}
  undo=()=>{for(int i=made.Count-1;i>=0;i--)DropFeature(d,made[i]);foreach(var t in temps)try{DropFeature(d,t);}catch{}};
  for(int ix=0;ix<names.Count;ix++){var nm=names[ix];
   var prev=new HashSet<string>(BodiesOf(d,1).Select(b=>b.Name));var had=new HashSet<string>(FeatureNames(d));IFeature split=null;
   // two closed tubes: their intersection makes no split line (measured). When the other body is an extrusion of a sketch, that
   // sketch projected onto this body along its normal is the same curve (the extrusion direction is the sketch normal)
   for(int j=0;j<names.Count;j++){if(j==ix||split!=null)continue;var sk=sketches[j];
    if(sk==null&&cyls[j]!=null){sk=AxisCircleSketch(d,cyls[j],tried);if(sk!=null){sketches[j]=sk;temps.Add(sk);tried.Add("circle "+sk.Name+" normal to the axis of "+names[j]);}}
    if(sk==null){tried.Add("split "+nm+": "+names[j]+" has no sketch to project");continue;}
    try{d.ClearSelection2(true);if(!sk.Select2(false,4))throw new Exception("cannot select "+sk.Name);
     foreach(var fc in ((object[])byName(nm).GetFaces()).Cast<IFace2>())Mark(d,fc,1,"face to split");
     d.InsertSplitLineProject(false,false);var f3=NewFeature(d,had);d.ClearSelection2(true);
     if(f3!=null){d.EditRebuild3();made.Add(f3);split=f3;tried.Add("split "+nm+" by projecting "+sk.Name+" (the sketch of "+names[j]+"): "+f3.Name);}
     else tried.Add("split "+nm+" by projecting "+sk.Name+": nothing");
    }catch(Exception ex){tried.Add("split "+nm+" by projecting "+sk.Name+": "+ex.Message);d.ClearSelection2(true);}}
   foreach(int opt in new[]{0,1})foreach(int tm in new[]{0,1,2,4})foreach(int fmk in new[]{0,1,2,4}){
    if(split!=null||tm==fmk)continue;
    try{d.ClearSelection2(true);
     foreach(var on in names)if(on!=nm)Mark(d,byName(on),tm,"tool "+on);
     foreach(var fc in ((object[])byName(nm).GetFaces()).Cast<IFace2>())Mark(d,fc,fmk,"face to split");
     var f2=fm.InsertSplitLineIntersect(opt) as IFeature;split=f2??NewFeature(d,had);
     if(split!=null){d.EditRebuild3();made.Add(split);tried.Add("split "+nm+" where the others cross it (option "+opt+", tool mark "+tm+", faces mark "+fmk+"): "+split.Name);}
    }catch(Exception ex){if(tm==0&&fmk==1&&opt==0)tried.Add("split "+nm+" by intersection: "+ex.Message);}
   }
   d.ClearSelection2(true);
   if(split==null){tried.Add("split "+nm+": no variant made it");undo();return null;}
   // the split body takes the name of the split line feature: follow it
   var added=BodiesOf(d,1).Select(b=>b.Name).Where(x=>!prev.Contains(x)).ToList();if(byName(nm)==null&&added.Count==1)names[ix]=added[0];
  }
  var faces1=allFaces();
  if(faces1.Count<=n0){tried.Add("the split lines divided no face ("+n0+" faces before and after)");undo();return null;}
  var drop=faces1.Where(x=>{double ar=x.GetArea()*1e6;return !areas0.Any(y=>Math.Abs(y-ar)<1e-4*Math.Max(1,y))&&!keep.Any(k=>FaceDistMm(x,k)<0.05);}).ToList();
  var held=faces1.Where(x=>keep.Any(k=>FaceDistMm(x,k)<0.05)).ToList();
  if(drop.Count==0||held.Count==0){tried.Add("after the splits: "+drop.Count+" pieces to delete, "+held.Count+" with a keep point; nothing deleted");undo();return null;}
  var had2=new HashSet<string>(FeatureNames(d));
  d.ClearSelection2(true);foreach(var x in drop)Mark(d,x,0,"piece to delete");
  object del=d.Extension.InsertDeleteFace(0);d.ClearSelection2(true);
  var df=del as IFeature??NewFeature(d,had2);
  tried.Add("delete face of "+drop.Count+" piece(s) without a keep point: "+(df!=null?"ok":"no"));
  if(df==null)undo();
  return df;
 }
}
