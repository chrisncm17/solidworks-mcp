using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.6 session_health: why SolidWorks feels slow, and safe cleanup.
// report: SolidWorks process memory, free system RAM, open documents (visible / hidden / unsaved / owned by this MCP session),
// hints. cleanup: closes ONLY hidden, saved documents that no visible open document references (leftovers of MCP sessions that
// died, parts loaded by API and never released). Never closes a visible document, an unsaved one, or one in use.
partial class Worker {
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential,CharSet=System.Runtime.InteropServices.CharSet.Auto)]
 class MemStatus{public uint dwLength=(uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(MemStatus));public uint dwMemoryLoad;public ulong ullTotalPhys,ullAvailPhys,ullTotalPageFile,ullAvailPageFile,ullTotalVirtual,ullAvailVirtual,ullAvailExtendedVirtual;}
 [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Auto,SetLastError=true)]
 static extern bool GlobalMemoryStatusEx([System.Runtime.InteropServices.In,System.Runtime.InteropServices.Out]MemStatus m);
 static bool TrySessionHealth(string op,Dictionary<string,object>a,out object result){
  result=null;if(op!="session_health")return false;
  bool clean=a.ContainsKey("action")&&Str(a,"action")=="cleanup";
  var docs=((object[])sw.GetDocuments()??new object[0]).OfType<IModelDoc2>().ToList();
  var ownedDocs=new HashSet<IModelDoc2>(owned.Values);
  // kept: visible, unsaved or opened by this MCP session (in a minimized SolidWorks an open assembly reports Visible=false),
  // plus everything those documents use (their files + references + components). Only the rest can be closed.
  var inUse=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var unknown=new List<string>();
  // v3.6 review: documents registered by OTHER chats (generated\workers) are kept too, and every open assembly is kept itself
  var others=OtherWorkersDocuments();foreach(var o in others){try{inUse.Add(Path.GetFullPath(o));}catch{unknown.Add(o);}}
  foreach(var d in docs.Where(x=>x.Visible||x.GetSaveFlag()||ownedDocs.Contains(x)||x.GetType()==2||inUse.Contains(Path.GetFullPath(x.GetPathName()??"x")))){string p=d.GetPathName();if(string.IsNullOrEmpty(p))continue;inUse.Add(Path.GetFullPath(p));
   try{var deps=sw.GetDocumentDependencies2(p,true,true,false) as string[]??new string[0];for(int i=1;i<deps.Length;i+=2)if(!string.IsNullOrEmpty(deps[i]))inUse.Add(Path.GetFullPath(deps[i]));}catch{unknown.Add(Path.GetFileName(p));}
   if(d.GetType()==2)try{foreach(IComponent2 c in (object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]){string cp=c.GetPathName();if(!string.IsNullOrEmpty(cp))inUse.Add(Path.GetFullPath(cp));}}catch{unknown.Add(Path.GetFileName(p));}}
  if(clean&&unknown.Count>0)throw new Exception("Nothing closed: could not read what these documents use ("+string.Join(", ",unknown.Distinct())+"), so closing anything could break them.");
  var list=new List<object>();var closable=new List<IModelDoc2>();
  foreach(var d in docs){string p=d.GetPathName()??"";bool vis=d.Visible,dirty=d.GetSaveFlag();bool used=p!=""&&inUse.Contains(Path.GetFullPath(p));
   bool canClose=!vis&&!dirty&&!used&&p!="";if(canClose)closable.Add(d);
   list.Add(new{title=d.GetTitle(),path=p,visible=vis,unsaved=dirty,owned_by_mcp=ownedDocs.Contains(d),in_use=used,closable=canClose});}
  int nVisible=docs.Count(x=>x.Visible),nHidden=docs.Count-nVisible,nUnsaved=docs.Count(x=>x.GetSaveFlag()),nClosable=closable.Count;
  var closed=new List<string>();
  if(clean){
   // re-check right before closing (another chat or the user may have touched it meanwhile)
   foreach(var d in closable){try{if(d.Visible||d.GetSaveFlag()||owned.Values.Contains(d))continue;string t=d.GetTitle();sw.CloseDoc(t);closed.Add(t);}catch{}}
   // v3.7 discard_orphans: ONLY in the MCP's own SolidWorks, unsaved documents of the managed folder (generated) that no live
   // chat has registered: leftovers of a worker that died mid-test. Discarded without saving.
   // v3.7 review: verified identity (this worker is connected to the dedicated PID), hidden only, no unreadable registry, and
   // no kept document (anything that is not itself an orphan candidate) references it.
   if(Flag(a,"discard_orphans")){
    var ist=InstanceState();int dpid=Convert.ToInt32(ist["pid"]);int mine=-1;try{mine=sw.GetProcessID();}catch{}
    if(Convert.ToString(ist["mode"])!="dedicated"||!IsOurs(ist)||mine!=dpid)throw new Exception("discard_orphans only runs in the MCP's own SolidWorks (sw_instance start); nothing discarded");
    var regList=OtherWorkersDocuments();if(regList.Any(x=>x.StartsWith("(unreadable")))throw new Exception("discard_orphans: a worker registry is unreadable ("+string.Join(", ",regList.Where(x=>x.StartsWith("(unreadable")))+"); nothing discarded");
    var reg=new HashSet<string>(regList.Select(x=>{try{return Path.GetFullPath(x);}catch{return x;}}),StringComparer.OrdinalIgnoreCase);
    string root=Path.GetFullPath(Root)+Path.DirectorySeparatorChar;
    var live=((object[])sw.GetDocuments()??new object[0]).OfType<IModelDoc2>().ToList();
    var cand=new List<IModelDoc2>();
    foreach(var d in live){try{string p=d.GetPathName();if(string.IsNullOrEmpty(p)||owned.Values.Contains(d)||d.Visible)continue;p=Path.GetFullPath(p);
     if(p.StartsWith(root,StringComparison.OrdinalIgnoreCase)&&!reg.Contains(p))cand.Add(d);}catch{}}
    var candPaths=new HashSet<string>(cand.Select(d=>Path.GetFullPath(d.GetPathName())),StringComparer.OrdinalIgnoreCase);
    var refd=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var unread=new List<string>();
    foreach(var d in live){string p=null;try{p=d.GetPathName();}catch{}if(string.IsNullOrEmpty(p)||candPaths.Contains(Path.GetFullPath(p)))continue;
     try{var deps=sw.GetDocumentDependencies2(p,true,true,false) as string[]??new string[0];for(int i=1;i<deps.Length;i+=2)if(!string.IsNullOrEmpty(deps[i]))refd.Add(Path.GetFullPath(deps[i]));}catch{unread.Add(Path.GetFileName(p));}
     if(d.GetType()==2)try{foreach(IComponent2 c in (object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]){string cp=c.GetPathName();if(!string.IsNullOrEmpty(cp))refd.Add(Path.GetFullPath(cp));}}catch{unread.Add(Path.GetFileName(p));}}
    if(unread.Count>0)throw new Exception("discard_orphans: could not read what these documents use ("+string.Join(", ",unread.Distinct())+"); nothing discarded");
    foreach(var d in cand){try{string p=Path.GetFullPath(d.GetPathName());if(refd.Contains(p)||d.Visible)continue;string t=d.GetTitle();sw.CloseDoc(t);closed.Add(t+" (huérfano, sin guardar)");}catch{}}
   }
   // the closed documents are dead COM objects now: list again from SolidWorks
   docs=((object[])sw.GetDocuments()??new object[0]).OfType<IModelDoc2>().ToList();
   list=docs.Select(d=>(object)new{title=d.GetTitle(),path=d.GetPathName()??"",visible=d.Visible,unsaved=d.GetSaveFlag(),owned_by_mcp=ownedDocs.Contains(d),in_use=true,closable=false}).ToList();
   nVisible=docs.Count(x=>x.Visible);nHidden=docs.Count-nVisible;nUnsaved=docs.Count(x=>x.GetSaveFlag());}
  // memory of THIS SolidWorks (the one the MCP uses) and of all SolidWorks processes
  long swMb=-1,allMb=-1;int swCount=0;try{int myPid=sw.GetProcessID();var ps=Process.GetProcessesByName("SLDWORKS");swCount=ps.Length;allMb=ps.Sum(x=>x.WorkingSet64)/(1024*1024);var me=ps.FirstOrDefault(x=>x.Id==myPid);swMb=me==null?-1:me.WorkingSet64/(1024*1024);}catch{}
  var ms=new MemStatus();double freeGb=-1,totalGb=-1;if(GlobalMemoryStatusEx(ms)){freeGb=Math.Round(ms.ullAvailPhys/1073741824.0,1);totalGb=Math.Round(ms.ullTotalPhys/1073741824.0,1);}
  var hints=new List<string>();
  if(freeGb>=0&&freeGb<3)hints.Add("Poca RAM libre ("+freeGb+" GB de "+totalGb+"): Windows usa el disco como memoria y SolidWorks se vuelve muy lento. Cierra Chrome, Spotify y apps que no uses.");
  if(swMb>3500)hints.Add("SolidWorks ya usa "+swMb+" MB: guarda y reinícialo si se siente lento.");
  if(nClosable>0&&!clean)hints.Add(nClosable+" documentos ocultos sin uso siguen cargados: action cleanup los cierra (no toca nada visible, sin guardar ni en uso).");
  if(nHidden>30)hints.Add("Hay "+nHidden+" documentos ocultos cargados.");
  result=new{solidworks_processes=swCount,solidworks_ram_mb=swMb,all_solidworks_ram_mb=allMb,system_ram_free_gb=freeGb,system_ram_total_gb=totalGb,documents=list.Count,visible=nVisible,hidden=nHidden,unsaved=nUnsaved,closable=clean?0:nClosable,closed=closed,document_list=list,hints=hints};
  return true;
 }
}
