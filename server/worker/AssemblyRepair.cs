using System;

using System.IO;

using System.Linq;

using System.Collections.Generic;

using SolidWorks.Interop.sldworks;

using SolidWorks.Interop.swconst;



// v2.8 assembly_repair on a managed assembly:

//  snapshot  - save the pose (every component transform), center of mass, broken mates and constrained status under a name.

//  compare   - current state vs a snapshot: moved/rotated components, added/missing components, CM shift, newly broken mates.

//  fix_mates - search, in rounds, for mate changes that remove the errors: keep the mate (flip the dimension side, change

//              alignment) and, only with allow_suppress, suppress it. Candidates are the broken mates AND the mates SolidWorks

//              flags as over-defined warnings (the intruder is often the warned one, not the one with the error).

//              With reference (a snapshot name) a solution is accepted only if every error is gone AND the pose matches the

//              snapshot: that is what "rebuild without errors keeping the intended pose" means. Without reference, only if no

//              component outside the changed mates moves. Everything is simulated first; apply=false (default) reverts it all.

partial class Worker {

 class RepairEval { public int Broken; public List<string> BrokenNames; public double RefMm, RefDeg, Sum; public List<object> Moved; public HashSet<string> MovedNames; }

 class RepairOption { public string Mate, Variant; public RepairEval Eval; }

 static string PoseDir(){var p=Path.Combine(Root,"poses");Directory.CreateDirectory(p);return p;}

 static string PosePath(IModelDoc2 d,string name){

  if(string.IsNullOrWhiteSpace(name)||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw new Exception("name must be a simple snapshot name");

  return Path.Combine(PoseDir(),Path.GetFileNameWithoutExtension(d.GetPathName())+"__"+name+".json");}

 static Dictionary<string,object> LoadPose(IModelDoc2 d,string name){

  string path=PosePath(d,name);if(!File.Exists(path))throw new Exception("Snapshot not found: "+name+" (take it first with action=snapshot)");

  var snap=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));

  if(!string.Equals(Convert.ToString(snap["document"]),d.GetPathName(),StringComparison.OrdinalIgnoreCase))throw new Exception("That snapshot belongs to another document");

