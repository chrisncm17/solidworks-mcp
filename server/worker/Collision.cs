using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.2:
//  collision  — drive an existing distance/angle mate from its current value toward `to` and stop at the FIRST CONTACT:
//               a new interfering component pair (pairs already interfering at the start are ignored) or the mechanical
//               limit (the mate can no longer be solved). Coarse steps, then bisection to `tolerance`. Restores the start
//               value unless stay_at_contact=true. Interference checks restore any component they move.
//  edit_mate  — change an existing mate without deleting it: value (distance_mm / angle_deg), flip_dimension, align,
//               lock_rotation, through IMateFeatureData + ModifyDefinition; reverted if the mate ends up with an error.
partial class Worker {
 static IFeature MateByName(IModelDoc2 d,string name){var f=Mates(d).FirstOrDefault(x=>x.Name==name);if(f==null)throw new Exception("Mate not found: "+name+" (see sw_mates list)");return f;}
 static bool MateBroken(IFeature f){bool w;int e=f.GetErrorCode2(out w);return e!=0&&!w;}

 // Interfering component pairs (names sorted inside each pair); restores every component the detection moves.
 static HashSet<string> PairKeys(IModelDoc2 d,out int restored){
  var asm=(IAssemblyDoc)d;var comps=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().ToList();
  var saved=comps.Select(c=>{var t=c.Transform2 as MathTransform;return t==null?null:(double[])t.ArrayData;}).ToList();
  var keys=new HashSet<string>();restored=0;
  var mgr=asm.InterferenceDetectionManager;
  try{
   mgr.TreatCoincidenceAsInterference=false;mgr.TreatSubAssembliesAsComponents=false;mgr.IncludeMultibodyPartInterferences=true;mgr.MakeInterferingPartsTransparent=false;mgr.CreateFastenersFolder=false;mgr.IgnoreHiddenBodies=true;
   foreach(IInterference it in (object[])mgr.GetInterferences()??new object[0]){var n=((object[])it.Components??new object[0]).Cast<IComponent2>().Select(c=>c.Name2).OrderBy(x=>x,StringComparer.Ordinal).ToArray();keys.Add(string.Join(" + ",n));}
  }finally{
   try{mgr.Done();}catch{}
   var mu=(IMathUtility)sw.GetMathUtility();int failed=0;
   for(int i=0;i<comps.Count;i++){if(saved[i]==null)continue;
    try{var now=comps[i].Transform2 as MathTransform;if(now==null){failed++;continue;}if(MaxDiff((double[])now.ArrayData,saved[i])>1e-9){comps[i].Transform2=(MathTransform)mu.CreateTransform(saved[i]);restored++;}}catch{failed++;}}
   if(restored>0)try{d.EditRebuild3();}catch{}
   for(int i=0;i<comps.Count&&failed==0;i++){if(saved[i]==null)continue;try{var now=comps[i].Transform2 as MathTransform;if(now==null||MaxDiff((double[])now.ArrayData,saved[i])>1e-9)failed++;}catch{failed++;}}
   if(failed>0)throw new Exception("Interference detection moved "+failed+" component(s) that could not be put back; saving stays blocked — close without saving");}
  return keys;
 }

