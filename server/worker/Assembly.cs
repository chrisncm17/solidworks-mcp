using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// Assembly tools: mates (list/suppress/unsuppress) and safe interference detection.
partial class Worker {
 static IAssemblyDoc RequireAssembly(IModelDoc2 d){if(d.GetType()!=(int)swDocumentTypes_e.swDocASSEMBLY)throw new Exception("This tool requires a managed assembly (.SLDASM)");return (IAssemblyDoc)d;}

 static List<IFeature> Mates(IModelDoc2 d){
  var list=new List<IFeature>();
  foreach(var f in AllFeatures(d))if(f.GetTypeName2()=="MateGroup"){var sf=(IFeature)f.GetFirstSubFeature();while(sf!=null){if(sf.GetSpecificFeature2() is IMate2)list.Add(sf);sf=(IFeature)sf.GetNextSubFeature();}}
  return list;
 }

 static string mateRoot="";
 static object MateInfo(IFeature f){
  var mate=(IMate2)f.GetSpecificFeature2();bool warning=false;int error=f.GetErrorCode2(out warning);
  var comps=new List<string>();bool assemblyGeometry=false;
  for(int i=0;i<mate.GetMateEntityCount();i++){var me=mate.MateEntity(i);var c=me.ReferenceComponent as IComponent2;string path=c==null?null:c.GetPathName();
   // Assembly planes/origin are reported with the root component (or null), not with a part.
   if(c==null||path==null||string.Equals(Path.GetFullPath(path),mateRoot,StringComparison.OrdinalIgnoreCase)){assemblyGeometry=true;comps.Add("<assembly>");}else comps.Add(c.Name2);}
  string typeName=Enum.IsDefined(typeof(swMateType_e),mate.Type)?((swMateType_e)mate.Type).ToString():mate.Type.ToString();
  var dims=new List<object>();var dd=(IDisplayDimension)f.GetFirstDisplayDimension();int j=0;while(dd!=null&&j++<10){var dim=(IDimension)dd.GetDimension2(0);if(dim!=null)dims.Add(new{name=dim.FullName,value_si=dim.SystemValue});dd=(IDisplayDimension)f.GetNextDisplayDimension(dd);}
  return new{name=f.Name,type=mate.Type,type_name=typeName,suppressed=f.IsSuppressed(),error_code=error,is_warning=warning,components=comps.ToArray(),references_assembly_geometry=assemblyGeometry,dimensions=dims.ToArray()};
 }

 static object MateSummary(IModelDoc2 d,bool onlyProblems){
  mateRoot=Path.GetFullPath(d.GetPathName());
  var all=Mates(d).Select(MateInfo).ToList();
  Func<object,string,object> get=(o,k)=>o.GetType().GetProperty(k).GetValue(o,null);
  int errors=all.Count(m=>(int)get(m,"error_code")!=0&&!(bool)get(m,"is_warning")&&!(bool)get(m,"suppressed"));
  int warnings=all.Count(m=>(int)get(m,"error_code")!=0&&(bool)get(m,"is_warning"));
  int suppressed=all.Count(m=>(bool)get(m,"suppressed"));
  int toAssembly=all.Count(m=>(bool)get(m,"references_assembly_geometry")&&!(bool)get(m,"suppressed"));
  var shown=onlyProblems?all.Where(m=>(int)get(m,"error_code")!=0||(bool)get(m,"references_assembly_geometry")).ToList():all;
  var fixedComps=((object[])((IAssemblyDoc)d).GetComponents(true)??new object[0]).Cast<IComponent2>().Where(c=>c.IsFixed()).Select(c=>c.Name2).ToArray();
  return new{title=d.GetTitle(),unsaved_changes=d.GetSaveFlag(),mate_count=all.Count,errors=errors,warnings=warnings,suppressed=suppressed,active_mates_to_assembly_geometry=toAssembly,fixed_components=fixedComps,mates=shown.Take(1000).ToArray()};
 }

