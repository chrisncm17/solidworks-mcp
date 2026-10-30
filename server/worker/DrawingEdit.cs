using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.12 drawing_edit - clean up an existing drawing sheet (lessons from the 2-sheet valve drawing, 2026-10):
//  list              every dimension of the sheet (sheet sketch + views): value, view, text position on the sheet, colour
//  move_text         moves dimension texts found near a sheet point (optionally only one value) to a new point
//  delete            deletes dimensions near a sheet point (optionally only one value), e.g. bogus 90° angulars (1570.796)
//  move_view         moves a view by a delta or to a centre point
//  title_text        lists or replaces texts of the sheet format (title block), e.g. "HOJA 1 DE 1" -> "HOJA 1 DE 2"
//  title_fields      title / drawing no. / automatic sheet numbers INSIDE the sheet format (linked to properties), one .slddrt for all sheets
//  hide_construction puts construction lines/points of the sheet and view sketches on a hidden layer
//  black             makes every dimension (and optionally note) of the sheet black (B&W drawings)
//  color             same as black with color "#RRGGBB" (e.g. royal blue dimensions); texts: only those notes (e.g. red part names)
partial class Worker {
 class SheetDim{public IView View;public IDisplayDimension Dd;public double Value;public bool Ang;public double[] Pos;}
 static List<SheetDim> SheetDimensions(IDrawingDoc dr,string onlyView){
  var list=new List<SheetDim>();var sheetView=(IView)dr.GetFirstView();
  var views=new List<IView>{sheetView};views.AddRange(SheetViews(dr));
  foreach(var v in views){if(onlyView!=null&&v.Name!=onlyView)continue;
   for(var o=v.GetFirstDisplayDimension5();o!=null;o=((IDisplayDimension)o).GetNext5()){var dd=(IDisplayDimension)o;var dim=dd.GetDimension2(0) as IDimension;
    bool ang=dd.Type2==(int)swDimensionType_e.swAngularDimension;double sv=dim==null?double.NaN:dim.GetSystemValue2("");
    var p=(double[])((IAnnotation)dd.GetAnnotation()).GetPosition();
    list.Add(new SheetDim{View=v,Dd=dd,Ang=ang,Value=ang?sv*180/Math.PI:sv*1000,Pos=new[]{p[0]*1000,p[1]*1000}});}}
  return list;
 }
 static double[] MmPair(Dictionary<string,object> a,string k){var v=Items(a[k]).Select(Convert.ToDouble).ToArray();if(v.Length!=2)throw new Exception(k+": [x, y] in sheet mm");return v;}
 // value (mm or deg, ±tolerance) and/or near_mm + radius_mm pick the dimensions an action works on
 static List<SheetDim> PickDims(IDrawingDoc dr,Dictionary<string,object> a,bool needNear){
  if(needNear&&!a.ContainsKey("near_mm"))throw new Exception("near_mm [x, y] (sheet mm) is required; see action list");
  double tol=a.ContainsKey("tolerance")?Num(a,"tolerance"):0.015;double r=a.ContainsKey("radius_mm")?Num(a,"radius_mm"):10;
  var near=a.ContainsKey("near_mm")?MmPair(a,"near_mm"):null;
  return SheetDimensions(dr,a.ContainsKey("view")?Str(a,"view"):null).Where(x=>(!a.ContainsKey("value")||Math.Abs(x.Value-Num(a,"value"))<=tol)
   &&(near==null||Math.Sqrt(Math.Pow(x.Pos[0]-near[0],2)+Math.Pow(x.Pos[1]-near[1],2))<=r)).ToList();
 }
 static object DimRow(SheetDim x){return new{view=x.View.Name,value=Math.Round(x.Value,3),unit=x.Ang?"deg":"mm",name=x.Dd.GetDimension2(0)==null?null:((IDimension)x.Dd.GetDimension2(0)).FullName,
  text_mm=new[]{Math.Round(x.Pos[0],1),Math.Round(x.Pos[1],1)},color=((IAnnotation)x.Dd.GetAnnotation()).Color,value_shown=x.Dd.ShowDimensionValue};}

