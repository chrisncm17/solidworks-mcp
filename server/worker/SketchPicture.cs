using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using SolidWorks.Interop.sldworks;

// v3.24 sketch_picture (airplane from a 3-view, 25-nov): a picture of a drawing goes into a new sketch at its real scale, so
// splines and lofts can be traced on it. The scale comes from two pixels and the real distance between them (or mm_per_px),
// and an anchor pixel lands on a sketch point (e.g. the nose or the root leading edge on the origin). crop_px cuts one view out
// of a sheet with several; flip and rotate turn it the way the plane sees it. All pixel coordinates are in the ORIGINAL file.
// trace_columns also returns the upper and lower outline of the dark part of the picture, in sketch mm, per column.
partial class Worker {
 static bool TrySketchPicture(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="sketch_picture")return false;result=SketchPicture(d,a);return true;
 }

 static double[] SpNums(Dictionary<string,object>a,string k,int n){var v=Items(a[k]).Select(Convert.ToDouble).ToArray();if(v.Length!=n)throw new Exception(k+" needs "+n+" numbers");return v;}

 static object SketchPicture(IModelDoc2 d,Dictionary<string,object>a){
  if(d.GetType()!=1)throw new Exception("sketch_picture needs a part");
  string path=Str(a,"image_path");
  if(!Path.IsPathRooted(path)||!File.Exists(path))throw new Exception("image_path must be an existing absolute file: "+path);
  string ext=Path.GetExtension(path).ToLowerInvariant();if(!new[]{".png",".jpg",".jpeg",".bmp",".gif",".tif",".tiff"}.Contains(ext))throw new Exception("image_path: png, jpg, bmp, gif or tif");
  int W0,H0;double[] crop;bool fx=Flag(a,"flip_x"),fy=Flag(a,"flip_y");int rot=a.ContainsKey("rotate_deg")?Convert.ToInt32(a["rotate_deg"]):0;
  if(rot%90!=0)throw new Exception("rotate_deg: 0, 90, 180 or 270");rot=((rot%360)+360)%360;
  string used=path;int W,H;
  using(var src=new Bitmap(path)){
   W0=src.Width;H0=src.Height;
   crop=a.ContainsKey("crop_px")?SpNums(a,"crop_px",4):new double[]{0,0,W0,H0};
   int x0=Math.Max(0,(int)Math.Floor(crop[0])),y0=Math.Max(0,(int)Math.Floor(crop[1])),x1=Math.Min(W0,(int)Math.Ceiling(crop[2])),y1=Math.Min(H0,(int)Math.Ceiling(crop[3]));
   if(x1-x0<8||y1-y0<8)throw new Exception("crop_px leaves less than 8 x 8 pixels of the picture ("+W0+" x "+H0+")");
   crop=new double[]{x0,y0,x1,y1};
   bool same=x0==0&&y0==0&&x1==W0&&y1==H0&&!fx&&!fy&&rot==0;
   using(var bmp=src.Clone(new Rectangle(x0,y0,x1-x0,y1-y0),PixelFormat.Format32bppArgb)){
    // order: crop, mirror, then turn counterclockwise as seen on the screen
    if(fx)bmp.RotateFlip(RotateFlipType.RotateNoneFlipX);
    if(fy)bmp.RotateFlip(RotateFlipType.RotateNoneFlipY);
    if(rot==90)bmp.RotateFlip(RotateFlipType.Rotate270FlipNone);else if(rot==180)bmp.RotateFlip(RotateFlipType.Rotate180FlipNone);else if(rot==270)bmp.RotateFlip(RotateFlipType.Rotate90FlipNone);
    W=bmp.Width;H=bmp.Height;
    if(!same){string dir=Path.Combine(Root,"pictures");Directory.CreateDirectory(dir);
     used=Path.Combine(dir,Path.GetFileNameWithoutExtension(path)+"_"+DateTime.Now.ToString("yyyyMMddHHmmssfff")+".png");bmp.Save(used,ImageFormat.Png);}
   }
  }
  // original pixel -> pixel of the picture that goes into the sketch (y down)
  Func<double[],double[]> map=p=>{double u=p[0]-crop[0],v=p[1]-crop[1],cw=crop[2]-crop[0],ch=crop[3]-crop[1];
   if(fx)u=cw-u;if(fy)v=ch-v;
   if(rot==90){double t=u;u=v;v=cw-t;}else if(rot==180){u=cw-u;v=ch-v;}else if(rot==270){double t=u;u=ch-v;v=t;}
   return new[]{u,v};};
  double mmPx;
  if(a.ContainsKey("mm_per_px"))mmPx=Num(a,"mm_per_px");
  else if(a.ContainsKey("scale_ref")){var s=(Dictionary<string,object>)a["scale_ref"];var pa=Items(s["px_a"]).Select(Convert.ToDouble).ToArray();var pb=Items(s["px_b"]).Select(Convert.ToDouble).ToArray();
   double px=Math.Sqrt((pa[0]-pb[0])*(pa[0]-pb[0])+(pa[1]-pb[1])*(pa[1]-pb[1]));if(px<2)throw new Exception("scale_ref: px_a and px_b must be at least 2 pixels apart");
   mmPx=Num(s,"distance_mm")/px;}
  else if(a.ContainsKey("width_mm"))mmPx=Num(a,"width_mm")/W;
  else throw new Exception("Give the scale: scale_ref {px_a, px_b, distance_mm}, mm_per_px or width_mm");
  if(!(mmPx>0)||double.IsInfinity(mmPx))throw new Exception("Invalid scale");
  double[] anchorPx,anchorMm;
  if(a.ContainsKey("anchor")){var an=(Dictionary<string,object>)a["anchor"];anchorPx=map(Items(an["px"]).Select(Convert.ToDouble).ToArray());anchorMm=Items(an["at_mm"]).Select(Convert.ToDouble).ToArray();}
  else{anchorPx=new[]{W/2.0,H/2.0};anchorMm=new[]{0.0,0.0};}
  // sketch mm of a picture pixel (u right, v down): x = ox + u*s, y = oy + (H - v)*s
  double oxMm=anchorMm[0]-anchorPx[0]*mmPx,oyMm=anchorMm[1]-(H-anchorPx[1])*mmPx;
  Func<double[],double[]> toMm=p=>{var q=map(p);return new[]{Math.Round(oxMm+q[0]*mmPx,4),Math.Round(oyMm+(H-q[1])*mmPx,4)};};

  var plane=PlaneByIndex(d,a.ContainsKey("plane_index")?Convert.ToInt32(a["plane_index"]):0);
  d.ClearSelection2(true);if(!plane.Select2(false,0))throw new Exception("Cannot select the plane");
  d.SketchManager.InsertSketch(true);
  string name=null;double rx=0,ry=0,rw=0,rh=0;
  try{
   var sk=d.SketchManager.ActiveSketch;if(sk==null)throw new Exception("Could not open a sketch on "+plane.Name);
   var pic=d.SketchManager.InsertSketchPicture(used);if(pic==null)throw new Exception("SolidWorks did not insert the picture "+used);
   pic.SetSize(W*mmPx/1000,H*mmPx/1000,false);pic.SetOrigin(oxMm/1000,oyMm/1000);
   if(a.ContainsKey("transparency")){try{double tr=Num(a,"transparency");pic.SetTransparency(2,tr,0,tr);}catch{}}
   pic.GetOrigin(ref rx,ref ry);pic.GetSize(ref rw,ref rh);
   name=((IFeature)sk).Name;
  }finally{if(d.SketchManager.ActiveSketch!=null)d.SketchManager.InsertSketch(true);d.ClearSelection2(true);}
  if(Math.Abs(rw*1000-W*mmPx)>0.01*W*mmPx||Math.Abs(rx*1000-oxMm)>Math.Max(0.01,0.001*W*mmPx))throw new Exception("The picture did not keep its size or position (size "+Math.Round(rw*1000,3)+" mm, wanted "+Math.Round(W*mmPx,3)+")");
  var r=new Dictionary<string,object>{
   {"sketch",name},{"plane",plane.Name},{"picture_file",used},{"image_px",new[]{W0,H0}},{"picture_px",new[]{W,H}},
   {"mm_per_px",Math.Round(mmPx,6)},{"size_mm",new[]{Math.Round(rw*1000,3),Math.Round(rh*1000,3)}},
   {"origin_mm",new[]{Math.Round(rx*1000,3),Math.Round(ry*1000,3)}},
   {"corners_mm",new{top_left=toMm(new[]{crop[0],crop[1]}),bottom_right=toMm(new[]{crop[2],crop[3]})}},
   {"note","Sketch mm of an original pixel: read them with px_to_mm next time, or use corners_mm; the picture is not geometry (lofts and trims ignore it)."}};
  if(a.ContainsKey("px_to_mm"))r["px_to_mm"]=Items(a["px_to_mm"]).Select(o=>{var p=Items(o).Select(Convert.ToDouble).ToArray();return new{px=p,mm=toMm(p)};}).ToArray();
  if(a.ContainsKey("trace_columns"))r["outline"]=SpTrace(used,Convert.ToInt32(a["trace_columns"]),a.ContainsKey("threshold")?Convert.ToInt32(a["threshold"]):-1,W,H,mmPx,oxMm,oyMm);
  return r;
 }

 // per column: the first and last dark pixel from the top -> sketch mm (upper and lower outline of the drawing)
 static object SpTrace(string path,int n,int threshold,int W,int H,double s,double ox,double oy){
  n=Math.Max(2,Math.Min(400,n));
  using(var bmp=new Bitmap(path)){
   var data=bmp.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new int[W*H];
   System.Runtime.InteropServices.Marshal.Copy(data.Scan0,px,0,px.Length);bmp.UnlockBits(data);
   var lum=new byte[W*H];var hist=new int[256];
   for(int i=0;i<px.Length;i++){int p=px[i];int alpha=(p>>24)&255;int l=alpha<128?255:(int)(0.299*((p>>16)&255)+0.587*((p>>8)&255)+0.114*(p&255));lum[i]=(byte)l;hist[l]++;}
   int t=threshold;
   if(t<0){double sum=0;for(int i=0;i<256;i++)sum+=i*(double)hist[i];double sB=0,wB=0,best=-1;int bt=110;int total=W*H;
    for(int i=0;i<256;i++){wB+=hist[i];if(wB==0)continue;double wF=total-wB;if(wF==0)break;sB+=i*(double)hist[i];double mB=sB/wB,mF=(sum-sB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>best){best=v;bt=i;}}
    t=Math.Min(bt,160);}
   var cols=new List<double[]>();
   for(int k=0;k<n;k++){int u=(int)Math.Round((k+0.5)*W/n);if(u>=W)u=W-1;int top=-1,bot=-1;
    for(int v=0;v<H;v++)if(lum[v*W+u]<=t){top=v;break;}
    for(int v=H-1;v>=0;v--)if(lum[v*W+u]<=t){bot=v;break;}
    if(top<0)continue;
    cols.Add(new[]{Math.Round(ox+(u+0.5)*s,3),Math.Round(oy+(H-top)*s,3),Math.Round(oy+(H-bot-1)*s,3)});}
   return new{threshold=t,columns=cols.Count,points_mm=cols,note="[x, y_top, y_bottom] in sketch mm; lines inside the outline (panels, labels) do not count, text or dimension lines outside it do: crop them out first."};
  }
 }
}
