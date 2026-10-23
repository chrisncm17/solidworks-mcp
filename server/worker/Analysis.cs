using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// Analysis and delivery tools: part_diff (read-only comparison) and pack_and_go (verified package).
partial class Worker {
 static string PackRoot{get{return Path.Combine(Root,"packs");}}

 static Dictionary<string,object> PartFacts(IModelDoc2 d){
  var p=(IPartDoc)d;string db;string mat=p.GetMaterialPropertyName2("",out db)??"";
  var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.AccuracyLevel=2;mp.IncludeHiddenBodiesOrComponents=true;mp.Recalculate();
  var bodies=(object[])p.GetBodies2((int)swBodyType_e.swSolidBody,false)??new object[0];
  double x0=double.PositiveInfinity,y0=x0,z0=x0,x1=double.NegativeInfinity,y1=x1,z1=x1;
  foreach(IBody2 b in bodies){var x=(double[])b.GetBodyBox();x0=Math.Min(x0,x[0]);y0=Math.Min(y0,x[1]);z0=Math.Min(z0,x[2]);x1=Math.Max(x1,x[3]);y1=Math.Max(y1,x[4]);z1=Math.Max(z1,x[5]);}
  var feats=new List<string>();var dims=new Dictionary<string,double>();var combines=new List<string>();
  foreach(var f in AllFeatures(d)){string tn=f.GetTypeName2();
   if(tn!="RefPlane"&&tn!="OriginProfileFeature"&&!tn.EndsWith("Folder")&&tn!="DetailCabinet"&&tn!="MaterialFolder")feats.Add(f.Name+" ["+tn+"]"+(f.IsSuppressed()?" (suppressed)":""));
   if(tn=="CombineBodies"){var cd=f.GetDefinition() as ICombineBodiesFeatureData;int op=cd==null?-1:cd.OperationType;combines.Add(f.Name+": "+(op==0?"add":op==1?"subtract":op==2?"common":"unknown"));}
   var dd=(IDisplayDimension)f.GetFirstDisplayDimension();int j=0;
   // FullName is "D1@Sketch1@<document>.Part": drop the document part so copies with other names compare.
   while(dd!=null&&j++<200){var dim=(IDimension)dd.GetDimension2(0);if(dim!=null){string k=dim.FullName;int at=k.LastIndexOf('@');if(at>0&&k.IndexOf('@')!=at)k=k.Substring(0,at);if(!dims.ContainsKey(k))dims[k]=dim.SystemValue;}dd=(IDisplayDimension)f.GetNextDisplayDimension(dd);}}
  return new Dictionary<string,object>{{"title",d.GetTitle()},{"material",mat},{"volume_mm3",mp.Volume*1e9},{"mass_g",mp.Mass*1000},{"density_kg_m3",mp.Density},{"solid_bodies",bodies.Length},
   {"solid_box_mm",bodies.Length==0?null:new[]{(x1-x0)*1000,(y1-y0)*1000,(z1-z0)*1000}},{"features",feats},{"dimensions_si",dims},{"combines",combines}};
 }

