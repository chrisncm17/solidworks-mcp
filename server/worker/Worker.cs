using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
partial class Worker {
 static readonly string Root=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"generated");
 static readonly System.Threading.Mutex CadLock=new System.Threading.Mutex(false,"Local\\SolidWorksLocalMcpCadV1");
 static IModelDoc2 lastDoc;
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=4000000 };
 static ISldWorks sw;
 static Dictionary<string,IModelDoc2> owned=new Dictionary<string,IModelDoc2>();
 static string Str(Dictionary<string,object>a,string k){return Convert.ToString(a[k]);}
 static double Num(Dictionary<string,object>a,string k){return Convert.ToDouble(a[k]);}
 static object EntityInfo(object entity){var p=entity as ISketchPoint;if(p!=null)return new{kind="point",id=p.GetID(),xyz=new[]{p.X,p.Y,p.Z}};var s=entity as ISketchSegment;if(s!=null)return new{kind="segment",id=s.GetID(),type=s.GetType()};return new{kind="other"};}
 static string ManagedPath(string name) {
  if(string.IsNullOrWhiteSpace(name)||Path.GetFileName(name)!=name||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||!name.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase))throw new Exception("Use a simple .SLDPRT filename without directories");
  var p=Path.GetFullPath(Path.Combine(Root,name));
  if(!p.StartsWith(Path.GetFullPath(Root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Path outside managed directory");
  if(File.Exists(p)&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked files are not supported");
  return p;
 }
 static IModelDoc2 Doc(Dictionary<string,object>a){
  string id=Str(a,"document_id");if(!owned.ContainsKey(id))throw new Exception("Unknown document_id; use open_copy, resume_copy or create_cylinder first");
  var d=owned[id];int e=0;var active=(IModelDoc2)sw.ActivateDoc3(d.GetTitle(),false,1,ref e); // 1 = swDontRebuildActiveDoc (0 asks the user and can dirty the doc)
  if(external.ContainsKey(id)&&!string.Equals(Path.GetFullPath(d.GetPathName()),external[id],StringComparison.OrdinalIgnoreCase))throw new Exception("Document path changed since sw_open_project (Save As?); its backup no longer covers it. Close it and open it again with sw_open_project.");
  // managed = directly in Root or in the subfolders the MCP itself saves to (assemblies, drawings)
  if(!external.ContainsKey(id)&&(!new[]{Root,Path.Combine(Root,"assemblies"),Path.Combine(Root,"drawings")}.Any(dir=>string.Equals(Path.GetDirectoryName(Path.GetFullPath(d.GetPathName())),Path.GetFullPath(dir),StringComparison.OrdinalIgnoreCase))||!InsideRoot(d.GetPathName())))throw new Exception("Document was moved outside the managed folder; refusing edits");
  if(active==null||!string.Equals(active.GetPathName(),d.GetPathName(),StringComparison.OrdinalIgnoreCase))throw new Exception("Could not activate requested managed document");
  if(d.GetType()==1&&d.SketchManager.ActiveSketch!=null)throw new Exception("Exit the active sketch before calling this tool");
  lastDoc=d; return d;
 }
 // v3.8 speed: after each edit only what changed is rebuilt (a full rebuild after EVERY feature made each feature slower than
 // the previous one); one full rebuild runs at the end through op verify_rebuild (part_build calls it before its checks)
 static object Checked(IModelDoc2 d){return Checked(d,false);}
 static object Checked(IModelDoc2 d,bool full){return Checked(d,full,true);}
 static object Checked(IModelDoc2 d,bool full,bool inspect){
  if(full)d.ForceRebuild3(false);else d.EditRebuild3();
  foreach(var f in AllFeatures(d)){bool warning=false;int code=f.GetErrorCode2(out warning);if(code!=0&&!warning)throw new Exception("Rebuild error in "+f.Name+": "+code+". Copy may contain unsaved changes; inspect before continuing.");
   var sk=f.GetSpecificFeature2() as ISketch;if(sk!=null){int status=sk.GetConstrainedStatus();if(status==4||status==5||status==6)throw new Exception("Invalid sketch "+f.Name+" (status "+status+"). Copy may contain unsaved changes; inspect before continuing.");}}
  return inspect?Inspect(d):(object)new{checked_only=true};
 }
 // Tight bounding box in mm [xmin,ymin,zmin,xmax,ymax,zmax] from extreme points (GetBodyBox can be loose on curved faces).
 static double[] ExactBox(IBody2 b){var r=new double[6];double x,y,z;
  for(int k=0;k<3;k++)foreach(int s in new[]{-1,1}){var v=new double[3];v[k]=s;if(!b.GetExtremePoint(v[0],v[1],v[2],out x,out y,out z))throw new Exception("GetExtremePoint failed for body "+b.Name);r[s<0?k:k+3]=Math.Round(new[]{x,y,z}[k]*1000,6);}
  return r;}
 static object Inspect(IModelDoc2 d){
  if(d.GetType()!=1)return InspectOther(d);
  d.ClearSelection2(true);var p=(IPartDoc)d; string db="";string mat=p.GetMaterialPropertyName2("",out db);
  object[] solidBodies=(object[])p.GetBodies2(0,false)??new object[0];
  var mp=solidBodies.Length>0?(IMassProperty2)d.Extension.CreateMassProperty2():null;
  if(mp!=null){mp.UseSystemUnits=true;mp.AccuracyLevel=2;mp.IncludeHiddenBodiesOrComponents=true;mp.Recalculate();}
  var ov=mp==null?null:(IMassPropertyOverrideOptions)mp.GetOverrideOptions();
  var fs=new List<object>(); IFeature f=(IFeature)d.FirstFeature();int n=0;
  while(f!=null&&n++<500){var dims=new List<object>();var dd=(IDisplayDimension)f.GetFirstDisplayDimension();int j=0;while(dd!=null&&j++<100){var dim=(IDimension)dd.GetDimension2(0);bool diam=false;try{diam=dd.Diametric;}catch{}dims.Add(new{name=dim.FullName,value_si=dim.SystemValue,dim_type=dd.GetType(),diametric=diam});dd=(IDisplayDimension)f.GetNextDisplayDimension(dd);}bool warning=false;int error=f.GetErrorCode2(out warning);fs.Add(new{name=f.Name,type=f.GetTypeName2(),suppressed=f.IsSuppressed(),error_code=error,is_warning=warning,dimensions=dims});f=(IFeature)f.GetNextFeature();}
  object[] bodies=(object[])p.GetBodies2(0,false);var bs=new List<object>();if(bodies!=null)foreach(IBody2 b in bodies){string bdb="";bs.Add(new{name=b.Name,box_m=b.GetBodyBox(),box_exact_mm=ExactBox(b),material=b.GetMaterialPropertyName("",out bdb),material_database=bdb,face_count=b.GetFaceCount()});}
  return new {title=d.GetTitle(),path=d.GetPathName(),unsaved_changes=d.GetSaveFlag(),material=mat,material_database=db,mass_g=mp==null?(double?)null:mp.Mass*1000,volume_mm3=mp==null?0:mp.Volume*1e9,density_kg_m3=mp==null?(double?)null:mp.Density,override_mass=ov!=null&&ov.OverrideMass,units=d.GetUnits(),sketches=AllFeatures(d).Where(x=>x.GetSpecificFeature2() is ISketch).Select(x=>new{name=x.Name,status=((ISketch)x.GetSpecificFeature2()).GetConstrainedStatus()}).ToArray(),bodies=bs,features=fs};
 }
 static object Execute(string op,Dictionary<string,object>a){
  if(op=="status") {
   try{if(sw==null)sw=ConnectSw();return new{connected=true,revision=sw.RevisionNumber(),document_count=sw.GetDocumentCount(),managed_directory=Root,owned_documents=owned.Keys.ToArray(),instance=InstanceState()["mode"]};}
   catch(COMException e){sw=null;return new{connected=false,hresult=e.ErrorCode,message="Open SolidWorks normally in the same Windows user session, then retry.",managed_directory=Root};}
  }
  object extraIn;if(TryInstance(op,a,out extraIn))return extraIn;
  // v3.6: follow instance changes made by other chats, and drop a SolidWorks that was closed/restarted
  preSplit=new long[8];preSplit[0]=opWatch.ElapsedMilliseconds;var ist=InstanceState();preSplit[1]=opWatch.ElapsedMilliseconds;string ikey=Convert.ToString(ist["mode"])+"|"+(ist.ContainsKey("pid")?Convert.ToString(ist["pid"]):"");
  if(ikey!=swKey){if(swKey!=null&&owned.Count>0)throw new Exception("Another chat switched the MCP to a different SolidWorks while this chat has "+owned.Count+" document(s) open in the previous one; switch back (sw_instance) or close them.");sw=null;swKey=ikey;}
  if(sw!=null)try{sw.GetProcessID();}catch{sw=null;}preSplit[2]=opWatch.ElapsedMilliseconds;
  if(sw==null)sw=ConnectSw();
  if(Convert.ToString(ist["mode"])=="dedicated")try{AckRecoveryNotice(Convert.ToInt32(ist["pid"]));}catch{}   // the notice can show up late
  // v3.6 fast mode (switched off in Main after every operation, only by the worker that switched it on); SW_MCP_FAST=0 disables it
  // v3.8 speed: fast_hold keeps CommandInProgress on BETWEEN the operations of one build (assembly_build): otherwise SolidWorks uses
  // every gap to redraw/tessellate parts loaded from disk (12 s stuck in the first COM call of mass_check); released at the end
  if(op=="fast_hold"){fastHold=Flag(a,"on");if(!fastHold)try{sw.CommandInProgress=false;}catch{}return new{fast_hold=fastHold};}
  if(System.Environment.GetEnvironmentVariable("SW_MCP_FAST")!="0")try{sw.CommandInProgress=true;fastSet=true;}catch{}
  preSplit[3]=opWatch.ElapsedMilliseconds;if(DiskRestore().Count>0)ProcessDiskRestore();preSplit[4]=opWatch.ElapsedMilliseconds;
  object extraSh;if(TrySessionHealth(op,a,out extraSh))return extraSh;preSplit[5]=opWatch.ElapsedMilliseconds;
  if(op=="equations")return ReadEquations(a);
  object extra;if(TryGlobal(op,a,out extra))return extra;
  if(TryProject(op,a,out extra))return extra;
  if(TryCopyRenamed(op,a,out extra))return extra;
  if(TryAssemblyGlobal(op,a,out extra))return extra;
  if(TryDrawingGlobal(op,a,out extra))return extra;
  if(TrySnapshot(op,a,out extra))return extra;
  if(op=="resume_copy") {string name=Str(a,"name");if(Path.GetFileName(name)!=name)throw new Exception("Filename required");string path=ManagedPath(name);int e=0,w=0;IModelDoc2 d=(IModelDoc2)sw.GetOpenDocumentByName(path);if(d==null)d=(IModelDoc2)sw.OpenDoc6(path,1,1,"",ref e,ref w);if(d==null)throw new Exception("Cannot open owned copy");string id=Guid.NewGuid().ToString("N");owned.Add(id,d);return new{document_id=id,inspection=Inspect(d)};}
  if(op=="open_copy"){
   if(!Path.IsPathRooted(Str(a,"source")))throw new Exception("Source must be an absolute path");string source=Path.GetFullPath(Str(a,"source"));
   var sourceDoc=(IModelDoc2)sw.GetOpenDocumentByName(source);if(sourceDoc!=null&&sourceDoc.GetSaveFlag())throw new Exception("Source has unsaved changes. Save it yourself or choose a saved source; open_copy copies the disk version only.");if(!source.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase))throw new Exception("Only SLDPRT supported");
   string name=Str(a,"name");if(Path.GetFileName(name)!=name||!name.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase))throw new Exception("Use a simple .SLDPRT filename");
   string dest=ManagedPath(name);File.Copy(source,dest,false);int err=0,warn=0;var d=(IModelDoc2)sw.OpenDoc6(dest,1,1,"",ref err,ref warn);if(d==null)throw new Exception("OpenDoc6 failed "+err);
   string id=Guid.NewGuid().ToString("N");owned.Add(id,d);return new{document_id=id,open_errors=err,open_warnings=warn,inspection=Inspect(d)};
  }
  // v3.9 import a neutral file (STEP, IGES, Parasolid, ACIS) as a NEW managed SLDPRT/SLDASM. The source is copied to
  // generated/imports first and only the copy is read, so the user's file is never opened, locked or changed.
  if(op=="import_model"){
   if(!Path.IsPathRooted(Str(a,"source")))throw new Exception("Source must be an absolute path");string source=Path.GetFullPath(Str(a,"source"));
   if(!File.Exists(source))throw new Exception("Source not found: "+source);string ext=Path.GetExtension(source).ToLowerInvariant();
   if(!new[]{".step",".stp",".igs",".iges",".x_t",".x_b",".sat"}.Contains(ext))throw new Exception("Import supports STEP, IGES, Parasolid (x_t/x_b) and ACIS (sat)");
   string name=Str(a,"name");bool wantAsm=name.EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase);
   if(Path.GetFileName(name)!=name||!(wantAsm||name.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase)))throw new Exception("Use a simple .SLDPRT or .SLDASM filename");
   if(name.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw new Exception("Invalid filename");
   string dest=wantAsm?Path.Combine(Root,name):ManagedPath(name);if(File.Exists(dest))throw new Exception("Destination already exists");
   string impDir=Path.Combine(Root,"imports");Directory.CreateDirectory(impDir);
   string copy=Path.Combine(impDir,Path.GetFileNameWithoutExtension(name)+"_"+DateTime.Now.ToString("yyyyMMddHHmmss")+ext);File.Copy(source,copy,false);
   int err=0;object data=null;try{data=sw.GetImportFileData(copy);}catch{}
   var d=(IModelDoc2)sw.LoadFile4(copy,"r",data,ref err);
   if(d==null)throw new Exception("Import failed (LoadFile4 error "+err+"): the translator may be unavailable or the file damaged");
   bool isAsm=d.GetType()==2;
   if(isAsm!=wantAsm){try{sw.CloseDoc(d.GetTitle());}catch{}throw new Exception("The file holds "+(isAsm?"an ASSEMBLY: use a .SLDASM name":"a PART: use a .SLDPRT name"));}
   int e=0,w=0;d.ClearSelection2(true);
   // Codex review: everything this import opened is closed again if any step fails (no orphan documents)
   var opened=new List<IModelDoc2>{d};
   try{
    // 3D Interconnect leaves the parts of an imported assembly in a TEMP folder: FIRST save every referenced document that
    // lies outside generated into generated/<assembly>_parts (deepest first), THEN save the assembly, so nothing is ever
    // written outside the managed folder
    if(isAsm){string partsDir=Path.Combine(Root,Path.GetFileNameWithoutExtension(name)+"_parts");var moved=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
     for(int pass=0;pass<6;pass++){bool any=false;
      foreach(IComponent2 c in ((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().OrderByDescending(x=>x.Name2.Count(ch=>ch=='/'))){
       var md=c.GetModelDoc2() as IModelDoc2;if(md==null)continue;string pth=md.GetPathName();
       if(string.IsNullOrEmpty(pth)||InsideRoot(pth)||moved.Contains(pth))continue;
       Directory.CreateDirectory(partsDir);string fn=Path.GetFileNameWithoutExtension(pth).Replace(".step","").Replace(".stp","").Replace(".igs","").Replace(".iges","")+(md.GetType()==2?".SLDASM":".SLDPRT");
       string to=Path.Combine(partsDir,fn);for(int k=2;File.Exists(to);k++)to=Path.Combine(partsDir,Path.GetFileNameWithoutExtension(fn)+"_"+k+Path.GetExtension(fn));
       if(!InsideRoot(to))throw new Exception("Refusing to write outside the managed folder: "+to);
       int pe=0,pw=0;if(!md.Extension.SaveAs(to,0,(int)swSaveAsOptions_e.swSaveAsOptions_Silent,null,ref pe,ref pw)||pe!=0)throw new Exception("Cannot save imported component "+c.Name2+" to "+to+" ("+pe+")");
       opened.Add(md);moved.Add(to);any=true;}
      if(!any)break;}}
    if(!d.Extension.SaveAs(dest,0,(int)swSaveAsOptions_e.swSaveAsOptions_Silent,null,ref e,ref w)||e!=0||!File.Exists(dest))throw new Exception("Save of the imported model failed: "+e+" warnings "+w);
    if(isAsm){var outside=((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().Select(c=>c.GetPathName()).Where(p=>!string.IsNullOrEmpty(p)&&!InsideRoot(p)).ToList();
     if(outside.Count>0)throw new Exception("Imported assembly still references files outside generated: "+string.Join(", ",outside.Take(5)));}
   }catch{for(int k=opened.Count-1;k>=0;k--)try{sw.CloseDoc(opened[k].GetTitle());}catch{}throw;}
   lastDoc=d;string id=Guid.NewGuid().ToString("N");owned.Add(id,d);createdHere.Add(id);
   int solids=0,sheets=0;var parts=new List<object>();
   if(!isAsm){var pd=(IPartDoc)d;solids=((object[])pd.GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]).Length;sheets=((object[])pd.GetBodies2((int)swBodyType_e.swSheetBody,true)??new object[0]).Length;}
   else foreach(IComponent2 c in (object[])((IAssemblyDoc)d).GetComponents(false)??new object[0])parts.Add(new{component=c.Name2,file=c.GetPathName()});
   var warnings=new List<string>();
   if(!isAsm&&solids==0)warnings.Add("No solid body: the file only brought surfaces ("+sheets+"); mass and center of mass are not valid until they are knitted into a solid");
   if(!isAsm&&sheets>0&&solids>0)warnings.Add(sheets+" surface bodies came along with the solids; they do not count for mass");
   return new{document_id=id,path=dest,kind=isAsm?"assembly":"part",source_copy=copy,load_errors=err,save_warnings=w,solid_bodies=solids,surface_bodies=sheets,components=isAsm?parts:null,warnings=warnings,inspection=Inspect(d),
    note="Imported geometry has no feature history: dimensions cannot be edited; assign the material (sw_set_material) before reading mass."};
  }
  if(op=="create_cylinder") {
   string path=ManagedPath(Str(a,"name"));if(File.Exists(path))throw new Exception("Destination already exists");
   double radius=Num(a,"radius_mm")/1000,depth=Num(a,"depth_mm")/1000;
   if(radius<=0||radius>1||depth<=0||depth>10)throw new Exception("Cylinder dimensions outside supported bounds");
   string template=Str(a,"template");if(!Path.IsPathRooted(template)||!File.Exists(template)||!template.EndsWith(".prtdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing absolute PRTDOT template required");
   var d=(IModelDoc2)sw.NewDocument(template,0,0,0);if(d==null)throw new Exception("NewDocument failed; check part template");
   lastDoc=d;string id=Guid.NewGuid().ToString("N");owned.Add(id,d);
   IFeature plane=(IFeature)d.FirstFeature();while(plane!=null&&plane.GetTypeName2()!="RefPlane")plane=(IFeature)plane.GetNextFeature();
   if(plane==null||!plane.Select2(false,0))throw new Exception("No reference plane");
   bool prompt=sw.GetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate);
   try{d.SketchManager.InsertSketch(true);var seg=(ISketchSegment)d.SketchManager.CreateCircleByRadius(0,0,0,radius);sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,false);d.ClearSelection2(true);seg.Select2(false,0);var dd=(IDisplayDimension)d.AddRadialDimension2(radius*1.5,0,0);if(dd==null)throw new Exception("Radius dimension failed");((IDimension)dd.GetDimension2(0)).SystemValue=radius;}
   finally{try{sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,prompt);}finally{if(d.SketchManager.ActiveSketch!=null)d.SketchManager.InsertSketch(true);}}
   var feature=d.FeatureManager.FeatureExtrusion3(true,false,false,0,0,depth,0,false,false,false,false,0,0,false,false,false,false,true,true,true,0,0,false);
   if(feature==null)throw new Exception("Cylinder extrusion failed");Checked(d); // keeps the SolidWorks default name (user rule)
   int errors=0,warnings=0;if(!d.Extension.SaveAs(path,0,1,null,ref errors,ref warnings)||errors!=0)throw new Exception("Initial SaveAs failed: "+errors);
   return new{document_id=id,path=path,inspection=Inspect(d)};
  }
  var doc=Doc(a);
  return Guarded(op,a,doc);
 }
 // v2.9: everything that acts on a resolved document; Guarded() (Guard.cs) wraps it with health checks and automatic restore.
 // v3.8 profiling: every response carries worker_ms (whole operation inside the worker) and pre_ms (until the document code)
  static readonly System.Diagnostics.Stopwatch opWatch=new System.Diagnostics.Stopwatch();static long reachMs=-1;static bool fastHold=false;static long[] preSplit=new long[8];
  static object ExecuteOnDoc(string op,Dictionary<string,object>a,IModelDoc2 doc){object extra;if(reachMs<0)reachMs=opWatch.ElapsedMilliseconds;
  if((op=="save"||op=="checkpoint"||op=="pack_and_go"||op=="export")&&recoveryPending.Contains(doc.GetPathName()))throw new Exception("Saving is blocked: this document may not be in a verified state (interference detection, a failed repair or an edit that could not be restored). Close it with sw_close_document (discard_changes=true) and open it again.");
  if(TryParametric(op,a,doc,out extra))return extra;
  if(TryDocumentUnits(op,a,doc,out extra))return extra;
  if(TryFeatureInfo(op,a,doc,out extra))return extra;
  if(TrySketchPlane(op,a,doc,out extra))return extra;
  if(TryExtrudeEdit(op,a,doc,out extra))return extra;
  if(TrySetMaterial(op,a,doc,out extra))return extra;
  if(TryAssembly(op,a,doc,out extra))return extra;
  if(TryAssembly2(op,a,doc,out extra))return extra;
  if(TryAssemblyExport(op,a,doc,out extra))return extra;
  if(TryAssemblyBatch(op,a,doc,out extra))return extra;
  if(TryFindFaces(op,a,doc,out extra))return extra;
  if(TryDrawingAnnotate(op,a,doc,out extra))return extra;
  if(TrySheetMetal(op,a,doc,out extra))return extra;
  if(TryCollision(op,a,doc,out extra))return extra;
  if(TryComponents(op,a,doc,out extra))return extra;
  if(TryBom(op,a,doc,out extra))return extra;
  if(TryExplode(op,a,doc,out extra))return extra;
  if(TryDrawingSheets(op,a,doc,out extra))return extra;
  if(TryDrawingNote(op,a,doc,out extra))return extra;
  if(TryMassCheck(op,a,doc,out extra))return extra;
  if(TryCoordinateSystem(op,a,doc,out extra))return extra;
  if(TryAssemblyDoctor(op,a,doc,out extra))return extra;
  if(TryAssemblyRepair(op,a,doc,out extra))return extra;
  if(TryAnalysis(op,a,doc,out extra))return extra;
  if(TryDrawings(op,a,doc,out extra))return extra;
  if(doc.GetType()!=1&&!new[]{"inspect","save","preview","export","checkpoint","compare_volume","set_dimension"}.Contains(op))throw new Exception("This tool requires a managed part, not an assembly or drawing");
  if(TryModel(op,a,doc,out extra))return extra;
  if(TryFeatures(op,a,doc,out extra))return extra;
  if(TryFeatures2(op,a,doc,out extra))return extra;
  if(TryFeatures3(op,a,doc,out extra))return extra;
  if(op=="inspect")return Inspect(doc);
 if(op=="verify_rebuild")return Checked(doc,true);
  if(op=="radius_dimension") {var feature=SketchFeature(doc,Str(a,"sketch"));doc.ClearSelection2(true);feature.Select2(false,0);bool prompt=sw.GetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate);try{doc.EditSketch();sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,false);var sk=(ISketch)feature.GetSpecificFeature2();var seg=(ISketchSegment)((object[])sk.GetSketchSegments())[Convert.ToInt32(a["segment"])];doc.ClearSelection2(true);seg.Select2(false,0);var dd=(IDisplayDimension)doc.AddRadialDimension2(-.05,-.065,0);if(dd==null)throw new Exception("Radius dimension failed");((IDimension)dd.GetDimension2(0)).SystemValue=Num(a,"radius_mm")/1000;}finally{try{sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,prompt);}finally{if(doc.SketchManager.ActiveSketch!=null)doc.SketchManager.InsertSketch(true);}}doc.ForceRebuild3(false);return Checked(doc);}
  if(op=="relations"||op=="delete_relation") {var f=SketchFeature(doc,Str(a,"sketch"));var sk=(ISketch)f.GetSpecificFeature2();var rels=(object[])sk.RelationManager.GetRelations(0)??new object[0];if(op=="relations"){var result=new List<object>();int i=0;foreach(ISketchRelation rel in rels)result.Add(new{index=i++,type=rel.GetRelationType(),entities=((object[])rel.GetEntities()??new object[0]).Select(EntityInfo).ToArray()});return new{status=sk.GetConstrainedStatus(),relations=result};}doc.ClearSelection2(true);f.Select2(false,0);try{doc.EditSketch();var rel=(ISketchRelation)rels[Convert.ToInt32(a["index"])];if(rel.GetRelationType()!=Convert.ToInt32(a["expected_type"]))throw new Exception("Relation changed");if(!sk.RelationManager.DeleteRelation((SketchRelation)rel))throw new Exception("Delete relation failed");}finally{if(doc.SketchManager.ActiveSketch!=null)doc.SketchManager.InsertSketch(true);}doc.ForceRebuild3(false);return Checked(doc);}
  if(op=="sketch") {var feature=SketchFeature(doc,Str(a,"name"));var sketch=(ISketch)feature.GetSpecificFeature2();var data=new List<object>();int index=0;foreach(ISketchSegment seg in (object[])sketch.GetSketchSegments()??new object[0]){object details=null;if(seg.GetType()==0){var l=(ISketchLine)seg;var p=(ISketchPoint)l.GetStartPoint2();var q=(ISketchPoint)l.GetEndPoint2();details=new{start=new[]{p.X,p.Y,p.Z},end=new[]{q.X,q.Y,q.Z}};}if(seg.GetType()==1){var arc=(ISketchArc)seg;var p=(ISketchPoint)arc.GetStartPoint2();var q=(ISketchPoint)arc.GetEndPoint2();var c=(ISketchPoint)arc.GetCenterPoint2();details=new{start=new[]{p.X,p.Y,p.Z},end=new[]{q.X,q.Y,q.Z},center=new[]{c.X,c.Y,c.Z},radius=arc.GetRadius()};}var relations=new List<int>();var rs=(object[])seg.GetRelations();if(rs!=null)foreach(ISketchRelation r in rs)relations.Add(r.GetRelationType());data.Add(new{index=index++,type=seg.GetType(),construction=seg.ConstructionGeometry,details=details,relations=relations});}return data;}
  if(op=="tangent") {var feature=SketchFeature(doc,Str(a,"sketch"));doc.ClearSelection2(true);feature.Select2(false,0);try{doc.EditSketch();var sketch=(ISketch)feature.GetSpecificFeature2();var segs=(object[])sketch.GetSketchSegments()??new object[0];int relationCount=((object[])sketch.RelationManager.GetRelations(0)??new object[0]).Length;doc.ClearSelection2(true); ((ISketchSegment)segs[Convert.ToInt32(a["first"])]).Select2(false,0); if(Convert.ToInt32(a["second"])!=Convert.ToInt32(a["first"]))((ISketchSegment)segs[Convert.ToInt32(a["second"])]).Select2(true,0); doc.SketchAddConstraints(a.ContainsKey("constraint")?Str(a,"constraint"):"sgTANGENT");if(((object[])sketch.RelationManager.GetRelations(0)??new object[0]).Length<=relationCount)throw new Exception("No new constraint was added; it may already exist or be incompatible");}finally{if(doc.SketchManager.ActiveSketch!=null)doc.SketchManager.InsertSketch(true);}doc.ForceRebuild3(false);return Checked(doc);}
  if(op=="set_dimension") {var dim=(IDimension)doc.Parameter(Str(a,"name"));if(dim==null)throw new Exception("Dimension not found");double value=Num(a,"value_si");if(double.IsNaN(value)||double.IsInfinity(value)||value<0)throw new Exception("Invalid dimension (negative)");int setResult=dim.SetSystemValue3(value,1,null);if(setResult!=0)throw new Exception("Dimension assignment rejected: "+setResult);doc.ForceRebuild3(false);if(Math.Abs(dim.SystemValue-value)>Math.Max(1e-10,Math.Abs(value)*1e-8))throw new Exception("Dimension did not retain requested value");return Checked(doc);}
  if(op=="geometry") {var faces=new List<object>();object[] bodies=(object[])((IPartDoc)doc).GetBodies2(0,false)??new object[0];int index=0;foreach(IBody2 b in bodies)foreach(IFace2 face in (object[])b.GetFaces()){ISurface surface=(ISurface)face.GetSurface();var edges=new List<object>();foreach(IEdge edge in (object[])face.GetEdges()){ICurve curve=(ICurve)edge.GetCurve();edges.Add(new{circle=curve.IsCircle(),circle_params=curve.IsCircle()?curve.CircleParams:null,start=((IVertex)edge.GetStartVertex())==null?null:((IVertex)edge.GetStartVertex()).GetPoint(),end=((IVertex)edge.GetEndVertex())==null?null:((IVertex)edge.GetEndVertex()).GetPoint()});}faces.Add(new{index=index++,area_mm2=face.GetArea()*1e6,box_m=face.GetBox(),cylinder=surface.IsCylinder()?surface.CylinderParams:null,plane=surface.IsPlane()?surface.PlaneParams:null,edges=edges});}return faces;}
  if(op=="preview") {if(doc.GetType()!=3)doc.ShowNamedView2("",7);doc.ViewZoomtofit2();string path=Path.Combine(Root,Guid.NewGuid().ToString("N")+"-preview.bmp");if(!doc.SaveBMP(path,1200,900))throw new Exception("Preview failed");string png=Path.ChangeExtension(path,".png");using(var bitmap=new System.Drawing.Bitmap(path)){bitmap.Save(png,System.Drawing.Imaging.ImageFormat.Png);}File.Delete(path);return new{path=png};}
  if(op=="set_material"){
   string database=Str(a,"database"),material=Str(a,"material");((IPartDoc)doc).SetMaterialPropertyName2("",database,material);doc.ForceRebuild3(false);string actualDb="";string actual=((IPartDoc)doc).GetMaterialPropertyName2("",out actualDb);if(actual!=material)throw new Exception("Material assignment did not match requested material");return Checked(doc);
  }
  if(op=="scale_uniform"){
   double s=Num(a,"factor");if(s<0.01||s>100||double.IsNaN(s))throw new Exception("Invalid factor");
   doc.ClearSelection2(true);var f=doc.FeatureManager.InsertScale(0,true,s,s,s);if(f==null)throw new Exception("Scale creation failed");doc.ForceRebuild3(false);return Checked(doc);
  }
  if(op=="save") {bool allowErrors=Flag(a,"allow_errors");if(doc.GetType()==2)doc.EditRebuild3();else doc.ForceRebuild3(false);var hNow=Health(doc);var problems=HealthProblems(hNow);
   Dictionary<string,object> kb;if(keptBaseline.TryGetValue(doc.GetPathName(),out kb)){var still=HealthRegressions(kb,hNow);if(still.Count==0)keptBaseline.Remove(doc.GetPathName());else problems.AddRange(still.Select(x=>"keep_broken: "+x));}
   if(problems.Count>0&&!allowErrors)throw new Exception("No se guarda: "+string.Join("; ",problems));object refsSaved=null;
   if(doc.GetType()==2&&a.ContainsKey("include_references")&&Convert.ToBoolean(a["include_references"])){
    // Referenced parts/subassemblies marked modified (e.g. converted from an older SolidWorks version): back up every
    // one outside the managed folder FIRST, then save them, so Pack and Go can copy saved files.
    var dirty=new Dictionary<string,IModelDoc2>(StringComparer.OrdinalIgnoreCase);
    foreach(IComponent2 cc in (object[])((IAssemblyDoc)doc).GetComponents(false)??new object[0]){var md=cc.GetModelDoc2() as IModelDoc2;if(md!=null&&md.GetSaveFlag()&&!string.IsNullOrEmpty(md.GetPathName()))dirty[md.GetPathName()]=md;}
    var blocked=dirty.Keys.Where(k=>recoveryPending.Contains(k)).ToArray();if(blocked.Length>0)throw new Exception("Saving is blocked for references altered by interference detection: "+string.Join(", ",blocked.Select(Path.GetFileName))+". Nothing was saved.");
    // Codex review: a reference is saved only after a FULL rebuild check and a clean health (a body-less part is refused too)
     foreach(var kv in dirty){try{Checked(kv.Value,true,false);var hp=HealthProblems(Health(kv.Value,true));if(hp.Count>0&&!allowErrors)throw new Exception(string.Join("; ",hp));}catch(Exception ex){throw new Exception("Reference "+Path.GetFileName(kv.Key)+" has rebuild errors; nothing was saved. "+ex.Message);}}
    var outside=dirty.Keys.Where(k=>!Path.GetFullPath(k).StartsWith(Path.GetFullPath(Root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)).ToList();
    object backup=outside.Count>0?BackupFiles(doc.GetPathName(),outside,new List<string>(),"refs"):null;
    var saved=new List<string>();foreach(var kv in dirty){int e1=0,w1=0;if(!kv.Value.Save3(1,ref e1,ref w1)||e1!=0)throw new Exception("Save failed for reference "+kv.Key+" ("+e1+"); saved so far: "+string.Join(", ",saved));saved.Add(Path.GetFileName(kv.Key));if(DiskRestore().Remove(kv.Key))SaveDiskRestore();}
    refsSaved=new{saved=saved.ToArray(),backup=backup};}
   int e=0,w=0;bool ok=doc.Save3(1,ref e,ref w);if(!ok||e!=0)throw new Exception("Save failed "+e);if(DiskRestore().Remove(doc.GetPathName()))SaveDiskRestore();keptBaseline.Remove(doc.GetPathName());return new{path=doc.GetPathName(),warnings=w,references=refsSaved,saved_with_problems=problems.ToArray(),inspection=Inspect(doc)};}
  throw new Exception("Unknown operation: "+op);
 }
 [STAThread]static void Main(){
  System.Threading.Thread.CurrentThread.CurrentCulture=System.Globalization.CultureInfo.InvariantCulture;
  Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  Directory.CreateDirectory(Root);if((File.GetAttributes(Root)&FileAttributes.ReparsePoint)!=0)throw new Exception("Managed directory must not be a symbolic link");string line;
  while((line=Console.ReadLine())!=null){object response;bool locked=false;lastDoc=null;lastGuard=null;opWatch.Restart();reachMs=-1;preSplit=new long[8];
   try{try{locked=CadLock.WaitOne(5000);}catch(System.Threading.AbandonedMutexException){locked=true;}
    if(!locked)throw new Exception("SolidWorks MCP is busy with another client; retry after that operation finishes.");
    var req=Json.Deserialize<Dictionary<string,object>>(line);var a=(Dictionary<string,object>)req["arguments"];
    var res=Execute(Str(req,"operation"),a);response=new{ok=true,result=res,safe_edit=lastGuard,worker_ms=opWatch.ElapsedMilliseconds,pre_ms=reachMs,pre_split=preSplit};
   }catch(Exception ex){object state=null;try{if(lastDoc!=null)state=Inspect(lastDoc);}catch{}var ge=ex as GuardException;response=new{ok=false,error=ex.Message,error_type=ge!=null&&ge.InnerException!=null?ge.InnerException.GetType().Name:ex.GetType().Name,stack=System.Environment.GetEnvironmentVariable("SW_MCP_STACK")=="1"?((ge!=null&&ge.InnerException!=null?ge.InnerException:ex).ToString()):null,state_after=state,automatic_rollback=ge!=null&&(bool)ge.Info.GetType().GetProperty("automatic_rollback").GetValue(ge.Info,null),safe_edit=ge!=null?ge.Info:lastGuard};}
   finally{if(locked){try{if(fastSet&&sw!=null&&!fastHold)sw.CommandInProgress=false;}catch{}fastSet=false;PublishOwnership();CadLock.ReleaseMutex();}}
   Console.WriteLine(Json.Serialize(response));Console.Out.Flush();
  }
   try{if(sw!=null)sw.CommandInProgress=false;}catch{} // Codex review: never leave CommandInProgress on after the last request (fast_hold)
 }
}
