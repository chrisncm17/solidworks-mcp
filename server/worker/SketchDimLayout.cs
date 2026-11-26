using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.20 sketch dimensions in order. FullyDefineSketch leaves each dimension where its own placement puts it, piled on the
// geometry and on each other. Like the tracks of a drawing (dims_layout.mjs): horizontal distances in rows under the sketch and
// vertical ones in columns to its left, the shortest nearest, two in one row only when they do not overlap; radii and diameters
// just outside their arc, away from the middle. Only the text moves: the geometry and the values stay as they are.
partial class Worker {
 // a point of any sketch (this one, or the origin of another) in the coordinates of `into`
 static double[] SkPoint(IMathUtility mu,MathTransform into,ISketch own,double x,double y,double z){
  var p=(MathPoint)mu.CreatePoint(new[]{x,y,z});
  if(own!=null)p=(MathPoint)p.MultiplyTransform((MathTransform)((MathTransform)own.ModelToSketchTransform).Inverse());
  p=(MathPoint)p.MultiplyTransform(into);var a=(double[])p.ArrayData;return new[]{a[0],a[1]};
 }
 // greedy rows: each interval goes in the first row where it does not touch another (spans sorted shortest first)
 static int SkRow(List<List<double[]>> rows,double lo,double hi,double clear){
  for(int r=0;r<rows.Count;r++)if(rows[r].All(t=>hi+clear<=t[0]||lo>=t[1]+clear)){rows[r].Add(new[]{lo,hi});return r;}
  rows.Add(new List<double[]>{new[]{lo,hi}});return rows.Count-1;
 }
 static object ArrangeSketchDims(IModelDoc2 d,ISketch sketch,IFeature sf){
  var mu=(IMathUtility)sw.GetMathUtility();var into=(MathTransform)sketch.ModelToSketchTransform;var toModel=(MathTransform)into.Inverse();
  double x0=double.MaxValue,x1=double.MinValue,y0=double.MaxValue,y1=double.MinValue;
  Action<double,double> grow=(x,y)=>{x0=Math.Min(x0,x);x1=Math.Max(x1,x);y0=Math.Min(y0,y);y1=Math.Max(y1,y);};
  foreach(object o in (object[])sketch.GetSketchSegments()??new object[0]){var s=o as ISketchSegment;if(s==null||s.ConstructionGeometry)continue;
   if(s is ISketchLine){var l=(ISketchLine)s;foreach(var p in new[]{(ISketchPoint)l.GetStartPoint2(),(ISketchPoint)l.GetEndPoint2()})grow(p.X,p.Y);}
   else if(s is ISketchArc){var c=(ISketchArc)s;var cp=(ISketchPoint)c.GetCenterPoint2();double r=c.GetRadius();grow(cp.X-r,cp.Y-r);grow(cp.X+r,cp.Y+r);}}
  if(x0>x1)return new{arranged=0,note="no lines or arcs to place dimensions around"};
  double size=Math.Max(x1-x0,y1-y0),gap=Math.Max(size*0.12,0.004),step=Math.Max(size*0.09,0.0035),cx=(x0+x1)/2,cy=(y0+y1)/2;
  var hor=new List<Tuple<IAnnotation,double,double>>();var ver=new List<Tuple<IAnnotation,double,double>>();
  var radial=new List<Tuple<IAnnotation,double[],double>>();int asPlaced=0,n=0;var why=new List<object>();
  var aligned=new List<Tuple<IDisplayDimension,double[],double[]>>();var angular=new List<IDisplayDimension>();
  var dd=(IDisplayDimension)sf.GetFirstDisplayDimension();
  while(dd!=null&&n++<1000){
   var an=(IAnnotation)dd.GetAnnotation();double v=Math.Abs(((IDimension)dd.GetDimension2(0)).SystemValue);
   var pts=new List<double[]>();double[] ctr=null;double rad=0;
   foreach(object o in (object[])an.GetAttachedEntities3()??new object[0]){
    if(o is ISketchPoint){var p=(ISketchPoint)o;pts.Add(SkPoint(mu,into,(ISketch)p.GetSketch(),p.X,p.Y,p.Z));}
    else if(o is ISketchLine){var l=(ISketchLine)o;var sk=(ISketch)((ISketchSegment)l).GetSketch();foreach(var p in new[]{(ISketchPoint)l.GetStartPoint2(),(ISketchPoint)l.GetEndPoint2()})pts.Add(SkPoint(mu,into,sk,p.X,p.Y,p.Z));}
    else if(o is ISketchArc){var c=(ISketchArc)o;var sk=(ISketch)((ISketchSegment)c).GetSketch();var cp=(ISketchPoint)c.GetCenterPoint2();ctr=SkPoint(mu,into,sk,cp.X,cp.Y,cp.Z);rad=c.GetRadius();pts.Add(ctr);}}
   // a dimension of a part sketch often gives no attached entities: its reference points (model space) say where it measures
   if(pts.Count<2&&ctr==null){try{var rp=(object[])((IDimension)dd.GetDimension2(0)).ReferencePoints;
    if(rp!=null)foreach(var o in rp.Take(2)){var a2=(double[])((MathPoint)o).ArrayData;pts.Add(SkPoint(mu,into,null,a2[0],a2[1],a2[2]));}}catch{}}
   int ty=dd.Type2;
   if((ty==(int)swDimensionType_e.swRadialDimension||ty==(int)swDimensionType_e.swDiameterDimension)&&ctr!=null)radial.Add(Tuple.Create(an,ctr,rad));
   // Fully Define gives horizontal (11) and vertical (12) linear dimensions; a plain linear one (2) is told apart by its span
   else if((ty==(int)swDimensionType_e.swLinearDimension||ty==(int)swDimensionType_e.swHorLinearDimension||ty==(int)swDimensionType_e.swVertLinearDimension)&&pts.Count>=2){
    double lx=pts.Min(p=>p[0]),hx=pts.Max(p=>p[0]),ly=pts.Min(p=>p[1]),hy=pts.Max(p=>p[1]),eps=1e-7+v*1e-6;
    if(ty==(int)swDimensionType_e.swHorLinearDimension)hor.Add(Tuple.Create(an,lx,hx));else if(ty==(int)swDimensionType_e.swVertLinearDimension)ver.Add(Tuple.Create(an,ly,hy));
    else if(Math.Abs(hx-lx-v)<eps)hor.Add(Tuple.Create(an,lx,hx));else if(Math.Abs(hy-ly-v)<eps)ver.Add(Tuple.Create(an,ly,hy));
    else if(pts.Count>=2&&Math.Abs(Math.Sqrt(Math.Pow(pts[1][0]-pts[0][0],2)+Math.Pow(pts[1][1]-pts[0][1],2))-v)<eps*10+1e-6)aligned.Add(Tuple.Create(dd,pts[0],pts[1]));
    else{asPlaced++;why.Add(new{dim=((IDimension)dd.GetDimension2(0)).FullName,dx_mm=Math.Round((hx-lx)*1000,3),dy_mm=Math.Round((hy-ly)*1000,3),value_mm=Math.Round(v*1000,3)});}}
   else if(ty==(int)swDimensionType_e.swAngularDimension)angular.Add(dd);
   else{asPlaced++;why.Add(new{dim=((IDimension)dd.GetDimension2(0)).FullName,type=ty,points=pts.Count});}
   dd=(IDisplayDimension)sf.GetNextDisplayDimension(dd);
  }
  int moved=0;
  Func<IAnnotation,double,double,bool> put=(an,x,y)=>{var m=(double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{x,y,0.0})).MultiplyTransform(toModel)).ArrayData;bool ok=an.SetPosition2(m[0],m[1],m[2]);if(ok)moved++;return ok;};
  var rowsH=new List<List<double[]>>();foreach(var h in hor.OrderBy(t=>t.Item3-t.Item2)){int r=SkRow(rowsH,h.Item2,h.Item3,step);put(h.Item1,(h.Item2+h.Item3)/2,y0-gap-r*step);}
  var rowsV=new List<List<double[]>>();foreach(var t in ver.OrderBy(t=>t.Item3-t.Item2)){int r=SkRow(rowsV,t.Item2,t.Item3,step);put(t.Item1,x0-gap-r*step,(t.Item2+t.Item3)/2);}
  foreach(var r in radial){double dx=r.Item2[0]-cx,dy=r.Item2[1]-cy,len=Math.Sqrt(dx*dx+dy*dy);if(len<1e-9){dx=Math.Sqrt(0.5);dy=dx;len=1;}
   put(r.Item1,r.Item2[0]+dx/len*(r.Item3+gap*0.6),r.Item2[1]+dy/len*(r.Item3+gap*0.6));}
  // v3.22 aligned distances: beside their segment, on the side away from the middle of the sketch; angles: near their vertex on
  // the side where SolidWorks put them (the other side would measure the supplement). A move that changes the value goes back.
  int alignedDone=0,angularDone=0;
  Func<IDisplayDimension,double,double,bool> careful=(dd2,x,y)=>{var an=(IAnnotation)dd2.GetAnnotation();var dim=(IDimension)dd2.GetDimension2(0);double before=dim.SystemValue;
   var old=(double[])an.GetPosition();if(!put(an,x,y))return false;
   if(Math.Abs(dim.SystemValue-before)>1e-9){an.SetPosition2(old[0],old[1],old[2]);dim.SystemValue=before;moved--;why.Add(new{dim=dim.FullName,note="moving it changed what it measures; left where SolidWorks put it"});asPlaced++;return false;}return true;};
  foreach(var t in aligned){double mx=(t.Item2[0]+t.Item3[0])/2,my=(t.Item2[1]+t.Item3[1])/2,ux=t.Item3[0]-t.Item2[0],uy=t.Item3[1]-t.Item2[1],l=Math.Sqrt(ux*ux+uy*uy);if(l<1e-9)continue;
   double nx=-uy/l,ny=ux/l;if(nx*(mx-cx)+ny*(my-cy)<0){nx=-nx;ny=-ny;}if(careful(t.Item1,mx+nx*gap,my+ny*gap))alignedDone++;}
  foreach(var dd2 in angular){var an=(IAnnotation)dd2.GetAnnotation();var lines=((object[])an.GetAttachedEntities3()??new object[0]).OfType<ISketchLine>().ToList();
   if(lines.Count<2){asPlaced++;why.Add(new{dim=((IDimension)dd2.GetDimension2(0)).FullName,note="angle without two sketch lines"});continue;}
   Func<ISketchLine,double[][]> ends=ln=>{var sk=(ISketch)((ISketchSegment)ln).GetSketch();var p1=(ISketchPoint)ln.GetStartPoint2();var p2=(ISketchPoint)ln.GetEndPoint2();return new[]{SkPoint(mu,into,sk,p1.X,p1.Y,p1.Z),SkPoint(mu,into,sk,p2.X,p2.Y,p2.Z)};};
   var A=ends(lines[0]);var B=ends(lines[1]);double d1x=A[1][0]-A[0][0],d1y=A[1][1]-A[0][1],d2x=B[1][0]-B[0][0],d2y=B[1][1]-B[0][1],den=d1x*d2y-d1y*d2x;
   if(Math.Abs(den)<1e-12)continue;double tt=((B[0][0]-A[0][0])*d2y-(B[0][1]-A[0][1])*d2x)/den;double vx=A[0][0]+tt*d1x,vy=A[0][1]+tt*d1y;
   var cur=SkPoint(mu,into,null,((double[])an.GetPosition())[0],((double[])an.GetPosition())[1],((double[])an.GetPosition())[2]);double ox=cur[0]-vx,oy=cur[1]-vy,ol=Math.Sqrt(ox*ox+oy*oy);if(ol<1e-9)continue;
   double rr=Math.Max(gap*1.2,Math.Min(Math.Sqrt(d1x*d1x+d1y*d1y),Math.Sqrt(d2x*d2x+d2y*d2y))*0.35);if(careful(dd2,vx+ox/ol*rr,vy+oy/ol*rr))angularDone++;}
  try{d.GraphicsRedraw2();}catch{}
  return new{arranged=moved,rows_below=rowsH.Count,columns_left=rowsV.Count,horizontal=hor.Count,vertical=ver.Count,radial=radial.Count,aligned=alignedDone,angular=angularDone,left_as_placed=asPlaced,why_left=why.Count>0?why:null};
 }
}
