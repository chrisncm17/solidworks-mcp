using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.3 component tools on a managed assembly:
//  replace_component  — ReplaceComponents2 on one instance (or all), re-attaching mates; reports mates left with errors.
//  component_pattern  — local linear (direction = an edge picked by a point in its component's coordinates, or an assembly
//                       plane normal is NOT allowed: SolidWorks needs an edge/axis) or circular (axis = cylindrical face/edge)
//                       pattern of seed components, via CreateDefinition(swFmLocalLPattern/LocalCirPattern) + CreateFeature.
//  component_solving  — make a subassembly flexible or rigid (CompConfigProperties6, keeping its other properties).
partial class Worker {
 static IComponent2 TopComp(IAssemblyDoc asm,string name){var c=((object[])asm.GetComponents(true)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==name);if(c==null)throw new Exception(name.Contains("/")?"Only top-level components are supported here ("+name+" is inside a subassembly)":"Component not found at the top level: "+name);return c;}
 static Dictionary<string,string> CompPaths(IAssemblyDoc asm){var r=new Dictionary<string,string>();foreach(IComponent2 c in (object[])asm.GetComponents(true)??new object[0])r[c.Name2]=Path.GetFullPath(c.GetPathName()??"");return r;}
 static IComponent2 CompByName(IAssemblyDoc asm,string name){var c=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==name);if(c==null)throw new Exception("Component not found: "+name);return c;}
 // Pick an entity with the same rules as add_mate (component + local point / plane) and return the selected object.
 static object PickEntity(IModelDoc2 d,Dictionary<string,object> e,string what){
  d.ClearSelection2(true);SelectMateEntity(d,e,0,what);var sm=(ISelectionMgr)d.SelectionManager;
  if(sm.GetSelectedObjectCount2(-1)!=1)throw new Exception(what+": expected exactly one selected entity");
  var o=sm.GetSelectedObject6(1,-1);d.ClearSelection2(true);return o;
 }
 static void SelectSeeds(IModelDoc2 d,IComponent2[] seeds,object reference){
  d.ClearSelection2(true);var sm=(ISelectionMgr)d.SelectionManager;
  var sdRef=(SelectData)sm.CreateSelectData();sdRef.Mark=2;((IEntity)reference).Select4(true,sdRef);
  var sdSeed=(SelectData)sm.CreateSelectData();sdSeed.Mark=1;foreach(var c in seeds)c.Select4(true,sdSeed,false);
 }
 static List<string> BrokenMates(IModelDoc2 d){return Mates(d).Where(x=>!x.IsSuppressed()&&MateBroken(x)).Select(x=>x.Name).ToList();}

 static bool TryComponents(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op!="replace_component"&&op!="component_pattern"&&op!="component_solving")return false;
  if(d.GetType()!=2)throw new Exception(op+" needs a managed assembly");var asm=(IAssemblyDoc)d;
  var brokenBefore=new HashSet<string>(BrokenMates(d));
  if(op=="replace_component"){
   var c=TopComp(asm,Str(a,"component"));string file=Str(a,"new_path");
   if(!Path.IsPathRooted(file)||!File.Exists(file))throw new Exception("new_path must be an existing absolute file");
   string ext=Path.GetExtension(file).ToLowerInvariant();if(ext!=Path.GetExtension(c.GetPathName()).ToLowerInvariant())throw new Exception("Replace a part with a part and an assembly with an assembly ("+ext+" vs "+Path.GetExtension(c.GetPathName())+")");
   if(string.Equals(Path.GetFullPath(file),Path.GetFullPath(c.GetPathName()),StringComparison.OrdinalIgnoreCase))throw new Exception("new_path is the file the component already uses");
   string oldFile=c.GetPathName();bool all=Flag(a,"all_instances");string cfg=a.ContainsKey("configuration")?Str(a,"configuration"):"";
   // SolidWorks may close the old component's document while replacing: refuse if it (or the new file) has unsaved changes
   foreach(var pth in new[]{oldFile,file}){var od=(IModelDoc2)sw.GetOpenDocumentByName(pth);if(od!=null&&od.GetSaveFlag())throw new Exception(Path.GetFileName(pth)+" has unsaved changes (often just the conversion from an older SolidWorks version); save first with sw_save include_references:true, or close it (nothing changed)");}
   var pathsBefore=CompPaths(asm);string oldFull=Path.GetFullPath(oldFile),newFull=Path.GetFullPath(file);
   var wanted=all?pathsBefore.Where(kv=>string.Equals(kv.Value,oldFull,StringComparison.OrdinalIgnoreCase)).Select(kv=>kv.Key).ToList():new List<string>{c.Name2};
   var alreadyNew=new HashSet<string>(pathsBefore.Where(kv=>string.Equals(kv.Value,newFull,StringComparison.OrdinalIgnoreCase)).Select(kv=>kv.Key));
   d.ClearSelection2(true);if(!c.Select4(false,null,false))throw new Exception("Cannot select "+c.Name2);
   int choice=cfg==""?(int)swReplaceComponentsConfiguration_e.swReplaceComponentsConfiguration_MatchName:(int)swReplaceComponentsConfiguration_e.swReplaceComponentsConfiguration_ManuallySelect;
   bool ok=false;string apiError=null;try{ok=asm.ReplaceComponents2(file,cfg,all,choice,true);}catch(Exception ex){apiError=ex.Message;}
   d.ClearSelection2(true);try{d.ForceRebuild3(false);}catch{}
   var pathsAfter=CompPaths(asm);
   var nowNew=pathsAfter.Where(kv=>string.Equals(kv.Value,newFull,StringComparison.OrdinalIgnoreCase)&&!alreadyNew.Contains(kv.Key)).Select(kv=>kv.Key).ToArray();
   var stillOld=wanted.Where(n=>pathsAfter.ContainsKey(n)&&string.Equals(pathsAfter[n],oldFull,StringComparison.OrdinalIgnoreCase)).ToArray();
   var othersChanged=pathsBefore.Where(kv=>!wanted.Contains(kv.Key)&&pathsAfter.ContainsKey(kv.Key)&&!string.Equals(kv.Value,pathsAfter[kv.Key],StringComparison.OrdinalIgnoreCase)).Select(kv=>kv.Key).ToArray();
   if(!ok||apiError!=null||stillOld.Length>0||othersChanged.Length>0||nowNew.Length!=wanted.Count){
    bool untouched=nowNew.Length==0&&othersChanged.Length==0&&stillOld.Length==wanted.Count;
    if(!untouched)recoveryPending.Add(d.GetPathName());
    throw new Exception("Replace did not complete as requested"+(apiError!=null?" ("+apiError+")":"")+": replaced "+nowNew.Length+" of "+wanted.Count+(othersChanged.Length>0?", also changed "+string.Join(",",othersChanged):"")+(untouched?"; nothing changed":"; the assembly is PARTIALLY changed, saving is blocked — close without saving"));}
   var newBroken=BrokenMates(d).Where(n=>!brokenBefore.Contains(n)).ToArray();
   result=new{replaced=wanted.ToArray(),now_using_new_file=nowNew,old_file=oldFile,new_file=file,mates_with_new_errors=newBroken,
    note=(newBroken.Length>0?"Some mates could not re-attach: fix them (sw_edit_mate / sw_delete_mate + sw_add_mate) before saving. ":"")+"Unsaved until sw_save.",inspection=Inspect(d)};
   return true;
  }
  if(op=="component_solving"){
   var c=TopComp(asm,Str(a,"component"));if(!c.GetPathName().EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase))throw new Exception("Only subassemblies can be flexible or rigid");
   int sup=c.GetSuppression2();if(sup!=(int)swComponentSuppressionState_e.swComponentFullyResolved&&sup!=(int)swComponentSuppressionState_e.swComponentResolved)throw new Exception(c.Name2+" is suppressed or lightweight; resolve it first (nothing changed)");
   bool flex=Str(a,"solving")=="flexible";int want=flex?(int)swComponentSolvingOption_e.swComponentFlexibleSolving:(int)swComponentSolvingOption_e.swComponentRigidSolving;
   int before=c.Solving;
   if(before!=want){
    d.ClearSelection2(true);if(!c.Select4(false,null,false))throw new Exception("Cannot select "+c.Name2);
    var snap=new object[]{sup,c.Visible,c.ReferencedConfiguration,c.ExcludeFromBOM,c.IsEnvelope()};
    // CompConfigProperties4 sets suppression, solving, visibility, configuration and BOM only (no save-as-part preference)
    bool ok=asm.CompConfigProperties4(sup,want,c.Visible==(int)swComponentVisibilityState_e.swComponentVisible,true,c.ReferencedConfiguration,c.ExcludeFromBOM);
    d.ClearSelection2(true);d.ForceRebuild3(false);
    c=TopComp(asm,Str(a,"component"));
    var after=new object[]{c.GetSuppression2(),c.Visible,c.ReferencedConfiguration,c.ExcludeFromBOM,c.IsEnvelope()};
    if(!ok||c.Solving!=want)throw new Exception("Could not make "+c.Name2+" "+(flex?"flexible":"rigid"));
    if(!snap.SequenceEqual(after))throw new Exception("Solving changed but other component properties changed too ("+string.Join(",",snap)+" → "+string.Join(",",after)+"); close without saving");
   }
   var newBroken=BrokenMates(d).Where(n=>!brokenBefore.Contains(n)).ToArray();
   result=new{component=c.Name2,solving=flex?"flexible":"rigid",changed=before!=want,mates_with_new_errors=newBroken,note="Unsaved until sw_save.",inspection=Inspect(d)};
   return true;
  }
  // component_pattern
  string kind=Str(a,"kind");var seeds=Items(a["seeds"]).Select(Convert.ToString).Select(n=>TopComp(asm,n)).ToArray();
  int count=Convert.ToInt32(a["count"]);if(count<2)throw new Exception("count must be at least 2 (it includes the seed)");
  var feats=new HashSet<string>(AllFeatures(d).Select(f=>f.Name));int compsBefore=((object[])asm.GetComponents(true)??new object[0]).Length;
  IFeature pf=null;
  Func<string,Exception> fail=why=>{
   var created=AllFeatures(d).Where(x=>!feats.Contains(x.Name)).Reverse().ToList();
   foreach(var x in created){d.ClearSelection2(true);try{if(x.Select2(false,0))d.Extension.DeleteSelection2(0);}catch{}}
   d.ClearSelection2(true);try{d.ForceRebuild3(false);}catch{}
   bool clean=!AllFeatures(d).Any(x=>!feats.Contains(x.Name))&&((object[])asm.GetComponents(true)??new object[0]).Length==compsBefore&&!BrokenMates(d).Any(n=>!brokenBefore.Contains(n));
   if(!clean)recoveryPending.Add(d.GetPathName());
   return new Exception(why+(clean?"; nothing was left in the assembly":"; the assembly could NOT be cleaned, saving is blocked — close without saving"));};
  try{
  if(kind=="linear"){
   var dir=PickEntity(d,(Dictionary<string,object>)a["direction"],"direction");
   if(!(dir is IEdge)||!((ICurve)((IEdge)dir).GetCurve()).IsLine())throw new Exception("direction must be a straight edge ({component, local_point_mm, kind: edge})");
   var def=d.FeatureManager.CreateDefinition((int)swFeatureNameID_e.swFmLocalLPattern) as ILocalLinearPatternFeatureData;if(def==null)throw new Exception("CreateDefinition(LocalLPattern) returned null");
   def.SeedComponentArray=seeds.Cast<Component2>().ToArray();def.D1Axis=dir;def.D1TotalInstances=count;def.D1Spacing=Num(a,"spacing_mm")/1000;def.D1ReverseDirection=Flag(a,"reverse");
   pf=d.FeatureManager.CreateFeature(def) as IFeature;
   if(pf==null){SelectSeeds(d,seeds,dir);pf=d.FeatureManager.CreateFeature(def) as IFeature;}
  }else if(kind=="circular"){
   var ax=PickEntity(d,(Dictionary<string,object>)a["axis"],"axis");
   bool okAxis=ax is IFace2&&((ISurface)((IFace2)ax).GetSurface()).IsCylinder()||ax is IEdge&&(((ICurve)((IEdge)ax).GetCurve()).IsLine()||((ICurve)((IEdge)ax).GetCurve()).IsCircle());
   if(!okAxis)throw new Exception("axis must be a cylindrical face or a straight/circular edge");
   var def=d.FeatureManager.CreateDefinition((int)swFeatureNameID_e.swFmLocalCirPattern) as ILocalCircularPatternFeatureData;if(def==null)throw new Exception("CreateDefinition(LocalCirPattern) returned null");
   double total=a.ContainsKey("total_angle_deg")?Num(a,"total_angle_deg"):360;
   string stage="seeds";
   try{def.SeedComponentArray=seeds.Cast<Component2>().ToArray();stage="axis";def.Axis=ax;stage="count";def.TotalInstances=count;stage="equal";def.EqualSpacing=true;stage="spacing";def.Spacing=total*Math.PI/180;stage="reverse";def.ReverseDirection=Flag(a,"reverse");
    stage="create";pf=d.FeatureManager.CreateFeature(def) as IFeature;}catch(Exception ex){throw new Exception("circular pattern failed at "+stage+": "+ex.Message);}
   if(pf==null){SelectSeeds(d,seeds,ax);pf=d.FeatureManager.CreateFeature(def) as IFeature;}
  }else throw new Exception("kind: linear or circular");
  }catch(Exception ex){throw fail("Component pattern failed: "+ex.Message);}
  d.ClearSelection2(true);
  if(pf==null)throw fail("Component pattern failed (SolidWorks returned no feature)");
  d.ForceRebuild3(false);
  int compsAfter=((object[])asm.GetComponents(true)??new object[0]).Length;int added=compsAfter-compsBefore;int expected=seeds.Length*(count-1);
  var newBroken2=BrokenMates(d).Where(n=>!brokenBefore.Contains(n)).ToArray();
  if(added!=expected||newBroken2.Length>0)throw fail("Pattern made "+added+" instances instead of "+expected+(newBroken2.Length>0?" and broke mates "+string.Join(",",newBroken2):""));
  result=new{pattern=pf.Name,kind=kind,seeds=seeds.Select(s=>s.Name2).ToArray(),instances_added=added,note="Pattern instances follow their seed (edit the seed, not the instances). Unsaved until sw_save.",inspection=Inspect(d)};
  return true;
 }
}
