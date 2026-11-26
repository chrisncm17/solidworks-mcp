using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 iso_check (Agarradera, 23-nov: the part came out turned over against the isometric of the drawing, built with the arc
// in Alzado and the rhombus in Planta). The lines of the drawing's isometric are compared with the visible edges and outline of
// the model seen in the SolidWorks isometric after each of the 48 ways of turning or mirroring it along its axes. If another way
// matches clearly better than the part as it is, the part is turned over (or mirrored) and the answer says which model axis the
// drawing shows up, and on which plane each sketch had to go. Nothing in the part changes.
partial class Worker {
 const int IsoN=160;

 static bool TryIsoCheck(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="iso_check")return false;result=IsoCheck(d,a);return true;
 }

 // the drawing's lines on an N x N grid: dark pixels of the crop, the content box fitted into the grid keeping its aspect
 static bool[] IsoDrawingLines(string path,double[] region,int threshold,out int usedThreshold,out double aspect){string mode;return IsoDrawingLines(path,region,threshold,out usedThreshold,out aspect,out mode);}
 static bool[] IsoDrawingLines(string path,double[] region,int threshold,out int usedThreshold,out double aspect,out string mode){mode="lines";
  using(var src=new Bitmap(path)){
   int x0=0,y0=0,x1=src.Width,y1=src.Height;
   if(region!=null){x0=Math.Max(0,(int)region[0]);y0=Math.Max(0,(int)region[1]);x1=Math.Min(src.Width,(int)region[2]);y1=Math.Min(src.Height,(int)region[3]);}
   if(x1-x0<20||y1-y0<20)throw new Exception("region_px leaves less than 20 x 20 pixels of the picture ("+src.Width+" x "+src.Height+")");
   int W=x1-x0,H=y1-y0;var lum=new byte[W*H];var hist=new int[256];
   using(var bmp=src.Clone(new Rectangle(x0,y0,W,H),PixelFormat.Format32bppArgb)){
    var data=bmp.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new int[W*H];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0,px,0,px.Length);bmp.UnlockBits(data);
    for(int i=0;i<px.Length;i++){int p=px[i];int l=(int)(0.299*((p>>16)&255)+0.587*((p>>8)&255)+0.114*(p&255));lum[i]=(byte)l;hist[l]++;}}
   int t=threshold;
   if(t<0){ // Otsu, capped: shaded faces of a drawing are grey, its lines black
    double sum=0;for(int i=0;i<256;i++)sum+=i*(double)hist[i];double sB=0,wB=0,best=-1;int bt=110;int total=W*H;
    for(int i=0;i<256;i++){wB+=hist[i];if(wB==0)continue;double wF=total-wB;if(wF==0)break;sB+=i*(double)hist[i];double mB=sB/wB,mF=(sum-sB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>best){best=v;bt=i;}}
    t=Math.Min(bt,110);}
   usedThreshold=t;
   int lx=int.MaxValue,ly=int.MaxValue,hx=-1,hy=-1,n=0;
   for(int y=0;y<H;y++)for(int x=0;x<W;x++)if(lum[y*W+x]<t){n++;if(x<lx)lx=x;if(x>hx)hx=x;if(y<ly)ly=y;if(y>hy)hy=y;}
   if(n<30||hx-lx<10||hy-ly<10)throw new Exception("No drawing lines found in the picture (threshold "+t+"): check image_path / region_px or give line_threshold");
   // v3.22 shaded view: more than a third of the box is dark, so the lines are where the shade jumps
   var line=new bool[W*H];for(int i=0;i<line.Length;i++)line[i]=lum[i]<t;
   if(threshold<0&&n>0.33*(hx-lx+1)*(hy-ly+1)){mode="shaded: lines where the shade jumps";int m2=0;
    for(int y=ly;y<=hy;y++)for(int x=lx;x<=hx;x++){int i=y*W+x,v=lum[i],j=0;
     if(x+1<W)j=Math.Max(j,Math.Abs(v-lum[i+1]));if(y+1<H)j=Math.Max(j,Math.Abs(v-lum[i+W]));if(x>0)j=Math.Max(j,Math.Abs(v-lum[i-1]));if(y>0)j=Math.Max(j,Math.Abs(v-lum[i-W]));
     line[i]=j>=28;if(line[i])m2++;}
    if(m2<30){mode="lines";for(int i=0;i<line.Length;i++)line[i]=lum[i]<t;}}
   double bw=hx-lx+1,bh=hy-ly+1;aspect=bw/bh;double s=(IsoN-8)/Math.Max(bw,bh),ox=(IsoN-bw*s)/2,oy=(IsoN-bh*s)/2;
   var g=new bool[IsoN*IsoN];
   for(int y=ly;y<=hy;y++)for(int x=lx;x<=hx;x++)if(line[y*W+x]){int gx=(int)(ox+(x-lx)*s),gy=(int)(oy+(y-ly)*s);if(gx>=0&&gy>=0&&gx<IsoN&&gy<IsoN)g[gy*IsoN+gx]=true;}
   return g;
  }
 }

 // v3.22 separate groups of lines (8-neighbours, gaps of one cell bridged), largest share first
 static List<double> IsoGroups(bool[] g){int N=IsoN;var lab=new int[N*N];var sizes=new List<int>();int total=g.Count(x=>x);
  for(int s=0;s<g.Length;s++){if(!g[s]||lab[s]!=0)continue;int id=sizes.Count+1,cnt=0;var st=new Stack<int>();st.Push(s);lab[s]=id;
   while(st.Count>0){int i=st.Pop();cnt++;int x=i%N,y=i/N;for(int dy=-2;dy<=2;dy++)for(int dx=-2;dx<=2;dx++){int xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=N||yy>=N)continue;int j=yy*N+xx;if(g[j]&&lab[j]==0){lab[j]=id;st.Push(j);}}}
   sizes.Add(cnt);}
  return sizes.OrderByDescending(x=>x).Select(x=>total==0?0:(double)x/total).ToList();}

 // chamfer (3-4) distance transform, in grid cells
 static double[] IsoDist(bool[] g){
  int N=IsoN;var d=new double[N*N];for(int i=0;i<d.Length;i++)d[i]=g[i]?0:1e9;
  for(int y=0;y<N;y++)for(int x=0;x<N;x++){int i=y*N+x;double v=d[i];
   if(x>0)v=Math.Min(v,d[i-1]+1);if(y>0){v=Math.Min(v,d[i-N]+1);if(x>0)v=Math.Min(v,d[i-N-1]+1.4142);if(x<N-1)v=Math.Min(v,d[i-N+1]+1.4142);}d[i]=v;}
  for(int y=N-1;y>=0;y--)for(int x=N-1;x>=0;x--){int i=y*N+x;double v=d[i];
   if(x<N-1)v=Math.Min(v,d[i+1]+1);if(y<N-1){v=Math.Min(v,d[i+N]+1);if(x<N-1)v=Math.Min(v,d[i+N+1]+1.4142);if(x>0)v=Math.Min(v,d[i+N-1]+1.4142);}d[i]=v;}
  return d;
 }

 class IsoModel{public List<float[]> Tri=new List<float[]>();public List<double[][]> Edges=new List<double[][]>();}
 static IsoModel IsoGeometry(IModelDoc2 d){
  var m=new IsoModel();
  foreach(IBody2 b in (object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]){
   foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){var t=f.GetTessTriangles(true) as float[];if(t!=null&&t.Length>=9)m.Tri.Add(t);}
   foreach(IEdge e in (object[])b.GetEdges()??new object[0]){
    try{var c=(ICurve)e.GetCurve();var cp=(double[])e.GetCurveParams2();if(c==null||cp==null||cp.Length<8)continue;
     int k=c.IsLine()?1:40;var pts=new double[k+1][];
     for(int i=0;i<=k;i++){double u=cp[6]+(cp[7]-cp[6])*i/k;var ev=(double[])c.Evaluate2(u,0);pts[i]=new[]{ev[0],ev[1],ev[2]};}
     if(c.IsLine()){pts[0]=new[]{cp[0],cp[1],cp[2]};pts[1]=new[]{cp[3],cp[4],cp[5]};}
     m.Edges.Add(pts);}catch{}}
  }
  if(m.Tri.Count==0)throw new Exception("The part has no solid body to compare");
  return m;
 }

 // the model seen in the iso after turning it with Q (rows of a signed permutation): visible edges + outline on the N x N grid
 static bool[] IsoModelLines(IsoModel m,double[] R,int[,] Q,out double aspect){
  int N=IsoN;
  Func<double,double,double,double[]> P=(x,y,z)=>{double qx=Q[0,0]*x+Q[0,1]*y+Q[0,2]*z,qy=Q[1,0]*x+Q[1,1]*y+Q[1,2]*z,qz=Q[2,0]*x+Q[2,1]*y+Q[2,2]*z;
   return new[]{qx*R[0]+qy*R[3]+qz*R[6],qx*R[1]+qy*R[4]+qz*R[7],qx*R[2]+qy*R[5]+qz*R[8]};};
  double minx=double.MaxValue,miny=double.MaxValue,maxx=double.MinValue,maxy=double.MinValue,minz=double.MaxValue,maxz=double.MinValue;
  var proj=new List<double[]>();
  foreach(var t in m.Tri)for(int k=0;k+2<t.Length;k+=3){var v=P(t[k],t[k+1],t[k+2]);proj.Add(v);minx=Math.Min(minx,v[0]);maxx=Math.Max(maxx,v[0]);miny=Math.Min(miny,v[1]);maxy=Math.Max(maxy,v[1]);minz=Math.Min(minz,v[2]);maxz=Math.Max(maxz,v[2]);}
  double bw=maxx-minx,bh=maxy-miny;aspect=bw/Math.Max(bh,1e-12);double s=(N-8)/Math.Max(Math.Max(bw,bh),1e-12),ox=(N-bw*s)/2,oy=(N-bh*s)/2;
  Func<double[],double[]> G=v=>new[]{ox+(v[0]-minx)*s,oy+(maxy-v[1])*s,v[2]};
  var zb=new double[N*N];for(int i=0;i<zb.Length;i++)zb[i]=double.MinValue;
  for(int i=0;i+2<proj.Count;i+=3)Raster(G(proj[i]),G(proj[i+1]),G(proj[i+2]),zb,N,N);
  var g=new bool[N*N];double tol=Math.Max(maxz-minz,1e-9)*0.02;
  foreach(var e in m.Edges)for(int i=0;i+1<e.Length;i++){
   var a=G(P(e[i][0],e[i][1],e[i][2]));var b=G(P(e[i+1][0],e[i+1][1],e[i+1][2]));int steps=Math.Max(1,(int)(Math.Sqrt(Math.Pow(b[0]-a[0],2)+Math.Pow(b[1]-a[1],2))*2));
   for(int k=0;k<=steps;k++){double f=(double)k/steps,x=a[0]+(b[0]-a[0])*f,y=a[1]+(b[1]-a[1])*f,z=a[2]+(b[2]-a[2])*f;int gx=(int)x,gy=(int)y;if(gx<0||gy<0||gx>=N||gy>=N)continue;
    double top=double.MinValue;for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int xx=gx+dx,yy=gy+dy;if(xx>=0&&yy>=0&&xx<N&&yy<N)top=Math.Max(top,zb[yy*N+xx]);}
    if(z>=top-tol)g[gy*N+gx]=true;}}
  for(int y=0;y<N;y++)for(int x=0;x<N;x++){int i=y*N+x;if(zb[i]==double.MinValue)continue;
   if(x==0||y==0||x==N-1||y==N-1||zb[i-1]==double.MinValue||zb[i+1]==double.MinValue||zb[i-N]==double.MinValue||zb[i+N]==double.MinValue)g[i]=true;}
  return g;
 }

 static double IsoScore(bool[] model,double[] dModel,bool[] draw,double[] dDraw){
  double a=0,b=0;int na=0,nb=0;
  for(int i=0;i<model.Length;i++){if(model[i]){a+=Math.Min(dDraw[i],30);na++;}if(draw[i]){b+=Math.Min(dModel[i],30);nb++;}}
  if(na==0||nb==0)return 1e9;return (a/na+b/nb)/2;
 }

 static readonly string[] IsoAxis={"X","Y","Z"};
 static string IsoAxisName(int[] v){for(int k=0;k<3;k++)if(v[k]!=0)return (v[k]>0?"+":"-")+IsoAxis[k];return "?";}
 static object IsoDescribe(int[,] Q,double score,bool current){
  // view axes of the SolidWorks iso: +Y up, +X to the lower right, +Z to the lower left. A model axis a ends on Q a, so the model
  // axis shown up is Q^T(+Y)
  Func<int,int[]> back=k=>new[]{Q[k,0],Q[k,1],Q[k,2]};
  int det=Q[0,0]*(Q[1,1]*Q[2,2]-Q[1,2]*Q[2,1])-Q[0,1]*(Q[1,0]*Q[2,2]-Q[1,2]*Q[2,0])+Q[0,2]*(Q[1,0]*Q[2,1]-Q[1,1]*Q[2,0]);
  var planes=new[]{new{name="Alzado",n=2},new{name="Planta",n=1},new{name="Vista lateral",n=0}};
  var moves=new List<object>();
  foreach(var p in planes){int to=-1,sg=0;for(int k=0;k<3;k++)if(Q[k,p.n]!=0){to=k;sg=Q[k,p.n];}
   string dest=to==2?"Alzado":to==1?"Planta":"Vista lateral";if(dest!=p.name||sg<0)moves.Add(new{from=p.name,to=dest,reversed=sg<0});}
  return new{score=Math.Round(score,2),current,mirrored=det<0,drawing_up=IsoAxisName(back(1)),drawing_lower_right=IsoAxisName(back(0)),drawing_lower_left=IsoAxisName(back(2)),sketch_planes=moves.ToArray()};
 }

 static object IsoCheck(IModelDoc2 d,Dictionary<string,object> a){
  if(d.GetType()!=1)throw new Exception("iso_check works on parts");
  string img=Str(a,"image_path");if(!Path.IsPathRooted(img)||!File.Exists(img))throw new Exception("image_path must be an existing absolute PNG/JPG (a render or crop of the drawing)");
  double[] region=a.ContainsKey("region_px")?Items(a["region_px"]).Select(Convert.ToDouble).ToArray():null;
  if(region!=null&&(region.Length!=4||region[2]<=region[0]||region[3]<=region[1]))throw new Exception("region_px: [left, top, right, bottom] in pixels");
  int thr=a.ContainsKey("line_threshold")?Convert.ToInt32(a["line_threshold"]):-1;
  int used;double drawAspect;string drawMode;var draw=IsoDrawingLines(img,region,thr,out used,out drawAspect,out drawMode);var dDraw=IsoDist(draw);
  // a whole sheet (views, frame, title block) is not one isometric: without region_px the verdict would compare the wrong thing
  var groups=IsoGroups(draw);int bigGroups=groups.Count(x=>x>=0.05);
  string sheetWarning=region==null&&bigGroups>=3?"The picture holds "+bigGroups+" separate drawings (a whole sheet?): give region_px [left, top, right, bottom] around the isometric view only; the verdict is not trusted without it.":null;
  // the SolidWorks isometric of this document (the same one sw_preview iso shows)
  var mv=(IModelView)d.ActiveView;if(mv==null)throw new Exception("No model view");
  d.ShowNamedView2("",7);var R=((double[])((MathTransform)mv.Orientation3).ArrayData).Take(9).ToArray();
  var geo=IsoGeometry(d);
  var cands=new List<Tuple<int[,],double,bool[],double>>();
  var perms=new[]{new[]{0,1,2},new[]{0,2,1},new[]{1,0,2},new[]{1,2,0},new[]{2,0,1},new[]{2,1,0}};
  foreach(var pm in perms)for(int sgn=0;sgn<8;sgn++){
   var Q=new int[3,3];for(int r=0;r<3;r++)Q[r,pm[r]]=((sgn>>r)&1)==1?-1:1;
   double asp;var lines=IsoModelLines(geo,R,Q,out asp);var sc=IsoScore(lines,IsoDist(lines),draw,dDraw);
   cands.Add(Tuple.Create(Q,sc,lines,asp));}
  Func<int[,],bool> isId=Q=>Q[0,0]==1&&Q[1,1]==1&&Q[2,2]==1;
  var ranked=cands.OrderBy(c=>c.Item2).ToList();var cur=cands.First(c=>isId(c.Item1));var best=ranked[0];
  int curRank=ranked.IndexOf(cur)+1;
  // a symmetric part looks the same turned several ways: it is right when the part as it is scores as well as the best
  bool ok=cur.Item2<=best.Item2*1.08+0.15&&sheetWarning==null;
  bool clear=!ok&&cur.Item2>=best.Item2*1.25&&sheetWarning==null;
  // the picture: drawing | model as it is | best way (drawing lines in grey under each model)
  string png=Path.Combine(Root,Guid.NewGuid().ToString("N")+"-iso-check.png");int Z=3,N=IsoN;
  using(var bmp=new Bitmap(N*Z*3+40,N*Z+40)){using(var g=Graphics.FromImage(bmp)){g.Clear(Color.White);var f=new Font("Arial",11,FontStyle.Bold);
   Action<bool[],int,Color> draw1=(m,col,c)=>{using(var br=new SolidBrush(c))for(int i=0;i<m.Length;i++)if(m[i])g.FillRectangle(br,10+col*(N*Z+10)+(i%N)*Z,30+(i/N)*Z,Z,Z);};
   draw1(draw,0,Color.Black);draw1(draw,1,Color.FromArgb(200,200,200));draw1(cur.Item3,1,Color.FromArgb(200,30,30));
   draw1(draw,2,Color.FromArgb(200,200,200));draw1(best.Item3,2,Color.FromArgb(20,120,20));
   g.DrawString("plano (iso)",f,Brushes.Black,10,6);g.DrawString("pieza como está ("+Math.Round(cur.Item2,2)+")",f,Brushes.DarkRed,10+N*Z+10,6);
   g.DrawString((isId(best.Item1)?"mejor: como está":"mejor: girada")+" ("+Math.Round(best.Item2,2)+")",f,Brushes.DarkGreen,10+2*(N*Z+10),6);}
   bmp.Save(png,ImageFormat.Png);}
  string verdict=sheetWarning!=null?"doubtful: "+sheetWarning:ok?"ok: the part sits like the drawing isometric":clear?"turned: the part does not sit like the drawing isometric":"doubtful: another way matches a little better; look at the picture";
  string fix=null;
  if(!ok){var bd=best.Item1;bool mir=bd[0,0]*(bd[1,1]*bd[2,2]-bd[1,2]*bd[2,1])-bd[0,1]*(bd[1,0]*bd[2,2]-bd[1,2]*bd[2,0])+bd[0,2]*(bd[1,0]*bd[2,1]-bd[1,1]*bd[2,0])<0;
   fix=(mir?"Mirrored: a sketch is drawn the other way round or a feature went to the wrong side. ":"")+"Rebuild with the sketches on the planes in best.sketch_planes (reversed = flip the sketch or the extrude direction), so the drawing up is the model +Y; then run iso_check again.";}
  return new{verdict,ok,clear,current=IsoDescribe(cur.Item1,cur.Item2,true),current_rank=curRank,best=IsoDescribe(best.Item1,best.Item2,isId(best.Item1)),
   others=ranked.Skip(1).Take(3).Select(c=>IsoDescribe(c.Item1,c.Item2,isId(c.Item1))).ToArray(),fix,
   drawing_mode=drawMode,warning=sheetWarning,drawing_aspect=Math.Round(drawAspect,3),model_aspect=Math.Round(cur.Item4,3),line_threshold=used,path=png,paths=new[]{png},
   note="score = mean distance in grid cells (160 per side) between the drawing lines and the model edges, lower is better. Only the SolidWorks isometric is compared; the part is not changed."};
 }
}
