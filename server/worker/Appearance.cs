using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.14 appearance (motor lineal, was Colors.exe): part-level color (MaterialPropertyValues) of a managed part, or of the parts
// behind assembly components. rgb in 0..1; specular 0..1 (default 0.6). Geometry, mass and the tree do not change. In an
// assembly the parts become modified: save with include_references.
partial class Worker {
 static double[] ApColor(object v,string what){var c=Items(v).Select(Convert.ToDouble).ToArray();if(c.Length!=3||c.Any(x=>x<0||x>1||double.IsNaN(x)))throw new Exception(what+": rgb [r, g, b] from 0 to 1");return c;}
 static void ApSet(IModelDoc2 p,double[] rgb,double spec){
  var mp=(double[])p.MaterialPropertyValues;if(mp==null||mp.Length<9)mp=new double[9];
  mp[0]=rgb[0];mp[1]=rgb[1];mp[2]=rgb[2];mp[3]=0.6;mp[4]=0.8;mp[5]=spec;mp[6]=0.5;mp[7]=0;mp[8]=0;
  p.MaterialPropertyValues=mp;p.SetSaveFlag();p.GraphicsRedraw2();
 }
 // v3.25 every face of every body with a point INSIDE it (centroid of its largest display triangle, put back on the face) and
 // the outward normal there, so a script can decide each face's color by where it lies (inside a camouflage patch or not)
 static object ApFaceList(IModelDoc2 d,int max){
  var rows=new List<object>();int k=0;
  foreach(var pair in new[]{new{t=0,kind="solid"},new{t=1,kind="surface"}})foreach(var b in BodiesOf(d,pair.t))foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){
   if(k++>=max)break;double[] pt=null,nr=null;
   var tri=f.GetTessTriangles(true) as float[];var nor=f.GetTessNorms() as float[];
   if(tri!=null&&tri.Length>=9){int best=0;double ba=-1;
    for(int i=0;i+8<tri.Length;i+=9){double ux=tri[i+3]-tri[i],uy=tri[i+4]-tri[i+1],uz=tri[i+5]-tri[i+2],vx=tri[i+6]-tri[i],vy=tri[i+7]-tri[i+1],vz=tri[i+8]-tri[i+2];
     double cx=uy*vz-uz*vy,cy=uz*vx-ux*vz,cz=ux*vy-uy*vx,ar=Math.Sqrt(cx*cx+cy*cy+cz*cz);if(ar>ba){ba=ar;best=i;}}
    pt=new[]{(tri[best]+tri[best+3]+tri[best+6])/3.0,(tri[best+1]+tri[best+4]+tri[best+7])/3.0,(tri[best+2]+tri[best+5]+tri[best+8])/3.0};
    if(nor!=null&&nor.Length>=best+9){var n=new[]{(double)nor[best]+nor[best+3]+nor[best+6],(double)nor[best+1]+nor[best+4]+nor[best+7],(double)nor[best+2]+nor[best+5]+nor[best+8]};double l=Math.Sqrt(n.Sum(v=>v*v));if(l>1e-12)nr=n.Select(v=>Math.Round(v/l,4)).ToArray();}}
   else{var bx=(double[])f.GetBox();pt=new[]{(bx[0]+bx[3])/2,(bx[1]+bx[4])/2,(bx[2]+bx[5])/2};}
   var cp=f.GetClosestPointOn(pt[0],pt[1],pt[2]) as double[];if(cp!=null&&cp.Length>=3)pt=new[]{cp[0],cp[1],cp[2]};
   rows.Add(new{body=b.Name,kind=pair.kind,area_mm2=Math.Round(f.GetArea()*1e6,1),point_mm=pt.Select(v=>Math.Round(v*1000,3)).ToArray(),normal=nr,rgb=FaceRgb(f)});}
  return new{faces=rows.ToArray(),count=rows.Count,note="point_mm lies on the face: pass it to sw_appearance faces[].point_mm or to sw_split_line face_points_mm."};
 }
 static double[] FaceRgb(IFace2 f){var m=f.MaterialPropertyValues as double[];return m==null?null:m.Take(3).Select(v=>Math.Round(v,3)).ToArray();}
 static int TessCount(IFace2 f){var t=f.GetTessTriangles(true) as float[];return t==null?-1:t.Length/9;}
 static bool TryAppearance(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="appearance")return false;
  var done=new List<object>();
  Func<Dictionary<string,object>,double> spec=x=>{double s=x.ContainsKey("specular")?Num(x,"specular"):0.6;if(s<0||s>1)throw new Exception("specular: 0 to 1");return s;};
  if(d.GetType()==1&&Flag(a,"list_faces")&&a.ContainsKey("probe_mm")){
   // diagnostic: every face that passes within 0.05 mm of the point, with its distance to the surface and to the display mesh
   var p=Xyz(a["probe_mm"],"probe_mm");var hits=new List<object>();
   foreach(var b in BodiesOf(d,0).Concat(BodiesOf(d,1)))foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){double dd=FaceDistMm(f,p);if(dd<0.05)hits.Add(new{body=b.Name,area_mm2=Math.Round(f.GetArea()*1e6,1),dist_mm=dd,mesh_dist_mm=TessDistMm(f,p),tess=TessCount(f),rgb=FaceRgb(f)});}
   result=new{probe_mm=p,hits=hits.ToArray(),chosen_area_mm2=Math.Round(AnyFaceAt(d,p,"probe_mm").GetArea()*1e6,1)};return true;}
  if(d.GetType()==1&&Flag(a,"list_faces")){result=ApFaceList(d,a.ContainsKey("max_faces")?Convert.ToInt32(a["max_faces"]):2000);return true;}
  if(d.GetType()==1&&a.ContainsKey("faces")){
   // v3.25 face colors: [{point_mm, rgb, specular?}], each point ON a face (solid or surface body, 0.05 mm), e.g. a camouflage after sw_split_line
   foreach(Dictionary<string,object> x in Items(a["faces"])){
    var p=Xyz(x["point_mm"],"faces[].point_mm");var f=AnyFaceAt(d,p,"faces[].point_mm");var rgb=ApColor(x["rgb"],"faces[].rgb");double s=spec(x);
    double tr=x.ContainsKey("transparency")?Num(x,"transparency"):0;if(tr<0||tr>1)throw new Exception("transparency: 0 to 1");
    var mp=new double[]{rgb[0],rgb[1],rgb[2],0.6,0.8,s,0.5,tr,0};f.MaterialPropertyValues=mp;
    // SolidWorks keeps 8-bit color (0.07 comes back as 18/255): compare with a 1/255-wide tolerance
    var back=f.MaterialPropertyValues as double[];if(back==null||back.Length<3||Enumerable.Range(0,3).Any(i=>Math.Abs(back[i]-rgb[i])>0.006))throw new Exception("SolidWorks did not keep the color of the face at "+string.Join(", ",p)+(back==null?" (no color read back)":" (read back "+string.Join(", ",back.Take(3).Select(v=>Math.Round(v,4)))+")"));
    done.Add(new{point_mm=p,rgb=rgb,mp=mp});}
   // Some faces made by sw_split_line (the centre disc inside a ring) read their color back in place but lose it on a fresh
   // lookup. Re-find every face; one without its color is painted again the way the UI does it (select + SetMaterialPropertyValues).
   Func<double[],double[],bool> same=(m,c)=>m!=null&&m.Length>=3&&Enumerable.Range(0,3).All(i=>Math.Abs(m[i]-c[i])<=0.006);
   int viaSel=0;var lost=new List<double[]>();var retry=new List<dynamic>();
   d.ForceRebuild3(false);   // the loss shows after a full rebuild: check after one
   foreach(dynamic x in done){double[] p=x.point_mm,mp=x.mp;var g=AnyFaceAt(d,p,"faces[].point_mm");if(same(g.MaterialPropertyValues as double[],mp))continue;
    d.ClearSelection2(true);((IEntity)g).Select4(false,null);d.Extension.SetMaterialPropertyValues(mp,(int)swInConfigurationOpts_e.swAllConfiguration,null);d.ClearSelection2(true);retry.Add(x);}
   if(retry.Count>0){d.ForceRebuild3(false);foreach(dynamic x in retry){double[] p=x.point_mm,mp=x.mp;if(same(AnyFaceAt(d,p,"faces[].point_mm").MaterialPropertyValues as double[],mp))viaSel++;else lost.Add(p);}}
   d.SetSaveFlag();d.GraphicsRedraw2();
   result=new{colored_faces=done.Count-lost.Count,repainted_by_selection=viaSel,not_kept=lost.ToArray(),note=lost.Count>0?"Some faces did not keep their color (not_kept); unsaved until sw_save.":"Face colors set (they win over the part color); unsaved until sw_save."};return true;
  }
  if(d.GetType()==1){
   if(a.ContainsKey("parts"))throw new Exception("parts is for assemblies; on a part give rgb");
   ApSet(d,ApColor(a["rgb"],"rgb"),spec(a));done.Add(new{part=d.GetTitle()});
  } else if(d.GetType()==2){
   if(!a.ContainsKey("parts"))throw new Exception("assembly: parts [{component, rgb, specular?}] (component = name or prefix, e.g. Biela-1 or Biela)");
   var comps=((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().ToList();
   foreach(Dictionary<string,object> x in Items(a["parts"])){
    string n=Str(x,"component");var rgb=ApColor(x["rgb"],"parts["+n+"].rgb");double s=spec(x);
    var hit=comps.Where(c=>c.Name2==n||c.Name2.StartsWith(n+"-")||c.Name2.Split('/').Last().StartsWith(n+"-")).ToList();
    if(hit.Count==0)throw new Exception("component not found: "+n);
    foreach(var path in hit.Select(c=>c.GetPathName()).Distinct(StringComparer.OrdinalIgnoreCase)){
     var m=hit.First(c=>c.GetPathName().Equals(path,StringComparison.OrdinalIgnoreCase)).GetModelDoc2() as IModelDoc2;
     if(m==null)throw new Exception(n+": component is suppressed or lightweight (resolve it first)");
     if(m.GetType()!=1)throw new Exception(n+": only part components (a subassembly has no single color)");
     ApSet(m,rgb,s);done.Add(new{component=n,part=System.IO.Path.GetFileName(path)});
    }
   }
   d.GraphicsRedraw2();
  } else throw new Exception("appearance needs a part or an assembly");
  result=new{colored=done.ToArray(),note="Part-level color set; unsaved until sw_save (in an assembly use include_references=true)."};return true;
 }
}
