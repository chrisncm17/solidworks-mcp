using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.15 supervision of drawing dimensions (the logic lives in dims_layout.mjs; here only what SolidWorks can tell or do):
//  drawing_dim_geometry  real geometry of every dimension of a sheet (text box data, lines), views, title block zone, loose notes
//  drawing_dim_apply     moves dimension texts, deletes dimensions, adds prefix/suffix (4X, TIP.) and moves views. Never saves.
//  drawing_dim_insert    Insert Model Items into each given view, repeats included: shows in which views each model dimension can live
//  drawing_dim_shapes    what each view really occupies on the sheet and the arcs it shows, so dimensions can use the free room inside its frame
//  drawing_part_hollows  what the part of a view has hollow (holes, cuts, shell), to decide a section view
//  drawing_part_sizes    what the part of a view is made of, to work out which dimensions someone needs to make it
// A dimension id is "view#index" in sheet order; a delete shifts the indexes, so read again after applying.
partial class Worker {
 static Dictionary<string,SheetDim> DimIndex(IDrawingDoc dr){
  var r=new Dictionary<string,SheetDim>();var n=new Dictionary<string,int>();
  foreach(var x in SheetDimensions(dr,null)){int i;n.TryGetValue(x.View.Name,out i);n[x.View.Name]=i+1;r[x.View.Name+"#"+i]=x;}
  return r;
 }
 static double Mm(double m){return Math.Round(m*1000,3);}
 // the dimensions of a part that Insert Model Items will not bring back (the flag only means something on the model side)
 static HashSet<string> UnmarkedDims(IDrawingDoc dr){
  var r=new HashSet<string>();var v0=SheetViews(dr).FirstOrDefault(q=>q.ReferencedDocument is IModelDoc2&&((IModelDoc2)q.ReferencedDocument).GetType()==1);if(v0==null)return r;
  Action<IFeature> one=f=>{for(var o=f.GetFirstDisplayDimension();o!=null;o=f.GetNextDisplayDimension(o)){var dd=o as IDisplayDimension;if(dd==null)continue;var dm=dd.GetDimension2(0) as IDimension;if(dm!=null&&!dd.MarkedForDrawing)r.Add(DimKey(dm.FullName));}};
  for(var f=((IModelDoc2)v0.ReferencedDocument).FirstFeature() as IFeature;f!=null;f=f.GetNextFeature() as IFeature){one(f);for(var s=f.GetFirstSubFeature() as IFeature;s!=null;s=s.GetNextSubFeature() as IFeature)one(s);}
  return r;
 }
 static string DimKey(string full){var p=(full??"").Split('@');return p.Length>=2?p[0]+"@"+p[1]:full;}
 // v3.16 what a dimension hangs from: a dimension made on the sheet can hang from the line of a section instead of the part
 static string[] AttachedKinds(IDisplayDimension dd){
  try{var an=dd.GetAnnotation() as IAnnotation;var ty=an==null?null:an.GetAttachedEntityTypes() as int[];if(ty==null)return new string[0];return ty.Select(k=>Enum.GetName(typeof(swSelectType_e),k)??k.ToString()).ToArray();}catch{return null;}
 }
 static object DimGeometry(string id,SheetDim x,HashSet<string> unmarked){
  var dd=x.Dd;var lines=new List<double[]>();var arcList=new List<double[]>();string text="";double h=0,ang=0;double[] start=null;int arcs=0;bool asLinear=false;try{asLinear=dd.DisplayAsLinear;}catch{}int arrowSide=-1;try{arrowSide=dd.ArrowSide;}catch{}
  var ds=dd.GetDisplayData() as IDisplayData;
  if(ds!=null){
   for(int i=0;i<ds.GetTextCount();i++){text+=ds.GetTextAtIndex(i);if(i==0){var t=ds.GetTextPositionAtIndex(i) as double[];if(t!=null)start=new[]{Mm(t[0]),Mm(t[1])};h=Mm(ds.GetTextHeightAtIndex(i));ang=ds.GetTextAngleAtIndex(i);}}
   for(int i=0;i<ds.GetLineCount();i++){var l=ds.GetLineAtIndex3(i) as double[];if(l!=null&&l.Length>=9)lines.Add(new[]{Mm(l[4]),Mm(l[5]),Mm(l[7]),Mm(l[8])});}
   // v3.17 start, end and centre, counter-clockwise from start to end: the first is the angle itself, the others the tails out to the arrows or the text
   arcs=ds.GetArcCount();for(int i=0;i<arcs;i++){var l=ds.GetArcAtIndex2(i) as double[];if(l!=null&&l.Length>=13)arcList.Add(new[]{Mm(l[4]),Mm(l[5]),Mm(l[7]),Mm(l[8]),Mm(l[10]),Mm(l[11])});}}
  var dim=dd.GetDimension2(0) as IDimension;
  return new{attached=AttachedKinds(dd),id=id,view=x.View.Name,marked=dim==null||!unmarked.Contains(DimKey(dim.FullName)),name=dim==null?null:dim.FullName,type=dd.Type2,hole_callout=dd.IsHoleCallout(),value=Math.Round(x.Value,3),unit=x.Ang?"deg":"mm",text=text,pos=new[]{Math.Round(x.Pos[0],3),Math.Round(x.Pos[1],3)},start=start,height=h,angle=ang,lines=lines.ToArray(),arcs=arcs,arc_list=arcList.ToArray(),as_linear=asLinear,arrow_side=arrowSide};
 }
 // the title block has no API: its zone is deduced from the format notes in the lower part of the sheet (the caller may override it)
 static double[] TitleBlockZone(IDrawingDoc dr,double wMm,double hMm){
  var ps=new List<double[]>();
  foreach(var o in (object[])((IView)dr.GetFirstView()).GetNotes()??new object[0]){var nt=o as INote;if(nt==null)continue;var an=(IAnnotation)nt.GetAnnotation();
   if(an.OwnerType!=(int)swAnnotationOwner_e.swAnnotationOwner_DrawingTemplate)continue;var p=an.GetPosition() as double[];if(p==null)continue;double x=p[0]*1000,y=p[1]*1000;if(y<0.35*hMm)ps.Add(new[]{x,y});}
  if(ps.Count==0)return null;
  return new[]{Math.Round(ps.Min(p=>p[0])-3,1),0,wMm,Math.Round(ps.Max(p=>p[1])+3,1)};
 }
 static List<object> LooseNotes(IDrawingDoc dr){
  var r=new List<object>();var views=new List<IView>{(IView)dr.GetFirstView()};views.AddRange(SheetViews(dr));
  foreach(var v in views)foreach(var o in (object[])v.GetNotes()??new object[0]){var nt=o as INote;if(nt==null)continue;var an=(IAnnotation)nt.GetAnnotation();
   if(an.OwnerType==(int)swAnnotationOwner_e.swAnnotationOwner_DrawingTemplate||nt.IsBomBalloon())continue;
   var e=nt.GetExtent() as double[];if(e==null||e.Length<6)continue;
   r.Add(new{text=nt.GetText(),box=new[]{Mm(Math.Min(e[0],e[3])),Mm(Math.Min(e[1],e[4])),Mm(Math.Max(e[0],e[3])),Mm(Math.Max(e[1],e[4]))}});}
  return r;
 }
 // the image on the sheet of the model X, Y and Z axes (z of the image = towards the viewer)
 static double[][] ViewAxes(IView v){
  var mu=(IMathUtility)sw.GetMathUtility();var xf=(MathTransform)v.ModelToViewTransform;
  return new[]{new double[]{1,0,0},new double[]{0,1,0},new double[]{0,0,1}}.Select(p=>{var q=(double[])((MathVector)((MathVector)mu.CreateVector(p)).MultiplyTransform(xf)).ArrayData;double n=Math.Sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]);return q.Select(x=>Math.Round(x/n,4)).ToArray();}).ToArray();
 }
 // v3.17 what a view really occupies, from the mesh of the part: the frame of a slender part is mostly air and a dimension can live there. A grid over the frame,
 // row by row the columns from and to that are full; and the arcs it shows in true shape, with a point half way along, because a leader must land on its arc
 static List<float[]> PartMesh(IModelDoc2 rd){
  var r=new List<float[]>();
  foreach(var bo in (object[])((IPartDoc)rd).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]){var body=bo as IBody2;if(body==null)continue;
   foreach(var fo in (object[])body.GetFaces()??new object[0]){var f=fo as IFace2;var tp=f==null?null:f.GetTessTriangles(true) as float[];if(tp!=null)r.Add(tp);}}
  return r;
 }
 static int[][] ShapeRows(List<float[]> mesh,double[][] ax,double ox,double oy,double k,double x0,double y0,double cell,int nx,int ny){
  var full=new bool[ny,nx];var px=new double[3];var py=new double[3];
  foreach(var t in mesh)for(int i=0;i+8<t.Length;i+=9){
   for(int n=0;n<3;n++){double X=t[i+3*n],Y=t[i+3*n+1],Z=t[i+3*n+2];px[n]=(ox+k*(ax[0][0]*X+ax[1][0]*Y+ax[2][0]*Z)-x0)/cell;py[n]=(oy+k*(ax[0][1]*X+ax[1][1]*Y+ax[2][1]*Z)-y0)/cell;}
   int r0=Math.Max(0,(int)Math.Floor(Math.Min(py[0],Math.Min(py[1],py[2])))),r1=Math.Min(ny-1,(int)Math.Floor(Math.Max(py[0],Math.Max(py[1],py[2]))));
   for(int r=r0;r<=r1;r++){double lo=double.MaxValue,hi=double.MinValue;
    // the columns of this row the triangle covers: each side cut to the band of the row
    for(int n=0;n<3;n++){int m=(n+1)%3;double y1=py[n],dy=py[m]-y1,t0=0,t1=1;
     if(Math.Abs(dy)<1e-12){if(y1<r||y1>r+1)continue;}else{double ta=(r-y1)/dy,tb=(r+1-y1)/dy;if(ta>tb){double q=ta;ta=tb;tb=q;}t0=Math.Max(t0,ta);t1=Math.Min(t1,tb);if(t0>t1)continue;}
     double xa=px[n]+t0*(px[m]-px[n]),xb=px[n]+t1*(px[m]-px[n]);lo=Math.Min(lo,Math.Min(xa,xb));hi=Math.Max(hi,Math.Max(xa,xb));}
    if(lo>hi)continue;int c0=Math.Max(0,(int)Math.Floor(lo)),c1=Math.Min(nx-1,(int)Math.Floor(hi));for(int c=c0;c<=c1;c++)full[r,c]=true;}}
  var rows=new int[ny][];
  for(int r=0;r<ny;r++){var sp=new List<int>();bool was=false;for(int c=0;c<nx;c++){if(full[r,c]!=was){sp.Add(c);was=full[r,c];}}if(was)sp.Add(nx);rows[r]=sp.ToArray();}
  return rows;
 }
 // half way along an arc: of the two points across the centre, the one the edge really reaches (the parameters of its curve can go round the other way)
 static double[] ArcMiddle(ViewEdge e){
  double[] u={e.A[0]-e.C[0],e.A[1]-e.C[1],e.A[2]-e.C[2]},b={u[0]+e.B[0]-e.C[0],u[1]+e.B[1]-e.C[1],u[2]+e.B[2]-e.C[2]};
  if(Dist(b,new double[3])<1e-9)b=new[]{e.N[1]*u[2]-e.N[2]*u[1],e.N[2]*u[0]-e.N[0]*u[2],e.N[0]*u[1]-e.N[1]*u[0]};
  double n=Dist(b,new double[3]),gap=double.MaxValue;double[] best=null;
  foreach(int s in new[]{1,-1}){var p=new[]{e.C[0]+s*e.Radius*b[0]/n,e.C[1]+s*e.Radius*b[1]/n,e.C[2]+s*e.Radius*b[2]/n};var q=e.Edge.GetClosestPointOn(p[0],p[1],p[2]) as double[];if(q==null)continue;double g=Dist(p,q);if(g<gap){gap=g;best=p;}}
  return best??e.A;
 }
 static object ViewShape(IView v,Dictionary<string,List<float[]>> meshes,double cell){
  var rd=v.ReferencedDocument as IModelDoc2;if(rd==null||rd.GetType()!=1)return null;
  var ax=ViewAxes(v);if(!ax.Any(q=>Math.Abs(q[2])>0.99))return null;
  // the mesh is that of the configuration open: it would say nothing about another one
  var active=rd.ConfigurationManager.ActiveConfiguration;string used=v.ReferencedConfiguration;if(active!=null&&!string.IsNullOrEmpty(used)&&!string.Equals(used,active.Name,StringComparison.OrdinalIgnoreCase))return null;
  List<float[]> mesh;string key=rd.GetPathName();if(!meshes.TryGetValue(key,out mesh))meshes[key]=mesh=PartMesh(rd);
  var o=(double[])v.GetOutline();var s0=ModelToSheet(v,new double[]{0,0,0});double k=v.ScaleDecimal*1000,ox=s0[0]*1000,oy=s0[1]*1000,x0=o[0]*1000,y0=o[1]*1000;
  int nx=(int)Math.Ceiling((o[2]-o[0])*1000/cell)+1,ny=(int)Math.Ceiling((o[3]-o[1])*1000/cell)+1;
  var arcs=new List<object>();var lines=new List<double[]>();
  try{Func<double[],double[]> sh=p=>{var s=ModelToSheet(v,p);return new[]{Mm(s[0]),Mm(s[1])};};
   foreach(var e in VisibleEdges(v))try{
    if(e.Kind=="line"&&e.A!=null&&e.B!=null){var p=sh(e.A);var q=sh(e.B);lines.Add(new[]{p[0],p[1],q[0],q[1]});continue;}
    // a round on an inclined side meets it in a curve, no circle at all, and on the sheet it is still its arc: the plan knows the centre and only needs the ends
    if(e.Kind=="curve"&&e.A!=null&&e.B!=null){arcs.Add(new{start=sh(e.A),end=sh(e.B),curve=true});continue;}
    if((e.Kind!="arc"&&e.Kind!="circle")||e.C==null||e.N==null)continue;
    double look=Math.Abs(ax[0][2]*e.N[0]+ax[1][2]*e.N[1]+ax[2][2]*e.N[2]);
    // seen from the side a circle is a straight line across it
    if(look<0.001){double nx0=ax[0][0]*e.N[0]+ax[1][0]*e.N[1]+ax[2][0]*e.N[2],ny0=ax[0][1]*e.N[0]+ax[1][1]*e.N[1]+ax[2][1]*e.N[2],len=Math.Sqrt(nx0*nx0+ny0*ny0),hx=-ny0/len*e.Radius*k,hy=nx0/len*e.Radius*k;var c0=sh(e.C);lines.Add(new[]{c0[0]-hx,c0[1]-hy,c0[0]+hx,c0[1]+hy});continue;}
    if(look<0.999)continue;
    if(e.Kind=="circle"||e.A==null||e.B==null){arcs.Add(new{center=sh(e.C),r=Math.Round(e.Radius*k,3),full=true});continue;}
    arcs.Add(new{center=sh(e.C),r=Math.Round(e.Radius*k,3),start=sh(e.A),end=sh(e.B),mid=sh(ArcMiddle(e))});}catch{}}catch{}
  return new{view=v.Name,cell_mm=cell,x0=Math.Round(x0,3),y0=Math.Round(y0,3),origin_mm=new[]{Math.Round(ox,3),Math.Round(oy,3)},rows=ShapeRows(mesh,ax,ox,oy,k,x0,y0,cell,nx,ny),arcs=arcs.ToArray(),lines=lines.ToArray()};
 }
 static object ViewRow(IView v){
  var o=v.GetOutline() as double[];var rd=v.ReferencedDocument as IModelDoc2;double[][] axes=null;try{axes=ViewAxes(v);}catch{}
  double[] origin=null;try{var s0=ModelToSheet(v,new double[]{0,0,0});origin=new[]{Mm(s0[0]),Mm(s0[1])};}catch{}
  bool section=v.Type==(int)swDrawingViewTypes_e.swDrawingSectionView;
  return new{name=v.Name,scale=v.ScaleDecimal,outline_mm=o==null?null:new[]{Mm(o[0]),Mm(o[1]),Mm(o[2]),Mm(o[3])},axes=axes,origin_mm=origin,section=section,hatches=section?ViewHatches(v):null,model=rd==null?null:rd.GetPathName(),model_type=rd==null?0:rd.GetType()};
 }
 // what a section fills its cut faces with: no rows, or a pattern that draws nothing, is a section that does not say what is solid
 static object[] ViewHatches(IView v){
  var rows=new List<object>();
  try{foreach(var o in (object[])v.GetFaceHatches()??new object[0]){var h=o as IFaceHatch;if(h!=null)rows.Add(new{pattern=h.Pattern,solid=h.SolidFill,material=h.UseMaterialHatch,scale=Math.Round(h.Scale2,3),angle=Math.Round(h.Angle,3),type=h.HatchType,scope=h.HatchScope,layer=h.Layer});}}catch{}
  return rows.ToArray();
 }
 static readonly HashSet<string> HollowTypes=new HashSet<string>{"Cut","ICE","Extrusion","RevCut","CutRevolve","SweepCut","LoftCut","HoleWzd","AdvHoleWzd","Shell"};
 // a face normal points out of the material: towards the axis means the hollow is inside the cylinder
 static bool HollowInside(IFace2 f,double[] c,double[] ax){
  bool inner=f.FaceInSurfaceSense();var tp=f.GetTessTriangles(true) as float[];var tn=f.GetTessNorms() as float[];
  if(tp!=null&&tn!=null&&tp.Length>=3&&tn.Length>=3){double rx=tp[0]-c[0],ry=tp[1]-c[1],rz=tp[2]-c[2],al=rx*ax[0]+ry*ax[1]+rz*ax[2];rx-=al*ax[0];ry-=al*ax[1];rz-=al*ax[2];inner=rx*tn[0]+ry*tn[1]+rz*tn[2]<0;}
  return inner;
 }
 // where a face really reaches, from its mesh: GetBox can be loose around a curved face
 static double[] MeshBox(IFace2 f){
  var tp=f.GetTessTriangles(true) as float[];if(tp==null||tp.Length<3)return (double[])f.GetBox();
  var b=new double[]{tp[0],tp[1],tp[2],tp[0],tp[1],tp[2]};
  for(int i=0;i+2<tp.Length;i+=3)for(int k=0;k<3;k++){b[k]=Math.Min(b[k],tp[i+k]);b[k+3]=Math.Max(b[k+3],tp[i+k]);}
  return b;
 }
 static double[] MmAll(double[] p){return p.Select(Mm).ToArray();}
 class RoundFaces{public double R;public double[] Ax,Foot,Box;public bool Inner,Blend=true;public Dictionary<string,double[]> Spans=new Dictionary<string,double[]>();}
 // v3.17 what a part is made of, to work out which dimensions someone needs to make it (dims_needed.mjs): the planes normal to an axis, the
 // round faces (one row per axis line and radius, with how much of a turn they cover), the slanted planes, and what is none of these
 static object PartSizes(IModelDoc2 rd,IView view){
  var planes=new Dictionary<string,double[]>();var slanted=new List<object>();var rounds=new Dictionary<string,RoundFaces>();
  var cones=new List<object>();var spheres=new List<object>();var tori=new List<object>();var free=new List<object>();
  foreach(var bo in (object[])((IPartDoc)rd).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]){var body=bo as IBody2;if(body==null)continue;
   foreach(var fo in (object[])body.GetFaces()??new object[0]){var f=fo as IFace2;if(f==null)continue;var su=(ISurface)f.GetSurface();double area=f.GetArea()*1e6;
    var fe=f.GetFeature() as IFeature;string ft=fe==null?"":fe.GetTypeName2();bool blend=ft.IndexOf("Fillet",StringComparison.OrdinalIgnoreCase)>=0;bool chamfer=ft.IndexOf("Chamfer",StringComparison.OrdinalIgnoreCase)>=0;
    if(su.IsPlane()){var p=(double[])su.PlaneParams;int ax=Array.FindIndex(new[]{p[0],p[1],p[2]},n=>Math.Abs(n)>0.9999);
     if(ax>=0){string key=ax+"|"+Math.Round(p[3+ax]*1e5);double[] row;if(!planes.TryGetValue(key,out row))planes[key]=row=new[]{ax,p[3+ax]*1000,0};row[2]+=area;}
     else slanted.Add(new{normal=new[]{Math.Round(p[0],5),Math.Round(p[1],5),Math.Round(p[2],5)},box=MmAll(MeshBox(f)),area=Math.Round(area,2),chamfer=chamfer});}
    else if(su.IsCylinder()){var c=(double[])su.CylinderParams;double[] ax={c[3],c[4],c[5]};var uv=(double[])f.GetUVBounds();var b=MeshBox(f);
     double k=c[0]*ax[0]+c[1]*ax[1]+c[2]*ax[2];double[] foot={c[0]-k*ax[0],c[1]-k*ax[1],c[2]-k*ax[2]};
     string key=string.Join("|",new[]{Math.Abs(ax[0]),Math.Abs(ax[1]),Math.Abs(ax[2]),foot[0],foot[1],foot[2],c[6]}.Select(x=>Math.Round(x*1e4).ToString()));
     RoundFaces g;if(!rounds.TryGetValue(key,out g))rounds[key]=g=new RoundFaces{R=c[6],Ax=ax,Foot=foot,Box=b,Inner=HollowInside(f,c,ax)};
     int along=Array.FindIndex(ax,n=>Math.Abs(n)>0.9999);double s0=along<0?0:Mm(b[along]),s1=along<0?0:Mm(b[along+3]);string sk=Math.Round(s0,2)+"|"+Math.Round(s1,2);double[] sp;if(!g.Spans.TryGetValue(sk,out sp))g.Spans[sk]=sp=new[]{s0,s1,0};
     // how much of a turn counts stretch by stretch along the axis: the tips of eight arms do not make a cylinder
     sp[2]+=Math.Abs(uv[1]-uv[0]);g.Blend&=blend;for(int i=0;i<3;i++){g.Box[i]=Math.Min(g.Box[i],b[i]);g.Box[i+3]=Math.Max(g.Box[i+3],b[i+3]);}}
    else if(su.IsCone()){var c=(double[])su.ConeParams;double[] ax={c[3],c[4],c[5]};var tp=f.GetTessTriangles(true) as float[];double t0=double.MaxValue,t1=double.MinValue,r0=0,r1=0;
     for(int i=0;tp!=null&&i+2<tp.Length;i+=3){double dx=tp[i]-c[0],dy=tp[i+1]-c[1],dz=tp[i+2]-c[2],t=dx*ax[0]+dy*ax[1]+dz*ax[2];double rx=dx-t*ax[0],ry=dy-t*ax[1],rz=dz-t*ax[2],r=Math.Sqrt(rx*rx+ry*ry+rz*rz);if(t<t0){t0=t;r0=r;}if(t>t1){t1=t;r1=r;}}
     Func<double,double,object> end=(t,r)=>new{point=new[]{Mm(c[0]+t*ax[0]),Mm(c[1]+t*ax[1]),Mm(c[2]+t*ax[2])},r=Mm(r)};
     cones.Add(new{axis=new[]{Math.Round(ax[0],5),Math.Round(ax[1],5),Math.Round(ax[2],5)},half_angle_deg=Math.Round(c[7]*180/Math.PI,3),ends=new[]{end(t0,r0),end(t1,r1)},chamfer=chamfer});}
    else if(su.IsSphere()){var c=(double[])su.SphereParams;spheres.Add(new{center=new[]{Mm(c[0]),Mm(c[1]),Mm(c[2])},r=Mm(c[3]),blend=blend});}
    else if(su.IsTorus()){var c=(double[])su.TorusParams;tori.Add(new{center=new[]{Mm(c[0]),Mm(c[1]),Mm(c[2])},axis=new[]{Math.Round(c[3],5),Math.Round(c[4],5),Math.Round(c[5],5)},major=Mm(c[6]),minor=Mm(c[7]),blend=blend});}
    else free.Add(new{box=MmAll(MeshBox(f)),area=Math.Round(area,2),blend=blend});}}
  string used=view.ReferencedConfiguration;var active=rd.ConfigurationManager.ActiveConfiguration;
  return new{planes=planes.Values.Select(r=>new{axis=(int)r[0],pos=Math.Round(r[1],3),area=Math.Round(r[2],2)}).ToArray(),slanted=slanted.ToArray(),
   rounds=rounds.Values.Select(g=>new{axis=new[]{Math.Round(g.Ax[0],5),Math.Round(g.Ax[1],5),Math.Round(g.Ax[2],5)},point=MmAll(g.Foot),r=Mm(g.R),sweep=Math.Round(g.Spans.Values.Max(x=>x[2]),4),spans=g.Spans.Values.Select(x=>new[]{x[0],x[1]}).ToArray(),inner=g.Inner,blend=g.Blend,box=MmAll(g.Box)}).ToArray(),
   cones=cones.ToArray(),spheres=spheres.ToArray(),tori=tori.ToArray(),free=free.ToArray(),
   configuration_differs=active!=null&&!string.IsNullOrEmpty(used)&&!string.Equals(used,active.Name,StringComparison.OrdinalIgnoreCase)};
 }
 // full cylinders whose material is outside (holes, bores, tubes), whatever feature made them; a concave fillet is only a part of a turn and stays out
 static object PartHollows(IModelDoc2 rd){
  var groups=new Dictionary<string,List<double[]>>();
  foreach(var bo in (object[])((IPartDoc)rd).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]){var body=bo as IBody2;if(body==null)continue;
   foreach(var fo in (object[])body.GetFaces()??new object[0]){var f=fo as IFace2;if(f==null)continue;var su=(ISurface)f.GetSurface();if(!su.IsCylinder())continue;
    var c=(double[])su.CylinderParams;var uv=(double[])f.GetUVBounds();var b=(double[])f.GetBox();
    double[] ax={c[3],c[4],c[5]};double[] o0={c[0],c[1],c[2]};double[] mid={(b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2};
    if(!HollowInside(f,c,ax))continue;
    double t=(mid[0]-o0[0])*ax[0]+(mid[1]-o0[1])*ax[1]+(mid[2]-o0[2])*ax[2];
    double[] onAxis={o0[0]+t*ax[0],o0[1]+t*ax[1],o0[2]+t*ax[2]};
    // one key per axis line and radius: the faces of one hole share it
    double k=o0[0]*ax[0]+o0[1]*ax[1]+o0[2]*ax[2];double[] foot={o0[0]-k*ax[0],o0[1]-k*ax[1],o0[2]-k*ax[2]};
    string key=string.Join("|",new[]{Math.Abs(ax[0]),Math.Abs(ax[1]),Math.Abs(ax[2]),foot[0],foot[1],foot[2],c[6]}.Select(x=>Math.Round(x*1e4).ToString()));
    if(!groups.ContainsKey(key))groups[key]=new List<double[]>();groups[key].Add(new[]{Math.Abs(uv[1]-uv[0]),c[6],ax[0],ax[1],ax[2],onAxis[0],onAxis[1],onAxis[2],Math.Abs(uv[3]-uv[2])});}}
  var holes=groups.Values.Where(g=>g.Sum(r=>r[0])>=1.5*Math.PI).Select(g=>{var r=g[0];return new{diameter_mm=Math.Round(r[1]*2000,3),axis=new[]{Math.Round(r[2],4),Math.Round(r[3],4),Math.Round(r[4],4)},point_mm=new[]{Mm(r[5]),Mm(r[6]),Mm(r[7])},length_mm=Mm(g.Max(x=>x[8]))};}).ToArray();
  var feats=new List<object>();
  for(var f=rd.FirstFeature() as IFeature;f!=null;f=f.GetNextFeature() as IFeature){string ty=f.GetTypeName2();if(!HollowTypes.Contains(ty))continue;
   // the same type name serves extruded bosses and cuts
   var ex=f.GetDefinition() as IExtrudeFeatureData2;if(ex!=null&&(ex.IsBossFeature()||ex.IsBaseExtrude()))continue;
   var sup=f.IsSuppressed2((int)swInConfigurationOpts_e.swThisConfiguration,null) as bool[];if(sup!=null&&sup.Length>0&&sup[0])continue;
   double[] box=null;foreach(var fo in (object[])f.GetFaces()??new object[0]){var fc=fo as IFace2;var b=fc==null?null:fc.GetBox() as double[];if(b==null)continue;if(box==null)box=(double[])b.Clone();else for(int i=0;i<3;i++){box[i]=Math.Min(box[i],b[i]);box[i+3]=Math.Max(box[i+3],b[i+3]);}}
   var sks=new List<string>();for(var s=f.GetFirstSubFeature() as IFeature;s!=null;s=s.GetNextSubFeature() as IFeature)if(s.GetTypeName2()=="ProfileFeature")sks.Add(s.Name);
   feats.Add(new{name=f.Name,type=ty,sketches=sks.ToArray(),center_mm=box==null?null:new[]{Mm((box[0]+box[3])/2),Mm((box[1]+box[4])/2),Mm((box[2]+box[5])/2)}});}
  return new{holes=holes,features=feats.ToArray()};
 }
 static bool TryDimLayout(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_dim_geometry"&&op!="drawing_dim_apply"&&op!="drawing_dim_insert"&&op!="drawing_dim_shapes"&&op!="drawing_part_hollows"&&op!="drawing_part_sizes")return false;
  var dr=RequireDrawing(d);var names=(string[])dr.GetSheetNames();string active=((ISheet)dr.GetCurrentSheet()).GetName();
  string sheet=a.ContainsKey("sheet")?Str(a,"sheet"):active;
  if(!names.Contains(sheet))throw new Exception("Sheet not found: "+sheet+" (sheets: "+string.Join(", ",names)+")");
  if(sheet!=active)dr.ActivateSheet(sheet);
  if(op=="drawing_part_hollows"){
   var pv=SheetViews(dr).FirstOrDefault(q=>q.ReferencedDocument is IModelDoc2&&((IModelDoc2)q.ReferencedDocument).GetType()==1);
   result=pv==null?(object)new{holes=new object[0],features=new object[0]}:PartHollows((IModelDoc2)pv.ReferencedDocument);return true;}
  if(op=="drawing_dim_shapes"){
   var meshes=new Dictionary<string,List<float[]>>();var rows=new List<object>();
   foreach(var v in SheetViews(dr)){object row=null;try{row=ViewShape(v,meshes,0.5);}catch{}if(row!=null)rows.Add(row);}
   result=new{sheet=sheet,views=rows.ToArray()};return true;}
  if(op=="drawing_part_sizes"){
   var pv=SheetViews(dr).FirstOrDefault(q=>q.ReferencedDocument is IModelDoc2&&((IModelDoc2)q.ReferencedDocument).GetType()==1);
   if(pv==null)throw new Exception("The sheet has no view of a part");
   result=PartSizes((IModelDoc2)pv.ReferencedDocument,pv);return true;}
  if(op=="drawing_dim_insert"){
   var rows=new List<object>();
   foreach(string name in Items(a["views"]).Select(Convert.ToString)){var v=SheetViews(dr).FirstOrDefault(q=>q.Name==name);if(v==null)throw new Exception("View not found on "+sheet+": "+name);
    d.ClearSelection2(true);if(!d.Extension.SelectByID2(name,"DRAWINGVIEW",0,0,0,false,0,null,0))throw new Exception("Cannot select view "+name);
    int n0=ViewDims(v).Count;dr.InsertModelAnnotations3((int)swImportModelItemsSource_e.swImportModelItemsFromEntireModel,(int)swInsertAnnotation_e.swInsertDimensionsMarkedForDrawing,false,true,true,true);
    d.ClearSelection2(true);rows.Add(new{view=name,before=n0,after=ViewDims(v).Count});}
   d.EditRebuild3();result=new{sheet=sheet,views=rows.ToArray(),note="Unsaved until sw_save."};return true;}
  if(op=="drawing_dim_geometry"){
   var sp=(double[])((ISheet)dr.GetCurrentSheet()).GetProperties2();double w=sp[5]*1000,h=sp[6]*1000;
   var views=SheetViews(dr).Select(ViewRow).ToArray();
   var rows=new List<object>();int unreadable=0;
   HashSet<string> unmarked;try{unmarked=UnmarkedDims(dr);}catch{unmarked=new HashSet<string>();}
   foreach(var kv in DimIndex(dr)){try{rows.Add(DimGeometry(kv.Key,kv.Value,unmarked));}catch{unreadable++;}}
   result=new{sheet=sheet,active_sheet=active,sheets=names,sheet_mm=new[]{Math.Round(w,1),Math.Round(h,1)},title_block_mm=TitleBlockZone(dr,w,h),views=views,notes=LooseNotes(dr),dimensions=rows.ToArray(),unreadable=unreadable};
   return true;}
  var index=DimIndex(dr);var moved=new List<string>();var deleted=new List<string>();var missed=new List<string>();var viewsMoved=new List<string>();var textsSet=new List<string>();
  if(a.ContainsKey("deletes"))foreach(var o in Items(a["deletes"])){string id=Convert.ToString(o);SheetDim x;
   if(!index.TryGetValue(id,out x)){missed.Add(id);continue;}
   d.ClearSelection2(true);if(((IAnnotation)x.Dd.GetAnnotation()).Select3(false,null)&&d.Extension.DeleteSelection2(0))deleted.Add(id);else missed.Add(id);}
  d.ClearSelection2(true);
  if(a.ContainsKey("moves"))foreach(var o in Items(a["moves"]).Cast<Dictionary<string,object>>()){string id=Str(o,"id");SheetDim x;var p=MmPair(o,"pos");
   if(index.TryGetValue(id,out x)&&((IAnnotation)x.Dd.GetAnnotation()).SetPosition2(p[0]/1000,p[1]/1000,0)){moved.Add(id);
    // v3.17 a radius whose text stays on the side of its centre: the arrow reaches the arc from there, without a tail through the part
    if(o.ContainsKey("arrows"))x.Dd.ArrowSide=(int)(Str(o,"arrows")=="inside"?swDimensionArrowsSide_e.swDimArrowsInside:swDimensionArrowsSide_e.swDimArrowsFollowDoc);}
   else missed.Add(id);}
  if(a.ContainsKey("texts"))foreach(var o in Items(a["texts"]).Cast<Dictionary<string,object>>()){string id=Str(o,"id");SheetDim x;
   if(!index.TryGetValue(id,out x)){missed.Add(id);continue;}
   if(o.ContainsKey("prefix"))x.Dd.SetText((int)swDimensionTextParts_e.swDimensionTextPrefix,Str(o,"prefix"));
   if(o.ContainsKey("suffix"))x.Dd.SetText((int)swDimensionTextParts_e.swDimensionTextSuffix,Str(o,"suffix"));
   if(Flag(o,"black"))((IAnnotation)x.Dd.GetAnnotation()).Color=0;
   // v3.17 a diameter with a leader instead of two extension lines: it takes no track around the view. One arrow and the line stops at the circle: it does not cross it to a second arrow
   if(Flag(o,"as_leader")){x.Dd.DisplayAsLinear=false;x.Dd.SetSecondArrow(false,false);x.Dd.SolidLeader=false;}
   // ...and a radius the same: its line stops at the arc, it does not go on to the centre through the part
   if(Flag(o,"open_leader"))x.Dd.SolidLeader=false;
   textsSet.Add(id);}
  if(a.ContainsKey("view_moves"))foreach(var o in Items(a["view_moves"]).Cast<Dictionary<string,object>>()){string name=Str(o,"view");var by=MmPair(o,"by");var v=SheetViews(dr).FirstOrDefault(q=>q.Name==name);
   if(v==null){missed.Add(name);continue;}var q0=(double[])v.Position;v.Position=new[]{q0[0]+by[0]/1000,q0[1]+by[1]/1000};viewsMoved.Add(name);}
  d.EditRebuild3();d.GraphicsRedraw2();
  // v3.17 SolidWorks cuts the hatching of a section around the dimensions that lay on it when they came, and it stays cut after they leave: EditRebuild3 does not draw it again, this does
  if(Flag(a,"rebuild")){d.ForceRebuild3(false);d.GraphicsRedraw2();}
  result=new{sheet=sheet,moved=moved.Count,deleted=deleted.ToArray(),views_moved=viewsMoved.ToArray(),texts=textsSet.ToArray(),missed=missed.ToArray(),note="Unsaved until sw_save."};
  return true;
 }
}
