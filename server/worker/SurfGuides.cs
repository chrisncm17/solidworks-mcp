using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

// v3.24 (gancho, 25-nov: a loft with guides drawn with arcs never came out and SolidWorks only says "check the selection").
// 1) A guide can be some segments of another sketch: {sketch, segments:[i...]} makes a new sketch on the same plane with those
//    segments converted (Convert Entities), so one sketch can feed several guides, as the user picks a chain in the UI.
// 2) loft_check (read-only) and the error of a failed loft say, for every guide, whether it is one joined open chain (points at
//    the same place but not merged are named) and how far it passes from every profile (it must touch each one).
partial class Worker {
 static List<IFeature> GuideFeatures(IModelDoc2 d,Dictionary<string,object>a,List<string> tried){
  var list=new List<IFeature>();if(!a.ContainsKey("guides"))return list;
  foreach(var g in Items(a["guides"])){
   IFeature f=g is Dictionary<string,object>?GuideFromSegments(d,(Dictionary<string,object>)g,tried):Feature(d,Convert.ToString(g));
   list.Add(f);}
  return list;
 }

 static IFeature GuideFromSegments(IModelDoc2 d,Dictionary<string,object>g,List<string> tried){
  var src=SketchFeature(d,Str(g,"sketch"));var sk=(ISketch)src.GetSpecificFeature2();
  if(sk.Is3D())throw new Exception("guide from segments: "+src.Name+" is a 3D sketch; give it whole");
  var segs=((object[])sk.GetSketchSegments()??new object[0]).Cast<ISketchSegment>().ToArray();
  var idx=Items(g["segments"]).Select(Convert.ToInt32).ToArray();
  foreach(var i in idx)if(i<0||i>=segs.Length)throw new Exception("guide from segments: "+src.Name+" has segments 0.."+(segs.Length-1)+" (sw_sketch lists them)");
  int type=0;var refEnt=sk.GetReferenceEntity(ref type);
  d.ClearSelection2(true);bool sel=refEnt is IFeature?((IFeature)refEnt).Select2(false,0):refEnt is IEntity&&((IEntity)refEnt).Select4(false,null);
  if(!sel)throw new Exception("guide from segments: cannot select the plane of "+src.Name);
  d.SketchManager.InsertSketch(true);string name=null;int made=0;
  try{
   var act=d.SketchManager.ActiveSketch;if(act==null)throw new Exception("guide from segments: could not open a sketch");
   d.ClearSelection2(true);foreach(var i in idx)if(!segs[i].Select4(true,null))throw new Exception("guide from segments: cannot select segment "+i+" of "+src.Name);
   if(!d.SketchManager.SketchUseEdge3(false,false))throw new Exception("guide from segments: Convert Entities failed on "+src.Name);
   made=((object[])act.GetSketchSegments()??new object[0]).Length;name=((IFeature)act).Name;
  }finally{if(d.SketchManager.ActiveSketch!=null)d.SketchManager.InsertSketch(true);d.ClearSelection2(true);}
  if(made!=idx.Length)throw new Exception("guide from segments: converted "+made+" of "+idx.Length+" segments of "+src.Name);
  tried.Add("guide "+name+" = segments "+string.Join(",",idx)+" of "+src.Name);
  return Feature(d,name);
 }

 // ---- loft check ----
 // a segment in sketch space: lines and arcs exactly from their points (the API curve of a sketch line is the whole line and
 // its parameters are not the segment's), anything else (splines) by its API curve; pts are model-space samples
 class GSeg{public int kind;public double[] a,b,c;public double r,a0,sweep;public ICurve curve;public bool model;public MathTransform toModel,toSketch;public List<double[]> pts=new List<double[]>();}

