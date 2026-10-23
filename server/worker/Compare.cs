using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v1.9: assembly_diff (read-only) compares a managed assembly with a reference assembly file (e.g. the original from the teacher):
// components (matched by file, then nearest position), transforms (mm / degrees, optionally relative to a common component),
// mates (type + joined files + values), mass, volume and center of mass. Nothing is saved; a reference it opened is closed again.
partial class Worker {
 class CompFact{public string name,file,config;public bool suppressed,fixd,loaded;public double[] t;}
 class MateFact{public string name,type,sig;public bool suppressed;public int error;public double[] values;}

 static List<CompFact> CompFacts(IAssemblyDoc asm){
  var r=new List<CompFact>();
  foreach(IComponent2 c in (object[])asm.GetComponents(false)??new object[0]){
   string p=c.GetPathName()??"";var mt=c.Transform2 as MathTransform;
   r.Add(new CompFact{name=c.Name2,file=Path.GetFileName(p).ToLowerInvariant(),config=c.ReferencedConfiguration,suppressed=c.IsSuppressed(),fixd=c.IsFixed(),loaded=c.IsSuppressed()||c.GetModelDoc2()!=null,t=mt==null?null:(double[])mt.ArrayData});}
  return r;
 }
 static List<MateFact> MateFacts(IModelDoc2 d){
  var r=new List<MateFact>();
  foreach(var f in Mates(d)){var m=(IMate2)f.GetSpecificFeature2();bool w;int err=f.GetErrorCode2(out w);
   var files=new List<string>();for(int i=0;i<m.GetMateEntityCount();i++){var c=m.MateEntity(i).ReferenceComponent as IComponent2;string p=c==null?null:c.GetPathName();files.Add(c==null||p==null||string.Equals(Path.GetFullPath(p),Path.GetFullPath(d.GetPathName()),StringComparison.OrdinalIgnoreCase)?"<ensamble>":Path.GetFileName(p).ToLowerInvariant());}
   string type=Enum.IsDefined(typeof(swMateType_e),m.Type)?((swMateType_e)m.Type).ToString().Replace("swMate",""):m.Type.ToString();
   var vals=new List<double>();var dd=(IDisplayDimension)f.GetFirstDisplayDimension();int j=0;while(dd!=null&&j++<10){var dim=(IDimension)dd.GetDimension2(0);if(dim!=null)vals.Add(dim.SystemValue);dd=(IDisplayDimension)f.GetNextDisplayDimension(dd);}
   files.Sort(StringComparer.Ordinal);
   r.Add(new MateFact{name=f.Name,type=type,sig=type+"("+string.Join("|",files)+")",suppressed=f.IsSuppressed(),error=w?0:err,values=vals.ToArray()});}
  return r;
 }
 static object MassFacts(IModelDoc2 d){var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();var cm=(double[])mp.CenterOfMass;
  return new{mass_g=Math.Round(mp.Mass*1000,4),volume_mm3=Math.Round(mp.Volume*1e9,3),center_of_mass_mm=cm.Select(v=>Math.Round(v*1000,4)).ToArray()};}

 // assembly_snapshot {path}: open an assembly READ-ONLY (unless it is already open from that same path), read components, mates and
 // mass properties, close it again if this call opened it. Refuses when a different file with the same name as the assembly or any of
 // its references is open, because SolidWorks would silently reuse that document and the snapshot would be wrong.
 static bool TrySnapshot(string op,Dictionary<string,object>a,out object result){
  result=null;if(op!="assembly_snapshot")return false;
  string path=Str(a,"path");
  if(!Path.IsPathRooted(path)||!path.EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase)||!File.Exists(path))throw new Exception("path must be an existing absolute .SLDASM");
  path=Path.GetFullPath(path);
  var open=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  foreach(var o in (object[])sw.GetDocuments()??new object[0]){var md=o as IModelDoc2;string pp=md==null?null:md.GetPathName();if(!string.IsNullOrEmpty(pp))open[Path.GetFileName(pp)]=Path.GetFullPath(pp);}
  var deps=new List<string>{path};var dd=(string[])sw.GetDocumentDependencies2(path,true,true,false);if(dd!=null)for(int i=1;i<dd.Length;i+=2)if(!string.IsNullOrEmpty(dd[i]))deps.Add(dd[i]);
  var clash=deps.Where(x=>open.ContainsKey(Path.GetFileName(x))&&!string.Equals(open[Path.GetFileName(x)],Path.GetFullPath(x),StringComparison.OrdinalIgnoreCase)).Select(x=>Path.GetFileName(x)+" (abierto desde "+open[Path.GetFileName(x)]+")").Distinct().ToArray();
  if(clash.Length>0)throw new Exception("Close these documents first; another file with the same name is open and SolidWorks would reuse it: "+string.Join(", ",clash));
  // documents the user already has open must be saved (the snapshot compares SAVED files) and are never altered
  var dirtyOpen=deps.Where(x=>{var od=(IModelDoc2)sw.GetOpenDocumentByName(x);return od!=null&&od.GetSaveFlag();}).Select(Path.GetFileName).Distinct().ToArray();
  if(dirtyOpen.Length>0)throw new Exception("Save or close these open documents first (unsaved changes): "+string.Join(", ",dirtyOpen));
  var doc=(IModelDoc2)sw.GetOpenDocumentByName(path);bool opened=false;int loadErr=0,loadWarn=0;
  if(doc==null){doc=(IModelDoc2)sw.OpenDoc6(path,2,(int)(swOpenDocOptions_e.swOpenDocOptions_Silent|swOpenDocOptions_e.swOpenDocOptions_ReadOnly|swOpenDocOptions_e.swOpenDocOptions_OverrideDefaultLoadLightweight),"",ref loadErr,ref loadWarn);if(doc==null)throw new Exception("Cannot open "+path+" (error "+loadErr+")");opened=true;}
  bool closedOk=true;
  try{
   string active=((IConfiguration)doc.ConfigurationManager.ActiveConfiguration).Name;
   if(a.ContainsKey("configuration")&&Str(a,"configuration")!=active){
    string cn=Str(a,"configuration");if(!opened)throw new Exception(Path.GetFileName(path)+" is open in configuration "+active+"; close it to snapshot configuration "+cn+" (an open document is never changed)");
    if(!((object[])doc.GetConfigurationNames()).Select(Convert.ToString).Contains(cn))throw new Exception("Configuration not found: "+cn);
    doc.ShowConfiguration2(cn);if(((IConfiguration)doc.ConfigurationManager.ActiveConfiguration).Name!=cn)throw new Exception("Could not activate configuration "+cn);}
   if(opened)doc.ForceRebuild3(false);
   var comps=CompFacts((IAssemblyDoc)doc).Select(c=>new{name=c.name,file=c.file,configuration=c.config,suppressed=c.suppressed,fixd=c.fixd,loaded=c.loaded,transform=c.t}).ToArray();
   var mates=MateFacts(doc).Select(m=>new{name=m.name,type=m.type,signature=m.sig,suppressed=m.suppressed,error=m.error,values_si=m.values}).ToArray();
   result=new{path=path,configuration=((IConfiguration)doc.ConfigurationManager.ActiveConfiguration).Name,components=comps,mates=mates,mass=MassFacts(doc),opened_read_only=opened,load_error=loadErr,load_warning=loadWarn};
  }finally{if(opened){try{sw.CloseDoc(doc.GetTitle());}catch{}closedOk=sw.GetOpenDocumentByName(path)==null;}}
  if(!closedOk)throw new Exception("Snapshot read, but "+Path.GetFileName(path)+" could not be closed; close it before the next snapshot");
  return true;
 }
}
