using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using SolidWorks.Interop.sldworks;

// User files outside `generated`: always back up the document and all its references BEFORE opening it.
partial class Worker {
 static string BackupRoot{get{return Path.Combine(Root,"backups");}}
 // document_id -> authorized full path (a "Save As" elsewhere loses the authorization; reopen to back up again)
 static readonly Dictionary<string,string> external=new Dictionary<string,string>(StringComparer.Ordinal);
 // documents whose state may be altered (e.g. interference detection moved components): never save them
 static readonly HashSet<string> recoveryPending=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
 static readonly string[] NativeExt={".sldprt",".sldasm",".slddrw"};

 static string NativeType(string path){string x=Path.GetExtension(path).ToLowerInvariant();if(!NativeExt.Contains(x))throw new Exception("Native .SLDPRT, .SLDASM or .SLDDRW required");return x;}
 static string Sha256(string f){using(var s=File.OpenRead(f))using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(s)).Replace("-","").ToLowerInvariant();}

 // Rejects reparse points (junctions/symlinks) in the path or any existing ancestor directory.
 static void NoLinks(string path){
  var p=Path.GetFullPath(path);
  while(!string.IsNullOrEmpty(p)){if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked path component not supported: "+p);var parent=Path.GetDirectoryName(p);if(parent==p)break;p=parent;}
 }

 static List<string> Dependencies(string path,List<string> missing){
  var deps=sw.GetDocumentDependencies2(path,true,true,false) as string[]??new string[0];var files=new List<string>{Path.GetFullPath(path)};
  for(int i=1;i<deps.Length;i+=2){if(string.IsNullOrEmpty(deps[i]))continue;if(File.Exists(deps[i]))files.Add(Path.GetFullPath(deps[i]));else if(missing!=null)missing.Add(deps[i]);}
  return files.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
 }

 static string[] DirtyOpen(IEnumerable<string> files){return files.Where(f=>{var o=sw.GetOpenDocumentByName(f) as IModelDoc2;return o!=null&&o.GetSaveFlag();}).Select(Path.GetFileName).ToArray();}

 // Copies exactly `files` into a new backup folder with a manifest (original path, backup name, size, sha256).
 static object BackupFiles(string main,List<string> files,List<string> missing,string label){
  Directory.CreateDirectory(BackupRoot);NoLinks(BackupRoot);
  string folder=Path.Combine(BackupRoot,DateTime.Now.ToString("yyyyMMdd-HHmmss")+"_"+label+"_"+Path.GetFileNameWithoutExtension(main));
  if(Directory.Exists(folder))folder+="_"+Guid.NewGuid().ToString("N").Substring(0,6);
  Directory.CreateDirectory(folder);
  var entries=new List<Dictionary<string,object>>();var used=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  foreach(var f in files){NoLinks(f);string n=Path.GetFileName(f);int k=1;while(used.Contains(n))n=Path.GetFileNameWithoutExtension(f)+"_"+(k++)+Path.GetExtension(f);used.Add(n);
   string dst=Path.Combine(folder,n);File.Copy(f,dst,false);string h=Sha256(dst);
   entries.Add(new Dictionary<string,object>{{"original",f},{"backup",n},{"bytes",new FileInfo(dst).Length},{"sha256",h}});}
  var manifest=new Dictionary<string,object>{{"created",DateTime.Now.ToString("s")},{"main",main},{"files",entries},{"missing_references",missing??new List<string>()}};
  File.WriteAllText(Path.Combine(folder,"manifest.json"),Json.Serialize(manifest));
  return new{backup_name=Path.GetFileName(folder),backup_folder=folder,files_backed_up=entries.Count,size_mb=Math.Round(entries.Sum(e=>(long)e["bytes"])/1048576.0,1),missing_references=(missing??new List<string>()).ToArray()};
 }

 // Validated manifest entries: backup file must be a plain name inside the folder and match its hash; original must be an absolute native path.
 static List<Tuple<string,string,string>> ReadManifest(string folder,out string main){
  var man=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(folder,"manifest.json")));
  main=Convert.ToString(man["main"]);var list=new List<Tuple<string,string,string>>();
  foreach(Dictionary<string,object> e in (System.Collections.ArrayList)man["files"]){
   string orig=Convert.ToString(e["original"]),bak=Convert.ToString(e["backup"]),sha=e.ContainsKey("sha256")?Convert.ToString(e["sha256"]):null;
   if(string.IsNullOrEmpty(bak)||Path.GetFileName(bak)!=bak||bak=="."||bak==".."||bak.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw new Exception("Invalid backup entry: "+bak);
   string src=Path.Combine(folder,bak);if(!File.Exists(src))throw new Exception("Backup file missing: "+bak);NoLinks(src);
   if(string.IsNullOrEmpty(sha)||sha.Length!=64)throw new Exception("Missing or invalid SHA-256 in manifest: "+bak);
   if(!Path.IsPathRooted(orig)||Path.GetFullPath(orig)!=orig)throw new Exception("Invalid original path in manifest: "+orig);NativeType(orig);NoLinks(orig);
   if(Path.GetFullPath(orig).StartsWith(Path.GetFullPath(BackupRoot)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Manifest targets the backup area: "+orig);
   if(Sha256(src)!=sha)throw new Exception("Backup file was altered (hash mismatch): "+bak);
   list.Add(Tuple.Create(orig,src,sha));}
  return list;
 }

 static bool TryProject(string op,Dictionary<string,object>a,out object result){
  result=null;
  if(op=="open_project"){
   string path=Str(a,"path");if(!Path.IsPathRooted(path))throw new Exception("Absolute path required");path=Path.GetFullPath(path);NativeType(path);
   if(!File.Exists(path))throw new Exception("File missing");NoLinks(path);
   var missing=new List<string>();var files=Dependencies(path,missing);
   var dirty=DirtyOpen(files);if(dirty.Length>0)throw new Exception("Save or close these open documents first, so the backup matches what will be edited: "+string.Join(", ",dirty));
   if(missing.Count>0&&!(a.ContainsKey("allow_missing_references")&&Convert.ToBoolean(a["allow_missing_references"])))throw new Exception("Missing references (nothing opened): "+string.Join(", ",missing.Select(Path.GetFileName))+". Pass allow_missing_references=true to continue anyway.");
   var backup=BackupFiles(path,files,missing,"open");
   var d=OpenNative(path,missing.Count>0);bool dirtyOnOpen=d.GetSaveFlag()/*v3.5: dirty right after OpenDoc6, before any inspection*/;string id=Guid.NewGuid().ToString("N");owned.Add(id,d);external[id]=Path.GetFullPath(d.GetPathName());lastDoc=d;
   result=new{document_id=id,backup=backup,dirty_on_open=dirtyOnOpen,note="Edits and sw_save write to the user's files. Restore with sw_restore_backup (close the documents first).",inspection=Inspect(d)};return true;
  }
  if(op=="restore_backup"){
   Directory.CreateDirectory(BackupRoot);
   if(Str(a,"action")=="list"){
    var list=Directory.GetDirectories(BackupRoot).OrderByDescending(x=>x).Take(50).Select(x=>{string m=Path.Combine(x,"manifest.json");Dictionary<string,object> man=null;try{if(File.Exists(m))man=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(m));}catch{}
     return new{backup_name=Path.GetFileName(x),main=man==null?null:man["main"],files=man==null?0:((System.Collections.ArrayList)man["files"]).Count,created=man==null?null:man["created"]};}).ToArray();
    result=new{backups=list};return true;
   }
   string name=Str(a,"backup_name");if(Path.GetFileName(name)!=name||name=="."||name=="..")throw new Exception("Simple backup_name required");
   string folder=Path.Combine(BackupRoot,name);if(!File.Exists(Path.Combine(folder,"manifest.json")))throw new Exception("Backup not found");NoLinks(folder);
   string main;var items=ReadManifest(folder,out main);
   var open=items.Select(i=>i.Item1).Where(p=>sw.GetOpenDocumentByName(p)!=null).ToArray();
   if(open.Length>0)throw new Exception("Close these documents first (sw_close_document): "+string.Join(", ",open.Select(Path.GetFileName)));
   // Safety net: snapshot EXACTLY the destinations that will be overwritten.
   var targets=items.Select(i=>i.Item1).Where(File.Exists).ToList();
   object safety=targets.Count>0?BackupFiles(main,targets,null,"prerestore"):null;
   var done=new List<string>();
   try{foreach(var i in items){string tmp=i.Item1+"."+Guid.NewGuid().ToString("N")+".mcp-restore.tmp";File.Copy(i.Item2,tmp,false);if(File.Exists(i.Item1))File.Replace(tmp,i.Item1,null);else File.Move(tmp,i.Item1);done.Add(i.Item1);}}
   catch(Exception ex){throw new Exception("Restore stopped after "+done.Count+" of "+items.Count+" files ("+ex.Message+"). Current files were saved first in "+(safety==null?"(nothing to save)":safety.GetType().GetProperty("backup_name").GetValue(safety,null))+"; restore that backup to undo.");}
   var bad=items.Where(i=>Sha256(i.Item1)!=i.Item3).Select(i=>Path.GetFileName(i.Item1)).ToArray();
   result=new{restored=done.Count,from=name,verified_by_hash=bad.Length==0,mismatched=bad,pre_restore_backup=safety};return true;
  }
  if(op=="close_document"){
   string id=Str(a,"document_id");if(!owned.ContainsKey(id))throw new Exception("Unknown document_id");var d=owned[id];
   bool discard=a.ContainsKey("discard_changes")&&Convert.ToBoolean(a["discard_changes"]);
   bool dirty;try{dirty=d.GetSaveFlag();}catch{dirty=false;}
   if(dirty&&!discard)throw new Exception("Document has unsaved changes; save it or pass discard_changes=true");
   string title,path;try{title=d.GetTitle();path=d.GetPathName();}catch{
    // dead COM object (document already closed by a failed safe-edit restore): just forget the id
    foreach(var k in owned.Where(x=>x.Value==d).Select(x=>x.Key).ToList()){owned.Remove(k);external.Remove(k);}if(lastDoc==d)lastDoc=null;
    result=new{closed=(string)null,note="The document was already closed; its id was released.",restored_saved_version=ProcessDiskRestore().ToArray()};return true;}
   sw.CloseDoc(title);
   if(!string.IsNullOrEmpty(path)&&sw.GetOpenDocumentByName(path)!=null)throw new Exception("SolidWorks keeps "+Path.GetFileName(path)+" loaded (an open assembly or drawing references it); its window was closed but the id stays valid. Close that assembly/drawing first.");
   foreach(var k in owned.Where(x=>x.Value==d).Select(x=>x.Key).ToList()){owned.Remove(k);external.Remove(k);}
   recoveryPending.Remove(path);axisCache.Remove(string.IsNullOrEmpty(path)?title:path);if(lastDoc==d)lastDoc=null;
   // v2.9: a safe-edit restore wrote unsaved intermediate state into the file; closing without saving puts the saved version back
   refsEdited.Remove(path);keptBaseline.Remove(path);
   var restoredDisk=ProcessDiskRestore().Where(x=>string.Equals(x,path,StringComparison.OrdinalIgnoreCase)).FirstOrDefault();
   result=new{closed=path,discarded_changes=dirty,restored_saved_version=restoredDisk};return true;
  }
  return false;
 }
}