 static bool TryAssembly(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="mates"){
   RequireAssembly(d);string action=Str(a,"action");bool onlyProblems=a.ContainsKey("only_problems")&&Convert.ToBoolean(a["only_problems"]);
   if(action=="list"){d.ForceRebuild3(false);result=MateSummary(d,onlyProblems);return true;}
   var names=((System.Collections.IEnumerable)a["names"]).Cast<object>().Select(Convert.ToString).ToList();
   var byName=Mates(d).ToDictionary(f=>f.Name,f=>f);
   var missing=names.Where(n=>!byName.ContainsKey(n)).ToArray();
   if(missing.Length>0)throw new Exception("Mates not found (nothing changed): "+string.Join(", ",missing));
   bool suppress=action=="suppress";var changed=new List<string>();
   foreach(var n in names){var f=byName[n];if(f.IsSuppressed()==suppress)continue;d.ClearSelection2(true);if(!f.Select2(false,0))throw new Exception("Could not select mate "+n+"; earlier mates in this call may already be changed (unsaved).");
    bool ok=suppress?d.EditSuppress2():d.EditUnsuppress2();d.ClearSelection2(true);if(!ok)throw new Exception((suppress?"Suppress":"Unsuppress")+" failed for "+n+"; earlier mates in this call may already be changed (unsaved).");changed.Add(n);}
   d.ForceRebuild3(false);
   result=new{action=action,changed=changed.ToArray(),note="Changes are unsaved; call sw_save after reviewing.",after=MateSummary(d,true)};return true;
  }
  if(op=="interference"){
   var asm=RequireAssembly(d);bool coincident=a.ContainsKey("treat_coincidence")&&Convert.ToBoolean(a["treat_coincidence"]);int maxPairs=a.ContainsKey("max_pairs")?Convert.ToInt32(a["max_pairs"]):200;
   bool dirtyBefore=d.GetSaveFlag();
   var comps=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().ToList();
   // The interference manager can reposition under-defined components: remember every transform first.
   var saved=comps.Select(c=>{var t=c.Transform2 as MathTransform;return t==null?null:(double[])t.ArrayData;}).ToList();
   var pairs=new List<object>();int count=0;double total=0;
   int restored=0;double maxMove=0;var notRestored=new List<string>();bool failed=true;
   string recoveryPath=d.GetPathName();bool previouslyPending=recoveryPending.Contains(recoveryPath);recoveryPending.Add(recoveryPath);
   try{
    var mgr=asm.InterferenceDetectionManager;
    try{
     mgr.TreatCoincidenceAsInterference=coincident;mgr.TreatSubAssembliesAsComponents=false;mgr.IncludeMultibodyPartInterferences=true;mgr.MakeInterferingPartsTransparent=false;mgr.CreateFastenersFolder=false;mgr.IgnoreHiddenBodies=true;
     var found=(object[])mgr.GetInterferences()??new object[0];count=found.Length;
     foreach(IInterference it in found){double v=it.Volume*1e9;total+=v;if(pairs.Count>=maxPairs)continue;
      double[] box=null;bool fast=false;try{fast=it.IsFastener;var b=it.GetInterferenceBody() as IBody2;if(b!=null)box=(double[])b.GetBodyBox();}catch{}
      pairs.Add(ExplainInterference(((object[])it.Components??new object[0]).Cast<IComponent2>().Select(c=>c.Name2).ToArray(),v,box,fast));}
    }finally{mgr.Done();}
    failed=false;
   }finally{
    // Always try to put every component back, even if detection threw; report the ones that could not be restored.
    var mu=(IMathUtility)sw.GetMathUtility();
    for(int i=0;i<comps.Count;i++){if(saved[i]==null)continue;
     try{var now=comps[i].Transform2 as MathTransform;if(now==null){notRestored.Add(comps[i].Name2);continue;}var cur=(double[])now.ArrayData;double diff=0;for(int k=0;k<12;k++)diff=Math.Max(diff,Math.Abs(cur[k]-saved[i][k]));
      if(diff>1e-9){maxMove=Math.Max(maxMove,diff);comps[i].Transform2=(MathTransform)mu.CreateTransform(saved[i]);restored++;}}
     catch{string n;try{n=comps[i].Name2;}catch{n="#"+i;}notRestored.Add(n);}}
    try{if(restored>0)d.EditRebuild3();}catch{}
    // Saving stays blocked unless the recovery is verified clean (an exception above leaves the block in place).
    if(!previouslyPending&&!failed&&restored==0&&notRestored.Count==0&&(dirtyBefore||!d.GetSaveFlag()))recoveryPending.Remove(recoveryPath);
   }
   bool blocked=recoveryPending.Contains(d.GetPathName());
   // The exam gives only how many interferences there should be: compare and say where to look.
   int expected=a.ContainsKey("expected_count")?Convert.ToInt32(a["expected_count"]):-1;string hint=null;
   if(expected>=0&&count<expected)hint="Missing "+(expected-count)+": look for parts the drawing makes overlap (closed position of a mechanism, seats, press fits, pins or bolts at nominal size, a plate on one side of a flat versus mid-plane, a dimension read too small). Rerun with treat_coincidence true to list touching pairs; symmetric parts usually add pairs in twos.";
   else if(expected>=0&&count>expected)hint="Extra "+(count-expected)+": check overlap pairs that are not seats (wrong extrude side or mid-plane, wrong dimension, flipped mate) and the mechanism position; fragile pairs come from tiny placement differences.";
   result=new{expected_count=expected<0?(int?)null:expected,count_matches=expected<0?(bool?)null:count==expected,count_hint=hint,interference_count=count,total_volume_mm3=total,treat_coincidence=coincident,pairs=pairs.ToArray(),pairs_truncated=count>pairs.Count,components_repositioned_and_restored=restored,components_not_restored=notRestored.ToArray(),max_transform_change=maxMove,unsaved_changes_before=dirtyBefore,unsaved_changes_after=d.GetSaveFlag(),save_blocked=blocked,
    note=blocked?"Interference detection altered this document; transforms were restored where possible and saving is now BLOCKED. Close with sw_close_document(discard_changes=true) and reopen.":"No component moved. Nothing was saved."};
   return true;
  }
  return false;
 }
 // Shape of the interference body says where its value comes from: thin slivers and tiny volumes depend on tenths of a mm
 // of placement (fragile, cannot be predicted without the reference model); bulky overlaps come from design intent.
 static object ExplainInterference(string[] names,double v,double[] box,bool fastener){
  if(box==null||box.Length<6)return new{components=names,volume_mm3=v,kind=fastener?"fastener":"unknown",fragile=v<1};
  var dims=new[]{(box[3]-box[0])*1000,(box[4]-box[1])*1000,(box[5]-box[2])*1000};var s=dims.OrderBy(x=>x).ToArray();
  double fill=s[0]*s[1]*s[2]>0?v/(s[0]*s[1]*s[2]):0;bool thin=s[0]<0.1,fragile=thin||v<1;
  // v3.11 thread engagement: IsFastener is only set for Toolbox parts; the MCP's own generated bolts (ISO4017_M5x16...) inside a
  // tap-drill hole gave a ring-shaped "overlap" (jet engine: 8 x 69.4 mm3). A fastener by name whose interference is a thin ring
  // around its axis (two equal small sides, ring fill) is the thread, not a clash.
  if(!fastener&&names.Any(n=>System.Text.RegularExpressions.Regex.IsMatch(n,@"(?i)\b(ISO_?\s?(4017|4014|4762|10642|7380|4026|4027|4028|4029)|DIN_?\s?(933|931|912|7991)|bolt|screw|tornillo|perno|esparrago|stud)"))){
   for(int ax=0;ax<3&&!fastener;ax++){var o=dims.Where((x,i)=>i!=ax).ToArray();if(o[0]>0&&Math.Abs(o[0]-o[1])<=0.02*Math.Max(o[0],o[1])+0.01&&o[0]<=36){double rOut=o[0]/2,len=dims[ax];double ring=v/(len*Math.PI);double rIn2=rOut*rOut-ring;
    if(rIn2>0&&Math.Sqrt(rIn2)>0.6*rOut)fastener=true;}}
   if(fastener)return new{components=names,volume_mm3=v,kind="thread_engagement",fragile=false,expected=true,thickness_mm=s[0],box_mm=dims,fill=fill,center_mm=new[]{(box[0]+box[3])*500,(box[1]+box[4])*500,(box[2]+box[5])*500},why="generated bolt without thread inside a tapped (tap-drill) hole: the ring between nominal and drill diameter is the thread engagement, not a clash"};
  }
  string kind=fastener?"fastener":thin?"sliver":v<1?"tiny":"overlap";
  string why=fastener?"bolt or thread at nominal size inside its hole; usually expected":
   thin?"faces almost touching (zero clearance or a part shifted a few hundredths of mm); value changes with tiny placement differences":
   v<1?"small overlap from near-zero clearance or a slightly shifted part; value is fragile":
   "one part sits inside another (mid-plane extrude, seat or press fit, different dimension or mate); reproducible from the drawing";
  return new{components=names,volume_mm3=v,kind=kind,fragile=fragile,thickness_mm=s[0],box_mm=dims,fill=fill,center_mm=new[]{(box[0]+box[3])*500,(box[1]+box[4])*500,(box[2]+box[5])*500},why=why};
 }
}
