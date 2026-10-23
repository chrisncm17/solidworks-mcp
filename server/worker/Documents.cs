using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

partial class Worker {
 // v3.5: per-component dirty flag and the SolidWorks version that last saved the file (older versions are converted on open)
 static object CompDirty(IComponent2 x){try{var m=x.GetModelDoc2() as IModelDoc2;return m==null?(object)null:m.GetSaveFlag();}catch{return null;}}
 static string SavedIn(string p){try{var h=(string[])sw.VersionHistory(p);return h==null||h.Length==0?null:h[h.Length-1];}catch{return null;}}

 static string ExistingManaged(string name){
  if(Path.GetFileName(name)!=name||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||!new[]{".sldprt",".sldasm",".slddrw"}.Contains(Path.GetExtension(name).ToLowerInvariant()))throw new Exception("Simple managed native filename required");
  // assembly_build saves in Root\assemblies and drawings go to Root\drawings: look there too (still only simple names inside Root)
  string path=new[]{Root,Path.Combine(Root,"assemblies"),Path.Combine(Root,"drawings")}.Select(dir=>Path.Combine(dir,name)).FirstOrDefault(File.Exists)??Path.Combine(Root,name);if(!File.Exists(path)||(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0||!InsideRoot(path))throw new Exception("Managed document is missing or linked");return path;
 }
 static IModelDoc2 OpenNative(string path){
  var d=(IModelDoc2)sw.GetOpenDocumentByName(path);if(d!=null)return d;
  int e=0,w=0,type=path.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase)?1:path.EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase)?2:3;
  d=(IModelDoc2)sw.OpenDoc6(path,type,1,"",ref e,ref w);
  if(d!=null&&e!=0)try{sw.CloseDoc(d.GetTitle());}catch{}
  if(d==null||e!=0)throw new Exception("Could not open native document: "+e);return d;
 }
 // v2.8: an assembly with a missing reference opens (d != null) but reports swFileNotFoundError (2). Accept that only when the
 // caller allowed missing references; on any other failure close what SolidWorks opened so it is not left orphaned.
 static IModelDoc2 OpenNative(string path,bool allowMissingRefs){
  if(!allowMissingRefs)return OpenNative(path);
  var d=(IModelDoc2)sw.GetOpenDocumentByName(path);if(d!=null)return d;
  int e=0,w=0,type=path.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase)?1:path.EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase)?2:3;
  d=(IModelDoc2)sw.OpenDoc6(path,type,1,"",ref e,ref w);
  if(d!=null&&(e==0||e==2/*swFileNotFoundError*/))return d;
  if(d!=null)try{sw.CloseDoc(d.GetTitle());}catch{}
  throw new Exception("Could not open native document: "+e);
 }
 static object RegisterDocument(IModelDoc2 d){string id=Guid.NewGuid().ToString("N");owned.Add(id,d);lastDoc=d;return new{document_id=id,inspection=Inspect(d)};}
 static object InspectOther(IModelDoc2 d){
  if(d.GetType()==2){
   var assembly=(IAssemblyDoc)d;var components=(object[])assembly.GetComponents(false)??new object[0];
   var mass=(IMassProperty2)d.Extension.CreateMassProperty2();mass.UseSystemUnits=true;mass.AccuracyLevel=2;mass.IncludeHiddenBodiesOrComponents=true;mass.Recalculate();
   return new{title=d.GetTitle(),path=d.GetPathName(),document_type="assembly",unsaved_changes=d.GetSaveFlag(),volume_mm3=mass.Volume*1e9,mass_g=mass.Mass*1000,center_of_mass_mm=((double[])mass.CenterOfMass).Select(v=>Math.Round(v*1000,4)).ToArray(),components=components.Cast<IComponent2>().Select(x=>new{name=x.Name2,path=x.GetPathName(),fixed_position=x.IsFixed(),transform=x.Transform2==null?null:x.Transform2.ArrayData,unsaved_changes=CompDirty(x),last_saved_in=SavedIn(x.GetPathName())}).ToArray()};
  }
  if(d.GetType()==3){
   var drawing=(IDrawingDoc)d;var views=new List<object>();var view=(IView)drawing.GetFirstView();if(view!=null)view=(IView)view.GetNextView();
   while(view!=null){views.Add(new{name=view.Name,model=view.GetReferencedModelName(),outline_m=view.GetOutline()});view=(IView)view.GetNextView();}
   return new{title=d.GetTitle(),path=d.GetPathName(),document_type="drawing",unsaved_changes=d.GetSaveFlag(),sheets=drawing.GetSheetNames(),active_sheet_views=views};
  }
  throw new Exception("Unsupported document type");
 }
 static bool TryDocuments(string op,Dictionary<string,object>a,out object result){
  result=null;
  if(op=="resume_document"){result=RegisterDocument(OpenNative(ExistingManaged(Str(a,"name"))));return true;}
  if(op=="create_assembly"){
   string path=OutputPath(Str(a,"name"),new[]{".sldasm"});string template=Str(a,"template");
   if(!Path.IsPathRooted(template)||!File.Exists(template)||!template.EndsWith(".asmdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing absolute ASMDOT template required");
   var parts=Items(a["components"]).Cast<Dictionary<string,object>>().ToArray();
   foreach(var item in parts){string source=ExistingManaged(Str(item,"part_name"));if(!source.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase))throw new Exception("Assembly insertion currently supports managed parts only");var pd=OpenNative(source);if(pd.GetSaveFlag())throw new Exception("Save component edits before creating an assembly");}
   var d=(IModelDoc2)sw.NewDocument(template,0,0,0);if(d==null)throw new Exception("New assembly failed");lastDoc=d;var assembly=(IAssemblyDoc)d;
   foreach(var item in parts){
    string source=ExistingManaged(Str(item,"part_name"));var c=(IComponent2)assembly.AddComponent5(source,0,"",false,"",0,0,0);if(c==null)throw new Exception("Component insertion failed");
    if(c.IsFixed()){d.ClearSelection2(true);c.Select4(false,null,false);assembly.UnfixComponent();}
    double[] xyz=Items(item["translation_mm"]).Select(x=>Convert.ToDouble(x)/1000).ToArray();double angle=OptionalNum(item,"rotation_z_deg")*Math.PI/180,cos=Math.Cos(angle),sin=Math.Sin(angle);
    double[] matrix={cos,sin,0,-sin,cos,0,0,0,1,xyz[0],xyz[1],xyz[2],1,0,0,0};var transform=(MathTransform)((IMathUtility)sw.GetMathUtility()).CreateTransform(matrix);
    if(!c.SetTransformAndSolve2(transform))throw new Exception("Component transform failed");d.ClearSelection2(true);if(!c.Select4(false,null,false))throw new Exception("Component selection failed");assembly.FixComponent();if(!c.IsFixed())throw new Exception("Cannot fix component placement");
   }
   d.ClearSelection2(true);Checked(d);SaveNew(d,path);result=RegisterDocument(d);return true;
  }
  if(op=="create_drawing"){
   string path=OutputPath(Str(a,"name"),new[]{".slddrw"});string source=ExistingManaged(Str(a,"model_name"));if(source.EndsWith(".slddrw",StringComparison.OrdinalIgnoreCase))throw new Exception("Drawing source must be a part or assembly");
   var model=OpenNative(source);if(model.GetSaveFlag())throw new Exception("Save model edits before creating its drawing");
   string template=Str(a,"template");if(!Path.IsPathRooted(template)||!File.Exists(template)||!template.EndsWith(".drwdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing absolute DRWDOT template required");
   var d=(IModelDoc2)sw.NewDocument(template,0,0,0);if(d==null)throw new Exception("New drawing failed");lastDoc=d;var drawing=(IDrawingDoc)d;
   bool ok=Str(a,"projection")=="first_angle"?drawing.Create1stAngleViews2(source):drawing.Create3rdAngleViews2(source);if(!ok)throw new Exception("Standard drawing view creation failed");
   Checked(d);SaveNew(d,path);result=RegisterDocument(d);return true;
  }
  return false;
 }
}
