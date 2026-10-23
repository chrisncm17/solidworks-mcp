using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.5 drawing_sheets on a managed drawing:
//  list       — sheets: size, scale, sheet format (title block) file, view names.
//  add/setup  — new or existing sheet: size A4..A0 / letter / width_mm×height_mm, landscape/portrait, first or third angle, and the
//               sheet format (cajetín) from a .slddrt (format_path) or COPIED from another drawing (format_from_drawing, opened
//               read-only; the original is never modified). Sheet scale stays 1:1 so the frame is not shrunk.
//  activate   — make a sheet the active one.
//  properties — drawing custom properties that title-block notes show ($PRP/$PRPSHEET), e.g. title, author, material.
//  add_view   — model view (isometric/front/top/right/back/bottom/left) of a part/assembly on the active sheet, with its own scale,
//               shaded or not, exploded (uses the assembly's exploded view; re-links it so the view really shows exploded).
partial class Worker {
 static readonly Dictionary<string,double[]> PaperMm=new Dictionary<string,double[]>{{"A4",new[]{297.0,210}},{"A3",new[]{420.0,297}},{"A2",new[]{594.0,420}},{"A1",new[]{841.0,594}},{"A0",new[]{1189.0,841}},{"letter",new[]{279.4,215.9}},{"tabloid",new[]{431.8,279.4}}};
 static object SheetInfo(IDrawingDoc dr,ISheet s){double w=0,h=0;s.GetSize(ref w,ref h);var p=(double[])s.GetProperties2();
  var views=((object[])dr.GetViews()??new object[0]).Cast<object[]>().FirstOrDefault(arr=>arr!=null&&arr.Length>0&&((IView)arr[0]).GetName2()==s.GetName());
  return new{name=s.GetName(),width_mm=Math.Round(w*1000,2),height_mm=Math.Round(h*1000,2),scale=p==null?null:(object)(p[2]+":"+p[3]),first_angle=p!=null&&p[4]!=0,format=s.GetTemplateName(),views=views==null?new string[0]:views.Skip(1).Cast<IView>().Select(v=>v.GetName2()).ToArray()};}
 static string CopyFormat(string drawingPath,string sheetName){
  if(!Path.IsPathRooted(drawingPath)||!File.Exists(drawingPath)||!drawingPath.EndsWith(".slddrw",StringComparison.OrdinalIgnoreCase))throw new Exception("format_from_drawing must be an existing absolute .SLDDRW");
  if(sw.GetOpenDocumentByName(drawingPath)!=null)throw new Exception(Path.GetFileName(drawingPath)+" is open; close it so it can be read in read-only mode (it is never modified)");
  IModelDoc2 src=null;bool opened=false;
  {int e=0,w=0;src=(IModelDoc2)sw.OpenDoc6(drawingPath,3,(int)(swOpenDocOptions_e.swOpenDocOptions_Silent|swOpenDocOptions_e.swOpenDocOptions_ReadOnly),"",ref e,ref w);if(src==null)throw new Exception("Cannot open "+drawingPath+" ("+e+")");opened=true;}
  try{var sdr=(IDrawingDoc)src;ISheet sh;
   if(sheetName!=null){sh=(ISheet)sdr.get_Sheet(sheetName);if(sh==null)throw new Exception("Sheet "+sheetName+" not found in "+Path.GetFileName(drawingPath));}else sh=(ISheet)sdr.GetCurrentSheet();
   string dir=Path.Combine(Root,"formats");Directory.CreateDirectory(dir);
   string outp=Path.Combine(dir,Path.GetFileNameWithoutExtension(drawingPath)+"_"+DateTime.Now.ToString("yyyyMMddHHmmss")+".slddrt");
   if(!sh.SaveFormat(outp)||!File.Exists(outp))throw new Exception("Could not save the sheet format of "+Path.GetFileName(drawingPath));
   return outp;
  }finally{if(opened){try{sw.CloseDoc(src.GetTitle());}catch{}if(sw.GetOpenDocumentByName(drawingPath)!=null)throw new Exception("The source drawing could not be closed after copying its format");}}
 }
 static bool TryDrawingSheets(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_sheets")return false;
  if(d.GetType()!=3)throw new Exception("drawing_sheets needs a managed drawing");var dr=(IDrawingDoc)d;string action=Str(a,"action");
  Func<object> list=()=>((object[])dr.GetSheetNames()??new object[0]).Select(n=>SheetInfo(dr,(ISheet)dr.get_Sheet(Convert.ToString(n)))).ToArray();
  if(action=="list"){result=new{active=((ISheet)dr.GetCurrentSheet()).GetName(),sheets=list()};return true;}
  if(action=="activate"){if(!dr.ActivateSheet(Str(a,"name")))throw new Exception("Sheet not found: "+Str(a,"name"));result=new{active=Str(a,"name")};return true;}
  if(action=="properties"){
   var cpm=d.Extension.get_CustomPropertyManager("");var set=new List<string>();
   foreach(var kv in (Dictionary<string,object>)a["values"]){int r=cpm.Add3(kv.Key,(int)swCustomInfoType_e.swCustomInfoText,Convert.ToString(kv.Value),(int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
    string v,res;bool wasRes;cpm.Get6(kv.Key,false,out v,out res,out wasRes,out wasRes);if(v!=Convert.ToString(kv.Value))throw new Exception("Could not set property "+kv.Key+" (status "+r+")");set.Add(kv.Key);}
   d.ForceRebuild3(false);result=new{properties_set=set.ToArray(),note="Title-block notes linked to these properties update on rebuild. Unsaved until sw_save."};return true;
  }
  if(action=="add"||action=="setup"){
   string name=Str(a,"name");var names=((object[])dr.GetSheetNames()??new object[0]).Select(Convert.ToString).ToList();
   if(action=="add"&&names.Contains(name))throw new Exception("A sheet named "+name+" already exists");
   if(action=="setup"&&!names.Contains(name))throw new Exception("Sheet not found: "+name);
   double w,h;
   if(a.ContainsKey("width_mm")){w=Num(a,"width_mm");h=Num(a,"height_mm");}
   else{string sz=a.ContainsKey("size")?Str(a,"size"):"A4";if(!PaperMm.ContainsKey(sz))throw new Exception("size: "+string.Join(", ",PaperMm.Keys));w=PaperMm[sz][0];h=PaperMm[sz][1];}
   if(a.ContainsKey("orientation")&&Str(a,"orientation")=="portrait"&&w>h){var t=w;w=h;h=t;}
   string fmt="";
   if(a.ContainsKey("format_path")){fmt=Str(a,"format_path");if(!Path.IsPathRooted(fmt)||!File.Exists(fmt)||!fmt.EndsWith(".slddrt",StringComparison.OrdinalIgnoreCase))throw new Exception("format_path must be an existing absolute .slddrt");}
   else if(a.ContainsKey("format_from_drawing"))fmt=CopyFormat(Str(a,"format_from_drawing"),a.ContainsKey("format_sheet")?Str(a,"format_sheet"):null);
   bool first=!a.ContainsKey("first_angle")||Flag(a,"first_angle");
   int paper=(int)swDwgPaperSizes_e.swDwgPapersUserDefined,tin=fmt==""?(int)swDwgTemplates_e.swDwgTemplateNone:(int)swDwgTemplates_e.swDwgTemplateCustom;
   bool ok=action=="add"?dr.NewSheet3(name,paper,tin,1,1,first,fmt,w/1000,h/1000,""):dr.SetupSheet5(name,paper,tin,1,1,first,fmt,w/1000,h/1000,"",true);
   if(!ok)throw new Exception((action=="add"?"NewSheet3":"SetupSheet5")+" failed");
   var sh=(ISheet)dr.get_Sheet(name);if(sh==null)throw new Exception("Sheet "+name+" not found after "+action);
   Func<bool> fmtOk=()=>fmt==""||string.Equals(Path.GetFullPath(sh.GetTemplateName()??""),Path.GetFullPath(fmt),StringComparison.OrdinalIgnoreCase);
   if(!fmtOk()){sh.SetTemplateName(fmt);sh.ReloadTemplate(true);}
   sh.SetScale(1,1,false,false);d.EditRebuild3();
   var pr=(double[])sh.GetProperties2();double ww=0,hh=0;sh.GetSize(ref ww,ref hh);
   string bad=!fmtOk()?"sheet format not applied":pr==null||pr[2]!=pr[3]?"sheet scale is not 1:1":Math.Abs(ww*1000-w)>0.5||Math.Abs(hh*1000-h)>0.5?"sheet size is "+Math.Round(ww*1000,1)+"x"+Math.Round(hh*1000,1)+" mm":null;
   if(bad!=null){bool removed=false;if(action=="add"){d.ClearSelection2(true);removed=d.Extension.SelectByID2(name,"SHEET",0,0,0,false,0,null,0)&&d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}
    if(!removed)recoveryPending.Add(d.GetPathName());
    throw new Exception("Sheet "+name+": "+bad+(removed?"; the new sheet was removed":"; saving is blocked, close without saving"));}
   result=new{sheet=SheetInfo(dr,sh),format_copied_to=a.ContainsKey("format_from_drawing")?fmt:null,note="Sheet scale 1:1 (views keep their own scale). Unsaved until sw_save."};return true;
  }
  if(action=="add_view"){
   if(a.ContainsKey("sheet")&&!dr.ActivateSheet(Str(a,"sheet")))throw new Exception("Sheet not found: "+Str(a,"sheet"));
   var sh=(ISheet)dr.GetCurrentSheet();var sp=(double[])sh.GetProperties2();
   string model=Str(a,"model_path");if(!Path.IsPathRooted(model)||!File.Exists(model))throw new Exception("model_path must be an existing absolute part/assembly");
   string orient=a.ContainsKey("view_orientation")?Str(a,"view_orientation"):"isometric";
   var namesEn=new Dictionary<string,string>{{"isometric","*Isometric"},{"front","*Front"},{"top","*Top"},{"right","*Right"},{"back","*Back"},{"bottom","*Bottom"},{"left","*Left"}};
   var namesEs=new Dictionary<string,string>{{"isometric","*Isom\u00e9trica"},{"front","*Frontal"},{"top","*Superior"},{"right","*Derecha"},{"back","*Posterior"},{"bottom","*Inferior"},{"left","*Izquierda"}};
   if(!namesEn.ContainsKey(orient))throw new Exception("orientation: "+string.Join(", ",namesEn.Keys));
   var pos=a.ContainsKey("position_mm")?Items(a["position_mm"]).Select(q=>Convert.ToDouble(q)/1000).ToArray():new[]{0.15,0.15};
   // v3.9 flat_pattern: the unfolded sheet metal part (Vista de chapa desplegada) with its bend lines (hide_bend_lines hides them)
   bool flatView=Flag(a,"flat_pattern");if(flatView&&!model.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase))throw new Exception("flat_pattern needs a sheet metal PART");
   var v=flatView?dr.CreateFlatPatternViewFromModelView3(model,"",pos[0],pos[1],0,Flag(a,"hide_bend_lines"),false) as IView
    :dr.CreateDrawViewFromModelView3(model,namesEn[orient],pos[0],pos[1],0)??dr.CreateDrawViewFromModelView3(model,namesEs[orient],pos[0],pos[1],0);
   if(v==null)throw new Exception(flatView?"Could not create the flat pattern view (is it a sheet metal part with a Flat-Pattern feature, saved?)":"Could not create the "+orient+" view of "+Path.GetFileName(model));
   if(flatView)orient="flat_pattern";
   if(a.ContainsKey("scale")){v.UseSheetScale=0;v.ScaleDecimal=Num(a,"scale");}
   if(a.ContainsKey("display")){string ds=Str(a,"display");v.SetDisplayMode4(false,ds=="shaded"?(int)swDisplayMode_e.swSHADED_EDGES:ds=="hidden_lines_removed"?(int)swDisplayMode_e.swHIDDEN:ds=="hidden_greyed"?(int)swDisplayMode_e.swHIDDEN_GREYED:(int)swDisplayMode_e.swWIREFRAME,false,true,false);}
   bool exploded=false;
   try{
   if(Flag(a,"exploded")){var md=v.ReferencedDocument as IModelDoc2;if(md==null||md.GetType()!=2)throw new Exception("exploded needs an assembly view");
    var evs=((object[])((IAssemblyDoc)md).GetExplodedViewNames2(v.ReferencedConfiguration)??new object[0]);if(evs.Length==0)throw new Exception("The assembly has no exploded view in configuration "+v.ReferencedConfiguration+" (create it with sw_explode and save the assembly)");
    v.ShowExploded(false);v.ShowExploded(true);d.EditRebuild3();exploded=v.IsExploded();if(!exploded)throw new Exception("The view did not switch to exploded");}
   }catch(Exception ex){string vn=v.GetName2();bool gone=false;try{d.ClearSelection2(true);gone=d.Extension.SelectByID2(vn,"DRAWINGVIEW",0,0,0,false,0,null,0)&&d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}catch{}
    if(sp!=null)sh.SetScale(sp[2],sp[3],false,false);d.EditRebuild3();
    throw new Exception(ex.Message+(gone?"; the new view "+vn+" was removed":"; the new view "+vn+" could NOT be removed"));}
   // inserting views can change the sheet scale: put it back so the frame / title block keep their size
   if(sp!=null)sh.SetScale(sp[2],sp[3],false,false);d.EditRebuild3();
   result=new{view=v.GetName2(),sheet=sh.GetName(),orientation=orient,scale=v.ScaleDecimal,exploded=exploded,note="Use sw_drawing_annotate / sw_bom / sw_balloons next. Unsaved until sw_save."};return true;
  }
  throw new Exception("action: list, add, setup, activate, properties or add_view");
 }
}
