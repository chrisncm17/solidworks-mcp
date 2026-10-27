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
//  hide_construction puts construction lines/points of the sheet and view sketches on a hidden layer
//  black             makes every dimension (and optionally note) of the sheet black (B&W drawings)
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
  if(action=="hide_construction"){string layer=a.ContainsKey("layer")?Str(a,"layer"):"CONSTRUCCION_OCULTA";var lm=(ILayerMgr)d.GetLayerManager();
   if(lm.GetLayer(layer)==null)lm.AddLayer(layer,"",0,0,0);((ILayer)lm.GetLayer(layer)).Visible=false;int segs=0,pts=0;
   var views=new List<IView>{(IView)dr.GetFirstView()};views.AddRange(SheetViews(dr));
   foreach(var v in views){var sk=v.GetSketch() as ISketch;if(sk==null)continue;
    foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0])if(s.ConstructionGeometry){s.Layer=layer;segs++;}
    foreach(ISketchPoint q in (object[])sk.GetSketchPoints2()??new object[0]){try{q.Layer=layer;pts++;}catch{}}}
   d.GraphicsRedraw2();result=new{sheet=sheet,layer=layer,construction_segments=segs,points=pts,note="Dimensions on hidden construction lines stay visible. Unsaved until sw_save."};return true;}
  if(action=="black"){bool notes=a.ContainsKey("notes")&&Convert.ToBoolean(a["notes"]);int dims=0,nn=0;
   var views=new List<IView>{(IView)dr.GetFirstView()};views.AddRange(SheetViews(dr));
   foreach(var v in views)foreach(var o in (object[])v.GetAnnotations()??new object[0]){var an=o as IAnnotation;if(an==null)continue;int t=an.GetType();
    if(t==(int)swAnnotationType_e.swDisplayDimension){an.Color=0;dims++;}
    else if(notes&&t==(int)swAnnotationType_e.swNote&&!((INote)an.GetSpecificAnnotation()).IsBomBalloon()){an.Color=0;nn++;}}
   d.GraphicsRedraw2();result=new{sheet=sheet,dimensions=dims,notes=nn,note="An overridden value still shows magenta in SolidWorks; hide the value and use a prefix text instead. Unsaved until sw_save."};return true;}
  throw new Exception("action: list, move_text, delete, move_view, title_text, hide_construction or black");
 }
}
