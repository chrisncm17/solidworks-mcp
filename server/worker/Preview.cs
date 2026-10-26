using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.10 preview (idea from HarrierPigeon/Solidworks-MCP-Server, MIT): PNG of one or more standard views and, for parts,
// numbered face labels. Labels are placed with the tessellation projected by the view orientation, calibrated to the picture
// by matching the model box to the largest non-background blob (orthographic views), and hidden faces are skipped with a small
// depth buffer. The legend gives each number a point ON the face (part mm) usable as face_point_mm / point_mm in other tools.
partial class Worker {
 static readonly Dictionary<string,int> PreviewViewIds=new Dictionary<string,int>{{"front",1},{"back",2},{"left",3},{"right",4},{"top",5},{"bottom",6},{"iso",7},{"trimetric",8},{"dimetric",9}};
 class FaceTess{public int Label;public IFace2 Face;public string Kind;public double Area;public double? Diameter;public float[] Tri;public float[] Nrm;}

 static string SaveViewPng(IModelDoc2 doc){
  // the picture must keep the aspect of the graphics window: SaveBMP renders the window's zoom, so another aspect crops it
  int W=1200,H=900;
  try{var vb=Items(((IModelView)doc.ActiveView).GetVisibleBox()).Select(Convert.ToDouble).ToArray();double vw=Math.Abs(vb[2]-vb[0]),vh=Math.Abs(vb[3]-vb[1]);
   if(vw>50&&vh>50){H=(int)Math.Round(W*vh/vw);if(H>1200){H=1200;W=(int)Math.Round(H*vw/vh);}}}catch{}
  string bmp=Path.Combine(Root,Guid.NewGuid().ToString("N")+"-preview.bmp");if(!doc.SaveBMP(bmp,W,H))throw new Exception("Preview failed");
  string png=Path.ChangeExtension(bmp,".png");using(var b=new Bitmap(bmp)){b.Save(png,ImageFormat.Png);}File.Delete(bmp);return png;
 }

 static object Preview(IModelDoc2 doc,Dictionary<string,object> a){
  if(doc.GetType()==3){doc.ViewZoomtofit2();string p=SaveViewPng(doc);return new{path=p,paths=new[]{p}};}
  var names=a.ContainsKey("views")?Items(a["views"]).Select(Convert.ToString).ToArray():new[]{"iso"};
  foreach(var n in names)if(!PreviewViewIds.ContainsKey(n))throw new Exception("Unknown view "+n+" ("+string.Join(", ",PreviewViewIds.Keys)+")");
  bool label=Flag(a,"label_faces");if(label&&doc.GetType()!=1)throw new Exception("label_faces works on parts");
  var faces=label?PreviewFaces(doc,a.ContainsKey("max_labels")?Convert.ToInt32(a["max_labels"]):40):null;
  var paths=new List<string>();var seen=new Dictionary<int,List<string>>();var warnings=new List<string>();
  var mv=(IModelView)doc.ActiveView;
  foreach(var n in names){
   doc.ShowNamedView2("",PreviewViewIds[n]);doc.ViewZoomtofit2();string png=SaveViewPng(doc);
   // the minimized MCP window can fit the model to a frame other than the picture: zoom out and retake while it is cut off
   for(int k=0;k<4&&ModelCutOff(png);k++){File.Delete(png);if(mv!=null)mv.ZoomByFactor(0.75);png=SaveViewPng(doc);}
   if(ModelCutOff(png))warnings.Add(n+": the model touches the picture border");
   paths.Add(png);
   if(faces==null)continue;
   if(mv!=null&&mv.HasPerspective()){warnings.Add(n+": perspective view, no labels");continue;}
   string w=LabelPng(png,faces,(MathTransform)mv.Orientation3,n,seen);if(w!=null)warnings.Add(w);
  }
  object legend=faces==null?null:faces.Select(f=>{var p=AnchorPoint(f);return new{label=f.Label,kind=f.Kind,area_mm2=Math.Round(f.Area*1e6,2),diameter_mm=f.Diameter,
   point_mm=p==null?null:p.Select(x=>Math.Round(x*1000,3)).ToArray(),visible_in=seen.ContainsKey(f.Label)?seen[f.Label].ToArray():new string[0]};}).ToArray();
  return new{path=paths[0],paths=paths.ToArray(),views=names,faces=legend,warnings=warnings.ToArray()};
 }