 static double[] GXf(IMathUtility mu,MathTransform xf,double[] p){if(xf==null)return p;return (double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{p[0],p[1],p[2]})).MultiplyTransform(xf)).ArrayData;}
 static double GDist(double[] p,double[] q){double x=p[0]-q[0],y=p[1]-q[1],z=p[2]-q[2];return Math.Sqrt(x*x+y*y+z*z);}
 static double[] GP(ISketchPoint p){return new[]{p.X,p.Y,p.Z};}

 static List<GSeg> GSegs(IModelDoc2 d,IFeature f,int n,int[] idx=null){
  var mu=(IMathUtility)sw.GetMathUtility();var sk=(ISketch)f.GetSpecificFeature2();bool is3d=sk.Is3D();
  MathTransform m2s=is3d?null:sk.ModelToSketchTransform;MathTransform s2m=m2s==null?null:(MathTransform)m2s.Inverse();
  var r=new List<GSeg>();int si=-1;
  foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0]){si++;
   if(idx!=null&&!idx.Contains(si))continue;if(s.ConstructionGeometry)continue;
   var g=new GSeg{toModel=s2m,toSketch=m2s};var local=new List<double[]>();
   if(s is ISketchLine){var l=(ISketchLine)s;g.kind=0;g.a=GP((ISketchPoint)l.GetStartPoint2());g.b=GP((ISketchPoint)l.GetEndPoint2());
    for(int k=0;k<=n;k++){double t=(double)k/n;local.Add(new[]{g.a[0]+(g.b[0]-g.a[0])*t,g.a[1]+(g.b[1]-g.a[1])*t,g.a[2]+(g.b[2]-g.a[2])*t});}}
   else if(s is ISketchArc&&!is3d){var ar=(ISketchArc)s;g.kind=1;g.c=GP((ISketchPoint)ar.GetCenterPoint2());g.r=ar.GetRadius();
    var p0=GP((ISketchPoint)ar.GetStartPoint2());var p1=GP((ISketchPoint)ar.GetEndPoint2());int dir=ar.GetRotationDir()<0?-1:1;
    double t0=Math.Atan2(p0[1]-g.c[1],p0[0]-g.c[0]),t1=Math.Atan2(p1[1]-g.c[1],p1[0]-g.c[0]);
    double sw0=((t1-t0)*dir)%(2*Math.PI);if(sw0<0)sw0+=2*Math.PI;if(ar.IsCircle()==1||sw0<1e-12)sw0=2*Math.PI;
    g.a0=t0;g.sweep=sw0;g.a=new[]{(double)dir};
    for(int k=0;k<=n;k++){double t=t0+dir*sw0*k/n;local.Add(new[]{g.c[0]+g.r*Math.Cos(t),g.c[1]+g.r*Math.Sin(t),g.c[2]});}}
   else{var cv=s.GetCurve() as ICurve;if(cv==null)continue;g.kind=2;g.curve=cv;double t0=0,t1=0;bool cl=false,per=false;cv.GetEndParams(out t0,out t1,out cl,out per);
    // the curve's own space: whichever of sketch or model space its two ends match
    var e0=(double[])cv.Evaluate2(t0,0);var e1=(double[])cv.Evaluate2(t1,0);var q0=new[]{e0[0],e0[1],e0[2]};var q1=new[]{e1[0],e1[1],e1[2]};var ends=SegEnds(s);
    Func<List<double[]>,double> fit=q=>Math.Min(GDist(q0,q[0])+GDist(q1,q[1]),GDist(q0,q[1])+GDist(q1,q[0]));
    g.model=s2m==null||(ends.Count>=2&&fit(ends.Select(q=>GXf(mu,s2m,q)).ToList())<fit(ends)-1e-9);
    for(int k=0;k<=n;k++){var e=(double[])cv.Evaluate2(t0+(t1-t0)*k/n,0);var q=new[]{e[0],e[1],e[2]};if(g.model)g.pts.Add(q);else local.Add(q);}}
   foreach(var q in local)g.pts.Add(GXf(mu,s2m,q));
   r.Add(g);}
  return r;
 }
 static List<double[]> SegEnds(ISketchSegment s){var r=new List<double[]>();var ps=new List<ISketchPoint>();
  if(s is ISketchLine){ps.Add((ISketchPoint)((ISketchLine)s).GetStartPoint2());ps.Add((ISketchPoint)((ISketchLine)s).GetEndPoint2());}
  else if(s is ISketchArc){ps.Add((ISketchPoint)((ISketchArc)s).GetStartPoint2());ps.Add((ISketchPoint)((ISketchArc)s).GetEndPoint2());}
  else if(s is ISketchSpline){var pts=(object[])((ISketchSpline)s).GetPoints2();if(pts!=null&&pts.Length>0){ps.Add((ISketchPoint)pts[0]);ps.Add((ISketchPoint)pts[pts.Length-1]);}}
  foreach(var p in ps)if(p!=null)r.Add(new[]{p.X,p.Y,p.Z});return r;}

 // exact closest point of the segment to a model point (model space)
 static double[] GClosest(IMathUtility mu,GSeg g,double[] p){
  var q=g.toSketch==null?p:GXf(mu,g.toSketch,p);double[] m;
  if(g.kind==0){double[] u={g.b[0]-g.a[0],g.b[1]-g.a[1],g.b[2]-g.a[2]};double uu=u[0]*u[0]+u[1]*u[1]+u[2]*u[2];
   double t=uu<1e-24?0:((q[0]-g.a[0])*u[0]+(q[1]-g.a[1])*u[1]+(q[2]-g.a[2])*u[2])/uu;t=Math.Max(0,Math.Min(1,t));m=new[]{g.a[0]+u[0]*t,g.a[1]+u[1]*t,g.a[2]+u[2]*t};}
  else if(g.kind==1){int dir=(int)g.a[0];double th=Math.Atan2(q[1]-g.c[1],q[0]-g.c[0]);double ph=((th-g.a0)*dir)%(2*Math.PI);if(ph<0)ph+=2*Math.PI;
   if(ph<=g.sweep+1e-12)m=new[]{g.c[0]+g.r*Math.Cos(th),g.c[1]+g.r*Math.Sin(th),g.c[2]};
   else{double te=g.a0+dir*g.sweep;var s0=new[]{g.c[0]+g.r*Math.Cos(g.a0),g.c[1]+g.r*Math.Sin(g.a0),g.c[2]};var s1=new[]{g.c[0]+g.r*Math.Cos(te),g.c[1]+g.r*Math.Sin(te),g.c[2]};m=GDist(q,s0)<=GDist(q,s1)?s0:s1;}}
  else{var cq=g.model?p:q;var r=g.curve.GetClosestPointOn(cq[0],cq[1],cq[2]) as double[];if(r==null)return null;var mw=new[]{r[0],r[1],r[2]};if(!g.model)mw=GXf(mu,g.toModel,mw);
   double gap=0;for(int k=1;k<g.pts.Count;k++)gap=Math.Max(gap,GDist(g.pts[k-1],g.pts[k]));
   if(g.pts.Count>1&&g.pts.Min(x=>GDist(x,mw))>0.75*gap+1e-9){var e0=g.pts[0];var e1=g.pts[g.pts.Count-1];return GDist(p,e0)<=GDist(p,e1)?e0:e1;}
   return mw;}
  return g.toModel==null?m:GXf(mu,g.toModel,m);
 }

 static double GCurveDist(IMathUtility mu,List<GSeg> A,List<GSeg> B,out double[] at){
  double best=double.MaxValue;double[] pa=null,pb=null;GSeg sa=null,sb=null;at=null;
  foreach(var x in A)foreach(var p in x.pts)foreach(var y in B)foreach(var q in y.pts){double dd=GDist(p,q);if(dd<best){best=dd;pa=p;pb=q;sa=x;sb=y;}}
  if(pa==null)return double.NaN;
  try{for(int k=0;k<12;k++){var nb=GClosest(mu,sb,pa);if(nb==null)break;var na=GClosest(mu,sa,nb);if(na==null)break;double dd=GDist(na,nb);pa=na;pb=nb;if(dd<best)best=dd;}}catch{}
  at=pa;return best;
 }

 // is the sketch one joined open chain? endpoints at the same place that are different sketch points are "not merged"
 static Dictionary<string,object> GChain(IFeature f,int[] idx=null){
  var sk=(ISketch)f.GetSpecificFeature2();var ends=new List<Tuple<double[],string>>();int nseg=0;int si=-1;
  foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0]){si++;
   if(idx!=null&&!idx.Contains(si))continue;
   if(s.ConstructionGeometry)continue;nseg++;ISketchPoint p0=null,p1=null;
   if(s is ISketchLine){p0=(ISketchPoint)((ISketchLine)s).GetStartPoint2();p1=(ISketchPoint)((ISketchLine)s).GetEndPoint2();}
   else if(s is ISketchArc){p0=(ISketchPoint)((ISketchArc)s).GetStartPoint2();p1=(ISketchPoint)((ISketchArc)s).GetEndPoint2();}
   else if(s is ISketchSpline){var pts=(object[])((ISketchSpline)s).GetPoints2();if(pts!=null&&pts.Length>1){p0=(ISketchPoint)pts[0];p1=(ISketchPoint)pts[pts.Length-1];}}
   foreach(var p in new[]{p0,p1})if(p!=null){var id=(int[])p.GetID();ends.Add(Tuple.Create(new[]{p.X,p.Y,p.Z},id==null?"":string.Join(".",id)));}}
  var groups=new List<List<Tuple<double[],string>>>();
  foreach(var e in ends){var g=groups.FirstOrDefault(x=>GDist(x[0].Item1,e.Item1)<1e-7);if(g==null)groups.Add(new List<Tuple<double[],string>>{e});else g.Add(e);}
  int open=groups.Count(x=>x.Count==1),branch=groups.Count(x=>x.Count>2);
  var unmerged=groups.Where(x=>x.Select(y=>y.Item2).Distinct().Count()>1).Select(x=>x[0].Item1.Select(v=>Math.Round(v*1000,3)).ToArray()).ToList();
  bool ok=nseg>0&&open==2&&branch==0&&unmerged.Count==0;
  string why=nseg==0?"no segments":branch>0?"branches ("+branch+" points shared by 3+ segments): a guide is one chain":open==0?"closed loop: a guide is an open chain":open>2?(open/2)+" pieces, not one chain (gaps)":unmerged.Count>0?"points at the same place but not merged (add a coincident/merge relation or redraw)":"one joined open chain";
  return new Dictionary<string,object>{{"segments",nseg},{"open_ends",open},{"not_merged_at_sketch_mm",unmerged},{"ok",ok},{"chain",why}};
 }

 static object LoftCheck(IModelDoc2 d,List<IFeature> profiles,List<IFeature> guides){return LoftCheck(d,profiles,guides.Select(g=>Tuple.Create(g.Name,g,(int[])null)).ToList());}
 // read-only: a guide given as {sketch, segments} is checked on those segments, nothing is converted
 static List<Tuple<string,IFeature,int[]>> GuideSpecs(IModelDoc2 d,Dictionary<string,object>a){
  return Items(a["guides"]).Select(o=>{if(o is Dictionary<string,object>){var g=(Dictionary<string,object>)o;var f=SketchFeature(d,Str(g,"sketch"));var ix=Items(g["segments"]).Select(Convert.ToInt32).ToArray();
   return Tuple.Create(f.Name+"["+string.Join(",",ix)+"]",f,ix);}var ff=Feature(d,Convert.ToString(o));return Tuple.Create(ff.Name,ff,(int[])null);}).ToList();
 }
 static object LoftCheck(IModelDoc2 d,List<IFeature> profiles,List<Tuple<string,IFeature,int[]>> guides){
  var mu=(IMathUtility)sw.GetMathUtility();var P=profiles.Select(p=>Tuple.Create(p.Name,GSegs(d,p,60))).ToList();
  var rows=new List<object>();var problems=new List<string>();
  foreach(var gs in guides){string gn=gs.Item1;
   var ch=GChain(gs.Item2,gs.Item3);if(!(bool)ch["ok"])problems.Add(gn+": "+ch["chain"]);
   var G=GSegs(d,gs.Item2,60,gs.Item3);var dist=new List<object>();
   foreach(var p in P){double[] at;double dd=GCurveDist(mu,G,p.Item2,out at)*1000;bool touch=dd<=0.01;
    if(!touch)problems.Add(gn+" misses "+p.Item1+" by "+Math.Round(dd,3)+" mm"+(at!=null?" (closest at "+string.Join(", ",at.Select(v=>Math.Round(v*1000,2)))+" mm)":""));
    dist.Add(new{profile=p.Item1,distance_mm=Math.Round(dd,4),touches=touch});}
   rows.Add(new{guide=gn,chain=ch,profiles=dist});}
  return new{ok=problems.Count==0,problems,guides=rows,note=problems.Count==0?"Every guide is one chain and touches every profile; if the loft still fails, try the profiles in another order, fewer guides, or start points (profiles must not twist).":"Fix these before the loft: a guide must be one joined open chain and pierce or touch every profile (a profile point on the guide)."};
 }
}
