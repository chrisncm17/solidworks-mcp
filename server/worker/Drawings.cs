using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// Drawing tools: list sheets/views, adjust one view (scale, shading, centre), force sheet scale 1:1.
partial class Worker {
 static IDrawingDoc RequireDrawing(IModelDoc2 d){if(d.GetType()!=(int)swDocumentTypes_e.swDocDRAWING)throw new Exception("This tool requires a drawing (.SLDDRW)");return (IDrawingDoc)d;}

 static object ViewInfo(IView v){
  var o=(double[])v.GetOutline();int dims=0,balloons=0,notes=0;
  for(var dd=(IDisplayDimension)v.GetFirstDisplayDimension5();dd!=null;dd=(IDisplayDimension)dd.GetNext5())dims++;
  for(var n=(INote)v.GetFirstNote();n!=null;n=(INote)n.GetNext()){if(n.IsBomBalloon())balloons++;else notes++;}
  int mode=v.GetDisplayMode2();
  return new{name=v.Name,model=v.GetReferencedModelName(),orientation=v.GetOrientationName(),scale=v.ScaleDecimal,uses_sheet_scale=v.UseSheetScale!=0,
   display_mode=mode,display=mode==3?"shaded":mode==2?"hidden_lines_removed":mode==1?"hidden_greyed":mode==0?"wireframe":mode.ToString(),
   exploded=v.IsExploded(),outline_mm=o==null?null:o.Select(x=>Math.Round(x*1000,1)).ToArray(),dimensions=dims,balloons=balloons,notes=notes};
 }

 static List<IView> SheetViews(IDrawingDoc dr){var list=new List<IView>();var sv=(IView)dr.GetFirstView();for(var v=sv==null?null:(IView)sv.GetNextView();v!=null;v=(IView)v.GetNextView())list.Add(v);return list;}

 static object DrawingSummary(IModelDoc2 d){
  var dr=(IDrawingDoc)d;string active=((ISheet)dr.GetCurrentSheet()).GetName();var sheets=new List<object>();
  foreach(string sn in (string[])dr.GetSheetNames()??new string[0]){dr.ActivateSheet(sn);var sh=(ISheet)dr.GetCurrentSheet();var p=(double[])sh.GetProperties2();
   sheets.Add(new{name=sn,width_mm=Math.Round(p[5]*1000,1),height_mm=Math.Round(p[6]*1000,1),sheet_scale=p[2]+":"+p[3],views=SheetViews(dr).Select(ViewInfo).ToArray()});}
  dr.ActivateSheet(active);
  return new{title=d.GetTitle(),unsaved_changes=d.GetSaveFlag(),active_sheet=active,sheets=sheets};
 }