  return snap;}

 static Dictionary<string,double[]> PoseTransforms(Dictionary<string,object> snap){return ((Dictionary<string,object>)snap["transforms"]).ToDictionary(kv=>kv.Key,kv=>Items(kv.Value).Select(Convert.ToDouble).ToArray());}

 static double[] CmNow(IModelDoc2 d){d.ClearSelection2(true);var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();return ((double[])mp.CenterOfMass).Select(x=>x*1000).ToArray();}

 static double RotDeg(double[] a,double[] b){double tr=0;for(int i=0;i<3;i++)for(int k=0;k<3;k++)tr+=a[3*i+k]*b[3*i+k];return Math.Acos(Math.Max(-1,Math.Min(1,(tr-1)/2)))*180/Math.PI;}

 static double PosMm(double[] a,double[] b){return Math.Sqrt(Enumerable.Range(9,3).Sum(i=>Math.Pow((a[i]-b[i])*1000,2)));}

 static List<object> PoseDiff(Dictionary<string,double[]> before,Dictionary<string,double[]> after,double tolMm,double tolDeg,ICollection<string> ignore){

  var r=new List<object>();

  foreach(var kv in after){if(!before.ContainsKey(kv.Key)||(ignore!=null&&ignore.Contains(kv.Key)))continue;double p=PosMm(before[kv.Key],kv.Value),q=RotDeg(before[kv.Key],kv.Value);

   if(p>tolMm||q>tolDeg)r.Add(new{component=kv.Key,moved_mm=Math.Round(p,4),rotated_deg=Math.Round(q,4)});}

  return r;

 }

 static List<string> MateComponents(IFeature f){var r=new List<string>();var m=f.GetSpecificFeature2() as IMate2;if(m==null)return r;for(int i=0;i<m.GetMateEntityCount();i++){var c=m.MateEntity(i).ReferenceComponent as IComponent2;if(c!=null&&!r.Contains(c.Name2))r.Add(c.Name2);}return r;}

 static RepairEval EvalRepair(IAssemblyDoc asm,IModelDoc2 d,Dictionary<string,double[]> basePose,ICollection<string> ignore,double tolMm,double tolDeg){

  var now=Transforms(asm);var e=new RepairEval();e.BrokenNames=Mates(d).Where(x=>!x.IsSuppressed()&&MateBroken(x)).Select(x=>x.Name).ToList();e.Broken=e.BrokenNames.Count;

  e.Moved=PoseDiff(basePose,now,tolMm,tolDeg,ignore);

  e.MovedNames=new HashSet<string>();

  if(ignore==null){foreach(var k in basePose.Keys.Where(k=>!now.ContainsKey(k)))e.Moved.Add(new{component=k,missing=true});

   foreach(var k in now.Keys.Where(k=>!basePose.ContainsKey(k)))e.Moved.Add(new{component=k,added=true});

   e.Sum+=1e6*(basePose.Keys.Count(k=>!now.ContainsKey(k))+now.Keys.Count(k=>!basePose.ContainsKey(k)));}

  foreach(var kv in now)if(basePose.ContainsKey(kv.Key)&&(ignore==null||!ignore.Contains(kv.Key))){double p=PosMm(basePose[kv.Key],kv.Value),q=RotDeg(basePose[kv.Key],kv.Value);

   e.RefMm=Math.Max(e.RefMm,p);e.RefDeg=Math.Max(e.RefDeg,q);if(p>tolMm||q>tolDeg){e.Sum+=p+q;e.MovedNames.Add(kv.Key);}}

  return e;

 }

 // full fingerprint used to prove that a trial (or the whole search) was undone exactly: suppression, error, alignment and flip of every mate

 static Dictionary<string,string> MateStates(IModelDoc2 d){var r=new Dictionary<string,string>();

  foreach(var f in Mates(d)){string s=f.IsSuppressed()?"S":"A";

   try{bool w;s+="|"+f.GetErrorCode2(out w);var def=f.GetDefinition();

    if(def is IDistanceMateFeatureData){var x=(IDistanceMateFeatureData)def;s+="|"+x.MateAlignment+"|"+x.FlipDimension;}

    else if(def is IAngleMateFeatureData){var x=(IAngleMateFeatureData)def;s+="|"+x.MateAlignment+"|"+x.FlipDimension;}

    else if(def is IConcentricMateFeatureData)s+="|"+((IConcentricMateFeatureData)def).MateAlignment;

    else if(def is ICoincidentMateFeatureData)s+="|"+((ICoincidentMateFeatureData)def).MateAlignment;

    else if(def is IParallelMateFeatureData)s+="|"+((IParallelMateFeatureData)def).MateAlignment;}catch{s+="|?";}

   r[f.Name]=s;}

  return r;}

 static List<string> StateDiff(IAssemblyDoc asm,IModelDoc2 d,Dictionary<string,string> st0,Dictionary<string,double[]> p0){

  var r=new List<string>();var st=MateStates(d);

  foreach(var k in st0.Keys.Union(st.Keys)){string x,y;st0.TryGetValue(k,out x);st.TryGetValue(k,out y);if(x!=y)r.Add("mate "+k+": "+x+" -> "+y);}

  var p=Transforms(asm);foreach(var k in p0.Keys.Union(p.Keys)){if(!p0.ContainsKey(k)||!p.ContainsKey(k))r.Add("component set changed: "+k);else if(MaxDiff(p0[k],p[k])>1e-8)r.Add("pose of "+k+" ("+Math.Round(PosMm(p0[k],p[k]),4)+" mm, "+Math.Round(RotDeg(p0[k],p[k]),4)+" deg)");}

  return r;}

 static void RestorePose(IAssemblyDoc asm,Dictionary<string,double[]> pose){var mu=(IMathUtility)sw.GetMathUtility();
  foreach(IComponent2 c in (object[])asm.GetComponents(false)??new object[0]){double[] p;if(c.IsFixed()||!pose.TryGetValue(c.Name2,out p))continue;var t=c.Transform2 as MathTransform;if(t!=null&&MaxDiff((double[])t.ArrayData,p)<=1e-12)continue;
   c.Transform2=(MathTransform)mu.CreateTransform(p);}}
 static void UndoAll(List<Action> undo){for(int i=undo.Count-1;i>=0;i--){try{undo[i]();}catch{}}undo.Clear();}

 // one change to a mate; returns its undo (null if the variant does not apply). Suppress is one more variant.

 static Action MateVariant(IModelDoc2 d,IFeature f,string variant){

  if(variant=="suppress"){var before=Transforms((IAssemblyDoc)d);d.ClearSelection2(true);if(!f.Select2(false,0)||!d.EditSuppress2()){d.ClearSelection2(true);return null;}d.ClearSelection2(true);d.EditRebuild3();

   // Unsuppressing is NOT an exact undo in an over-defined assembly (tested: the solver lets the last solved mate win and the pose
   // jumps). SolidWorks Undo restores the previous state; fall back to unsuppress only if Undo did not bring the mate back.
   // jumps). Unsuppress, put the components back where they were and rebuild so the solver starts from the previous pose.
   return ()=>{d.ClearSelection2(true);f.Select2(false,0);d.EditUnsuppress2();d.ClearSelection2(true);RestorePose((IAssemblyDoc)d,before);d.EditRebuild3();};}

  var def=f.GetDefinition();if(def==null)return null;Action revert=null;bool changed=false;var pose=Transforms((IAssemblyDoc)d);

  int al=variant=="aligned"?(int)swMateAlign_e.swMateAlignALIGNED:variant=="anti_aligned"?(int)swMateAlign_e.swMateAlignANTI_ALIGNED:(int)swMateAlign_e.swMateAlignCLOSEST;

  if(def is IDistanceMateFeatureData){var x=(IDistanceMateFeatureData)def;if(variant=="flip"){var o=x.FlipDimension;x.FlipDimension=!o;revert=()=>x.FlipDimension=o;changed=true;}else{var o=x.MateAlignment;if(o!=al){x.MateAlignment=al;revert=()=>x.MateAlignment=o;changed=true;}}}

  else if(def is IAngleMateFeatureData){var x=(IAngleMateFeatureData)def;if(variant=="flip"){var o=x.FlipDimension;x.FlipDimension=!o;revert=()=>x.FlipDimension=o;changed=true;}else{var o=x.MateAlignment;if(o!=al){x.MateAlignment=al;revert=()=>x.MateAlignment=o;changed=true;}}}

  else if(variant!="flip"&&def is IConcentricMateFeatureData){var x=(IConcentricMateFeatureData)def;var o=x.MateAlignment;if(o!=al){x.MateAlignment=al;revert=()=>x.MateAlignment=o;changed=true;}}

  else if(variant!="flip"&&def is ICoincidentMateFeatureData){var x=(ICoincidentMateFeatureData)def;var o=x.MateAlignment;if(o!=al){x.MateAlignment=al;revert=()=>x.MateAlignment=o;changed=true;}}

  else if(variant!="flip"&&def is IParallelMateFeatureData){var x=(IParallelMateFeatureData)def;var o=x.MateAlignment;if(o!=al){x.MateAlignment=al;revert=()=>x.MateAlignment=o;changed=true;}}

  if(!changed)return null;

  if(!f.ModifyDefinition(def,d,null))return null;

  d.EditRebuild3();

  return ()=>{revert();f.ModifyDefinition(def,d,null);RestorePose((IAssemblyDoc)d,pose);d.EditRebuild3();};

 }

 static bool TryAssemblyRepair(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){

  result=null;if(op!="assembly_repair")return false;

  if(d.GetType()!=2)throw new Exception("assembly_repair needs a managed assembly");var asm=(IAssemblyDoc)d;string action=Str(a,"action");

  double tolMm=a.ContainsKey("tolerance_mm")?Num(a,"tolerance_mm"):0.001,tolDeg=a.ContainsKey("tolerance_deg")?Num(a,"tolerance_deg"):0.001;

  if((action=="snapshot"||action=="compare")&&!a.ContainsKey("name"))throw new Exception("name is required for "+action);

  if(action=="snapshot"){

   d.ForceRebuild3(false);var t=Transforms(asm);var cm=CmNow(d);

   var status=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().ToDictionary(c=>c.Name2,c=>{try{return c.GetConstrainedStatus();}catch{return -1;}});

   var snap=new Dictionary<string,object>{{"document",d.GetPathName()},{"created",DateTime.Now.ToString("s")},{"transforms",t.ToDictionary(kv=>kv.Key,kv=>(object)kv.Value)},{"center_of_mass_mm",cm},{"broken_mates",BrokenMates(d).ToArray()},{"constrained_status",status.ToDictionary(kv=>kv.Key,kv=>(object)kv.Value)}};

   string path=PosePath(d,Str(a,"name"));File.WriteAllText(path,Json.Serialize(snap));

   result=new{snapshot=Str(a,"name"),path=path,components=t.Count,center_of_mass_mm=cm.Select(x=>Math.Round(x,4)).ToArray(),broken_mates=snap["broken_mates"]};return true;

  }

  if(action=="compare"){

   var snap=LoadPose(d,Str(a,"name"));var before=PoseTransforms(snap);

   d.ForceRebuild3(false);var now=Transforms(asm);var moved=PoseDiff(before,now,tolMm,tolDeg,null);

   var added=now.Keys.Where(k=>!before.ContainsKey(k)).ToArray();var removed=before.Keys.Where(k=>!now.ContainsKey(k)).ToArray();

   var cm0=Items(snap["center_of_mass_mm"]).Select(Convert.ToDouble).ToArray();var cm1=CmNow(d);

   var brokenBefore=new HashSet<string>(Items(snap["broken_mates"]).Select(Convert.ToString));var brokenNow=BrokenMates(d);

   var st0=(Dictionary<string,object>)snap["constrained_status"];

   var stChanged=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().Where(c=>st0.ContainsKey(c.Name2)).Select(c=>{int s;try{s=c.GetConstrainedStatus();}catch{s=-1;}return new{c=c.Name2,b=Convert.ToInt32(st0[c.Name2]),n=s};}).Where(x=>x.b!=x.n).Select(x=>new{component=x.c,before=DoctorConstraint(x.b),now=DoctorConstraint(x.n)}).ToArray();

   bool same=moved.Count==0&&added.Length==0&&removed.Length==0&&brokenNow.All(brokenBefore.Contains);

   result=new{verdict=same?"postura conservada":"la postura cambió",moved=moved.ToArray(),added_components=added,missing_components=removed,center_of_mass_shift_mm=Math.Round(Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(cm1[i]-cm0[i],2))),6),

    broken_before=brokenBefore.ToArray(),broken_now=brokenNow.ToArray(),newly_broken=brokenNow.Where(x=>!brokenBefore.Contains(x)).ToArray(),fixed_since=brokenBefore.Where(x=>!brokenNow.Contains(x)).ToArray(),constrained_status_changed=stChanged,

    note="constrained_status_changed means the intended freedom changed (e.g. a part that used to turn is now fully defined, or a fixed one became free). Check free movements with sw_assembly_doctor."};

   return true;

  }

  if(action!="fix_mates")throw new Exception("action: snapshot, compare or fix_mates");

  bool apply=Flag(a,"apply"),allowSuppress=Flag(a,"allow_suppress");

  string refName=a.ContainsKey("reference")?Str(a,"reference"):null;

  var refPose=refName==null?null:PoseTransforms(LoadPose(d,refName));

  HashSet<string> only=a.ContainsKey("mates")?new HashSet<string>(Items(a["mates"]).Select(Convert.ToString)):null;

  if(only!=null)foreach(var n in only)MateByName(d,n);

  var variants=allowSuppress?new[]{"flip","aligned","anti_aligned","closest","suppress"}:new[]{"flip","aligned","anti_aligned","closest"};

  var pose0=Transforms(asm);var start=BrokenMates(d);var states0=MateStates(d);string docPath=d.GetPathName();

  if(start.Count==0&&(refPose==null||EvalRepair(asm,d,refPose,null,tolMm,tolDeg).Moved.Count==0)){result=new{verdict=refPose==null?"sin relaciones con error":"sin errores y con la postura de la foto "+refName,applied=false,would_work=true,steps=new object[0],broken_mates_now=start.ToArray(),note=refPose==null?"No broken mates. A mate flipped the wrong way has no error: pass reference=<snapshot of the good assembly> to detect and fix it.":"Nothing to repair."};return true;}

  var undo=new List<Action>();var steps=new List<object>();var changed=new HashSet<string>();var touched=new HashSet<string>();var tried=new List<object>();

  int current=start.Count;

  for(int round=0;round<10&&current>0;round++){

   // candidates: broken mates + mates flagged with a warning code (over-defined), not changed yet

   var cands=Mates(d).Where(x=>!x.IsSuppressed()&&!changed.Contains(x.Name)&&(only==null||only.Contains(x.Name))).Where(x=>{bool w;int e=x.GetErrorCode2(out w);return e!=0;}).ToList();

   if(cands.Count==0)break;

   var options=new List<RepairOption>();

   foreach(var f in cands)foreach(var v in variants){

    var stT=MateStates(d);var pT=Transforms(asm);Action u=null;RepairEval ev=null;

    try{u=MateVariant(d,f,v);

     if(u!=null){var ign=new HashSet<string>(touched);foreach(var n in MateComponents(f))ign.Add(n);

      ev=refPose!=null?EvalRepair(asm,d,refPose,null,tolMm,tolDeg):EvalRepair(asm,d,pose0,ign,tolMm,tolDeg);}}

    catch{ev=null;}

    finally{if(u!=null)try{u();}catch{}}

    var bad=StateDiff(asm,d,stT,pT);

    if(bad.Count>0){UndoAll(undo);var left=StateDiff(asm,d,states0,pose0);if(left.Count>0)recoveryPending.Add(docPath);

     throw new Exception("Trial "+v+" on "+f.Name+" could not be undone exactly ("+string.Join("; ",bad.Take(5))+"). "+(left.Count>0?"Saving is BLOCKED: close without saving.":"The whole search was reverted."));}

    if(ev==null)continue;

    options.Add(new RepairOption{Mate=f.Name,Variant=v,Eval=ev});

    tried.Add(new{round=round+1,mate=f.Name,variant=v,broken_after=ev.Broken,max_deviation_mm=Math.Round(ev.RefMm,4),max_deviation_deg=Math.Round(ev.RefDeg,4)});

   }

   // fewer errors than now and no newly broken mates; rank: errors, pose deviation, keeping the mate before suppressing it

   var best=options.Where(o=>o.Eval.Broken<current&&o.Eval.BrokenNames.All(n=>start.Contains(n)||n==o.Mate)).OrderBy(o=>o.Eval.Broken).ThenBy(o=>o.Eval.Sum).ThenBy(o=>o.Variant=="suppress"?1:0).FirstOrDefault();

   if(best==null)break;

   var fb=MateByName(d,best.Mate);var ub=MateVariant(d,fb,best.Variant);if(ub==null)break;

   undo.Add(ub);changed.Add(best.Mate);foreach(var n in MateComponents(fb))touched.Add(n);

   current=BrokenMates(d).Count;steps.Add(new{mate=best.Mate,change=best.Variant,suppressed=best.Variant=="suppress",broken_after=current});

  }

  // phase 2 (only with reference): no errors left but the pose differs -> a mate solved to the wrong side/alignment.

  // Try flip/alignment (never suppress) on the mates of the components that moved; keep a change only if it reduces the deviation without errors.

  if(refPose!=null){var orient=new[]{"flip","aligned","anti_aligned","closest"};

   for(int round=0;round<6;round++){

    var ev0=EvalRepair(asm,d,refPose,null,tolMm,tolDeg);if(ev0.Moved.Count==0||ev0.Broken>current)break;

    var cands=Mates(d).Where(x=>!x.IsSuppressed()&&(only==null||only.Contains(x.Name))&&MateComponents(x).Any(ev0.MovedNames.Contains)).ToList();

    var options=new List<RepairOption>();

    foreach(var f in cands)foreach(var v in orient){

     var stT=MateStates(d);var pT=Transforms(asm);Action u=null;RepairEval ev=null;

     try{u=MateVariant(d,f,v);if(u!=null)ev=EvalRepair(asm,d,refPose,null,tolMm,tolDeg);}catch{ev=null;}

     finally{if(u!=null)try{u();}catch{}}

     var bad=StateDiff(asm,d,stT,pT);

     if(bad.Count>0){UndoAll(undo);var left=StateDiff(asm,d,states0,pose0);if(left.Count>0)recoveryPending.Add(docPath);

      throw new Exception("Trial "+v+" on "+f.Name+" could not be undone exactly ("+string.Join("; ",bad.Take(5))+"). "+(left.Count>0?"Saving is BLOCKED: close without saving.":"The whole search was reverted."));}

     if(ev==null)continue;

     options.Add(new RepairOption{Mate=f.Name,Variant=v,Eval=ev});

     tried.Add(new{round="orientation "+(round+1),mate=f.Name,variant=v,broken_after=ev.Broken,max_deviation_mm=Math.Round(ev.RefMm,4),max_deviation_deg=Math.Round(ev.RefDeg,4)});

    }

    var best=options.Where(o=>o.Eval.Broken<=ev0.Broken&&o.Eval.Sum<ev0.Sum-1e-6).OrderBy(o=>o.Eval.Sum).ThenBy(o=>o.Eval.Broken).FirstOrDefault();

    if(best==null)break;

    var fb=MateByName(d,best.Mate);var ub=MateVariant(d,fb,best.Variant);if(ub==null)break;

    undo.Add(ub);changed.Add(best.Mate);current=BrokenMates(d).Count;steps.Add(new{mate=best.Mate,change=best.Variant,suppressed=false,broken_after=current});

   }}

  var final=refPose!=null?EvalRepair(asm,d,refPose,null,tolMm,tolDeg):EvalRepair(asm,d,pose0,touched,tolMm,tolDeg);

  bool poseOk=final.Moved.Count==0;bool ok=final.Broken==0&&poseOk&&steps.Count>0;

  string verdict=ok?(refPose!=null?"sin errores y con la postura de la foto "+refName:"sin errores; nada fuera de las relaciones cambiadas se movió")

   :final.Broken>0?"no se encontró un cambio que quite todos los errores":(refPose!=null?"sin errores pero la postura NO coincide con la foto "+refName:"sin errores pero se movieron componentes ajenos a las relaciones cambiadas");

  bool kept=ok&&apply;

  List<string> notRestored=new List<string>();

  if(!kept){UndoAll(undo);notRestored=StateDiff(asm,d,states0,pose0);if(notRestored.Count>0)recoveryPending.Add(docPath);}

  object conflict=null;

  if(!ok){var own=new HashSet<string>(start.SelectMany(n=>MateComponents(MateByName(d,n))));conflict=Mates(d).Where(x=>!x.IsSuppressed()&&MateComponents(x).Any(own.Contains)).Select(x=>x.Name).ToArray();}

  result=new{verdict=verdict,applied=kept,would_work=ok,reference=refName,steps=steps.ToArray(),suppressed_mates=steps.Where(s=>(bool)s.GetType().GetProperty("suppressed").GetValue(s,null)).Select(s=>s.GetType().GetProperty("mate").GetValue(s,null)).ToArray(),

   moved_vs_reference=final.Moved.ToArray(),restored=kept?(bool?)null:notRestored.Count==0,save_blocked=notRestored.Count>0,not_restored=notRestored.ToArray(),broken_at_start=start.ToArray(),broken_mates_now=BrokenMates(d).ToArray(),mates_sharing_components=conflict,tried=tried.ToArray(),

   note=(refPose==null?"Without reference the intended pose is unknown: take a snapshot of the good assembly and pass it as reference. ":"")+(allowSuppress?"Suppressing a mate is reported as such: removing a mate is not a repair by itself unless the pose is kept. ":"Suppressing was not tried (allow_suppress=false). ")+(kept?"Applied; unsaved until sw_save. ":notRestored.Count==0?"Nothing was left changed (verified: every mate and component pose as before). ":"REVERT INCOMPLETE: saving is blocked, close without saving. ")+"Confirm free movements with sw_assembly_doctor."};

  return true;

 }

}

