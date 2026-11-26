using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

// v3.24 section_area (gancho, 25-nov): read-only area of the cut of the solid by a plane, to compare a loft with the sections
// of the drawing or find where mass is missing. A COPY of every solid body is intersected with a thin temporary slab
// (IModeler, never in the document): area = volume / thickness. RayIntersections crashed SolidWorks (RPC_E_SERVERFAULT) and
// Operations2 15903 ADDS the bodies; 15901 is intersect. size_mm (a square around origin_mm) keeps only one side of the part.
partial class Worker {
 static bool TrySectionArea(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="section_area")return false;result=SectionArea(d,a);return true;
 }

 static object SectionArea(IModelDoc2 d,Dictionary<string,object>a){
  if(d.GetType()!=1)throw new Exception("section_area needs a part");
  var bodies=((object[])((IPartDoc)d).GetBodies2(0,true)??new object[0]).Cast<IBody2>().ToList();
  if(bodies.Count==0)throw new Exception("section_area measures solid bodies and this part has none (surfaces: knit them into a solid or thicken first)");
  var bb=new[]{double.MaxValue,double.MaxValue,double.MaxValue,double.MinValue,double.MinValue,double.MinValue};
  foreach(var b in bodies){var x=(double[])b.GetBodyBox();for(int i=0;i<3;i++){bb[i]=Math.Min(bb[i],x[i]);bb[i+3]=Math.Max(bb[i+3],x[i+3]);}}
  double diag=Math.Sqrt(Enumerable.Range(0,3).Sum(i=>(bb[i+3]-bb[i])*(bb[i+3]-bb[i])));
  double[] mid={(bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2};
  var mo=(IModeler)sw.GetModeler();double t=a.ContainsKey("thickness_mm")?Num(a,"thickness_mm")/1000:0.0002;
  var rows=new List<object>();int k=0;
  foreach(var o in Items(a["sections"])){
   var s=(Dictionary<string,object>)o;string label=s.ContainsKey("name")?Str(s,"name"):"#"+k;k++;
   double[] n,c;
   if(s.ContainsKey("plane_index")){
    var pf=PlaneByIndex(d,Convert.ToInt32(s["plane_index"]));var rp=pf.GetSpecificFeature2() as IRefPlane;if(rp==null)throw new Exception(label+": plane_index is not a reference plane");
    var xa=(double[])rp.Transform.ArrayData;n=new[]{xa[6],xa[7],xa[8]};var p0=new[]{xa[9],xa[10],xa[11]};
    var q=s.ContainsKey("origin_mm")?Items(s["origin_mm"]).Select(w=>Convert.ToDouble(w)/1000).ToArray():mid;
    double dd=(q[0]-p0[0])*n[0]+(q[1]-p0[1])*n[1]+(q[2]-p0[2])*n[2];c=new[]{q[0]-dd*n[0],q[1]-dd*n[1],q[2]-dd*n[2]};label+=" ("+pf.Name+")";}
   else{
    if(!s.ContainsKey("origin_mm")||!s.ContainsKey("normal"))throw new Exception(label+": give plane_index, or origin_mm and normal");
    c=Items(s["origin_mm"]).Select(w=>Convert.ToDouble(w)/1000).ToArray();n=Items(s["normal"]).Select(Convert.ToDouble).ToArray();}
   double nl=Math.Sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);if(nl<1e-12)throw new Exception(label+": normal is zero");n=n.Select(v=>v/nl).ToArray();
   double L=s.ContainsKey("size_mm")?Num(s,"size_mm")/1000:2.2*diag;
   var box=(IBody2)mo.CreateBodyFromBox3(new[]{c[0],c[1],c[2],n[0],n[1],n[2],L,L,t});
   if(box==null){rows.Add(new{name=label,error="the temporary slab could not be made"});continue;}
   double vol=0;int pieces=0;var sb=new[]{double.MaxValue,double.MaxValue,double.MaxValue,double.MinValue,double.MinValue,double.MinValue};string err=null;
   foreach(var b in bodies){
    int e;object[] res=null;
    try{res=(object[])((IBody2)b.Copy()).Operations2(15901,(IBody2)box.Copy(),out e);if(e!=0&&res==null)err="intersect error "+e;}catch(Exception ex){err=ex.Message;}
    if(res!=null)foreach(IBody2 r in res){vol+=((double[])r.GetMassProperties(1))[3];pieces++;var x=(double[])r.GetBodyBox();for(int i=0;i<3;i++){sb[i]=Math.Min(sb[i],x[i]);sb[i+3]=Math.Max(sb[i+3],x[i+3]);}}}
   rows.Add(pieces==0?(object)new{name=label,area_mm2=0.0,pieces=0,note=err??"the plane does not cut the solid there"}
    :new{name=label,area_mm2=Math.Round(vol/t*1e6,2),pieces,box_min_mm=sb.Take(3).Select(x=>Math.Round(x*1000,2)).ToArray(),box_max_mm=sb.Skip(3).Select(x=>Math.Round(x*1000,2)).ToArray(),
     center_mm=c.Select(x=>Math.Round(x*1000,3)).ToArray(),normal=n.Select(x=>Math.Round(x,6)).ToArray(),square_mm=Math.Round(L*1000,1)});
  }
  return new{sections=rows,thickness_mm=t*1000,note="Area of the cut, from a thin slab (error ~ thickness x slope of the walls). Nothing in the part changes. pieces > 1 means the plane cuts the solid in separate places; size_mm keeps one side."};
 }
}
