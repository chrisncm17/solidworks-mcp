using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.5 copy_renamed: copy a SAVED assembly/drawing/part and every file it references into generated\copies\<folder>, adding a
// prefix to every file name, and re-link the copies to each other on disk (ISldWorks.ReplaceReferencedDocument) WITHOUT
// opening anything. SolidWorks cannot open two files with the same name, so this is how to test on a copy while the user
// keeps the originals open. Verifies afterwards that every reference of the copies resolves inside the new folder.
partial class Worker {
 static bool TryCopyRenamed(string op,Dictionary<string,object>a,out object result){
  result=null;if(op!="copy_renamed")return false;
  string src=Str(a,"path");if(!Path.IsPathRooted(src))throw new Exception("Absolute path required");src=Path.GetFullPath(src);NativeType(src);
  if(!File.Exists(src))throw new Exception("File missing");NoLinks(src);
  string prefix=a.ContainsKey("prefix")?Str(a,"prefix"):"copia_";
  if(prefix.Length==0||prefix.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw new Exception("Invalid prefix");
  string folder=Str(a,"folder_name");if(folder.Length==0||folder.IndexOfAny(Path.GetInvalidFileNameChars())>=0||folder=="."||folder=="..")throw new Exception("Simple folder_name required");
  string dest=Path.Combine(Root,"copies",folder);if(Directory.Exists(dest))throw new Exception("Destination already exists: "+dest);
  var missing=new List<string>();var files=Dependencies(src,missing);
  if(missing.Count>0)throw new Exception("Missing references (nothing copied): "+string.Join(", ",missing.Select(Path.GetFileName)));
  var names=files.GroupBy(f=>Path.GetFileName(f),StringComparer.OrdinalIgnoreCase).Where(g=>g.Count()>1).Select(g=>g.Key).ToArray();
  if(names.Length>0)throw new Exception("Two referenced files share a name (cannot flatten): "+string.Join(", ",names));
  var dirtyOpen=DirtyOpen(files);
  var map=files.ToDictionary(f=>f,f=>Path.Combine(dest,prefix+Path.GetFileName(f)),StringComparer.OrdinalIgnoreCase);
  // v3.6 review: no junction/symlink in any source nor on the way to the destination (we write and may delete there)
  foreach(var f in files)NoLinks(f);
  Directory.CreateDirectory(Path.Combine(Root,"copies"));NoLinks(Path.Combine(Root,"copies"));
  Directory.CreateDirectory(dest);NoLinks(dest);
  var relinks=new List<object>();var failures=new List<string>();
  try{
   foreach(var kv in map){File.Copy(kv.Key,kv.Value,false);File.SetAttributes(kv.Value,File.GetAttributes(kv.Value)&~FileAttributes.ReadOnly);}
   // every copied file that references others (assemblies, drawings, derived parts) is re-linked to the copies
   foreach(var kv in map){
    var direct=sw.GetDocumentDependencies2(kv.Key,false,true,false) as string[]??new string[0];
    for(int i=1;i<direct.Length;i+=2){
     if(string.IsNullOrEmpty(direct[i]))continue;string target;
     if(!map.TryGetValue(Path.GetFullPath(direct[i]),out target)){failures.Add(Path.GetFileName(kv.Value)+": "+direct[i]+" not in the copy set");continue;}
     bool ok=sw.ReplaceReferencedDocument(kv.Value,direct[i],target);
     relinks.Add(new{file=Path.GetFileName(kv.Value),from=direct[i],to=target,ok=ok});if(!ok)failures.Add(Path.GetFileName(kv.Value)+": could not re-link "+Path.GetFileName(direct[i]));
    }
   }
   // verification: the new top file and all its (recursive) references live in dest
   var check=sw.GetDocumentDependencies2(map[files[0]],true,true,false) as string[]??new string[0];var outside=new List<string>();
   for(int i=1;i<check.Length;i+=2)if(!string.IsNullOrEmpty(check[i])&&!Path.GetFullPath(check[i]).StartsWith(dest+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))outside.Add(check[i]);
   if(outside.Count>0)failures.Add("references still outside the copy: "+string.Join(", ",outside));
   if(failures.Count>0)throw new Exception(string.Join(" | ",failures));
  }catch{try{Directory.Delete(dest,true);}catch{}throw;}
  result=new{path=map[files[0]],folder=dest,files=map.Select(kv=>new{original=kv.Key,copy=kv.Value}).ToArray(),relinked=relinks,
   warning=dirtyOpen.Length>0?"Open with unsaved changes (the copy has the SAVED version): "+string.Join(", ",dirtyOpen):null,
   note="Nothing was opened. Open the copy with sw_open_project; component names carry the prefix (e.g. "+prefix+"EJE-1)."};
  return true;
 }
}
