using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.10 combine (Combinar, idea from HarrierPigeon/Solidworks-MCP-Server, MIT): add, subtract or keep the common volume of
// the solid bodies of a multibody part. Bodies are picked by a point ON one of their faces (part mm) or by index.
partial class Worker {
 static IBody2 BodyOnPoint(List<IBody2> bodies,object point,string what){
  var p=Items(point).Select(v=>Convert.ToDouble(v)/1000).ToArray();if(p.Length!=3)throw new Exception(what+": [x, y, z] in part mm");
  var hits=bodies.Where(b=>((object[])b.GetFaces()??new object[0]).Cast<IFace2>().Any(f=>{var cp=(double[])f.GetClosestPointOn(p[0],p[1],p[2]);return cp!=null&&Math.Sqrt(Math.Pow(cp[0]-p[0],2)+Math.Pow(cp[1]-p[1],2)+Math.Pow(cp[2]-p[2],2))<=1e-5;})).ToList();
  if(hits.Count!=1)throw new Exception(what+" ("+string.Join(", ",p.Select(v=>Math.Round(v*1000,3)))+" mm): "+(hits.Count==0?"no body surface passes through it; give a point ON a face":"several bodies touch it; pick a point on a face of only one"));
  return hits[0];
 }
 static bool TryCombine(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="combine")return false;
  if(d.GetType()!=1)throw new Exception("combine needs a managed part");
  var bodies=((object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]).Cast<IBody2>().ToList();
  if(bodies.Count<2)throw new Exception("combine needs at least two solid bodies (the part has "+bodies.Count+"); make features with merge=false");
  string operation=Str(a,"operation");
  Func<object,IBody2> byIndex=o=>{int i=Convert.ToInt32(o);if(i<0||i>=bodies.Count)throw new Exception("body index 0.."+(bodies.Count-1));return bodies[i];};
  IBody2 main=null;
  if(a.ContainsKey("main_point_mm"))main=BodyOnPoint(bodies,a["main_point_mm"],"main_point_mm");else if(a.ContainsKey("main_index"))main=byIndex(a["main_index"]);
  var tools=new List<IBody2>();
  if(a.ContainsKey("tool_points_mm"))foreach(var p in Items(a["tool_points_mm"]))tools.Add(BodyOnPoint(bodies,p,"tool_points_mm"));
  if(a.ContainsKey("tool_indexes"))foreach(var i in Items(a["tool_indexes"]))tools.Add(byIndex(i));
  if(operation=="subtract"){if(main==null)throw new Exception("subtract needs main_point_mm or main_index (the body that keeps its material)");
   if(tools.Count==0)tools=bodies.Where(b=>!ReferenceEquals(b,main)).ToList();}
  else{if(main!=null)tools.Insert(0,main);main=null;if(tools.Count==0)tools=bodies.ToList();}
  tools=tools.Distinct().ToList();if(tools.Contains(main))throw new Exception("The main body cannot also be a tool body");
  if(operation!="subtract"&&tools.Count<2)throw new Exception(operation+" needs at least two bodies");
  var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();double v0=mp.Volume*1e9;
  int type=operation=="add"?(int)swBodyOperationType_e.SWBODYADD:operation=="subtract"?(int)swBodyOperationType_e.SWBODYCUT:(int)swBodyOperationType_e.SWBODYINTERSECT;
  IFeature f=null;var attempts=new List<string>();
  foreach(var form in new[]{"selection","dispatch","objects"}){   // selection works on SolidWorks 2026; the array forms return null there
   d.ClearSelection2(true);
   try{
    if(form=="dispatch")f=d.FeatureManager.InsertCombineFeature(type,(Body2)main,tools.Select(b=>(object)new System.Runtime.InteropServices.DispatchWrapper(b)).ToArray()) as IFeature;
    else if(form=="objects")f=d.FeatureManager.InsertCombineFeature(type,(Body2)main,tools.Cast<object>().ToArray()) as IFeature;
    else{ // Combinar dialog order: main body (mark 1, subtract only) then tool bodies (mark 2)
     var sm=(ISelectionMgr)d.SelectionManager;var sd=(ISelectData)sm.CreateSelectData();
     if(main!=null){sd.Mark=1;main.Select2(true,(SelectData)sd);}sd.Mark=2;foreach(var b in tools)b.Select2(true,(SelectData)sd);
     f=d.FeatureManager.InsertCombineFeature(type,null,null) as IFeature;}
   }catch(Exception ex){attempts.Add(form+": "+ex.Message);}
   d.ClearSelection2(true);if(f!=null)break;attempts.Add(form+": null");}
  if(f==null)throw new Exception("SolidWorks did not create the combine ("+operation+"); check that the bodies touch or overlap ["+string.Join("; ",attempts)+"]");
  d.ForceRebuild3(false);
  int after=Items(((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]).Count();
  mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();double v1=mp.Volume*1e9;
  result=new{feature=f.Name,operation=operation,bodies_before=bodies.Count,bodies_after=after,volume_before_mm3=Math.Round(v0,4),volume_after_mm3=Math.Round(v1,4),failed_api_forms=attempts.ToArray(),inspection=Checked(d)};
  return true;
 }
}
