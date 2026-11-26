using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 dimension_style "drawing": an inclined line gets its length (aligned dimension) and its angle to a neighbouring line, the way
// school drawings show it, instead of the horizontal and vertical offsets of its two ends that Fully Define gives. They are added in the
// active sketch before Fully Define, which then adds only what is still missing. A dimension that would over-define the sketch or come
// out driven is taken back.
partial class Worker {
 static readonly List<Tuple<string,IDisplayDimension,string>> drawingAdded=new List<Tuple<string,IDisplayDimension,string>>();
 static object AddDrawingDims(IModelDoc2 d,ISketch sketch){
  var mu=(IMathUtility)sw.GetMathUtility();var toModel=(MathTransform)((MathTransform)sketch.ModelToSketchTransform).Inverse();
  Func<double,double,double[]> M=(x,y)=>(double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{x,y,0.0})).MultiplyTransform(toModel)).ArrayData;
  var lines=((object[])sketch.GetSketchSegments()??new object[0]).OfType<ISketchLine>().Where(l=>!((ISketchSegment)l).ConstructionGeometry).ToList();
  Func<ISketchLine,double[]> E=l=>{var p=(ISketchPoint)l.GetStartPoint2();var q=(ISketchPoint)l.GetEndPoint2();return new[]{p.X,p.Y,q.X,q.Y};};
  Func<double[],double> Len=e=>Math.Sqrt(Math.Pow(e[2]-e[0],2)+Math.Pow(e[3]-e[1],2));
  Func<double[],bool> hv=e=>{double l=Len(e);return l<1e-12||Math.Abs(e[2]-e[0])/l<1e-6||Math.Abs(e[3]-e[1])/l<1e-6;};
  Func<double,double,double,double,bool> same=(x1,y1,x2,y2)=>Math.Abs(x1-x2)<1e-9&&Math.Abs(y1-y2)<1e-9;
  // the middle of the sketch, to put a length on the outer side of its line
  double cx=0,cy=0;int np=0;foreach(var l in lines){var e=E(l);cx+=e[0]+e[2];cy+=e[1]+e[3];np+=2;}if(np>0){cx/=np;cy/=np;}
  int aligned=0,angles=0;var skipped=new List<object>();var pairs=new HashSet<string>();
  // a new dimension that left the sketch over-defined (or driven) is deleted again
  Func<object,string,bool> keep=(o,what)=>{
   var dd=o as IDisplayDimension;if(dd==null){skipped.Add(new{what,why="SolidWorks gave no dimension"});return false;}
   int st=sketch.GetConstrainedStatus();bool driven=false;try{driven=((IDimension)dd.GetDimension2(0)).DrivenState==(int)swDimensionDrivenState_e.swDimensionDriven;}catch{}
   if(driven||(st!=(int)swConstrainedStatus_e.swUnderConstrained&&st!=(int)swConstrainedStatus_e.swFullyConstrained)){
    d.ClearSelection2(true);try{((IAnnotation)dd.GetAnnotation()).Select3(false,null);d.EditDelete();}catch{}d.ClearSelection2(true);
    skipped.Add(new{what,why=driven?"it came out driven (the sketch already fixes it)":"it over-defined the sketch (status "+st+")"});return false;}
   return true;};
  foreach(var l in lines){var e=E(l);if(hv(e))continue;double len=Len(e);
   double mx=(e[0]+e[2])/2,my=(e[1]+e[3])/2,nx=-(e[3]-e[1])/len,ny=(e[2]-e[0])/len;if(nx*(mx-cx)+ny*(my-cy)<0){nx=-nx;ny=-ny;}
   string ln=((ISketchSegment)l).GetName();
   // length along the line
   d.ClearSelection2(true);if(((ISketchSegment)l).Select4(false,null)){var at=M(mx+nx*len*0.25,my+ny*len*0.25);var od=d.AddDimension2(at[0],at[1],at[2]);if(keep(od,"length of "+ln)){aligned++;drawingAdded.Add(Tuple.Create("length",(IDisplayDimension)od,"length of "+ln));}}
   // angle to a neighbour that shares an end: horizontal or vertical first, never a parallel one, each pair once
   ISketchLine nb=null;double[] vtx=null,far1=null,far2=null;
   foreach(var o in lines.Where(x=>x!=l).OrderBy(x=>hv(E(x))?0:1)){var f=E(o);
    for(int i=0;i<2&&nb==null;i++)for(int j=0;j<2&&nb==null;j++){if(!same(e[i*2],e[i*2+1],f[j*2],f[j*2+1]))continue;
     double ux=e[(1-i)*2]-e[i*2],uy=e[(1-i)*2+1]-e[i*2+1],vx=f[(1-j)*2]-f[j*2],vy=f[(1-j)*2+1]-f[j*2+1];
     double cr=ux*vy-uy*vx;if(Math.Abs(cr)<1e-9*Math.Sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy)))continue;
     string key=string.Join("|",new[]{ln,((ISketchSegment)o).GetName()}.OrderBy(s=>s));if(pairs.Contains(key))continue;
     nb=o;vtx=new[]{e[i*2],e[i*2+1]};far1=new[]{ux,uy};far2=new[]{vx,vy};pairs.Add(key);}
    if(nb!=null)break;}
   if(nb==null){skipped.Add(new{what="angle of "+ln,why="no line meets it at an end"});continue;}
   double l1=Math.Sqrt(far1[0]*far1[0]+far1[1]*far1[1]),l2=Math.Sqrt(far2[0]*far2[0]+far2[1]*far2[1]);
   double bx=far1[0]/l1+far2[0]/l2,by=far1[1]/l1+far2[1]/l2,bl=Math.Sqrt(bx*bx+by*by);if(bl<1e-9)continue;
   double r=Math.Min(l1,l2)*0.3;var ap=M(vtx[0]+bx/bl*r,vtx[1]+by/bl*r);
   d.ClearSelection2(true);if(((ISketchSegment)l).Select4(false,null)&&((ISketchSegment)nb).Select4(true,null)){var oa=d.AddDimension2(ap[0],ap[1],ap[2]);string wn="angle "+ln+" / "+((ISketchSegment)nb).GetName();if(keep(oa,wn)){angles++;drawingAdded.Add(Tuple.Create("angle",(IDisplayDimension)oa,wn));}}
  }
  d.ClearSelection2(true);
  return new{aligned_lengths=aligned,angles,skipped=skipped.Count>0?skipped:null};
 }
}