 static bool TryCollision(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="collision"){
   if(d.GetType()!=2)throw new Exception("collision needs a managed assembly");
   var f=MateByName(d,Str(a,"mate"));var m=(IMate2)f.GetSpecificFeature2();
   bool angle=m.Type==(int)swMateType_e.swMateANGLE;if(!angle&&m.Type!=(int)swMateType_e.swMateDISTANCE)throw new Exception("collision drives a DISTANCE or ANGLE mate (create one with sw_add_mate on the free degree of freedom)");
   var dd=(IDisplayDimension)f.GetFirstDisplayDimension();var dim=dd==null?null:(IDimension)dd.GetDimension2(0);if(dim==null)throw new Exception("The mate has no dimension");
   double k=angle?180/Math.PI:1000;   // SI → deg or mm
   double start=dim.SystemValue*k,to=Num(a,"to"),tol=a.ContainsKey("tolerance")?Num(a,"tolerance"):0.01;
   if(to<0)throw new Exception("to must be ≥ 0 (mate values are unsigned; use flip_dimension with sw_edit_mate to go to the other side)");
   if(Math.Abs(to-start)<tol)throw new Exception("to is the current value ("+Math.Round(start,4)+")");
   double step=a.ContainsKey("step")?Math.Abs(Num(a,"step")):Math.Max(tol,Math.Abs(to-start)/20);
   var only=a.ContainsKey("components")?new HashSet<string>(Items(a["components"]).Select(Convert.ToString)):null;
   int evals=0,restoredTotal=0,maxEval=a.ContainsKey("max_evaluations")?Convert.ToInt32(a["max_evaluations"]):300;
   if(MateBroken(f))throw new Exception("The driving mate "+f.Name+" already has an error; fix it first");
   var brokenAtStart=new HashSet<string>(Mates(d).Where(x=>!x.IsSuppressed()&&MateBroken(x)).Select(x=>x.Name));
   if(Math.Abs(to-start)/step+2*Math.Log(Math.Max(2,step/tol),2)>maxEval)throw new Exception("This needs more than max_evaluations ("+maxEval+") checks; use a larger step or raise max_evaluations");
   string path=d.GetPathName();bool wasPending=recoveryPending.Contains(path);recoveryPending.Add(path);   // blocked until the start state is verified
   Func<double,bool> set=v=>{if(++evals>maxEval+5)throw new Exception("max_evaluations exceeded");int r=dim.SetSystemValue3(v/k,(int)swSetValueInConfiguration_e.swSetValue_InThisConfiguration,null);d.ForceRebuild3(false);return r==0&&!Mates(d).Any(x=>!x.IsSuppressed()&&!brokenAtStart.Contains(x.Name)&&MateBroken(x))&&Math.Abs(dim.SystemValue*k-v)<1e-6;};
   Func<HashSet<string>> pairs=()=>{int rr;var p=PairKeys(d,out rr);restoredTotal+=rr;return p;};
   var basePairs=pairs();
   Func<HashSet<string>,List<string>> fresh=p=>p.Where(x=>!basePairs.Contains(x)&&(only==null||only.Any(c=>x.Split(new[]{" + "},StringSplitOptions.None).Contains(c)))).ToList();
   string kind="no_contact";double good=start,bad=double.NaN;List<string> hit=new List<string>();
   try{
    double dir=Math.Sign(to-start);
    for(double v=start+dir*step;;v+=dir*step){
     if(dir>0?v>to:v<to)v=to;
     if(!set(v)){kind="mechanical_limit";bad=v;break;}
     var nw=fresh(pairs());if(nw.Count>0){kind="collision";bad=v;hit=nw;break;}
     good=v;if(v==to)break;
    }
    if(kind!="no_contact"){
     while(Math.Abs(bad-good)>tol){double mid=(good+bad)/2;
      if(!set(mid)){kind="mechanical_limit";bad=mid;continue;}
      var nw=fresh(pairs());if(nw.Count>0){kind="collision";hit=nw;bad=mid;}else good=mid;}
    }
    if(!set(good))throw new Exception("Could not return to the last free value "+good);
    var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();var cm=((double[])mp.CenterOfMass).Select(x=>Math.Round(x*1000,4)).ToArray();
    bool stay=Flag(a,"stay_at_contact");if(!stay&&!set(start))throw new Exception("Could not restore the start value "+start+"; saving stays blocked");
    // release the save block only when nothing had to be put back by force and the mate sits where it should
    if(restoredTotal==0&&!wasPending&&Math.Abs(dim.SystemValue*k-(stay?good:start))<1e-6)recoveryPending.Remove(path);
    result=new{mate=f.Name,unit=angle?"deg":"mm",start=Math.Round(start,6),to=to,result=kind,contact_value=Math.Round(good,6),first_blocked_value=double.IsNaN(bad)?(double?)null:Math.Round(bad,6),
     new_interfering_pairs=hit.ToArray(),ignored_initial_pairs=basePairs.ToArray(),center_of_mass_at_contact_mm=cm,left_at=stay?"contact":"start",evaluations=evals,
     components_moved_by_detection=restoredTotal,save_blocked=recoveryPending.Contains(d.GetPathName()),
     note=(kind=="no_contact"?"No contact before 'to'. ":"")+"Contact = last value with no new interference (resolution "+tol+" "+(angle?"deg":"mm")+"). Interference detection is static, so very thin parts can be skipped by a coarse step; lower 'step' if in doubt. Unsaved."};
   }catch(Exception ex){bool back=false;try{back=set(start);}catch{}
    if(back&&restoredTotal==0&&!wasPending)recoveryPending.Remove(path);
    throw new Exception(ex.Message+(back?" (the mate was returned to its start value)":" (the start value could NOT be restored; saving is blocked — close without saving)"));}
   return true;
  }
  if(op=="edit_mate"){
   if(d.GetType()!=2)throw new Exception("edit_mate needs a managed assembly");
   var f=MateByName(d,Str(a,"name"));var def=f.GetDefinition();if(def==null)throw new Exception("This mate type cannot be edited through the API definition");
   var asm=(IAssemblyDoc)d;var tBefore=Transforms(asm);var changes=new List<string>();var undo=new List<Action>();
   Action<string,Func<object>,Action<object>,object> apply=(label,get,setv,v)=>{var old=get();setv(v);undo.Add(()=>setv(old));changes.Add(label+": "+old+" → "+v);};
   int alignVal=0;bool hasAlign=a.ContainsKey("align");if(hasAlign){string al=Str(a,"align");alignVal=al=="aligned"?(int)swMateAlign_e.swMateAlignALIGNED:al=="anti_aligned"?(int)swMateAlign_e.swMateAlignANTI_ALIGNED:(int)swMateAlign_e.swMateAlignCLOSEST;}
   if(def is IDistanceMateFeatureData){var x=(IDistanceMateFeatureData)def;
    if(a.ContainsKey("distance_mm"))apply("distance_mm",()=>x.Distance*1000,v=>x.Distance=Convert.ToDouble(v)/1000,Num(a,"distance_mm"));
    if(a.ContainsKey("flip_dimension"))apply("flip_dimension",()=>x.FlipDimension,v=>x.FlipDimension=(bool)v,Flag(a,"flip_dimension"));
    if(hasAlign)apply("align",()=>x.MateAlignment,v=>x.MateAlignment=(int)v,alignVal);}
   else if(def is IAngleMateFeatureData){var x=(IAngleMateFeatureData)def;
    if(a.ContainsKey("angle_deg"))apply("angle_deg",()=>x.Angle*180/Math.PI,v=>x.Angle=Convert.ToDouble(v)*Math.PI/180,Num(a,"angle_deg"));
    if(a.ContainsKey("flip_dimension"))apply("flip_dimension",()=>x.FlipDimension,v=>x.FlipDimension=(bool)v,Flag(a,"flip_dimension"));
    if(hasAlign)apply("align",()=>x.MateAlignment,v=>x.MateAlignment=(int)v,alignVal);}
   else if(def is IConcentricMateFeatureData){var x=(IConcentricMateFeatureData)def;
    if(hasAlign)apply("align",()=>x.MateAlignment,v=>x.MateAlignment=(int)v,alignVal);
    if(a.ContainsKey("lock_rotation"))apply("lock_rotation",()=>x.LockRotation,v=>x.LockRotation=(bool)v,Flag(a,"lock_rotation"));}
   else if(def is ICoincidentMateFeatureData){var x=(ICoincidentMateFeatureData)def;if(hasAlign)apply("align",()=>x.MateAlignment,v=>x.MateAlignment=(int)v,alignVal);}
   else if(def is IParallelMateFeatureData){var x=(IParallelMateFeatureData)def;if(hasAlign)apply("align",()=>x.MateAlignment,v=>x.MateAlignment=(int)v,alignVal);}
   else throw new Exception("Editing this mate type is not supported yet (distance, angle, concentric, coincident, parallel)");
   var ignored=new[]{"distance_mm","angle_deg","flip_dimension","align","lock_rotation"}.Where(n=>a.ContainsKey(n)&&!changes.Any(c=>c.StartsWith(n+":"))).ToArray();
   if(ignored.Length>0)throw new Exception("Not applicable to this "+def.GetType().Name.Replace("MateFeatureData","").TrimStart('I')+" mate: "+string.Join(", ",ignored)+" (nothing changed)");
   if(changes.Count==0)throw new Exception("Nothing to change: give distance_mm/angle_deg, flip_dimension, align or lock_rotation");
   if(!f.ModifyDefinition(def,d,null))throw new Exception("ModifyDefinition was rejected (nothing changed)");
   bool w=false;int code=0;string why=null;
   try{d.EditRebuild3();code=f.GetErrorCode2(out w);if(code!=0&&!w)why="error "+code;}catch(Exception ex){why=ex.Message;}
   if(why!=null){bool back=false;try{foreach(var u in undo)u();back=f.ModifyDefinition(def,d,null);d.EditRebuild3();back=back&&!MateBroken(f);}catch{}
    if(!back)recoveryPending.Add(d.GetPathName());
    throw new Exception("The edit left mate "+f.Name+" with "+why+"; "+(back?"it was reverted":"revert FAILED, saving is blocked — close without saving")+" ("+string.Join("; ",changes)+")");}
   var tAfter=Transforms(asm);
   var moved=tAfter.Where(kv=>tBefore.ContainsKey(kv.Key)&&MaxDiff(tBefore[kv.Key],kv.Value)>1e-9).Select(kv=>new{component=kv.Key,origin_mm=kv.Value.Skip(9).Take(3).Select(v=>Math.Round(v*1000,4)).ToArray()}).ToArray();
   result=new{mate=f.Name,changes=changes.ToArray(),error_code=code,is_warning=w,moved_components=moved,note="Unsaved; call sw_save after reviewing.",inspection=Inspect(d)};return true;
  }
  return false;
 }
}
