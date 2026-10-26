using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.10 drawing additions (ideas from haunchen/solidworks-mcp, MIT):
//  drawing_views action=detail - detail view (vista de detalle): a circle drawn in the parent view around a point given in MODEL
//                                coordinates, magnified into a new view placed on a free spot of the sheet.
//  drawing_dimension           - probe lists the visible edges of one view with an index (line/circle/arc, model and sheet mm);
//                                add places a dimension on one or two of those edges (smart, horizontal, vertical, diameter,
//                                radius, angle) and reads its value back.
partial class Worker {
 static IView FindSheetView(IDrawingDoc dr,Dictionary<string,object> a){
  string sheet=Str(a,"sheet"),viewName=Str(a,"view");
  if(!((string[])dr.GetSheetNames()).Contains(sheet))throw new Exception("Sheet not found: "+sheet);
  dr.ActivateSheet(sheet);var view=SheetViews(dr).FirstOrDefault(x=>x.Name==viewName);
  if(view==null)throw new Exception("View not found on "+sheet+": "+viewName+" (views: "+string.Join(", ",SheetViews(dr).Select(v=>v.Name))+")");
  return view;
 }
 static double[] ModelToSheet(IView view,double[] m){var mu=(IMathUtility)sw.GetMathUtility();return (double[])((MathPoint)((MathPoint)mu.CreatePoint(m)).MultiplyTransform(view.ModelToViewTransform)).ArrayData;}
 static string NextViewLabel(IDrawingDoc dr){
  var used=new HashSet<string>(SheetViews(dr).Select(v=>v.Name));
  for(char ch='A';ch<='Z';ch++)if(!used.Any(n=>n.EndsWith(" "+ch)||n.EndsWith("-"+ch)||n==ch.ToString()))return ch.ToString();
  return "Z";
 }
 // Moves a new view to the free spot (no overlap with other views, 10 mm inside the sheet) nearest to `near`, scanning a 5 mm grid.
 static string PlaceViewFree(IModelDoc2 d,IDrawingDoc dr,IView nv,double[] near){
  var shp=(double[])((ISheet)dr.GetCurrentSheet()).GetProperties2();double W=shp[5],H=shp[6],m=0.005;
  var others=SheetViews(dr).Where(v=>v.Name!=nv.Name).Select(v=>(double[])v.GetOutline()).Where(x=>x!=null).ToList();
  var so=(double[])nv.GetOutline();var p0=(double[])nv.Position;double w=so[2]-so[0],h=so[3]-so[1];
  double bestD=double.MaxValue,bx=0,by=0;bool found=false;
  for(double cx=0.01+w/2;cx<=W-0.01-w/2;cx+=0.005)for(double cy=0.01+h/2;cy<=H-0.01-h/2;cy+=0.005){
   double x0=cx-w/2,y0=cy-h/2,x1=cx+w/2,y1=cy+h/2;
   if(others.Any(b=>x0<b[2]+m&&x1>b[0]-m&&y0<b[3]+m&&y1>b[1]-m))continue;
   double dd=Math.Pow(cx-near[0],2)+Math.Pow(cy-near[1],2);if(dd<bestD){bestD=dd;bx=cx;by=cy;found=true;}}
  if(!found)return "no free place found on the sheet; left where SolidWorks put it";
  double ox=(so[0]+so[2])/2,oy=(so[1]+so[3])/2;nv.Position=new[]{p0[0]+bx-ox,p0[1]+by-oy};d.EditRebuild3();
  return "placed on the nearest free spot";
 }

