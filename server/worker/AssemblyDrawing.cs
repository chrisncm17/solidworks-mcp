using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.8 pieces for sw_assembly_drawing (the plan of the assembly in one call; the steps live in assembly_drawing.mjs):
//  drawing_new  - empty drawing from a DRWDOT template, sheet width_mm x height_mm, saved at an absolute path inside the managed
//                 folder (generated\drawings), never overwritten.
//  drawing_note - text notes on the SHEET (not on a view): one note per line, top-left at position_mm, height_mm per line;
//                 each note is read back and must say exactly what was asked.
partial class Worker {
 static bool TryDrawingGlobal(string op,Dictionary<string,object>a,out object result){
  result=null;
  if(op!="drawing_new")return false;
  string path=Str(a,"path");if(!Path.IsPathRooted(path)||Path.GetFullPath(path)!=path||!path.EndsWith(".slddrw",StringComparison.OrdinalIgnoreCase))throw new Exception("path must be an absolute .SLDDRW path");
  string folder=Path.GetFullPath(Path.Combine(Root,"drawings"))+Path.DirectorySeparatorChar;
  if(!path.StartsWith(folder,StringComparison.OrdinalIgnoreCase))throw new Exception("drawing_new writes only inside "+folder);
  Directory.CreateDirectory(folder);
  // Codex review: a junction anywhere on the way would let the drawing land outside generated
  if(!InsideRoot(path))throw new Exception("drawing_new writes only inside the managed folder (no links)");
  if(File.Exists(path))throw new Exception("File already exists (never overwritten): "+path);
  string template=Str(a,"template");if(!File.Exists(template)||!template.EndsWith(".drwdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing DRWDOT template required");
  double w=Num(a,"width_mm"),h=Num(a,"height_mm");if(w<50||h<50||w>5000||h>5000)throw new Exception("width_mm/height_mm between 50 and 5000");
  var d=(IModelDoc2)sw.NewDocument(template,(int)swDwgPaperSizes_e.swDwgPapersUserDefined,w/1000,h/1000);if(d==null)throw new Exception("New drawing failed");
  int errors=0,warnings=0;
  if(!d.Extension.SaveAs(path,0,1,null,ref errors,ref warnings)||errors!=0){try{sw.CloseDoc(d.GetTitle());}catch{}throw new Exception("Initial save failed: "+errors);}
  string id=Guid.NewGuid().ToString("N");owned.Add(id,d);lastDoc=d;   // a managed document (generated\drawings), not an external one
  var sh=(ISheet)((IDrawingDoc)d).GetCurrentSheet();
  result=new{document_id=id,path=d.GetPathName(),sheet=sh.GetName()};return true;
 }
 static bool TryDrawingNote(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_note")return false;
  if(d.GetType()!=3)throw new Exception("drawing_note needs a managed drawing");
  var dr=(IDrawingDoc)d;
  if(a.ContainsKey("sheet")&&!dr.ActivateSheet(Str(a,"sheet")))throw new Exception("Sheet not found: "+Str(a,"sheet"));
  var lines=Items(a["lines"]).Select(Convert.ToString).ToList();if(lines.Count==0||lines.Count>40)throw new Exception("lines: 1 to 40");
  var pos=Items(a["position_mm"]).Select(Convert.ToDouble).ToArray();double h=a.ContainsKey("height_mm")?Num(a,"height_mm"):3.5;
  if(h<1||h>20)throw new Exception("height_mm between 1 and 20");
  dr.EditSheet();d.ClearSelection2(true);
  var made=new List<object>();
  for(int i=0;i<lines.Count;i++){
   string text=lines[i];if(text.Length==0)continue;
   var n=(INote)d.InsertNote(text);if(n==null)throw new Exception("InsertNote failed for line "+(i+1));
   var an=(IAnnotation)n.GetAnnotation();
   var tf=(ITextFormat)an.GetTextFormat(0);if(tf!=null){tf.CharHeight=h/1000;an.SetTextFormat(0,false,tf);}
   double x=pos[0]/1000,y=(pos[1]-i*h*1.7)/1000;
   if(!an.SetPosition2(x,y,0))throw new Exception("Could not place line "+(i+1));
   string got=n.GetText();if(got!=text)throw new Exception("Line "+(i+1)+" reads back as '"+got+"'");
   made.Add(new{note=n.GetName(),text=got,position_mm=new[]{Math.Round(x*1000,2),Math.Round(y*1000,2)}});
   d.ClearSelection2(true);
  }
  d.EditRebuild3();
  result=new{sheet=((ISheet)dr.GetCurrentSheet()).GetName(),notes=made.ToArray(),note="Unsaved until sw_save."};return true;
 }
}
