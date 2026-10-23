using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.6 instance: "one SolidWorks for the user, one for the MCP". mode shared (default) = the SolidWorks the user opened
// (GetActiveObject). mode dedicated = a second SolidWorks process started by sw_instance start, minimized, found by its EXACT
// moniker SolidWorks_PID_<pid> in the Running Object Table and checked against the saved process start time (a reused PID is
// not "ours"). generated\instance.json (written atomically; a damaged file blocks instead of falling back) holds the mode for
// every chat; generated\workers\<worker pid>.json lists the documents each MCP worker has open, so nobody switches the
// instance while another chat still has documents in it. Nothing starts on its own.
// v3.6 review (Codex, high): exact identity, ownership across chats, "starting" state reconciled after an interruption,
// strict recovery-notice match.
partial class Worker {
 static string swKey=null;
 static bool fastSet=false;
 static string InstanceFile{get{return Path.Combine(Root,"instance.json");}}
 static string WorkersDir{get{return Path.Combine(Root,"workers");}}
 static Dictionary<string,object> InstanceState(){
  if(!File.Exists(InstanceFile))return new Dictionary<string,object>{{"mode","shared"},{"pid",0}};
  Dictionary<string,object> st=null;try{st=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(InstanceFile));}catch{}
  if(st==null||!st.ContainsKey("mode"))throw new Exception("generated\\instance.json is damaged; fix or delete it (deleting it means: use the user's SolidWorks)");
  if(!st.ContainsKey("pid"))st["pid"]=0;return st;
 }
 static void SaveInstanceState(string mode,int pid,string status,long started){
  var tmp=InstanceFile+"."+Process.GetCurrentProcess().Id+".tmp";
  File.WriteAllText(tmp,Json.Serialize(new Dictionary<string,object>{{"mode",mode},{"pid",pid},{"status",status},{"started_ticks",started},{"updated",DateTime.Now.ToString("s")}}));
  if(File.Exists(InstanceFile))File.Replace(tmp,InstanceFile,null);else File.Move(tmp,InstanceFile);
 }
 static long StartTicks(int pid){try{return Process.GetProcessById(pid).StartTime.ToUniversalTime().Ticks;}catch{return 0;}}
 // our process = same PID, same start time and it is SLDWORKS.exe
 static bool IsOurs(Dictionary<string,object> st){
  int pid=Convert.ToInt32(st["pid"]);if(pid<=0)return false;long want=st.ContainsKey("started_ticks")?Convert.ToInt64(st["started_ticks"]):0;
  try{var p=Process.GetProcessById(pid);if(!string.Equals(p.ProcessName,"SLDWORKS",StringComparison.OrdinalIgnoreCase))return false;return want!=0&&p.StartTime.ToUniversalTime().Ticks==want;}catch{return false;}
 }
 [DllImport("ole32.dll")]static extern int GetRunningObjectTable(int r,out IRunningObjectTable t);
 [DllImport("ole32.dll")]static extern int CreateBindCtx(int r,out IBindCtx c);
 static ISldWorks SwFromRot(int pid){
  IRunningObjectTable rot;if(GetRunningObjectTable(0,out rot)!=0)return null;IEnumMoniker e;rot.EnumRunning(out e);var m=new IMoniker[1];IBindCtx ctx;CreateBindCtx(0,out ctx);
  while(e.Next(1,m,IntPtr.Zero)==0){string name=null;try{m[0].GetDisplayName(ctx,null,out name);}catch{}
   if(name==null)continue;var mm=Regex.Match(name,@"SolidWorks_PID_(\d+)$",RegexOptions.IgnoreCase);if(!mm.Success||mm.Groups[1].Value!=pid.ToString())continue;
   object o;rot.GetObject(m[0],out o);var s=o as ISldWorks;try{if(s!=null&&s.GetProcessID()==pid)return s;}catch{}}
  return null;
 }
 static ISldWorks ConnectSw(){
  var st=InstanceState();
  if(Convert.ToString(st["mode"])!="dedicated")return (ISldWorks)Marshal.GetActiveObject("SldWorks.Application");
  int pid=Convert.ToInt32(st["pid"]);
  if(!IsOurs(st))throw new Exception("The MCP's own SolidWorks (PID "+pid+") is not running (or that PID now belongs to another process). Call sw_instance start or sw_instance use_shared.");
  var s=SwFromRot(pid);if(s==null)throw new Exception("The MCP's own SolidWorks (PID "+pid+") is still starting or stuck on a dialog. Call sw_instance start to wait for it, or sw_instance status.");
  return s;
 }
 // ---- documents each worker has open (so no chat switches the instance under another one)
 static void PublishOwnership(){
  try{Directory.CreateDirectory(WorkersDir);string f=Path.Combine(WorkersDir,Process.GetCurrentProcess().Id+".json");
   if(owned.Count==0){if(File.Exists(f))File.Delete(f);return;}
   var paths=new List<string>();foreach(var d in owned.Values){try{paths.Add(d.GetPathName());}catch{}}
   File.WriteAllText(f,Json.Serialize(new Dictionary<string,object>{{"key",swKey??""},{"documents",paths}}));}catch{}
 }
 static List<string> OtherWorkersDocuments(){return OtherWorkersDocuments(null);}
 // skipKey: registries of workers whose documents lived in an instance confirmed dead are ignored
 static List<string> OtherWorkersDocuments(string skipKey){
  var r=new List<string>();if(!Directory.Exists(WorkersDir))return r;int me=Process.GetCurrentProcess().Id;
  foreach(var f in Directory.GetFiles(WorkersDir,"*.json")){int pid;if(!int.TryParse(Path.GetFileNameWithoutExtension(f),out pid)||pid==me)continue;
   bool alive=false;try{alive=!Process.GetProcessById(pid).HasExited;}catch{}
   if(!alive){try{File.Delete(f);}catch{}continue;}
   try{var j=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(f));if(skipKey!=null&&j.ContainsKey("key")&&Convert.ToString(j["key"])==skipKey)continue;foreach(var p in Items(j["documents"]))r.Add(Convert.ToString(p));}catch{r.Add("(unreadable registry of worker "+pid+")");}}
  return r;
 }
 static void RefuseSwitch(){RefuseSwitch(null);}
 // v3.7 review: deadKey = "dedicated|<pid>" of an instance confirmed dead; its documents died with it and do not block a restart
 static void RefuseSwitch(string deadKey){
  if(deadKey!=null&&swKey==deadKey&&owned.Count>0){owned.Clear();PublishOwnership();}
  if(owned.Count>0)throw new Exception("Close the documents this chat opened first ("+owned.Count+")");
  var others=OtherWorkersDocuments(deadKey);if(others.Count>0)throw new Exception("Another chat still has documents open in the MCP ("+string.Join(", ",others.Select(Path.GetFileName))+"); close them there first");
 }
 static string SwExe(){
  string env=System.Environment.GetEnvironmentVariable("SW_MCP_SLDWORKS_EXE");if(!string.IsNullOrEmpty(env)&&File.Exists(env))return env;
  try{foreach(var p in Process.GetProcessesByName("SLDWORKS")){string f=p.MainModule.FileName;if(File.Exists(f))return f;}}catch{}
  // SW_MCP_SLDWORKS_EXE overrides; then the install folder the SolidWorks installer writes in the registry; then the default folder
  try{using(var k=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\SolidWorks"))if(k!=null)foreach(var v in k.GetSubKeyNames().OrderByDescending(x=>x)){using(var s=k.OpenSubKey(v+@"\Setup")){var dir=s==null?null:s.GetValue("SolidWorks Folder") as string;if(!string.IsNullOrEmpty(dir)&&File.Exists(Path.Combine(dir,"SLDWORKS.exe")))return Path.Combine(dir,"SLDWORKS.exe");}}}catch{}
  foreach(var f in new[]{@"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\SLDWORKS.exe",@"C:\Program Files\SolidWorks Corp\SolidWorks\SLDWORKS.exe"})if(File.Exists(f))return f;
  throw new Exception("SLDWORKS.exe not found (set SW_MCP_SLDWORKS_EXE)");
 }
 static object InstanceInfo(){
  var st=InstanceState();int dpid=Convert.ToInt32(st["pid"]);bool ours=Convert.ToString(st["mode"])=="dedicated"&&IsOurs(st);int userPid=-1;
  try{var u=(ISldWorks)Marshal.GetActiveObject("SldWorks.Application");userPid=u.GetProcessID();}catch{}
  var procs=Process.GetProcessesByName("SLDWORKS").Select(p=>new{pid=p.Id,started=SafeStart(p),ram_mb=p.WorkingSet64/(1024*1024),title=p.MainWindowTitle,role=ours&&p.Id==dpid?"MCP (dedicated)":p.Id==userPid?"user (first instance)":"other"}).ToArray();
  return new{mode=st["mode"],status=st.ContainsKey("status")?st["status"]:null,dedicated_pid=dpid,dedicated_running=ours,solidworks_processes=procs};
 }
 static string SafeStart(Process p){try{return p.StartTime.ToString("s");}catch{return null;}}
 // A second SolidWorks session always shows "No se puede crear un archivo histórico. La recuperación automática no funcionará..."
 // (the user's session owns the auto-recover file). Only THAT exact notice, only in the MCP's process, is acknowledged.
 delegate bool WndProcEnum(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(WndProcEnum f,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,WndProcEnum f,IntPtr l);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,System.Text.StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 static readonly string[] RecoveryNotice={"No se puede crear un archivo histórico","Unable to create history file"};
 static int AckRecoveryNotice(int pid){
  var hits=new List<IntPtr>();
  EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p!=(uint)pid||!IsWindowVisible(h))return true;
   var cls=new System.Text.StringBuilder(64);GetClassName(h,cls,64);if(cls.ToString()!="#32770")return true;
   var texts=new List<string>();EnumChildWindows(h,(c,l2)=>{var t=new System.Text.StringBuilder(1024);GetWindowText(c,t,1024);if(t.Length>0)texts.Add(t.ToString());return true;},IntPtr.Zero);
   // exactly one button plus the known message
   if(texts.Any(t=>RecoveryNotice.Any(k=>t.StartsWith(k,StringComparison.OrdinalIgnoreCase)))&&texts.Count<=3)hits.Add(h);
   return true;},IntPtr.Zero);
  int n=0;foreach(var h in hits){PostMessage(h,0x0111,(IntPtr)1,IntPtr.Zero);for(int i=0;i<10&&IsWindow(h)&&IsWindowVisible(h);i++)System.Threading.Thread.Sleep(100);if(!IsWindow(h)||!IsWindowVisible(h))n++;}
  return n;
 }
 // v3.8 orphans: a crash restart left the old SolidWorks alive (3 running after the roller test). Every process the MCP starts is
 // recorded (pid|start ticks); a recorded one that is not the current dedicated instance is an orphan. include_unrecorded also
 // takes SolidWorks processes started before this record existed, never the user's (first) one. A recorded process is the
 // MCP's even when it is the first one in the ROT (no user SolidWorks open). A process with any document
 // outside generated is never closed (the user may have opened files in it).
 static string HistoryFile{get{return Path.Combine(Root,"instance_history.txt");}}
 // inside generated for real: full path under Root + separator (not "generated_personal"), no junction on the way
 static bool InsideRoot(string path){
  try{string root=Path.GetFullPath(Root).TrimEnd('\\')+"\\",full=Path.GetFullPath(path);
   if(!full.StartsWith(root,StringComparison.OrdinalIgnoreCase))return false;
   for(var dir=Path.GetDirectoryName(full);dir!=null&&dir.Length>=root.Length-1;dir=Path.GetDirectoryName(dir))
    if(Directory.Exists(dir)&&(File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0)return false;
   return true;}catch{return false;}
 }
 static void RecordStarted(int pid,long ticks){try{File.AppendAllText(HistoryFile,pid+"|"+ticks+System.Environment.NewLine);}catch{}}
 static object CleanupOrphans(bool includeUnrecorded){
  var st=InstanceState();int current=Convert.ToString(st["mode"])=="dedicated"&&IsOurs(st)?Convert.ToInt32(st["pid"]):-1;int userPid=-1;
  try{var u=(ISldWorks)Marshal.GetActiveObject("SldWorks.Application");userPid=u.GetProcessID();}catch{}
  var recorded=new Dictionary<int,long>();
  if(File.Exists(HistoryFile))foreach(var line in File.ReadAllLines(HistoryFile)){var p=line.Split('|');int pid;long t;if(p.Length==2&&int.TryParse(p[0],out pid)&&long.TryParse(p[1],out t))recorded[pid]=t;}
  var closed=new List<object>();var kept=new List<object>();var alive=new List<string>();
  foreach(var proc in Process.GetProcessesByName("SLDWORKS")){int pid=proc.Id;long ticks=StartTicks(pid);
   bool ours=recorded.ContainsKey(pid)&&recorded[pid]==ticks;
   if(pid==current||(!ours&&(pid==userPid||!includeUnrecorded))){if(ours)alive.Add(pid+"|"+ticks);continue;}
   // Codex review: close only with POSITIVE evidence. The documents must be readable; an unreadable path, an unsaved (no path)
   // document or one outside generated keeps the process. An unrecorded process also needs at least one document, all of them
   // inside generated (an empty SolidWorks may be the user's second session).
   var s=SwFromRot(pid);var foreign=new List<string>();int docs=0;string reason=null;
   if(s==null)reason="not answering (cannot read its documents)";
   else{try{foreach(var d in ((object[])s.GetDocuments()??new object[0]).OfType<IModelDoc2>()){docs++;string path=null;try{path=d.GetPathName();}catch{}
      if(string.IsNullOrEmpty(path)){foreign.Add("(unsaved or unreadable document)");continue;}
      if(!InsideRoot(path))foreign.Add(path);}}
    catch(Exception ex){reason="cannot list its documents: "+ex.Message;}}
   if(reason==null&&foreign.Count>0)reason="has documents outside generated";
   if(reason==null&&!ours&&docs==0)reason="not started by the MCP and has no documents (may be the user's)";
   if(reason!=null){kept.Add(new{pid=pid,reason=reason,documents=foreign.ToArray()});if(ours)alive.Add(pid+"|"+ticks);continue;}
   string how="exit";
   try{s.CloseAllDocuments(true);s.ExitApp();}catch{how="kill (exit failed)";}
   if(!proc.WaitForExit(15000)){try{proc.Kill();proc.WaitForExit(5000);how=how=="exit"?"kill (did not exit)":how;}catch{}}
   bool gone=false;try{proc.Refresh();gone=proc.HasExited;}catch{gone=true;}
   if(gone)closed.Add(new{pid=pid,started=SafeStart(proc),how=how});else{kept.Add(new{pid=pid,reason="still running after exit and kill",documents=new string[0]});if(ours)alive.Add(pid+"|"+ticks);}}
  try{File.WriteAllLines(HistoryFile,alive.ToArray());}catch{}
  return new{closed=closed.ToArray(),kept=kept.ToArray(),user_pid=userPid,current_dedicated=current};
 }
 static bool TryInstance(string op,Dictionary<string,object>a,out object result){
  result=null;if(op!="instance")return false;
  string action=a.ContainsKey("action")?Str(a,"action"):"status";var st=InstanceState();
  if(action=="status"){result=InstanceInfo();return true;}
  if(action=="use_shared"){RefuseSwitch();SaveInstanceState("shared",Convert.ToInt32(st["pid"]),"ready",st.ContainsKey("started_ticks")?Convert.ToInt64(st["started_ticks"]):0);sw=null;result=InstanceInfo();return true;}
  if(action=="start"){
   int oldPid=Convert.ToInt32(st["pid"]);bool oldDead=Convert.ToString(st["mode"])=="dedicated"&&oldPid>0&&!IsOurs(st);
   RefuseSwitch(oldDead?"dedicated|"+oldPid:null);
   int pid=0;ISldWorks s=null;bool started=false;int acked=0;long ticks=0;
   // reconcile an instance we started before (also one left "starting" by an interrupted call)
   if(Convert.ToString(st["mode"])=="dedicated"&&IsOurs(st)){pid=Convert.ToInt32(st["pid"]);ticks=Convert.ToInt64(st["started_ticks"]);}
   object orphans=null;
   if(pid==0){
    try{orphans=CleanupOrphans(false);}catch(Exception ex){orphans="cleanup failed: "+ex.Message;}
    var psi=new ProcessStartInfo(SwExe()){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Minimized};var proc=Process.Start(psi);
    pid=proc.Id;ticks=StartTicks(pid);started=true;RecordStarted(pid,ticks);
    SaveInstanceState("dedicated",pid,"starting",ticks);
   }
   var t0=DateTime.Now;
   while(s==null&&(DateTime.Now-t0).TotalSeconds<100){
    bool alive=false;try{alive=!Process.GetProcessById(pid).HasExited;}catch{}
    if(!alive&&!started){
     // the process we were reconnecting to was dying (e.g. right after a crash): start a fresh one instead
     var psi2=new ProcessStartInfo(SwExe()){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Minimized};var proc2=Process.Start(psi2);
     pid=proc2.Id;ticks=StartTicks(pid);started=true;RecordStarted(pid,ticks);SaveInstanceState("dedicated",pid,"starting",ticks);t0=DateTime.Now;continue;}
    if(!alive){SaveInstanceState("dedicated",pid,"failed",ticks);throw new Exception("The MCP's SolidWorks (PID "+pid+") closed while starting (license or second-session limit?)");}
    acked+=AckRecoveryNotice(pid);s=SwFromRot(pid);if(s==null)System.Threading.Thread.Sleep(2000);}
   if(s==null)throw new Exception("The MCP's SolidWorks (PID "+pid+") is still starting; call sw_instance start again to keep waiting (it will not open another one)");
   for(int i=0;i<6&&acked==0&&started;i++){System.Threading.Thread.Sleep(1500);acked+=AckRecoveryNotice(pid);}   // the notice shows right after start-up
   try{s.FrameState=(int)swWindowState_e.swWindowMinimized;}catch{}
   SaveInstanceState("dedicated",pid,"ready",ticks);sw=s;swKey="dedicated|"+pid;
   result=new{started=started,pid=pid,revision=s.RevisionNumber(),recovery_notice_acknowledged=acked,orphans=orphans,info=InstanceInfo(),note="The MCP now works in its own minimized SolidWorks; the user's SolidWorks is not touched. sw_instance show to watch it, use_shared to go back."};return true;
  }
  if(action=="cleanup_orphans"){result=CleanupOrphans(a.ContainsKey("include_unrecorded")&&Convert.ToBoolean(a["include_unrecorded"]));return true;}
  if(action=="show"||action=="minimize"){
   if(Convert.ToString(st["mode"])!="dedicated")throw new Exception("No dedicated instance in use");var s=ConnectSw();
   s.FrameState=(int)(action=="show"?swWindowState_e.swWindowMaximized:swWindowState_e.swWindowMinimized);result=InstanceInfo();return true;
  }
  if(action=="stop"){
   if(Convert.ToString(st["mode"])!="dedicated")throw new Exception("No dedicated instance in use");
   RefuseSwitch();
   int pid=Convert.ToInt32(st["pid"]);
   if(IsOurs(st)){var s=SwFromRot(pid);
    // Codex review: a SolidWorks that does not answer is NOT killed (its documents cannot be checked); neither is one where the
    // user opened files outside generated (opening a file from Explorer can land in the MCP's process)
    if(s==null)throw new Exception("The MCP's SolidWorks (PID "+pid+") does not answer; it was not closed. Close it by hand after checking it has nothing of yours.");
    var all=((object[])s.GetDocuments()??new object[0]).OfType<IModelDoc2>().ToList();
    var dirty=all.Where(d=>d.GetSaveFlag()).Select(d=>d.GetTitle()).ToArray();
    if(dirty.Length>0)throw new Exception("The MCP's SolidWorks has unsaved documents: "+string.Join(", ",dirty)+". Save or close them first.");
    var outside=all.Select(d=>{string p=null;try{p=d.GetPathName();}catch{}return p;}).Where(p=>string.IsNullOrEmpty(p)||!InsideRoot(p)).ToArray();
    if(outside.Length>0)throw new Exception("The MCP's SolidWorks has documents outside generated (opened by the user?): "+string.Join(", ",outside.Select(p=>string.IsNullOrEmpty(p)?"(sin ruta)":p))+". It was not closed.");
    s.CloseAllDocuments(true);s.ExitApp();
    // ExitApp returns before the process ends (it was still listed after stop); wait, and end it if it hangs
    try{var p=Process.GetProcessById(pid);if(!p.WaitForExit(30000)){p.Kill();p.WaitForExit(5000);}}catch{}}
   SaveInstanceState("shared",0,"ready",0);sw=null;result=InstanceInfo();return true;
  }
  throw new Exception("action must be status, start, show, minimize, use_shared, stop or cleanup_orphans");
 }
}