 static object DetailView(Dictionary<string,object> a,IModelDoc2 d,IDrawingDoc dr){
  var view=FindSheetView(dr,a);string sheet=Str(a,"sheet");
  var o=(double[])view.GetOutline();var mu=(IMathUtility)sw.GetMathUtility();
  double cx=(o[0]+o[2])/2,cy=(o[1]+o[3])/2;
  if(a.ContainsKey("through_mm")){var m=Items(a["through_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();if(m.Length!=3)throw new Exception("through_mm: [x, y, z] in model mm");
   var sp=ModelToSheet(view,m);cx=sp[0];cy=sp[1];
   if(cx<o[0]||cx>o[2]||cy<o[1]||cy>o[3])throw new Exception("through_mm falls outside the view on the sheet ("+Math.Round(cx*1000,1)+", "+Math.Round(cy*1000,1)+" mm)");}
  if(!a.ContainsKey("radius_mm"))throw new Exception("detail requires radius_mm (radius of the detail circle in MODEL mm)");
  double vs=view.ScaleDecimal,r=Num(a,"radius_mm")/1000*vs;   // circle radius on the sheet
  double ds=a.ContainsKey("scale")?Num(a,"scale"):vs*2;if(ds<=vs)throw new Exception("scale must be larger than the parent view scale ("+vs+")");
  double s1=ds>=1?Math.Round(ds,3):1,s2=ds>=1?1:Math.Round(1/ds,3);
  string label=a.ContainsKey("label")?Str(a,"label"):NextViewLabel(dr);
  var before=new HashSet<string>(SheetViews(dr).Select(v=>v.Name));
  if(!dr.ActivateView(view.Name))throw new Exception("Cannot activate view "+view.Name);
  var sk=view.GetSketch() as ISketch;MathTransform toSk=null;try{toSk=sk==null?null:sk.ModelToSketchTransform;}catch{}
  Func<double[],double[]> map=q=>toSk==null?q:(double[])((MathPoint)((MathPoint)mu.CreatePoint(q)).MultiplyTransform(toSk)).ArrayData;
  var c0=map(new[]{cx,cy,0});var c1=map(new[]{cx+r,cy,0});double rs=Math.Sqrt(Math.Pow(c1[0]-c0[0],2)+Math.Pow(c1[1]-c0[1],2));
  bool addRel=d.SketchManager.AddToDB;d.SketchManager.AddToDB=true;ISketchSegment seg;
  try{seg=(ISketchSegment)d.SketchManager.CreateCircleByRadius(c0[0],c0[1],0,rs);}finally{d.SketchManager.AddToDB=addRel;}
  if(seg==null)throw new Exception("Cannot draw the detail circle in "+view.Name);
  d.ClearSelection2(true);if(!seg.Select4(false,null))throw new Exception("Cannot select the detail circle");
  double side=r*ds/vs;var pos=a.ContainsKey("position_mm")?Items(a["position_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray():new[]{o[2]+0.03+side,cy};
  IView dv=null;
  try{dv=dr.CreateDetailViewAt4(pos[0],pos[1],0,(int)swDetViewStyle_e.swDetViewSTANDARD,s1,s2,label,(int)swDetCircleShowType_e.swDetCircleCIRCLE,false,false,false,0) as IView;}catch{}
  d.ClearSelection2(true);
  if(dv==null){try{seg.Select4(false,null);d.Extension.DeleteSelection2(0);}catch{}d.ClearSelection2(true);throw new Exception("SolidWorks did not create the detail view (circle removed). Try another through_mm or radius_mm.");}
  d.EditRebuild3();
  string placed=a.ContainsKey("position_mm")?"as requested":PlaceViewFree(d,dr,dv,new[]{o[2]+0.03+side,cy});
  return new{sheet=sheet,parent=view.Name,label=label,scale=s1+":"+s2,circle_on_sheet_mm=new[]{Math.Round(cx*1000,2),Math.Round(cy*1000,2),Math.Round(r*1000,2)},
   detail=ViewInfo(dv),placement=placed,new_views=SheetViews(dr).Where(v=>!before.Contains(v.Name)).Select(v=>v.Name).ToArray(),
   note="Detail view; unsaved until sw_save. Check it with sw_preview or the PDF export."};
 }

 class ViewEdge{public IEdge Edge;public IComponent2 Comp;public string Kind;public double[] A,B,C;public double Radius,Length;public bool Full;}
 static List<ViewEdge> VisibleEdges(IView view){
  var list=new List<ViewEdge>();
  var comps=(view.GetVisibleComponents() as object[])??new object[0];
  var owners=comps.Length==0?new IComponent2[]{null}:comps.Cast<IComponent2>().ToArray();
  var mu=(IMathUtility)sw.GetMathUtility();
  foreach(var comp in owners){
   var ents=(view.GetVisibleEntities2((Component2)comp,(int)swViewEntityType_e.swViewEntityType_Edge) as object[])??new object[0];
   MathTransform xf=comp==null?null:comp.Transform2;
   Func<double[],double[]> toModel=p=>p==null||xf==null?p:(double[])((MathPoint)((MathPoint)mu.CreatePoint(p)).MultiplyTransform(xf)).ArrayData;
   foreach(var o in ents){var e=o as IEdge;if(e==null)continue;var cu=(ICurve)e.GetCurve();var ve=new ViewEdge{Edge=e,Comp=comp};
    var sv=e.GetStartVertex() as IVertex;var ev=e.GetEndVertex() as IVertex;
    ve.A=sv==null?null:toModel((double[])sv.GetPoint());ve.B=ev==null?null:toModel((double[])ev.GetPoint());
    double t0,t1;bool closed,periodic;cu.GetEndParams(out t0,out t1,out closed,out periodic);ve.Length=cu.GetLength3(t0,t1);
    if(cu.IsLine())ve.Kind="line";
    else if(cu.IsCircle()){var p=(double[])cu.CircleParams;ve.C=toModel(new[]{p[0],p[1],p[2]});ve.Radius=p[6];ve.Full=sv==null||ev==null||Dist(ve.A,ve.B)<1e-9;ve.Kind=ve.Full?"circle":"arc";}
    else ve.Kind="curve";
    list.Add(ve);}
  }
  return list;
 }
 static double Dist(double[] p,double[] q){return p==null||q==null?double.MaxValue:Math.Sqrt(Math.Pow(p[0]-q[0],2)+Math.Pow(p[1]-q[1],2)+Math.Pow(p[2]-q[2],2));}

 static bool TryDrawingDimension(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_dimension")return false;
  var dr=RequireDrawing(d);var view=FindSheetView(dr,a);var edges=VisibleEdges(view);
  Func<double[],double[]> mm=p=>p==null?null:p.Select(x=>Math.Round(x*1000,3)).ToArray();
  Func<double[],double[]> sh=p=>{if(p==null)return null;var s=ModelToSheet(view,p);return new[]{Math.Round(s[0]*1000,2),Math.Round(s[1]*1000,2)};};
  string action=Str(a,"action");
  if(action=="probe"){
   string only=a.ContainsKey("kind")?Str(a,"kind"):null;int max=a.ContainsKey("max_edges")?Convert.ToInt32(a["max_edges"]):200;
   var rows=edges.Select((e,i)=>new{e,i}).Where(x=>only==null||x.e.Kind==only).Take(max).Select(x=>new{index=x.i,kind=x.e.Kind,component=x.e.Comp==null?null:x.e.Comp.Name2,
    length_mm=Math.Round(x.e.Length*1000,3),diameter_mm=x.e.Kind=="circle"||x.e.Kind=="arc"?(double?)Math.Round(x.e.Radius*2000,3):null,
    start_model_mm=mm(x.e.A),end_model_mm=mm(x.e.B),center_model_mm=mm(x.e.C),start_sheet_mm=sh(x.e.A),end_sheet_mm=sh(x.e.B),center_sheet_mm=sh(x.e.C)}).ToArray();
   result=new{sheet=Str(a,"sheet"),view=view.Name,scale=view.ScaleDecimal,edges_total=edges.Count,edges=rows,
    note="Indexes are valid until the view or the model changes; call probe again after edits. Use them with action add."};return true;
  }
  // v3.11 action auto (idea from haunchen/solidworks-mcp): imported or dumb geometry has no model dimensions to insert. Dimension
  // what a drawing always needs from what the view shows: overall width and height (outermost straight edges) and one diameter
  // per distinct hole/circle size (count given in the answer).
  if(action=="auto"){
   var made=new List<object>();var skipped=new List<string>();var o2=(double[])view.GetOutline();
   Func<double[],double[]> S=p=>ModelToSheet(view,p);
   var lines=edges.Select((e,i)=>new{e,i}).Where(x=>x.e.Kind=="line"&&x.e.A!=null&&x.e.B!=null).Select(x=>new{x.i,a=S(x.e.A),b=S(x.e.B)}).ToList();
   var vert=lines.Where(l=>Math.Abs(l.a[0]-l.b[0])<1e-6&&Math.Abs(l.a[1]-l.b[1])>1e-6).ToList();
   var horz=lines.Where(l=>Math.Abs(l.a[1]-l.b[1])<1e-6&&Math.Abs(l.a[0]-l.b[0])>1e-6).ToList();
   Action<int[],string,double[],string> add=(ix,ty,p,what)=>{try{made.Add(new{what=what,dim=AddViewDim(d,dr,view,edges,ix,ty,p)});}catch(Exception ex){skipped.Add(what+": "+ex.Message);}};
   if(vert.Count>=2){var l=vert.OrderBy(v=>v.a[0]).First();var r=vert.OrderBy(v=>v.a[0]).Last();if(r.a[0]-l.a[0]>1e-4)add(new[]{l.i,r.i},"horizontal",new[]{(l.a[0]+r.a[0])/2,o2[1]-0.008},"overall width");}else skipped.Add("overall width: no vertical straight edges at the sides of the view");
   if(horz.Count>=2){var b=horz.OrderBy(v=>v.a[1]).First();var t=horz.OrderBy(v=>v.a[1]).Last();if(t.a[1]-b.a[1]>1e-4)add(new[]{b.i,t.i},"vertical",new[]{o2[0]-0.008,(b.a[1]+t.a[1])/2},"overall height");}else skipped.Add("overall height: no horizontal straight edges at the bottom/top of the view");
   var circles=edges.Select((e,i)=>new{e,i}).Where(x=>x.e.Kind=="circle"&&x.e.C!=null).GroupBy(x=>Math.Round(x.e.Radius*2000,2)).OrderByDescending(g=>g.Key).ToList();
   int maxC=a.ContainsKey("max_circles")?Convert.ToInt32(a["max_circles"]):12;
   foreach(var g in circles.Take(maxC)){var first=g.First();add(new[]{first.i},"diameter",null,(g.Count()>1?g.Count()+"x ":"")+"Ø"+g.Key);}
   if(circles.Count>maxC)skipped.Add((circles.Count-maxC)+" more circle sizes (raise max_circles)");
   d.EditRebuild3();
   result=new{sheet=Str(a,"sheet"),view=view.Name,dimensions=made.ToArray(),skipped=skipped.ToArray(),note="Driven dimensions; unsaved until sw_save. Check the layout with sw_preview."};return true;
  }
  // action add
  var idx=Items(a["edges"]).Select(Convert.ToInt32).ToArray();
  string type=a.ContainsKey("type")?Str(a,"type"):"smart";
  var res=AddViewDim(d,dr,view,edges,idx,type,a.ContainsKey("position_mm")?Items(a["position_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray():null);
  result=res;return true;
 }
 static object AddViewDim(IModelDoc2 d,IDrawingDoc dr,IView view,List<ViewEdge> edges,int[] idx,string type,double[] given){
  if(idx.Length<1||idx.Length>2)throw new Exception("edges: one or two indexes from action probe");
  foreach(int i in idx)if(i<0||i>=edges.Count)throw new Exception("Edge index "+i+" out of range 0.."+(edges.Count-1)+"; call action probe again");
  var e0=edges[idx[0]];
  if((type=="diameter"||type=="radius")&&(idx.Length!=1||e0.Kind=="line"||e0.Kind=="curve"))throw new Exception(type+" needs ONE circle or arc edge");
  if(type=="angle"&&(idx.Length!=2||edges[idx[1]].Kind!="line"||e0.Kind!="line"))throw new Exception("angle needs TWO straight edges");
  // default text position: 10 mm outside the view centre direction from the edge middle
  var o=(double[])view.GetOutline();double vcx=(o[0]+o[2])/2,vcy=(o[1]+o[3])/2;
  Func<ViewEdge,double[]> mid=e=>{var p=e.Kind=="line"?new[]{(e.A[0]+e.B[0])/2,(e.A[1]+e.B[1])/2,(e.A[2]+e.B[2])/2}:e.C??e.A;return ModelToSheet(view,p);};
  double[] pos;
  if(given!=null)pos=given;
  else{var m0=mid(e0);if(idx.Length==2){var m1=mid(edges[idx[1]]);m0=new[]{(m0[0]+m1[0])/2,(m0[1]+m1[1])/2};}
   double dx=m0[0]-vcx,dy=m0[1]-vcy,n=Math.Sqrt(dx*dx+dy*dy);if(n<1e-6){dx=0;dy=1;n=1;}
   if(type=="horizontal"){dx=0;dy=dy>=0?1:-1;n=1;}if(type=="vertical"){dy=0;dx=dx>=0?1:-1;n=1;}
   // a circle or arc: from its centre past the rim, so the text does not sit on the circle
   double off=0.012+(idx.Length==1&&e0.Kind!="line"&&e0.Kind!="curve"?e0.Radius*view.ScaleDecimal:0);
   pos=new[]{m0[0]+dx/n*off,m0[1]+dy/n*off};}
  if(!dr.ActivateView(view.Name))throw new Exception("Cannot activate view "+view.Name);
  d.ClearSelection2(true);
  for(int k=0;k<idx.Length;k++)if(!view.SelectEntity(edges[idx[k]].Edge,k>0))throw new Exception("Cannot select edge "+idx[k]+" in "+view.Name);
  object ddo=null;
  switch(type){
   case "horizontal":ddo=d.AddHorizontalDimension2(pos[0],pos[1],0);break;
   case "vertical":ddo=d.AddVerticalDimension2(pos[0],pos[1],0);break;
   case "diameter":ddo=d.AddDiameterDimension2(pos[0],pos[1],0);break;
   case "radius":ddo=d.AddRadialDimension2(pos[0],pos[1],0);break;
   default:ddo=d.AddDimension2(pos[0],pos[1],0);break;}
  d.ClearSelection2(true);
  var dd=ddo as IDisplayDimension;if(dd==null)throw new Exception("SolidWorks did not create the "+type+" dimension; try another type or edges (probe shows their kind)");
  var dim=(IDimension)dd.GetDimension2(0);double sv=dim.SystemValue;bool ang=dd.Type2==(int)swDimensionType_e.swAngularDimension||type=="angle";
  d.EditRebuild3();
  return new{view=view.Name,type=type,edges=idx,value=ang?Math.Round(sv*180/Math.PI,4):Math.Round(sv*1000,4),unit=ang?"deg":"mm",name=dim.FullName,
   text_on_sheet_mm=new[]{Math.Round(pos[0]*1000,1),Math.Round(pos[1]*1000,1)},note="Driven (reference) dimension of the drawing; unsaved until sw_save. Check placement with sw_preview."};
 }
}
