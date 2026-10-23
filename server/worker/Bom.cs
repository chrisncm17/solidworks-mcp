using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.4 drawing tables:
//  bom       — action insert: BOM (lista de materiales) on an assembly view (InsertBomTable4) with optional extra columns linked to
//              properties (e.g. SW-Material, SW-Mass or the part's own custom properties); action read: every BOM of the drawing
//              with its cells and the files behind each row.
//  balloons  — automatic balloons (AutoBalloon5) with item numbers on assembly views; reports which BOM items got a balloon.
partial class Worker {
 static List<IBomTableAnnotation> BomTables(IDrawingDoc dr){
  // every sheet (GetViews: one array per sheet, the sheet itself first), each BOM once (deduplicated by its feature name)
  var r=new List<IBomTableAnnotation>();var seen=new HashSet<string>();
  foreach(var sheet in (object[])dr.GetViews()??new object[0])foreach(var vo in (object[])sheet??new object[0]){var v=vo as IView;if(v==null)continue;
   foreach(var o in (object[])v.GetTableAnnotations()??new object[0]){var t=o as ITableAnnotation;if(t==null||t.Type!=(int)swTableAnnotationType_e.swTableAnnotation_BillOfMaterials)continue;
    var b=(IBomTableAnnotation)t;var bf=b.BomFeature;string key=bf==null?Guid.NewGuid().ToString():((IFeature)bf.GetFeature()).Name;if(seen.Add(key))r.Add(b);}}
  return r;
 }
 static string Plain(string x){return x==null?null:System.Text.RegularExpressions.Regex.Replace(x,"<[^>]+>","").Trim();}
 static object BomInfo(IBomTableAnnotation b){
  var t=(ITableAnnotation)b;var rows=new List<object>();var header=new List<string>();
  for(int cI=0;cI<t.ColumnCount;cI++)header.Add(Plain(t.get_DisplayedText(0,cI)));
  for(int rI=1;rI<t.RowCount;rI++){string item="",part="";var paths=(object[])b.GetModelPathNames(rI,out item,out part)??new object[0];
   rows.Add(new{row=rI,cells=Enumerable.Range(0,t.ColumnCount).Select(cI=>Plain(t.get_DisplayedText(rI,cI))).ToArray(),item_number=item,part_number=part,files=paths.Select(p=>Path.GetFileName(Convert.ToString(p))).Distinct().ToArray()});}
  var feat=b.BomFeature;
  return new{name=feat==null?null:((IFeature)feat.GetFeature()).Name,model=feat==null?null:Path.GetFileName(feat.GetReferencedModelName()),configuration=feat==null?null:feat.Configuration,columns=header.ToArray(),rows=rows.ToArray(),custom_properties=Enumerable.Range(0,t.ColumnCount).Select(cI=>b.GetColumnCustomProperty(cI)).ToArray()};
 }
 static IView AssemblyView(IDrawingDoc dr,Dictionary<string,object>a){
  var views=SheetViews(dr);IView v;
  if(a.ContainsKey("view")){v=views.FirstOrDefault(x=>x.GetName2()==Str(a,"view"));if(v==null)throw new Exception("View not found: "+Str(a,"view")+" (have: "+string.Join(", ",views.Select(x=>x.GetName2()))+")");}
  else v=views.FirstOrDefault(x=>{var m=x.ReferencedDocument as IModelDoc2;return m!=null&&m.GetType()==2;});
  if(v==null)throw new Exception("No view of an assembly on the active sheet");
  var md=v.ReferencedDocument as IModelDoc2;if(md==null||md.GetType()!=2)throw new Exception("View "+v.GetName2()+" does not show an assembly");
  return v;
 }
 static string DefaultBomTemplate(){
  string exe=sw.GetExecutablePath();string root=exe.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)?Path.GetDirectoryName(exe):exe;
  foreach(var lang in new[]{"spanish","english"}){var p=Path.Combine(root,"lang",lang,"bom-standard.sldbomtbt");if(File.Exists(p))return p;}
  throw new Exception("No default BOM template found; pass template (absolute .sldbomtbt)");
 }
 static bool TryBom(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="bom"&&op!="balloons")return false;
  if(d.GetType()!=3)throw new Exception(op+" needs a managed drawing (.SLDDRW)");var dr=(IDrawingDoc)d;
  if(op=="bom"){
   string action=Str(a,"action");
   if(action=="read"){result=new{boms=BomTables(dr).Select(BomInfo).ToArray()};return true;}
   var v=AssemblyView(dr,a);
   string type=a.ContainsKey("type")?Str(a,"type"):"top_level";
   int bt=type=="parts_only"?(int)swBomType_e.swBomType_PartsOnly:type=="indented"?(int)swBomType_e.swBomType_Indented:(int)swBomType_e.swBomType_TopLevelOnly;
   string tpl=a.ContainsKey("template")?Str(a,"template"):DefaultBomTemplate();
   if(!Path.IsPathRooted(tpl)||!File.Exists(tpl)||!tpl.EndsWith(".sldbomtbt",StringComparison.OrdinalIgnoreCase))throw new Exception("template must be an existing absolute .sldbomtbt");
   int before=BomTables(dr).Count;
   // default: inside the sheet, top-left corner (many title-block formats have no BOM anchor and SolidWorks then puts it off the sheet)
   bool useAnchor=Flag(a,"use_format_anchor");double x=0,y=0;int anchorType=(int)swBOMConfigurationAnchorType_e.swBOMConfigurationAnchor_TopLeft;
   if(a.ContainsKey("position_mm")){var p=Items(a["position_mm"]).Select(Convert.ToDouble).ToArray();x=p[0]/1000;y=p[1]/1000;}
   else if(!useAnchor){var sh=(ISheet)dr.GetCurrentSheet();double sw0=0,sh0=0;sh.GetSize(ref sw0,ref sh0);x=0.02;y=sh0-0.02;}
   dr.ActivateView(v.GetName2());
   var bom=v.InsertBomTable4(useAnchor,x,y,useAnchor?(int)swBOMConfigurationAnchorType_e.swBOMConfigurationAnchor_TopRight:anchorType,bt,v.ReferencedConfiguration,tpl,false,(int)swNumberingType_e.swNumberingType_Detailed,false);
   if(bom==null)throw new Exception("BOM insertion failed");
   var added=new List<string>();var statics=new List<string>();var unresolved=new List<string>();
   var asmDoc=(IModelDoc2)v.ReferencedDocument;string vcfg=v.ReferencedConfiguration;
   try{
   if(a.ContainsKey("columns"))foreach(Dictionary<string,object> col in Items(a["columns"])){
    var t=(ITableAnnotation)bom;int n=t.ColumnCount;
    if(!t.InsertColumn2((int)swTableItemInsertPosition_e.swTableItemInsertPosition_Last,n-1,Str(col,"title"),(int)swInsertTableColumnWidthStyle_e.swInsertColumn_DefaultWidth))throw new Exception("Could not add column "+Str(col,"title"));
    int ci=t.ColumnCount-1;string prop=Str(col,"property");
    if(prop.Equals("SW-Material",StringComparison.OrdinalIgnoreCase)||prop.Equals("SW-Mass",StringComparison.OrdinalIgnoreCase)){
     // SolidWorks 2026 shows these system properties as "$PRP:<value>" in a linked BOM column: write the real values instead
     bool mat=prop.Equals("SW-Material",StringComparison.OrdinalIgnoreCase);
     // values of the component INSTANCE in this row (its own configuration), mass per unit
     for(int r=1;r<t.RowCount;r++){var comps=((object[])bom.GetComponents2(r,vcfg)??new object[0]).Cast<IComponent2>().ToList();string val="";var cp=comps.FirstOrDefault();
      if(cp!=null){var md=cp.GetModelDoc2() as IModelDoc2;string ccfg=cp.ReferencedConfiguration;
       if(mat){if(md!=null&&md.GetType()==1){string db;string m=((IPartDoc)md).GetMaterialPropertyName2(ccfg,out db);val=string.IsNullOrEmpty(m)?"(sin material)":m;}else if(md!=null)val="—";}
       else if(md!=null&&((IConfiguration)md.ConfigurationManager.ActiveConfiguration).Name==ccfg){var mp=(IMassProperty2)md.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();double g=mp.Mass*1000;val=(g<0.1?g.ToString("0.####",System.Globalization.CultureInfo.InvariantCulture):g.ToString("0.00",System.Globalization.CultureInfo.InvariantCulture))+" g";}}
      if(val==""){val="?";unresolved.Add("fila "+r);}
      t.set_Text(r,ci,val);}
     t.set_Text(0,ci,Str(col,"title"));statics.Add(Str(col,"title"));added.Add(Str(col,"title")+" = "+prop+" (valores fijos)");continue;}
    int st=t.SetColumnType3(ci,(int)swTableColumnTypes_e.swBomTableColumnType_CustomProperty,false,prop);
    if(st!=(int)swColumnTypeStatus_e.swColumnTypeStatus_Success&&!bom.SetColumnCustomProperty(ci,prop))throw new Exception("Could not link column "+Str(col,"title")+" to property "+prop+" (status "+st+")");
    t.set_Text(0,ci,Str(col,"title"));
    added.Add(Str(col,"title")+" = "+prop);}
   }catch(Exception ex){
    // never leave a half-configured BOM: delete the table this call inserted
    bool gone=false;try{d.ClearSelection2(true);var ann=((ITableAnnotation)bom).GetAnnotation() as IAnnotation;gone=ann!=null&&ann.Select3(false,null)&&d.Extension.DeleteSelection2(0);d.ClearSelection2(true);}catch{}
    throw new Exception("BOM columns failed: "+ex.Message+(gone?"; the new BOM was removed":"; the new BOM could NOT be removed (delete it or close without saving)"));}
   d.EditRebuild3();
   // v3.8: drop columns with no text in any row (DESCRIPCION of a template nobody fills) and measure the table
   var tb=(ITableAnnotation)bom;var dropped=new List<string>();
   if(Flag(a,"drop_empty_columns"))for(int ci=tb.ColumnCount-1;ci>=0;ci--){bool empty=true;for(int r=1;r<tb.RowCount&&empty;r++)if(!string.IsNullOrWhiteSpace(Plain(tb.get_DisplayedText(r,ci))))empty=false;
    if(empty&&tb.ColumnCount>1){string title=Plain(tb.get_DisplayedText(0,ci));if(tb.DeleteColumn2(ci,false))dropped.Add(title);}}
   double tw=0,th=0;for(int ci=0;ci<tb.ColumnCount;ci++)tw+=tb.GetColumnWidth(ci);for(int r=0;r<tb.RowCount;r++)th+=tb.GetRowHeight(r);
   // v3.8: anchor top_right: position_mm is the TOP-RIGHT corner (keeps a wide table inside the sheet)
   if(a.ContainsKey("anchor")&&Str(a,"anchor")=="top_right"&&a.ContainsKey("position_mm")){var ann=(IAnnotation)tb.GetAnnotation();if(!ann.SetPosition2(x-tw,y,0))throw new Exception("Could not move the BOM to its top-right anchor");d.EditRebuild3();}
   double[] tpos=null;try{tpos=((double[])((IAnnotation)tb.GetAnnotation()).GetPosition()).Select(q=>Math.Round(q*1000,2)).ToArray();}catch{}
   var info=BomInfo(bom);
   result=new{bom=info,width_mm=Math.Round(tw*1000,2),height_mm=Math.Round(th*1000,2),top_left_mm=tpos,dropped_columns=dropped.ToArray(),columns_added=added.ToArray(),static_columns=statics.ToArray(),unresolved_cells=unresolved.ToArray(),boms_on_drawing=BomTables(dr).Count,before=before,template=tpl,note="SW-Material / SW-Mass columns hold values written now (re-run after changing parts). Empty linked cells mean the part has no such custom property. Unsaved until sw_save."};
   return true;
  }
  // balloons
  var targets=a.ContainsKey("views")?Items(a["views"]).Select(Convert.ToString).Select(n=>AssemblyView(dr,new Dictionary<string,object>{{"view",n}})).ToList():SheetViews(dr).Where(x=>{var m=x.ReferencedDocument as IModelDoc2;return m!=null&&m.GetType()==2;}).ToList();
  if(targets.Count==0)throw new Exception("No assembly views to balloon");
  Func<IView,List<string>> balloonTexts=vw=>{var r=new List<string>();var n=(INote)vw.GetFirstNote();int g=0;while(n!=null&&g++<5000){if(n.IsBomBalloon())r.Add(n.GetText());n=(INote)n.GetNext();}return r;};
  var perView=new List<object>();
  // v3.8 auto:false = no automatic balloons (only fill_missing by hand)
  foreach(var v in (a.ContainsKey("auto")&&!Flag(a,"auto"))?new List<IView>():targets){
   var already=balloonTexts(v);
   if(already.Count>0&&!Flag(a,"add_to_existing")){perView.Add(new{view=v.GetName2(),skipped="already has "+already.Count+" balloons (add_to_existing to balloon the rest)",balloons=already.ToArray()});continue;}
   dr.ActivateView(v.GetName2());d.ClearSelection2(true);if(!d.Extension.SelectByID2(v.GetName2(),"DRAWINGVIEW",0,0,0,false,0,null,0))throw new Exception("Cannot select view "+v.GetName2());
   var o=dr.CreateAutoBalloonOptions();
   string lay=a.ContainsKey("layout")?Str(a,"layout"):"square";
   o.Layout=lay=="circle"?(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Circle:lay=="top"?(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Top:lay=="bottom"?(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Bottom:lay=="left"?(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Left:lay=="right"?(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Right:(int)swBalloonLayoutType_e.swDetailingBalloonLayout_Square;
   o.IgnoreMultiple=true;o.Style=(int)swBalloonStyle_e.swBS_Circular;o.Size=(int)swBalloonFit_e.swBF_2Chars;o.UpperTextContent=(int)swBalloonTextContent_e.swBalloonTextItemNumber;
   var made=dr.AutoBalloon5(o) as object[];d.ClearSelection2(true);
   var now=balloonTexts(v);
   perView.Add(new{view=v.GetName2(),created=made==null?0:made.Length,balloons=now.ToArray()});
  }
  d.EditRebuild3();
  // v3.8 fill_missing: a BOM item with no balloon in ANY view of the sheet (the part is hidden in the isometric) gets one by hand on
  // the first target view where an edge of that part is visible, placed outside the view on its right
  var manual=new List<object>();var fillLog=new List<string>();
  if(Flag(a,"fill_missing"))foreach(var b in BomTables(dr)){
   var t=(ITableAnnotation)b;var bf=b.BomFeature;string cfg=bf==null?"":bf.Configuration;
   var have=new HashSet<string>(SheetViews(dr).SelectMany(balloonTexts));int k=0;
   for(int r=1;r<t.RowCount;r++){string it="",pn="";var rowFiles=((object[])b.GetModelPathNames(r,out it,out pn)??new object[0]).Select(p=>Path.GetFileName(Convert.ToString(p)).ToLowerInvariant()).ToList();
    if(string.IsNullOrEmpty(it)||have.Contains(it))continue;bool done=false;
    // the row's components come by FILE (GetComponents2 needs the exact BOM configuration and may return nothing)
    foreach(var v in targets){if(done)break;
     var allVis=((object[])v.GetVisibleComponents()??new object[0]).Cast<Component2>().ToList();
     var vis=allVis.Where(c=>{try{return rowFiles.Contains(Path.GetFileName(c.GetPathName()).ToLowerInvariant());}catch{return false;}}).ToList();
     fillLog.Add("item "+it+" "+string.Join("|",rowFiles)+" view "+v.GetName2()+": visible "+allVis.Count+", match "+vis.Count);
     foreach(var vc in vis){var edges=(object[])v.GetVisibleEntities2(vc,(int)swViewEntityType_e.swViewEntityType_Edge);fillLog.Add("  "+vc.Name2+" edges "+(edges==null?0:edges.Length));if(edges==null||edges.Length==0)continue;
      dr.ActivateView(v.GetName2());d.ClearSelection2(true);if(!v.SelectEntity(edges[edges.Length/2],false)){fillLog.Add("  select failed");continue;}
      var bo=d.Extension.CreateBalloonOptions();bo.Style=(int)swBalloonStyle_e.swBS_Circular;bo.Size=(int)swBalloonFit_e.swBF_2Chars;bo.UpperTextContent=(int)swBalloonTextContent_e.swBalloonTextItemNumber;
      var note=d.Extension.InsertBOMBalloon2(bo) as INote;d.ClearSelection2(true);if(note==null){fillLog.Add("  InsertBOMBalloon2 null");continue;}
      var o=(double[])v.GetOutline();try{((IAnnotation)note.GetAnnotation()).SetPosition2(o[2]+0.012,o[3]-0.012-k*0.014,0);}catch{}
      manual.Add(new{item=it,view=v.GetName2(),component=vc.Name2,text=note.GetText()});k++;done=true;break;}
    }
   }
  }
  if(manual.Count>0){d.EditRebuild3();perView.Add(new{view="(manual)",created=manual.Count,balloons=manual.Select(m=>(string)m.GetType().GetProperty("item").GetValue(m,null)).ToArray()});}
  // compare each BOM only with balloons of views that show the SAME assembly
  var missing=new List<string>();var items=new List<string>();
  foreach(var b in BomTables(dr)){var t=(ITableAnnotation)b;var bf=b.BomFeature;string model=bf==null?"":Path.GetFullPath(bf.GetReferencedModelName()??"");string bn=bf==null?"BOM":((IFeature)bf.GetFeature()).Name;
   var its=Enumerable.Range(1,Math.Max(0,t.RowCount-1)).Select(r=>{string it="",pn="";b.GetModelPathNames(r,out it,out pn);return it;}).Where(x=>!string.IsNullOrEmpty(x)).Distinct().ToList();
   // v3.8: balloons of EVERY view of the sheet that shows this assembly (earlier calls, other views, manual ones)
   var mine=SheetViews(dr).Where(vw=>{var md=vw.ReferencedDocument as IModelDoc2;return md!=null&&string.Equals(Path.GetFullPath(md.GetPathName()),model,StringComparison.OrdinalIgnoreCase);}).SelectMany(balloonTexts);
   var set=new HashSet<string>(mine);items.AddRange(its.Select(i=>bn+":"+i));missing.AddRange(its.Where(i=>!set.Contains(i)).Select(i=>bn+":"+i));}
  result=new{views=perView.ToArray(),bom_items=items.ToArray(),bom_items_without_balloon=missing.ToArray(),manual_balloons=manual.ToArray(),fill_log=fillLog.ToArray(),
   note=(items.Count==0?"No BOM on the drawing: balloon numbers follow the assembly order; insert the BOM first (sw_bom) so numbers match. ":"")+"Unsaved until sw_save."};
  return true;
 }
}
