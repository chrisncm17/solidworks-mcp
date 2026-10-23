using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.5 explode: exploded view (vista explosionada) of the active configuration of a managed assembly.
//  list     — exploded views and their steps (components, distance, direction reversed).
//  create   — steps [{components, direction X|Y|Z (assembly axes) or {component, local_point_mm, kind} edge/face, distance_mm, reverse}];
//             replace=true first deletes the existing steps/view. Each step is checked: its components must move by distance_mm.
//  show / collapse / delete.
partial class Worker {
 static IFeature AsmPlaneForAxis(IModelDoc2 d,string axis){
  // the default plane whose NORMAL is the requested world axis (tree order and names depend on the template/language)
  int k=axis=="X"?0:axis=="Y"?1:2;
  foreach(var f in AllFeatures(d).Where(x=>x.GetTypeName2()=="RefPlane").Take(3)){var rp=f.GetSpecificFeature2() as IRefPlane;if(rp==null)continue;var t=(double[])((MathTransform)rp.Transform).ArrayData;
   if(Math.Abs(Math.Abs(t[6+k])-1)<1e-9)return f;}
  throw new Exception("No default plane normal to "+axis);
 }
 static object ExplodeInfo(IAssemblyDoc asm,IConfiguration cfg){
  var names=((object[])asm.GetExplodedViewNames2(cfg.Name)??new object[0]).Select(Convert.ToString).ToArray();
  var steps=new List<object>();
  for(int i=0;i<cfg.GetNumberOfExplodeSteps();i++){var st=(IExplodeStep)cfg.GetExplodeStep(i);if(st==null)continue;
   steps.Add(new{name=st.Name,components=Enumerable.Range(0,st.GetNumOfComponents()).Select(k=>st.GetComponentName(k)).ToArray(),distance_mm=Math.Round(st.ExplodeDistance*1000,4),reverse=st.ReverseTranslationDirection});}
  return new{configuration=cfg.Name,exploded_views=names,steps=steps.ToArray()};
 }
 static bool TryExplode(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="explode")return false;
  if(d.GetType()!=2)throw new Exception("explode needs a managed assembly");
  var asm=(IAssemblyDoc)d;var cfg=(IConfiguration)d.ConfigurationManager.ActiveConfiguration;string action=Str(a,"action");
  Func<string> evName=()=>((object[])asm.GetExplodedViewNames2(cfg.Name)??new object[0]).Select(Convert.ToString).LastOrDefault();
  if(action=="list"){result=ExplodeInfo(asm,cfg);return true;}
  if(action=="show"||action=="collapse"){string ev=evName();if(ev==null)throw new Exception("No exploded view in configuration "+cfg.Name);
   if(!asm.ShowExploded2(action=="show",ev))throw new Exception("Could not "+action+" "+ev);if(action=="collapse")asm.ViewCollapseAssembly();d.EditRebuild3();result=ExplodeInfo(asm,cfg);return true;}
  Action wipe=()=>{var en=evName();if(en!=null){asm.ShowExploded2(false,en);asm.ViewCollapseAssembly();}
   while(cfg.GetNumberOfExplodeSteps()>0){var es=(IExplodeStep)cfg.GetExplodeStep(0);if(es==null||!cfg.DeleteExplodeStep(es.Name))throw new Exception("Could not delete explode step "+(es==null?"?":es.Name));}
   foreach(var n in ((object[])asm.GetExplodedViewNames2(cfg.Name)??new object[0]).Select(Convert.ToString).ToList()){d.ClearSelection2(true);if(d.Extension.SelectByID2(n,"EXPLODEDVIEWS",0,0,0,false,0,null,0))d.Extension.DeleteSelection2(0);}
   d.ClearSelection2(true);d.EditRebuild3();};
  if(action=="delete"){wipe();result=ExplodeInfo(asm,cfg);return true;}
  if(action!="create")throw new Exception("action: list, create, show, collapse or delete");
  if((cfg.GetNumberOfExplodeSteps()>0||evName()!=null)&&!Flag(a,"replace"))throw new Exception("Configuration "+cfg.Name+" already has an exploded view; pass replace=true to rebuild it");
  wipe();
  var sm=(ISelectionMgr)d.SelectionManager;
  var all=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().ToList();
  var home=all.ToDictionary(c=>c.Name2,c=>(double[])((MathTransform)c.Transform2).ArrayData);
  var homeBox=all.ToDictionary(c=>c.Name2,c=>(double[])c.GetBox(false,false));
  var trace=new List<string>();Action<string> trc=lbl=>trace.Add(lbl+": "+string.Join(" | ",all.Select(c=>{var t=(double[])((MathTransform)c.Transform2).ArrayData;return c.Name2+"("+Math.Round(t[9]*1000,2)+","+Math.Round(t[10]*1000,2)+","+Math.Round(t[11]*1000,2)+")";})));trc("home");
  Func<double[]> cmNow=()=>{var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();return ((double[])mp.CenterOfMass).Select(x=>x*1000).ToArray();};var cm0=cmNow();
  Func<string,Exception> Undo=why=>{bool clean=false,back=false;
   try{wipe();clean=evName()==null&&cfg.GetNumberOfExplodeSteps()==0;
    back=all.All(c=>{var t=(double[])((MathTransform)c.Transform2).ArrayData;return MaxDiff(t,home[c.Name2])<1e-9;});}catch{}
   if(!clean||!back)recoveryPending.Add(d.GetPathName());
   return new Exception(why+(clean&&back?"; the exploded view was removed and every component is back (nothing left)":"; the assembly could NOT be fully restored, saving is blocked — close without saving"));};
  if(evName()==null&&!asm.CreateExplodedView())throw new Exception("CreateExplodedView failed");
  int autoSteps=cfg.GetNumberOfExplodeSteps();while(cfg.GetNumberOfExplodeSteps()>0){var es0=(IExplodeStep)cfg.GetExplodeStep(0);if(es0==null||!cfg.DeleteExplodeStep(es0.Name)){wipe();throw new Exception("Could not remove the automatic explode steps; nothing was created");}}
  string view=evName();if(view==null)throw new Exception("No exploded view after CreateExplodedView");
  var expected=new Dictionary<string,double[]>();var stepPlan=new List<object[]>();   // cumulative expected displacement vector per component (mm)
  var made=new List<object>();int k=0;
  try{
   foreach(Dictionary<string,object> st in Items(a["steps"])){k++;
    var comps=Items(st["components"]).Select(Convert.ToString).Select(n=>{var c=all.FirstOrDefault(x=>x.Name2==n);if(c==null)throw new Exception("step "+k+": component not found: "+n);return c;}).ToList();
    double dist=Num(st,"distance_mm");bool rev=Flag(st,"reverse");stepPlan.Add(new object[]{comps.Select(c=>c.Name2).ToArray(),st["direction"],dist,rev});
    d.ClearSelection2(true);
    foreach(var c in comps){var sd=(SelectData)sm.CreateSelectData();sd.Mark=1;if(!c.Select4(true,sd,false))throw new Exception("step "+k+": cannot select "+c.Name2);}
    var dir=st["direction"];
    if(dir is string){var pl=AsmPlaneForAxis(d,Convert.ToString(dir));var sd2=(SelectData)sm.CreateSelectData();sd2.Mark=2;if(!pl.Select2(true,2))throw new Exception("step "+k+": cannot select the direction plane");}
    else SelectMateEntity(d,(Dictionary<string,object>)dir,2,"step "+k+" direction");
    var before=comps.ToDictionary(c=>c.Name2,c=>(double[])((MathTransform)c.Transform2).ArrayData);
    var es=cfg.AddExplodeStep(dist/1000,rev,false,false) as IExplodeStep;d.ClearSelection2(true);
    if(es==null)throw new Exception("step "+k+": AddExplodeStep failed (direction must be an assembly axis, a straight edge or a planar face)");
    d.EditRebuild3();
    // measure how far each component moved in this step
    var moves=comps.Select(c=>{var t=(double[])((MathTransform)c.Transform2).ArrayData;var b=before[c.Name2];var v=new[]{(t[9]-b[9])*1000,(t[10]-b[10])*1000,(t[11]-b[11])*1000};
     if(!expected.ContainsKey(c.Name2))expected[c.Name2]=new double[3];for(int i=0;i<3;i++)expected[c.Name2][i]+=v[i];return Math.Sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);}).ToList();
    if(moves.Any(m=>Math.Abs(m-dist)>0.01))throw new Exception("step "+k+": components moved "+string.Join("/",moves.Select(m=>Math.Round(m,3)))+" mm instead of "+dist+" mm");
    trc("after "+es.Name);made.Add(new{step=es.Name,components=comps.Select(c=>c.Name2).ToArray(),distance_mm=dist,moved_mm=moves.Select(m=>Math.Round(m,4)).ToArray()});
   }
  }catch(Exception ex){throw Undo(ex.Message);}
  // verify in the real exploded state: displacement of each component = sum of its steps; axis steps along that world axis
  asm.ShowExploded2(true,view);d.ForceRebuild3(false);trc("exploded");
  var want=new Dictionary<string,double[]>();var free=new HashSet<string>();bool axisOnly=true;
  Func<string,string,bool> under=(child,parent)=>child==parent||child.StartsWith(parent+"/");
  foreach(var sp in stepPlan){var names=(string[])sp[0];var dir=sp[1] as string;
   var affected=all.Where(c=>names.Any(n=>under(c.Name2,n))).Select(c=>c.Name2).ToList();
   if(dir==null){axisOnly=false;foreach(var n in affected)free.Add(n);continue;}
   double dd=(double)sp[2]*((bool)sp[3]?-1:1);int ax=dir=="X"?0:dir=="Y"?1:2;
   foreach(var n in affected){if(!want.ContainsKey(n))want[n]=new double[3];want[n][ax]+=dd;}}
  var disp=all.Select(c=>{var t=(double[])((MathTransform)c.Transform2).ArrayData;var h=home[c.Name2];return new{c.Name2,v=new[]{(t[9]-h[9])*1000,(t[10]-h[10])*1000,(t[11]-h[11])*1000}};}).ToList();
  var wrong=new List<string>();
  foreach(var dp in disp){if(free.Contains(dp.Name2))continue;var w=want.ContainsKey(dp.Name2)?want[dp.Name2]:new double[3];double e=Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(dp.v[i]-w[i],2)));if(e>0.01)wrong.Add(dp.Name2+" moved ("+string.Join(", ",dp.v.Select(x=>Math.Round(x,3)))+") expected ("+string.Join(", ",w.Select(x=>Math.Round(x,3)))+")");}
  if(wrong.Count>0)throw Undo("Exploded positions do not match the requested directions: "+string.Join("; ",wrong));
  bool keep=Flag(a,"keep_exploded");
  // collapse for real: ShowExploded2(false) alone can leave the components in exploded display positions
  bool shown=asm.ShowExploded2(keep,view);trc("after ShowExploded2("+keep+")="+shown);if(!keep){asm.ViewCollapseAssembly();trc("after ViewCollapseAssembly");}d.ForceRebuild3(false);trc("after rebuild");
  // collapsed again → every component back home (translation in mm, rotation entries separately)
  double off=0;var offs=new List<string>();
  if(!keep)foreach(var c in all){var t=(double[])((MathTransform)c.Transform2).ArrayData;var h=home[c.Name2];double tr=Math.Sqrt(Enumerable.Range(9,3).Sum(i=>Math.Pow((t[i]-h[i])*1000,2)));double rot=Enumerable.Range(0,9).Max(i=>Math.Abs(t[i]-h[i]));
   var bx=(double[])c.GetBox(false,false);var hb=homeBox[c.Name2];double boxOff=bx==null||hb==null?double.NaN:Enumerable.Range(0,6).Max(i=>Math.Abs(bx[i]-hb[i]))*1000;
   if(tr>1e-6||rot>1e-9){offs.Add(c.Name2+" "+Math.Round(tr,4)+" mm");}off=Math.Max(off,tr+(rot>1e-9?1:0));}
  var cm1=cmNow();double cmOff=Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(cm1[i]-cm0[i],2)));
  if(!keep&&off>0.001)throw Undo("The assembly did not collapse back ("+string.Join("; ",offs)+")");
  result=new{exploded_view=view,automatic_steps_removed=autoSteps,exploded_displacement_mm=disp.Select(x=>new{component=x.Name2,vector=x.v.Select(q=>Math.Round(q,4)).ToArray()}).ToArray(),directions_verified=axisOnly?"all":"axis steps only (edge/face directions checked by distance)",show_exploded_returned=shown,center_of_mass_shift_mm=Math.Round(cmOff,6),steps=made.ToArray(),left=keep?"exploded":"collapsed",max_offset_after_collapse=Math.Round(off,6),not_home=offs.ToArray(),info=ExplodeInfo(asm,cfg),note="In a drawing, sw_drawing_sheets add_view with exploded=true shows it. Unsaved until sw_save."};
  return true;
 }
}
