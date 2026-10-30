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
 static bool TryAppearance(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="appearance")return false;
  var done=new List<object>();
  Func<Dictionary<string,object>,double> spec=x=>{double s=x.ContainsKey("specular")?Num(x,"specular"):0.6;if(s<0||s>1)throw new Exception("specular: 0 to 1");return s;};
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
