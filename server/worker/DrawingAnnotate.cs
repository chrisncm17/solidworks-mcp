using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v1.9: drawing_annotate — import the model's own dimensions into drawing views (Insert Model Items) and auto center marks,
// then report what each view gained and which dimensions appear in more than one view. Unsaved until sw_save; check the PDF.
partial class Worker {
 static List<IDisplayDimension> ViewDims(IView v){
  var r=new List<IDisplayDimension>();
  foreach(var o in (object[])v.GetAnnotations()??new object[0]){var an=o as IAnnotation;if(an!=null&&an.GetType()==(int)swAnnotationType_e.swDisplayDimension){var dd=(IDisplayDimension)an.GetSpecificAnnotation();if(dd!=null&&!dd.IsHoleCallout())r.Add(dd);}}
  return r;
 }
 static int HoleCalloutCount(IView v){int n=0;foreach(var o in (object[])v.GetAnnotations()??new object[0]){var an=o as IAnnotation;if(an!=null&&an.GetType()==(int)swAnnotationType_e.swDisplayDimension){var dd=an.GetSpecificAnnotation() as IDisplayDimension;if(dd!=null&&dd.IsHoleCallout())n++;}}return n;}
 static bool TryDrawingAnnotate(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="drawing_annotate")return false;
  if(d.GetType()!=3)throw new Exception("drawing_annotate needs a managed drawing (.SLDDRW)");
  var dr=(IDrawingDoc)d;
  var all=SheetViews(dr);
  var want=a.ContainsKey("views")?Items(a["views"]).Select(Convert.ToString).ToList():null;
  if(want!=null){var missing=want.Where(n=>!all.Any(v=>v.GetName2()==n)).ToArray();if(missing.Length>0)throw new Exception("Views not found on the active sheet: "+string.Join(", ",missing)+" (have: "+string.Join(", ",all.Select(v=>v.GetName2()))+")");}
  var target=want==null?all:all.Where(v=>want.Contains(v.GetName2())).ToList();
  if(target.Count==0)throw new Exception("The active sheet has no model views; add views first (sw_drawing_views)");
  bool dims=!a.ContainsKey("dimensions")||Flag(a,"dimensions"),marks=Flag(a,"center_marks"),unmarked=Flag(a,"include_unmarked"),slots=Flag(a,"slot_center_marks");
  var before=target.ToDictionary(v=>v.GetName2(),v=>ViewDims(v).Count);
  Func<IView,IDisplayDimension,string> key=(v,x)=>{var dm=(IDimension)x.GetDimension2(0);return v.GetName2()+"|"+(dm==null?"":dm.FullName);};
  var existing=new HashSet<string>(target.SelectMany(v=>ViewDims(v).Select(x=>key(v,x))));
  int inserted=0;var marked=new List<string>();
  if(dims){
   d.ClearSelection2(true);bool allViews=want==null;
   if(!allViews)foreach(var v in target)if(!d.Extension.SelectByID2(v.GetName2(),"DRAWINGVIEW",0,0,0,true,0,null,0))throw new Exception("Cannot select view "+v.GetName2());
   int types=(int)swInsertAnnotation_e.swInsertDimensionsMarkedForDrawing;if(unmarked)types|=(int)swInsertAnnotation_e.swInsertDimensionsNotMarkedForDrawing;
   // source 0 = entire model; no duplicates across views; skip hidden-feature dims; use the sketch placement
   var res=dr.InsertModelAnnotations3((int)swImportModelItemsSource_e.swImportModelItemsFromEntireModel,types,allViews,false,false,true);
   inserted=res is object[]?((object[])res).Length:0;d.ClearSelection2(true);
  }
  if(marks){
   int kind=(int)swAutoInsertCenterMarkTypes_e.swAutoInsertCenterMarkType_Hole;if(slots)kind|=(int)swAutoInsertCenterMarkTypes_e.swAutoInsertCenterMarkType_Slots;
   foreach(var v in target){dr.ActivateView(v.GetName2());if(v.AutoInsertCenterMarks2(kind,(int)swCenterMarkConnectionLine_e.swCenterMark_ShowNoConnectLines,slots,slots,true,0.0025,0.0,true,true,0.0))marked.Add(v.GetName2());}
  }
  // hole callouts: one per hole feature per view, on a circular edge seen end-on (axis along the view direction)
  var callouts=new List<object>();
  var calloutSkipped=new List<string>();
  if(Flag(a,"hole_callouts")){
   bool anyCut=Flag(a,"include_cut_holes");var mu=(IMathUtility)sw.GetMathUtility();
   foreach(var v in target){
    var rd=v.ReferencedDocument as IModelDoc2;if(rd==null||rd.GetType()!=1){calloutSkipped.Add(v.GetName2()+" (not a part view)");continue;}
    if(HoleCalloutCount(v)>0){calloutSkipped.Add(v.GetName2()+" (already has hole callouts)");continue;}
    var done=new HashSet<string>();var xf=(MathTransform)v.ModelToViewTransform;
    foreach(var o in (object[])v.GetVisibleEntities2(null,(int)swViewEntityType_e.swViewEntityType_Edge)??new object[0]){
     var e=o as IEdge;if(e==null)continue;var cu=(ICurve)e.GetCurve();if(!cu.IsCircle())continue;
     IFace2 cyl=null;foreach(IFace2 fc in (object[])e.GetTwoAdjacentFaces2()??new object[0]){var su=(ISurface)fc.GetSurface();if(su.IsCylinder()||su.IsCone()){cyl=fc;break;}}
     if(cyl==null)continue;var feat=cyl.GetFeature() as IFeature;if(feat==null)continue;string ft=feat.GetTypeName2();
     if(!(ft=="HoleWzd"||ft=="AdvHoleWzd"||anyCut&&(ft=="Cut"||ft=="ICE"||ft=="CutRevolve")))continue;
     if(done.Contains(feat.Name))continue;
     var cp=(double[])cu.CircleParams;var axis=(MathVector)((MathVector)mu.CreateVector(new double[]{cp[3],cp[4],cp[5]})).MultiplyTransform(xf);var ad=(double[])axis.ArrayData;
     double an=Math.Sqrt(ad[0]*ad[0]+ad[1]*ad[1]+ad[2]*ad[2]);if(an<1e-12||Math.Abs(ad[2])/an<0.999)continue;
     var ctr=(double[])((MathPoint)((MathPoint)mu.CreatePoint(new double[]{cp[0],cp[1],cp[2]})).MultiplyTransform(xf)).ArrayData;
     dr.ActivateView(v.GetName2());d.ClearSelection2(true);if(!v.SelectEntity(e,false))continue;
     double off=cp[6]*v.ScaleDecimal+0.008;var co=dr.AddHoleCallout2(ctr[0]+off,ctr[1]+off,0);d.ClearSelection2(true);
     if(co!=null){done.Add(feat.Name);callouts.Add(new{view=v.GetName2(),feature=feat.Name,diameter_mm=Math.Round(cp[6]*2000,4)});}
    }
   }
  }
  d.EditRebuild3();
  // keep each model dimension in ONE view (the first in sheet order) and remove the repeats SolidWorks inserted elsewhere
  var removed=new List<string>();
  if(dims&&(!a.ContainsKey("remove_repeated")||Flag(a,"remove_repeated"))){
   var seen=new HashSet<string>();
   foreach(var v in target)foreach(var x in ViewDims(v)){var dim=(IDimension)x.GetDimension2(0);if(dim==null)continue;
    if(seen.Add(dim.FullName)||existing.Contains(key(v,x)))continue;
    d.ClearSelection2(true);if(((IAnnotation)x.GetAnnotation()).Select3(false,null)&&d.Extension.DeleteSelection2(0))removed.Add(dim.FullName+" @ "+v.GetName2());}
   d.ClearSelection2(true);
  }
  // SolidWorks "auto arrange" spacing of the dimensions of each view
  int arranged=0;
  if(!a.ContainsKey("auto_arrange")||Flag(a,"auto_arrange")){
   foreach(var v in target){var ds=ViewDims(v);if(ds.Count==0)continue;d.ClearSelection2(true);bool any=false;foreach(var x in ds)any|=((IAnnotation)x.GetAnnotation()).Select3(true,null);
    if(any&&d.Extension.AlignDimensions((int)swAlignDimensionType_e.swAlignDimensionType_AutoArrange,0.006))arranged++;}
   d.ClearSelection2(true);
  }
  d.EditRebuild3();d.GraphicsRedraw2();
  var perView=new List<object>();var names=new Dictionary<string,List<string>>();
  foreach(var v in target){var ds=ViewDims(v);foreach(var x in ds){var dim=(IDimension)x.GetDimension2(0);if(dim==null)continue;string k=dim.FullName;if(!names.ContainsKey(k))names[k]=new List<string>();names[k].Add(v.GetName2());}
   perView.Add(new{view=v.GetName2(),dimensions_before=before[v.GetName2()],dimensions_after=ds.Count,center_marks=marked.Contains(v.GetName2())});}
  var dup=names.Where(kv=>kv.Value.Count>1).Select(kv=>new{dimension=kv.Key,views=kv.Value.ToArray()}).ToArray();
  int gained=perView.Sum(p=>(int)p.GetType().GetProperty("dimensions_after").GetValue(p,null)-(int)p.GetType().GetProperty("dimensions_before").GetValue(p,null));
  result=new{dimensions_inserted=inserted,dimensions_gained=gained,views=perView.ToArray(),repeats_removed=removed.ToArray(),hole_callouts=callouts.ToArray(),hole_callout_views_skipped=calloutSkipped.ToArray(),views_auto_arranged=arranged,repeated_dimensions=dup,
   note=(gained==0&&dims?"No dimension was added: the model may have no driving dimensions marked for drawing (try include_unmarked=true) or they were already shown. ":"")+"Imported dimensions use the model sketch placement and can overlap; review the PDF (sw_export) before delivering. Unsaved until sw_save."};
  return true;
 }
}