 static List<FaceTess> PreviewFaces(IModelDoc2 doc,int max){
  var list=new List<FaceTess>();
  foreach(IBody2 b in (object[])((IPartDoc)doc).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0])
   foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){
    var tri=f.GetTessTriangles(true) as float[];if(tri==null||tri.Length<9)continue;var nrm=f.GetTessNorms() as float[];
    var s=(ISurface)f.GetSurface();string kind=s.IsPlane()?"plane":s.IsCylinder()?"cylinder":s.IsCone()?"cone":s.IsSphere()?"sphere":s.IsTorus()?"torus":"other";
    double? dia=null;if(s.IsCylinder())dia=Math.Round(((double[])s.CylinderParams)[6]*2000,3);
    list.Add(new FaceTess{Face=f,Kind=kind,Area=f.GetArea(),Diameter=dia,Tri=tri,Nrm=nrm});}
  list=list.OrderByDescending(x=>x.Area).Take(Math.Max(1,max)).ToList();for(int i=0;i<list.Count;i++)list[i].Label=i+1;
  return list;
 }
 // centroid of the triangle nearest to the area-weighted centre of the face: always a point ON the face
 static double[] AnchorPoint(FaceTess f){return AnchorAmong(f,Enumerable.Range(0,f.Tri.Length/9));}
 static double[] AnchorAmong(FaceTess f,IEnumerable<int> tris){
  var ids=tris.ToList();if(ids.Count==0)return null;double sx=0,sy=0,sz=0,sa=0;var cents=new Dictionary<int,double[]>();
  foreach(int t in ids){var T=f.Tri;int k=t*9;var c=new[]{(T[k]+T[k+3]+T[k+6])/3.0,(T[k+1]+T[k+4]+T[k+7])/3.0,(T[k+2]+T[k+5]+T[k+8])/3.0};cents[t]=c;
   double ux=T[k+3]-T[k],uy=T[k+4]-T[k+1],uz=T[k+5]-T[k+2],vx=T[k+6]-T[k],vy=T[k+7]-T[k+1],vz=T[k+8]-T[k+2];
   double ar=Math.Sqrt(Math.Pow(uy*vz-uz*vy,2)+Math.Pow(uz*vx-ux*vz,2)+Math.Pow(ux*vy-uy*vx,2))/2;sx+=c[0]*ar;sy+=c[1]*ar;sz+=c[2]*ar;sa+=ar;}
  if(sa<=0)return cents[ids[0]];var g=new[]{sx/sa,sy/sa,sz/sa};
  return cents.OrderBy(kv=>Math.Pow(kv.Value[0]-g[0],2)+Math.Pow(kv.Value[1]-g[1],2)+Math.Pow(kv.Value[2]-g[2],2)).First().Value;
 }

 static string LabelPng(string png,List<FaceTess> faces,MathTransform orient,string viewName,Dictionary<int,List<string>> seen){
  var R=(double[])orient.ArrayData;   // rows of the 3x3 rotation; a model point p maps to view (p*R): x right, y up, z to the viewer
  Func<double,double,double,double[]> P=(x,y,z)=>new[]{x*R[0]+y*R[3]+z*R[6],x*R[1]+y*R[4]+z*R[7],x*R[2]+y*R[5]+z*R[8]};
  double minx=double.MaxValue,miny=double.MaxValue,maxx=double.MinValue,maxy=double.MinValue;
  foreach(var f in faces)for(int k=0;k<f.Tri.Length;k+=3){var v=P(f.Tri[k],f.Tri[k+1],f.Tri[k+2]);minx=Math.Min(minx,v[0]);maxx=Math.Max(maxx,v[0]);miny=Math.Min(miny,v[1]);maxy=Math.Max(maxy,v[1]);}
  using(var bmp=new Bitmap(png)){
   int W=bmp.Width,H=bmp.Height;var box=ContentBox(bmp);if(box==null)return viewName+": model not found in the picture, no labels";
   double sx=(box[2]-box[0])/Math.Max(maxx-minx,1e-9),sy=(box[3]-box[1])/Math.Max(maxy-miny,1e-9);
   string warn=Math.Abs(sx-sy)/Math.Max(sx,sy)>0.12?viewName+": picture calibration uncertain, labels approximate":null;
   Func<double[],double[]> toPx=v=>new[]{box[0]+(v[0]-minx)*sx,box[3]-(v[1]-miny)*sy};
   // depth buffer at 1/3 resolution: the nearest surface per cell
   int bw=W/3+1,bh=H/3+1;var zb=new double[bw*bh];for(int i=0;i<zb.Length;i++)zb[i]=double.MinValue;
   var proj=new Dictionary<FaceTess,double[][]>();
   foreach(var f in faces){var pts=new double[f.Tri.Length/3][];for(int k=0;k<f.Tri.Length;k+=3){var v=P(f.Tri[k],f.Tri[k+1],f.Tri[k+2]);var q=toPx(v);pts[k/3]=new[]{q[0]/3,q[1]/3,v[2]};}proj[f]=pts;
    for(int t=0;t+2<pts.Length;t+=3)Raster(pts[t],pts[t+1],pts[t+2],zb,bw,bh);}
   double tol=Math.Max(maxx-minx,maxy-miny)*0.01;
   using(var g=Graphics.FromImage(bmp)){g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
    var font=new Font("Arial",10,FontStyle.Bold);var placed=new List<PointF>();
    foreach(var f in faces){var pts=proj[f];var vis=new List<int>();
     for(int t=0;t*3+2<pts.Length;t++){var c=new[]{(pts[t*3][0]+pts[t*3+1][0]+pts[t*3+2][0])/3,(pts[t*3][1]+pts[t*3+1][1]+pts[t*3+2][1])/3,(pts[t*3][2]+pts[t*3+1][2]+pts[t*3+2][2])/3};
      int cx=(int)c[0],cy=(int)c[1];if(cx<0||cy<0||cx>=bw||cy>=bh)continue;
      if(f.Nrm!=null&&f.Nrm.Length>=t*9+9){int k=t*9;var n=P((f.Nrm[k]+f.Nrm[k+3]+f.Nrm[k+6])/3,(f.Nrm[k+1]+f.Nrm[k+4]+f.Nrm[k+7])/3,(f.Nrm[k+2]+f.Nrm[k+5]+f.Nrm[k+8])/3);if(n[2]<0.05)continue;}
      if(c[2]>=zb[cy*bw+cx]-tol)vis.Add(t);}
     if(vis.Count==0)continue;
     var anchor=AnchorAmong(f,vis);var ap=toPx(P(anchor[0],anchor[1],anchor[2]));var pt=new PointF((float)ap[0],(float)ap[1]);
     if(placed.Any(q=>Math.Abs(q.X-pt.X)<20&&Math.Abs(q.Y-pt.Y)<16))pt=new PointF(pt.X+14,pt.Y+12);
     placed.Add(pt);if(!seen.ContainsKey(f.Label))seen[f.Label]=new List<string>();seen[f.Label].Add(viewName);
     string s=f.Label.ToString();var sz=g.MeasureString(s,font);float rr=Math.Max(sz.Width,sz.Height)/2+2;
     g.FillEllipse(Brushes.White,pt.X-rr,pt.Y-rr,2*rr,2*rr);g.DrawEllipse(new Pen(Color.FromArgb(200,20,20),2),pt.X-rr,pt.Y-rr,2*rr,2*rr);
     g.DrawString(s,font,Brushes.Black,pt.X-sz.Width/2,pt.Y-sz.Height/2);}
    g.DrawString(viewName,new Font("Arial",12,FontStyle.Bold),Brushes.Black,8,8);}
   string tmp=png+".tmp.png";bmp.Save(tmp,ImageFormat.Png);bmp.Dispose();File.Delete(png);File.Move(tmp,png);return warn;
  }
 }
 static void Raster(double[] a,double[] b,double[] c,double[] zb,int bw,int bh){
  int x0=Math.Max(0,(int)Math.Floor(Math.Min(a[0],Math.Min(b[0],c[0])))),x1=Math.Min(bw-1,(int)Math.Ceiling(Math.Max(a[0],Math.Max(b[0],c[0]))));
  int y0=Math.Max(0,(int)Math.Floor(Math.Min(a[1],Math.Min(b[1],c[1])))),y1=Math.Min(bh-1,(int)Math.Ceiling(Math.Max(a[1],Math.Max(b[1],c[1]))));
  double den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.Abs(den)<1e-12)return;
  for(int y=y0;y<=y1;y++)for(int x=x0;x<=x1;x++){double px=x+0.5,py=y+0.5;
   double w1=((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/den,w2=((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/den,w3=1-w1-w2;
   if(w1<-0.01||w2<-0.01||w3<-0.01)continue;double z=w1*a[2]+w2*b[2]+w3*c[2];int i=y*bw+x;if(z>zb[i])zb[i]=z;}
 }
 static bool ModelCutOff(string png){using(var b=new Bitmap(png)){var box=ContentBox(b);return box!=null&&(box[0]<=2||box[1]<=2||box[2]>=b.Width-2||box[3]>=b.Height-2);}}
 // box [left, top, right, bottom] in pixels of the largest blob that differs from the background of its row
 static double[] ContentBox(Bitmap bmp){
  int W=bmp.Width,H=bmp.Height,s=3,gw=W/s,gh=H/s;var mask=new bool[gw*gh];
  var data=bmp.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new int[W*H];
  System.Runtime.InteropServices.Marshal.Copy(data.Scan0,px,0,px.Length);bmp.UnlockBits(data);
  // the model's edges are drawn black and the (gradient) background never is: their box is the model outline
  int dn=0,dx0=int.MaxValue,dy0=int.MaxValue,dx1=-1,dy1=-1;
  for(int y=0;y<H;y++)for(int x=0;x<W;x++){int p=px[y*W+x];if(((p>>16)&255)<70&&((p>>8)&255)<70&&(p&255)<70){dn++;if(x<dx0)dx0=x;if(x>dx1)dx1=x;if(y<dy0)dy0=y;if(y>dy1)dy1=y;}}
  if(dn>=60&&dx1-dx0>10&&dy1-dy0>10)return new double[]{dx0,dy0,dx1+1,dy1+1};
  Func<int,int,int> diff=(p,q)=>Math.Abs(((p>>16)&255)-((q>>16)&255))+Math.Abs(((p>>8)&255)-((q>>8)&255))+Math.Abs((p&255)-(q&255));
  for(int gy=0;gy<gh;gy++){int y=gy*s;int l=px[y*W+2],r=px[y*W+W-3];for(int gx=0;gx<gw;gx++){int p=px[y*W+gx*s];mask[gy*gw+gx]=diff(p,l)>36&&diff(p,r)>36;}}
  var lab=new int[gw*gh];int best=0,bestN=0,id=0;var boxes=new Dictionary<int,int[]>();var stack=new Stack<int>();
  for(int i=0;i<mask.Length;i++){if(!mask[i]||lab[i]!=0)continue;id++;int n=0;var bx=new[]{int.MaxValue,int.MaxValue,-1,-1};stack.Push(i);lab[i]=id;
   while(stack.Count>0){int k=stack.Pop();n++;int x=k%gw,y=k/gw;bx[0]=Math.Min(bx[0],x);bx[1]=Math.Min(bx[1],y);bx[2]=Math.Max(bx[2],x);bx[3]=Math.Max(bx[3],y);
    foreach(int nb in new[]{k-1,k+1,k-gw,k+gw}){if(nb<0||nb>=mask.Length||!mask[nb]||lab[nb]!=0)continue;if((nb==k-1&&x==0)||(nb==k+1&&x==gw-1))continue;lab[nb]=id;stack.Push(nb);}}
   boxes[id]=bx;if(n>bestN){bestN=n;best=id;}}
  if(best==0||bestN<20)return null;var b=boxes[best];return new double[]{b[0]*s,b[1]*s,b[2]*s+s,b[3]*s+s};
 }
}