 static bool TryDrawings(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op!="drawing_views")return false;
  var dr=RequireDrawing(d);string action=Str(a,"action");
  if(action=="list"){result=DrawingSummary(d);return true;}
  if(action=="fix_sheet_scale"){
   // Inserting the first view changes the sheet scale; sheet sketches (frame, title block) then shrink. Views keep their own scale.
   string active=((ISheet)dr.GetCurrentSheet()).GetName();var changed=new List<string>();
   foreach(string sn in (string[])dr.GetSheetNames()??new string[0]){dr.ActivateSheet(sn);var sh=(ISheet)dr.GetCurrentSheet();var p=(double[])sh.GetProperties2();
    if(p[2]!=1||p[3]!=1){foreach(var v in SheetViews(dr))if(v.UseSheetScale!=0){double s=v.ScaleDecimal;v.UseSheetScale=0;v.ScaleDecimal=s;}sh.SetScale(1,1,false,false);changed.Add(sn+" ("+p[2]+":"+p[3]+" -> 1:1)");}}
   dr.ActivateSheet(active);d.EditRebuild3();
   result=new{changed=changed.ToArray(),note="Unsaved; call sw_save after reviewing.",summary=DrawingSummary(d)};return true;
  }
  if(action=="section"){result=SectionView(a,d,dr);return true;}
  if(action=="detail"){result=DetailView(a,d,dr);return true;}
  // action == set: one view on one sheet
  string sheet=Str(a,"sheet"),viewName=Str(a,"view");
  if(!((string[])dr.GetSheetNames()).Contains(sheet))throw new Exception("Sheet not found: "+sheet);
  dr.ActivateSheet(sheet);var view=SheetViews(dr).FirstOrDefault(x=>x.Name==viewName);if(view==null)throw new Exception("View not found on "+sheet+": "+viewName);
  if(a.ContainsKey("scale")){double s=Num(a,"scale");view.UseSheetScale=0;view.ScaleDecimal=s;}
  if(a.ContainsKey("display")){string disp=Str(a,"display");
   // In drawings "shaded with edges" is mode 3 (swSHADED) with Edges=true; mode 7 is accepted but ignored.
   int mode=disp=="shaded"?(int)swDisplayMode_e.swSHADED:disp=="hidden_lines_removed"?(int)swDisplayMode_e.swHIDDEN:disp=="hidden_greyed"?(int)swDisplayMode_e.swHIDDEN_GREYED:(int)swDisplayMode_e.swWIREFRAME;
   view.SetDisplayMode4(false,mode,false,true,false);}
  d.EditRebuild3();
  if(a.ContainsKey("center_mm")){var c=((System.Collections.IEnumerable)a["center_mm"]).Cast<object>().Select(Convert.ToDouble).ToArray();var o=(double[])view.GetOutline();var pos=(double[])view.Position;
   view.Position=new[]{pos[0]+c[0]/1000-(o[0]+o[2])/2,pos[1]+c[1]/1000-(o[1]+o[3])/2};d.EditRebuild3();}
  var info=ViewInfo(view);
  if(a.ContainsKey("display")&&Str(a,"display")=="shaded"&&view.GetDisplayMode2()!=3)throw new Exception("Shading was not applied (display mode "+view.GetDisplayMode2()+")");
  result=new{sheet=sheet,view=info,note="Dimensions and notes attached to the view move and scale with it; unsaved until sw_save."};return true;
 }

 // v3.9 section view: a straight cut line across the parent view, horizontal or vertical ON THE SHEET, through a point given
 // in MODEL coordinates (e.g. the centre of a hole: through_mm [x,y,z]); default through the middle of the view. The section
 // is placed at position_mm or beside the parent (right of a vertical cut, below a horizontal one).
 static object SectionView(Dictionary<string,object> a,IModelDoc2 d,IDrawingDoc dr){
  string sheet=Str(a,"sheet"),viewName=Str(a,"view");
  if(!((string[])dr.GetSheetNames()).Contains(sheet))throw new Exception("Sheet not found: "+sheet);
  dr.ActivateSheet(sheet);var view=SheetViews(dr).FirstOrDefault(x=>x.Name==viewName);if(view==null)throw new Exception("View not found on "+sheet+": "+viewName);
  string dir=a.ContainsKey("direction")?Str(a,"direction"):"horizontal";if(dir!="horizontal"&&dir!="vertical")throw new Exception("direction: horizontal or vertical");
  var o=(double[])view.GetOutline();var mu=(IMathUtility)sw.GetMathUtility();
  double px=(o[0]+o[2])/2,py=(o[1]+o[3])/2;
  if(a.ContainsKey("through_mm")){var m=Items(a["through_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();if(m.Length!=3)throw new Exception("through_mm: [x, y, z] in model mm");
   var sp=(double[])((MathPoint)((MathPoint)mu.CreatePoint(m)).MultiplyTransform(view.ModelToViewTransform)).ArrayData;px=sp[0];py=sp[1];
   if(dir=="horizontal"&&(py<o[1]||py>o[3])||dir=="vertical"&&(px<o[0]||px>o[2]))throw new Exception("through_mm falls outside the view on the sheet ("+Math.Round(px*1000,1)+", "+Math.Round(py*1000,1)+" mm; view "+string.Join(", ",o.Select(x=>Math.Round(x*1000,1)))+")");}
  double ext=0.004;
  var p1=dir=="horizontal"?new[]{o[0]-ext,py,0}:new[]{px,o[1]-ext,0};var p2=dir=="horizontal"?new[]{o[2]+ext,py,0}:new[]{px,o[3]+ext,0};
  string label=a.ContainsKey("label")?Str(a,"label"):null;
  if(label==null){var used=new HashSet<string>(SheetViews(dr).Select(v=>v.Name));label="A";for(char ch='A';ch<='Z';ch++){if(!used.Any(n=>n.EndsWith(" "+ch)||n.EndsWith("-"+ch)||n==ch.ToString())){label=ch.ToString();break;}}}
  double gap=0.03,w=o[2]-o[0],h=o[3]-o[1];
  var pos=a.ContainsKey("position_mm")?Items(a["position_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray():dir=="horizontal"?new[]{px,o[1]-gap-h/2}:new[]{o[2]+gap+w/2,py};
  var before=new HashSet<string>(SheetViews(dr).Select(v=>v.Name));
  // the cut line is a sketch line of the ACTIVE parent view; its coordinates are sheet coordinates mapped into the view sketch
  if(!dr.ActivateView(view.Name))throw new Exception("Cannot activate view "+view.Name);
  var sk=view.GetSketch() as ISketch;MathTransform toSk=null;try{toSk=sk==null?null:sk.ModelToSketchTransform;}catch{}
  Func<double[],double[]> map=q=>toSk==null?q:(double[])((MathPoint)((MathPoint)mu.CreatePoint(q)).MultiplyTransform(toSk)).ArrayData;
  bool addRel=d.SketchManager.AddToDB;d.SketchManager.AddToDB=true;ISketchSegment seg;
  try{var q1=map(p1);var q2=map(p2);seg=(ISketchSegment)d.SketchManager.CreateLine(q1[0],q1[1],0,q2[0],q2[1],0);}finally{d.SketchManager.AddToDB=addRel;}
  if(seg==null)throw new Exception("Cannot draw the cut line in "+view.Name);
  d.ClearSelection2(true);if(!seg.Select4(false,null))throw new Exception("Cannot select the cut line");
  int opt=Flag(a,"flip")?(int)swCreateSectionViewAtOptions_e.swCreateSectionView_ChangeDirection:0;
  IView sv=null;try{sv=dr.CreateSectionViewAt5(pos[0],pos[1],0,label,opt,null,0) as IView;}catch{}
  d.ClearSelection2(true);
  if(sv==null){try{seg.Select4(false,null);d.Extension.DeleteSelection2(0);}catch{}d.ClearSelection2(true);throw new Exception("SolidWorks did not create the section view (cut line removed). Try the other direction, another through_mm or flip.");}
  d.EditRebuild3();
  // the section stays aligned with its parent: without position_mm slide it along that alignment to the nearest place
  // that touches no other view and stays inside the sheet (10 mm margin)
  string placed="as requested";
  if(!a.ContainsKey("position_mm")){
   var shp=(double[])((ISheet)dr.GetCurrentSheet()).GetProperties2();double W=shp[5],H=shp[6],m=0.005;
   var others=SheetViews(dr).Where(v=>v.Name!=sv.Name).Select(v=>(double[])v.GetOutline()).Where(x=>x!=null).ToList();
   var so=(double[])sv.GetOutline();var p0=(double[])sv.Position;
   Func<double,double,bool> free=(dx,dy)=>{double x0=so[0]+dx,y0=so[1]+dy,x1=so[2]+dx,y1=so[3]+dy;
    if(x0<0.01||y0<0.01||x1>W-0.01||y1>H-0.01)return false;
    return !others.Any(b=>x0<b[2]+m&&x1>b[0]-m&&y0<b[3]+m&&y1>b[1]-m);};
   placed="no free place found; left where SolidWorks put it";
   for(int k=0;k<=80;k++){bool hit=false;foreach(int sg in new[]{1,-1}){double s=sg*k*0.005;double dx=dir=="vertical"?s:0,dy=dir=="horizontal"?s:0;
     if(free(dx,dy)){if(k>0){sv.Position=new[]{p0[0]+dx,p0[1]+dy};d.EditRebuild3();}placed=k==0?"beside the parent":"moved "+Math.Round(k*5.0)+" mm to a free place";hit=true;break;}if(k==0)break;}
    if(hit)break;}}
  var made=SheetViews(dr).Where(v=>!before.Contains(v.Name)).ToList();
  var info=ViewInfo(sv);
  return new{sheet=sheet,parent=view.Name,label=label,direction=dir,cut_on_sheet_mm=new[]{Math.Round(px*1000,2),Math.Round(py*1000,2)},section=info,placement=placed,new_views=made.Select(v=>v.Name).ToArray(),
   note="Section view with hatching; unsaved until sw_save. Check it with sw_preview or the PDF export."};
 }
}
