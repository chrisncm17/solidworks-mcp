using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.9 safe edits: every operation that modifies a document goes through Guarded().
//  before: health fingerprint (Health.cs) + a rollback point. A clean document (no unsaved changes) needs no copy: closing it
//          without saving and reopening it IS the previous state. A dirty one is copied first (SaveAs copy to generated\rollback).
//  after:  rebuild and compare health. If the operation threw, or it broke something that was fine before (a feature or sketch
//          that now fails, a mate that broke, a part left without bodies...), the document is restored and the restoration is
//          VERIFIED against the health taken before. keep_broken=true keeps a breaking result on purpose (saving stays refused
//          by sw_save until it is fixed).
//  When a restore is impossible (the document is still loaded by an open assembly/drawing, or the operation also changed
//  referenced documents) saving is blocked (recoveryPending) and the answer says so.
class GuardException : Exception {
 public object Info;
 public GuardException(string message,object info,Exception inner):base(message,inner){Info=info;}
}
partial class Worker {
 static object lastGuard;
 // documents created by create_part in this worker (the only ones light_guard may apply to)
 static readonly HashSet<string> createdHere=new HashSet<string>();
 // documents whose referenced parts were changed by an operation of this session (reopening would lose those changes).
 // References that are merely "modified" since opening (converted from an older SolidWorks version) are rebuilt identically on reopen.
 // SolidWorks locks an open file (tested: EBUSY), so a copy-mode restore leaves the previous in-memory state in the file. Remember
 // the real disk version: sw_save makes the saved state official (entry dropped); sw_close_document without saving puts it back.
 // Persisted (generated\rollback\pending_disk_restore.json) with the SHA-1 of what WE wrote: the saved version goes back only if the file
 // is still exactly that (nobody saved it since — sw_save, include_references or a manual save in SolidWorks all change it).
 static Dictionary<string,string[]> diskRestore;
 static string DiskRestoreFile(){return Path.Combine(Root,"rollback","pending_disk_restore.json");}
 static string Sha1(string f){using(var h=System.Security.Cryptography.SHA1.Create())using(var s=File.OpenRead(f))return BitConverter.ToString(h.ComputeHash(s)).Replace("-","");}
 static Dictionary<string,string[]> DiskRestore(){
  if(diskRestore!=null)return diskRestore;diskRestore=new Dictionary<string,string[]>(StringComparer.OrdinalIgnoreCase);
  try{if(File.Exists(DiskRestoreFile()))foreach(var kv in Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(DiskRestoreFile())))diskRestore[kv.Key]=Items(kv.Value).Select(Convert.ToString).ToArray();}catch{}
  return diskRestore;}
 static void SaveDiskRestore(){Directory.CreateDirectory(Path.GetDirectoryName(DiskRestoreFile()));File.WriteAllText(DiskRestoreFile(),Json.Serialize(DiskRestore()));}
 // put back the saved version of every file whose restore is pending, when SolidWorks no longer has it loaded and it is still what we wrote
 static List<string> ProcessDiskRestore(){var done=new List<string>();
  foreach(var kv in DiskRestore().ToList()){string path=kv.Key,bk=kv.Value[0],written=kv.Value[1];
   try{if(!File.Exists(path)||!File.Exists(bk)){DiskRestore().Remove(path);continue;}
    if(sw!=null&&sw.GetOpenDocumentByName(path)!=null)continue;
    if(Sha1(path)!=written){DiskRestore().Remove(path);continue;} // saved since: that save wins
    File.Copy(bk,path,true);DiskRestore().Remove(path);done.Add(path);}catch{}}
  try{SaveDiskRestore();}catch{}
  return done;}
 // keep_broken: health before the breaking edit; sw_save refuses while the document still has those regressions
 static readonly Dictionary<string,Dictionary<string,object>> keptBaseline=new Dictionary<string,Dictionary<string,object>>(StringComparer.OrdinalIgnoreCase);
 static readonly HashSet<string> refsEdited=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
 static readonly HashSet<string> Unguarded=new HashSet<string>{"save","checkpoint","export","preview","pack_and_go","close_document","interference","inspect","topology","geometry","sketch","relations","compare_volume","part_diff","mass_check","assembly_export","assembly_doctor","feature_info","find_faces","equations","status","environment","verify_rebuild"};
 static bool ReadOnlyAction(string op,Dictionary<string,object>a){
  string act=a.ContainsKey("action")?Convert.ToString(a["action"]):null;
  if(act==null)return false;
  if(act=="list"||act=="read")return true;
  if(op=="assembly_repair"&&(act=="snapshot"||act=="compare"))return true;
  if(op=="assembly_repair"&&act=="fix_mates"&&!Flag(a,"apply"))return true; // simulates and verifies its own revert
  return false;
 }
 static List<IModelDoc2> DirtyReferences(IModelDoc2 d){
  var r=new List<IModelDoc2>();
  try{
   if(d.GetType()==2){foreach(IComponent2 c in (object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]){var m=c.GetModelDoc2() as IModelDoc2;if(m!=null&&m.GetSaveFlag()&&!r.Contains(m))r.Add(m);}}
   else if(d.GetType()==3){var v=((IDrawingDoc)d).GetFirstView() as IView;while(v!=null){var m=v.ReferencedDocument as IModelDoc2;if(m!=null&&m.GetSaveFlag()&&!r.Contains(m))r.Add(m);v=v.GetNextView() as IView;}}
  }catch{}
  return r;
 }
 static void RebuildForCheck(IModelDoc2 d){try{if(d.GetType()==1)d.ForceRebuild3(false);else if(d.GetType()==2)d.EditRebuild3();}catch{}}
 static object Guarded(string op,Dictionary<string,object>a,IModelDoc2 doc){
  lastGuard=null;
  if(Unguarded.Contains(op)||ReadOnlyAction(op,a))return ExecuteOnDoc(op,a,doc);
  string id=Str(a,"document_id");string path=doc.GetPathName();
  // v3.5 (Codex review): a document whose earlier restore could not be verified is not edited again unprotected
  if(recoveryPending.Contains(path))throw new Exception("Not modified: an earlier failed edit on this document could not be undone and verified, so saving is blocked. Close it without saving (sw_close_document discard_changes) and open it again before editing.");
  bool keep=Flag(a,"keep_broken");
  bool lightReq=Flag(a,"light_guard")&&createdHere.Contains(id);
  Dictionary<string,object> before;try{before=Health(doc,lightReq);}catch(Exception hx){throw new Exception("Not modified: the safe-edit health check could not read this document ("+hx.Message+"), so a failure could not be detected or undone.");}
  if(doc.GetType()==2&&op=="set_material")refsEdited.Add(path); // writes into the referenced part: reopening the assembly would not undo it
  bool wasDirty=doc.GetSaveFlag();var refsDirtyBefore=DirtyReferences(doc);
  string point=null;string mode;
  // v3.8 speed: light_guard = a part the MCP itself is building from an IR (created this session, inside generated). No rollback
  // copy to disk and no second full rebuild per feature (the IR rebuilds it from zero); a failure or a regression is still
  // detected and reported, and a regression blocks saving.
  bool light=Flag(a,"light_guard")&&doc.GetType()==1&&createdHere.Contains(id)&&owned.ContainsKey(id)&&!external.ContainsKey(id)&&InsideRoot(path);
  if(light)mode="light";
  else if(refsDirtyBefore.Count>0&&refsEdited.Contains(path))mode="detect_only"; // reopening would lose unsaved changes made to referenced documents
  else if(!wasDirty)mode="reopen";
  else{mode="copy";
   string dir=Path.Combine(Root,"rollback");Directory.CreateDirectory(dir);
   point=Path.Combine(dir,DateTime.Now.ToString("yyyyMMdd_HHmmss_fff")+"__"+Path.GetFileName(path));
   try{SaveNew(doc,point,true);}catch(Exception ex){mode="detect_only";point=null;lastGuard=new{mode=mode,reason="rollback copy failed: "+ex.Message};}
   if(point!=null&&!string.Equals(doc.GetPathName(),path,StringComparison.OrdinalIgnoreCase))throw new Exception("Rollback copy changed the document path; inspect before continuing");}
  object res=null;Exception err=null;
  try{res=ExecuteOnDoc(op,a,doc);}catch(Exception ex){err=ex;}
  var cur=owned.ContainsKey(id)?owned[id]:doc;
  List<string> broke=new List<string>();
  if(light&&err!=null){recoveryPending.Add(path);lastGuard=new{mode=mode,automatic_rollback=false,save_blocked=true,note="IR build: nothing undone (the part is rebuilt from its IR); this copy cannot be saved"};throw err;}
  if(err==null){
   if(!light)RebuildForCheck(cur);try{broke=HealthRegressions(before,Health(cur,lightReq));}catch(Exception hx){broke=new List<string>{"no se pudo verificar el resultado: "+hx.Message};}
   // intended effects are not regressions: the features/mates the call named itself (suppress, delete...)
   var named=new HashSet<string>();foreach(var k in new[]{"name","names","features","mates","feature"})if(a.ContainsKey(k)){var v=a[k];if(v is string)named.Add((string)v);else if(v is System.Collections.IEnumerable)foreach(var x in Items(v))named.Add(Convert.ToString(x));}
   try{var sp=res==null?null:res.GetType().GetProperty("suppressed_mates");if(sp!=null){var v=sp.GetValue(res,null);if(v!=null)foreach(var x in Items(v))named.Add(Convert.ToString(x));}}catch{}
   // only "it is now suppressed / gone" about the items the call itself named (or reported as intentionally suppressed); anything that BROKE is still a regression
   // v3.9 sheet metal: folding/unfolding IS suppressing the Flat-Pattern (and its bounding box and sub-features)
   if(op=="sheet_metal")try{foreach(var f in AllFeatures(cur)){string tn=f.GetTypeName2();if(tn=="FlatPattern"||tn.IndexOf("BoundingBox",StringComparison.OrdinalIgnoreCase)>=0||tn=="SMBoundingBox"){named.Add(f.Name);for(var sf=f.GetFirstSubFeature() as IFeature;sf!=null;sf=sf.GetNextSubFeature() as IFeature)named.Add(sf.Name);}}}catch{}
   if(named.Count>0&&(op=="suppress_feature"||op=="delete_feature"||op=="mates"||op=="delete_mate"||op=="assembly_repair"||op=="sheet_metal"))broke=broke.Where(x=>!named.Any(n=>x.EndsWith(" "+n,StringComparison.Ordinal)&&(x.IndexOf("suprimid",StringComparison.OrdinalIgnoreCase)>=0||x.IndexOf("desapareci",StringComparison.OrdinalIgnoreCase)>=0))).ToList();
   var refsNow=DirtyReferences(cur);bool touchedRefs=refsNow.Any(m=>!refsDirtyBefore.Contains(m));
   if(broke.Count==0){if(point!=null)try{File.Delete(point);}catch{}lastGuard=new{mode=mode,checked_health=true,regressions=new string[0],note=touchedRefs?"The operation also changed referenced documents; save them with include_references.":null};return res;}
   if(light){recoveryPending.Add(path);var linfo=new{mode=mode,automatic_rollback=false,save_blocked=true,regressions=broke.ToArray()};lastGuard=linfo;
    throw new GuardException("La edición rompió lo que antes estaba bien: "+string.Join("; ",broke)+" | pieza del IR: no se guarda; corrige el IR y vuelve a construirla.",linfo,null);}
   if(keep){if(!keptBaseline.ContainsKey(path))keptBaseline[path]=before;if(point!=null)try{File.Delete(point);}catch{}lastGuard=new{mode=mode,checked_health=true,regressions=broke.ToArray(),kept=true,note="keep_broken: result kept on purpose. sw_save refuses to save it until these problems are fixed (or allow_errors)."};return res;}
  }
  // keep_broken also covers tools that end by throwing on the rebuild error they caused (set_dimension, features...): keep that state
  if(err!=null&&keep&&!(err is GuardException)){List<string> now=new List<string>();try{RebuildForCheck(cur);now=HealthRegressions(before,Health(cur));}catch{}
   if(now.Count>0){if(!keptBaseline.ContainsKey(path))keptBaseline[path]=before;var kinfo=new{mode=mode,automatic_rollback=false,kept=true,regressions=now.ToArray(),note="keep_broken: the failing result was kept on purpose. sw_save refuses to save it until fixed (or allow_errors)."};
    lastGuard=kinfo;throw new GuardException(err.Message+" | keep_broken: se conserv\u00f3 el resultado roto.",kinfo,err);}}
  // restore
  string what=err!=null?"La operación falló: "+err.Message:"La edición rompió lo que antes estaba bien: "+string.Join("; ",broke);
  object info;bool verified=false;List<string> diffs=null;string diskBackup=null;
  if(mode=="detect_only"){
   recoveryPending.Add(path);
   info=new{mode=mode,automatic_rollback=false,save_blocked=true,regressions=broke.ToArray(),reason="Not restorable automatically (referenced documents had or got unsaved changes). Close without saving (sw_close_document discard_changes=true) and reopen."};
   lastGuard=info;throw new GuardException(what+" | No se pudo revertir automáticamente: guardar queda BLOQUEADO; cierra sin guardar y vuelve a abrir.",info,err);
  }
  try{
   string title=cur.GetTitle();int type=cur.GetType();
   sw.CloseDoc(title);
   if(sw.GetOpenDocumentByName(path)!=null)throw new Exception("SolidWorks keeps it loaded (an open assembly or drawing references it)");
   if(mode=="copy"){
    string dir=Path.Combine(Root,"rollback");diskBackup=Path.Combine(dir,DateTime.Now.ToString("yyyyMMdd_HHmmss_fff")+"__disk__"+Path.GetFileName(path));
    File.Copy(path,diskBackup,false);File.Copy(point,path,true);
    if(!DiskRestore().ContainsKey(path))DiskRestore()[path]=new[]{diskBackup,Sha1(path)}; // keep the OLDEST: the version really saved by the user
    SaveDiskRestore();try{File.Delete(point);}catch{}
   }
   int e=0,w=0;var reopened=(IModelDoc2)sw.OpenDoc6(path,type,1,"",ref e,ref w);
   if(reopened==null)throw new Exception("reopen failed ("+e+")");
   // the closed document's COM object is dead (RPC_E_DISCONNECTED): match by reference, never call it
   foreach(var k in owned.Keys.ToList()){bool same=ReferenceEquals(owned[k],cur);if(!same)try{same=string.Equals(owned[k].GetPathName(),path,StringComparison.OrdinalIgnoreCase);}catch{same=false;}if(same)owned[k]=reopened;}
   owned[id]=reopened;lastDoc=reopened;
   if(mode=="copy")try{reopened.SetSaveFlag();}catch{} // it still has unsaved changes relative to the user's saved version
   int ae=0;sw.ActivateDoc3(reopened.GetTitle(),false,1,ref ae);
   diffs=HealthDifferences(before,Health(reopened),0.001);verified=diffs.Count==0;
   if(!verified)recoveryPending.Add(path);
  }catch(Exception rex){
   recoveryPending.Add(path);
   // after CloseDoc the old COM object is dead: drop the ids that still point to it (reopen with sw_open_project / sw_resume_document)
   foreach(var k in owned.Keys.ToList())if(ReferenceEquals(owned[k],cur)){owned.Remove(k);external.Remove(k);}
   if(ReferenceEquals(lastDoc,cur))lastDoc=null;
   info=new{mode=mode,automatic_rollback=false,save_blocked=true,regressions=broke.ToArray(),reason="Restore failed: "+rex.Message+". Close without saving and reopen."};
   lastGuard=info;throw new GuardException(what+" | La restauración falló ("+rex.Message+"): guardar queda BLOQUEADO.",info,err);
  }
  info=new{mode=mode,automatic_rollback=true,rollback_verified=verified,differences_after_restore=diffs.ToArray(),regressions=broke.ToArray(),
   wrote_previous_state_to_disk=mode=="copy",disk_version_backup=diskBackup,save_blocked=!verified,
   note=mode=="copy"?"The document had unsaved changes from earlier steps; to restore them exactly they were written to its file (SolidWorks locks open files). The saved version is in disk_version_backup and goes back automatically if you close with sw_close_document without saving; sw_save keeps the current state.":"The document was closed without saving and reopened from disk (it had no unsaved changes)."};
  lastGuard=info;
  throw new GuardException(what+" | Se revirtió al estado anterior"+(verified?" (verificado).":"; la verificación encontró diferencias: guardar queda BLOQUEADO."),info,err);
 }
}