 static bool TryAnalysis(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="part_diff"){
   if(d.GetType()!=(int)swDocumentTypes_e.swDocPART)throw new Exception("part_diff compares a managed PART");
   string orig=Str(a,"original_path");if(!Path.IsPathRooted(orig)||!orig.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase)||!File.Exists(orig))throw new Exception("original_path must be an existing absolute .SLDPRT");
   var now=PartFacts(d);
   // Same filename cannot be open twice: read the original through a uniquely named temporary copy, read-only.
   string tmp=Path.Combine(Path.GetTempPath(),"mcp_orig_"+Guid.NewGuid().ToString("N")+".SLDPRT");File.Copy(orig,tmp);
   Dictionary<string,object> was;IModelDoc2 od=null;
   try{int e=0,w=0;od=(IModelDoc2)sw.OpenDoc6(tmp,(int)swDocumentTypes_e.swDocPART,(int)(swOpenDocOptions_e.swOpenDocOptions_Silent|swOpenDocOptions_e.swOpenDocOptions_ReadOnly),"",ref e,ref w);
    if(od==null)throw new Exception("Could not open original copy: "+e);was=PartFacts(od);}
   finally{if(od!=null)sw.CloseDoc(od.GetTitle());int ee=0;sw.ActivateDoc3(d.GetTitle(),false,0,ref ee);try{File.Delete(tmp);}catch{}}
   Func<string,double> pct=k=>{double o=(double)was[k],n=(double)now[k];return o==0?0:(n-o)/o*100;};
   var fNow=(List<string>)now["features"];var fWas=(List<string>)was["features"];
   var dNow=(Dictionary<string,double>)now["dimensions_si"];var dWas=(Dictionary<string,double>)was["dimensions_si"];
   var dimChanges=dWas.Keys.Union(dNow.Keys).Where(k=>!dWas.ContainsKey(k)||!dNow.ContainsKey(k)||Math.Abs(dWas[k]-dNow[k])>1e-9)
    .Select(k=>new{name=k,original_si=dWas.ContainsKey(k)?(double?)dWas[k]:null,current_si=dNow.ContainsKey(k)?(double?)dNow[k]:null}).ToArray();
   result=new{original_path=orig,current=d.GetPathName(),volume_change_percent=pct("volume_mm3"),mass_change_percent=pct("mass_g"),original=new{volume_mm3=was["volume_mm3"],mass_g=was["mass_g"],material=was["material"],solid_bodies=was["solid_bodies"],solid_box_mm=was["solid_box_mm"]},
    current_values=new{volume_mm3=now["volume_mm3"],mass_g=now["mass_g"],material=now["material"],solid_bodies=now["solid_bodies"],solid_box_mm=now["solid_box_mm"]},
    material_changed=(string)was["material"]!=(string)now["material"],features_added=fNow.Except(fWas).ToArray(),features_removed=fWas.Except(fNow).ToArray(),combines=now["combines"],dimension_changes=dimChanges,
    note="Body boxes can be loose after boolean cuts; confirm sizes with drawing dimensions. Missing material uses default density."};
   return true;
  }
  if(op=="pack_and_go"){
   if(d.GetType()==(int)swDocumentTypes_e.swDocPART)throw new Exception("pack_and_go is for assemblies and drawings");
   if(d.GetSaveFlag())throw new Exception("Save the document first (sw_save); Pack and Go copies the saved files");
   string folder=Str(a,"folder_name");if(folder.IndexOfAny(Path.GetInvalidFileNameChars())>=0||folder.Trim('.',' ')!=folder||folder.Length==0)throw new Exception("folder_name must be a simple folder name");
   Directory.CreateDirectory(PackRoot);string dest=Path.GetFullPath(Path.Combine(PackRoot,folder));
   if(!dest.StartsWith(Path.GetFullPath(PackRoot)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Path outside packs directory");
   if(Directory.Exists(dest)||File.Exists(dest+".zip"))throw new Exception("Destination already exists; choose another folder_name");
   var pg=(PackAndGo)d.Extension.GetPackAndGo();pg.IncludeDrawings=false;pg.IncludeSimulationResults=false;pg.IncludeToolboxComponents=true;pg.FlattenToSingleFolder=true;
   object names;pg.GetDocumentNames(out names);var files=((string[])names??new string[0]).ToArray();
   if(files.Length==0)throw new Exception("Pack and Go returned no documents; nothing was copied");
   var dirtyRefs=DirtyOpen(files);if(dirtyRefs.Length>0)throw new Exception("Save these open documents first; Pack and Go copies saved files only: "+string.Join(", ",dirtyRefs));
   var clash=files.GroupBy(f=>Path.GetFileName(f),StringComparer.OrdinalIgnoreCase).Where(g=>g.Count()>1).Select(g=>g.Key).ToArray();
   if(clash.Length>0)throw new Exception("Flattening would merge different files with the same name: "+string.Join(", ",clash));
   NoLinks(PackRoot);
   Directory.CreateDirectory(dest);if(!pg.SetSaveToName(true,dest))throw new Exception("SetSaveToName failed");
   var status=(int[])d.Extension.SavePackAndGo(pg)??new int[0];
   var failed=files.Select((f,i)=>new{file=Path.GetFileName(f),status=i<status.Length?status[i]:-1}).Where(x=>x.status!=0).ToArray();
   // Verify: every referenced file must exist inside the package. The stored paths (search=false) keep the last-saved
   // location and are informational only: opening the package alone loads components from its own folder (tested).
   string main=Path.Combine(dest,Path.GetFileName(d.GetPathName()));
   var deps=sw.GetDocumentDependencies2(main,true,false,false) as string[]??new string[0];var refs=new List<string>();for(int i=1;i<deps.Length;i+=2)refs.Add(deps[i]);
   var missing=refs.Select(Path.GetFileName).Concat(files.Select(Path.GetFileName)).Where(n=>!File.Exists(Path.Combine(dest,n))||new FileInfo(Path.Combine(dest,n)).Length==0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
   if(!File.Exists(main)||new FileInfo(main).Length==0)missing=missing.Concat(new[]{Path.GetFileName(main)}).Distinct().ToArray();
   var outside=new string[0];int storedOutside=refs.Count(r=>!r.StartsWith(dest+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase));
   bool verified=failed.Length==0&&missing.Length==0;
   string zip=null;if(a.ContainsKey("zip")&&Convert.ToBoolean(a["zip"])&&verified){zip=dest+".zip";System.IO.Compression.ZipFile.CreateFromDirectory(dest,zip,System.IO.Compression.CompressionLevel.Optimal,true);}
   long bytes=Directory.GetFiles(dest).Sum(f=>new FileInfo(f).Length);
   result=new{destination=dest,main_document=main,files_copied=Directory.GetFiles(dest).Length,size_mb=Math.Round(bytes/1048576.0,1),failed=failed,references=refs.Count,references_missing_in_package=missing,stored_paths_pointing_elsewhere=storedOutside,zip=zip,zip_mb=zip==null?(double?)null:Math.Round(new FileInfo(zip).Length/1048576.0,1),
    ok=verified,isolated_open_verified=false,note="ok = every document copied and every referenced file present (non-empty) in the package. An isolated open was NOT performed: close documents with the same names and open the packed main file to confirm. stored_paths_pointing_elsewhere is informational (last-saved paths)."};
   return true;
  }
  return false;
 }
}