 static bool TryDrawingEdit(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_edit")return false;
  var dr=RequireDrawing(d);string sheet=Str(a,"sheet");
  if(!((string[])dr.GetSheetNames()).Contains(sheet))throw new Exception("Sheet not found: "+sheet+" (sheets: "+string.Join(", ",(string[])dr.GetSheetNames())+")");
  dr.ActivateSheet(sheet);string action=Str(a,"action");
  if(action=="list"){var rows=PickDims(dr,a,false);
   result=new{sheet=sheet,count=rows.Count,dimensions=rows.Select(DimRow).ToArray(),views=SheetViews(dr).Select(v=>v.Name).ToArray(),
    note="text_mm is the dimension text position on the sheet; use it as near_mm for move_text/delete. A 90 deg angular between edge-on circles is usually a bogus pick."};return true;}
  if(action=="move_text"||action=="delete"){var hits=PickDims(dr,a,true);var done=new List<object>();
   double[] to=action=="move_text"?MmPair(a,"to_mm"):null;
   if(action=="move_text"&&hits.Count>1&&!a.ContainsKey("value"))throw new Exception(hits.Count+" dimensions near that point; give value or a smaller radius_mm (found: "+string.Join(", ",hits.Select(h=>Math.Round(h.Value,3)))+")");
   foreach(var x in hits){var an=(IAnnotation)x.Dd.GetAnnotation();
    if(to!=null){if(an.SetPosition2(to[0]/1000,to[1]/1000,0))done.Add(DimRow(x));}
    else{d.ClearSelection2(true);if(an.Select3(false,null)&&d.Extension.DeleteSelection2(0))done.Add(new{view=x.View.Name,value=Math.Round(x.Value,3),text_mm=new[]{Math.Round(x.Pos[0],1),Math.Round(x.Pos[1],1)}});}}
   d.ClearSelection2(true);d.EditRebuild3();
   result=new{sheet=sheet,action=action,matched=hits.Count,changed=done.Count,dimensions=done.ToArray(),note="Unsaved until sw_save. Check with sw_preview."};return true;}
  if(action=="move_view"){var view=FindSheetView(dr,a);var p=(double[])view.Position;double[] np;
   if(a.ContainsKey("to_mm")){var t=MmPair(a,"to_mm");var o=(double[])view.GetOutline();np=new[]{p[0]+t[0]/1000-(o[0]+o[2])/2,p[1]+t[1]/1000-(o[1]+o[3])/2};}
   else if(a.ContainsKey("by_mm")){var b=MmPair(a,"by_mm");np=new[]{p[0]+b[0]/1000,p[1]+b[1]/1000};}
   else throw new Exception("move_view needs by_mm [dx, dy] or to_mm [x, y] (new outline centre)");
   view.Position=np;d.EditRebuild3();result=new{sheet=sheet,view=ViewInfo(view),note="Unsaved until sw_save."};return true;}
  if(action=="title_text"){var found=new List<string>();int n=0;string find=a.ContainsKey("find")?Str(a,"find"):null;
   dr.EditTemplate();
   try{var notes=(object[])((IView)dr.GetFirstView()).GetNotes()??new object[0];
    foreach(INote nt in notes){string t=nt.GetText();if(find!=null&&a.ContainsKey("replace")&&t.Contains(find)){nt.SetText(t.Replace(find,Str(a,"replace")));n++;found.Add(nt.GetText());}else found.Add(t);}}
   finally{dr.EditSheet();}
   d.EditRebuild3();
   result=new{sheet=sheet,replaced=n,format_notes=find==null?found.ToArray():found.Where(t=>t.Contains(find)||(n>0&&Str(a,"replace")!=""&&t.Contains(Str(a,"replace")))).ToArray(),
    note=a.ContainsKey("replace")?"Unsaved until sw_save. Format notes can be $PRP links; only literal text is replaced.":"List only; give find and replace to change text."};return true;}
  // v3.13 title_fields: title-block fields go INSIDE the sheet format (never as loose sheet notes, the classmates' complaint
  // "no hizo formato de hoja"): drawing properties, "HOJA x DE y" -> automatic sheet number/total, new format notes linked to
  // properties ($PRP:"Titulo") styled like an existing format text, loose sheet notes with the given texts removed on every sheet,
  // and with save_format_to (.slddrt next to the drawing) the edited format is saved and reloaded on every sheet (one format).
  if(action=="title_fields"){var log=new List<string>();var names=(string[])dr.GetSheetNames();
   Func<INote[]> fmtNotes=()=>((object[])((IView)dr.GetFirstView()).GetNotes()??new object[0]).Cast<INote>().Where(n=>((IAnnotation)n.GetAnnotation()).OwnerType==(int)swAnnotationOwner_e.swAnnotationOwner_DrawingTemplate).ToArray();
   string fmtOut=a.ContainsKey("save_format_to")?Str(a,"save_format_to"):null;
   if(fmtOut!=null&&(!System.IO.Path.IsPathRooted(fmtOut)||!fmtOut.EndsWith(".slddrt",StringComparison.OrdinalIgnoreCase)||!string.Equals(System.IO.Path.GetDirectoryName(fmtOut),System.IO.Path.GetDirectoryName(d.GetPathName()),StringComparison.OrdinalIgnoreCase)))
    throw new Exception("save_format_to must be an absolute .slddrt in the drawing's own folder");
   if(a.ContainsKey("properties")){var cpm=d.Extension.get_CustomPropertyManager("");
    foreach(var kv in (Dictionary<string,object>)a["properties"]){cpm.Add3(kv.Key,(int)swCustomInfoType_e.swCustomInfoText,Convert.ToString(kv.Value),(int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);log.Add("property "+kv.Key+" = "+kv.Value);}}
   if(a.ContainsKey("remove_loose"))foreach(string s in names){dr.ActivateSheet(s);
    foreach(string t in Items(a["remove_loose"]).Select(Convert.ToString))foreach(var n in ((object[])((IView)dr.GetFirstView()).GetNotes()??new object[0]).Cast<INote>())
     if(((IAnnotation)n.GetAnnotation()).OwnerType!=(int)swAnnotationOwner_e.swAnnotationOwner_DrawingTemplate&&n.GetText().Trim()==t.Trim()){d.ClearSelection2(true);((IAnnotation)n.GetAnnotation()).Select3(false,null);
      if(d.Extension.DeleteSelection2(0))log.Add(s+": loose note '"+t+"' removed");}
    d.ClearSelection2(true);}
   dr.ActivateSheet(sheet);dr.EditTemplate();
   try{var notes=fmtNotes();
    if(!a.ContainsKey("auto_sheet_numbers")||Flag(a,"auto_sheet_numbers"))foreach(var n in notes){string raw=n.PropertyLinkedText;var m=System.Text.RegularExpressions.Regex.Match(raw,@"^(.*?)HOJA\s+\d+\s+DE\s+\d+",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
     if(m.Success){n.SetText(m.Groups[1].Value+"HOJA $PRP:\"SW-Current Sheet\" DE $PRP:\"SW-Total Sheets\"");log.Add("sheet numbers automatic: "+n.PropertyLinkedText);}}
    if(a.ContainsKey("fields"))foreach(var f in Items(a["fields"]).Cast<Dictionary<string,object>>()){string text=Str(f,"text");var p=MmPair(f,"position_mm");
     if(notes.Any(n=>n.PropertyLinkedText.Replace("<FONT style=B>","")==text)){log.Add("already in format: "+text);continue;}
     d.ClearSelection2(true);var nn=(INote)d.InsertNote(text);if(nn==null)throw new Exception("InsertNote failed for "+text);var an=(IAnnotation)nn.GetAnnotation();
     if(an.OwnerType!=(int)swAnnotationOwner_e.swAnnotationOwner_DrawingTemplate)throw new Exception("The note did not land in the sheet format");
     an.SetPosition2(p[0]/1000,p[1]/1000,0);
     if(f.ContainsKey("style_from")){var src=notes.FirstOrDefault(n=>n.GetText().Contains(Str(f,"style_from")));if(src!=null)an.SetTextFormat(0,false,((IAnnotation)src.GetAnnotation()).GetTextFormat(0));}
     log.Add("format field "+text+" = "+nn.GetText());}}
   finally{d.ClearSelection2(true);dr.EditSheet();}
   if(fmtOut!=null){if(!((ISheet)dr.GetCurrentSheet()).SaveFormat(fmtOut))throw new Exception("SaveFormat failed: "+fmtOut);
    foreach(string s in names){dr.ActivateSheet(s);var sh=(ISheet)dr.GetCurrentSheet();sh.SetTemplateName(fmtOut);sh.ReloadTemplate(false);log.Add(s+" uses "+System.IO.Path.GetFileName(sh.GetTemplateName()));}
    dr.ActivateSheet(sheet);}
   d.ForceRebuild3(false);
   result=new{sheet=sheet,changes=log.ToArray(),note="Title-block fields live in the sheet format, linked to drawing properties. Unsaved until sw_save. Check with sw_preview."};return true;}
  if(action=="hide_construction"){string layer=a.ContainsKey("layer")?Str(a,"layer"):"CONSTRUCCION_OCULTA";var lm=(ILayerMgr)d.GetLayerManager();
   if(lm.GetLayer(layer)==null)lm.AddLayer(layer,"",0,0,0);((ILayer)lm.GetLayer(layer)).Visible=false;int segs=0,pts=0;
   var views=new List<IView>{(IView)dr.GetFirstView()};views.AddRange(SheetViews(dr));
   foreach(var v in views){var sk=v.GetSketch() as ISketch;if(sk==null)continue;
    foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0])if(s.ConstructionGeometry){s.Layer=layer;segs++;}
    foreach(ISketchPoint q in (object[])sk.GetSketchPoints2()??new object[0]){try{q.Layer=layer;pts++;}catch{}}}
   d.GraphicsRedraw2();result=new{sheet=sheet,layer=layer,construction_segments=segs,points=pts,note="Dimensions on hidden construction lines stay visible. Unsaved until sw_save."};return true;}
  if(action=="black"||action=="color"){bool notes=a.ContainsKey("notes")&&Convert.ToBoolean(a["notes"]);int dims=0,nn=0;
   int col=0,rgb;string hex="#000000";
   if(action=="color"){hex=a.ContainsKey("color")?Str(a,"color").Trim():"";var hx=hex.TrimStart('#');
    if(hx.Length!=6||!int.TryParse(hx,System.Globalization.NumberStyles.HexNumber,null,out rgb))throw new Exception("color needs color: \"#RRGGBB\" (e.g. \"#4169E1\" royal blue)");
    col=((rgb&0xFF)<<16)|(rgb&0xFF00)|((rgb>>16)&0xFF);}// SolidWorks wants COLORREF (0x00BBGGRR)
   // texts: only the notes whose whole text is one of these (e.g. part names), dimensions untouched
   var texts=a.ContainsKey("texts")?new HashSet<string>(Items(a["texts"]).Select(x=>Convert.ToString(x).Trim()),StringComparer.OrdinalIgnoreCase):null;var hit=new List<string>();
   var views=new List<IView>{(IView)dr.GetFirstView()};views.AddRange(SheetViews(dr));
   foreach(var v in views)foreach(var o in (object[])v.GetAnnotations()??new object[0]){var an=o as IAnnotation;if(an==null)continue;int t=an.GetType();
    if(t==(int)swAnnotationType_e.swDisplayDimension){if(texts==null){an.Color=col;dims++;}}
    else if((notes||texts!=null)&&t==(int)swAnnotationType_e.swNote){var nt=(INote)an.GetSpecificAnnotation();if(nt.IsBomBalloon())continue;
     if(texts!=null&&!texts.Contains((nt.GetText()??"").Trim()))continue;an.Color=col;nn++;hit.Add(nt.GetText());}}
   if(texts!=null&&nn==0)throw new Exception("No note on sheet "+sheet+" has exactly one of these texts: "+string.Join(", ",texts));
   d.GraphicsRedraw2();result=new{sheet=sheet,color=hex,dimensions=dims,notes=nn,notes_colored=texts!=null?hit.ToArray():null,note="An overridden value still shows magenta in SolidWorks; hide the value and use a prefix text instead. Unsaved until sw_save."};return true;}
  throw new Exception("action: list, move_text, delete, move_view, title_text, title_fields, hide_construction, black or color");
 }
}
