using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.5 sketch_plane: move an existing sketch onto another support (Editar plano de croquis) without redrawing it.
// Typical use: a sketch whose support was lost (the face it sat on no longer exists, so it hangs on an unnamed internal
// plane) carries a "?" warning that also shows on the feature built from it. coplanar_from rebuilds that same plane as an
// offset of a parallel datum plane, inserted before the sketch, and verifies the sketch did not move.
// Order checks use the feature HISTORY (FirstFeature/GetNextFeature; absorbed sketches sit right before their feature),
// never AllFeatures (reverse order with sub-features interleaved). A datum plane used as support must precede the sketch:
// if it comes later it is reordered before the sketch (or before the feature that absorbs it).
// v3.5 review (Codex, high): one target exactly, part documents only, no 3D sketches, every rollback/selection/delete
// result checked, wrong-side plane attempts verified gone.
partial class Worker {
 static List<string> HistoryNames(IModelDoc2 d){var r=new List<string>();var f=(IFeature)d.FirstFeature();int n=0;while(f!=null&&n++<5000){r.Add(f.Name);f=(IFeature)f.GetNextFeature();}return r;}
 static bool SpSelect(object t,bool append){return t is IFeature?((IFeature)t).Select2(append,0):((IEntity)t).Select4(append,null);}
 // sketch plane in model coordinates: [0..2] x axis, [6..8] normal, [9..11] origin (m)
 static double[] SpFrame(ISketch sk){return (double[])((IMathTransform)sk.ModelToSketchTransform.Inverse()).ArrayData;}
 static double SpCross(double[] p,double[] q){double x=p[7]*q[8]-p[8]*q[7],y=p[8]*q[6]-p[6]*q[8],z=p[6]*q[7]-p[7]*q[6];return Math.Sqrt(x*x+y*y+z*z);}
 static double SpOffset(double[] p,double[] b){return (p[9]-b[9])*b[6]+(p[10]-b[10])*b[7]+(p[11]-b[11])*b[8];}
 static string SpMm(double m){return (m*1000).ToString("0.####",System.Globalization.CultureInfo.InvariantCulture);}
 static bool SpEnsureBefore(IModelDoc2 d,IFeature t,IFeature sf){
  var h=HistoryNames(d);int ti=h.IndexOf(t.Name),si=h.IndexOf(sf.Name);
  if(ti<0||si<0)throw new Exception("Cannot place "+t.Name+" or "+sf.Name+" in the feature history");
  if(ti<si)return false;
  if(t.GetTypeName2()!="RefPlane")throw new Exception(t.Name+" comes after "+sf.Name+" in the history; a sketch can only sit on something built before it");
  string owner=FiNames(sf.GetChildren()).FirstOrDefault();
  d.Extension.ReorderFeature(t.Name,sf.Name,(int)swMoveLocation_e.swMoveBefore);h=HistoryNames(d);
  if(h.IndexOf(t.Name)>h.IndexOf(sf.Name)&&owner!=null){d.Extension.ReorderFeature(t.Name,owner,(int)swMoveLocation_e.swMoveBefore);h=HistoryNames(d);}
  if(h.IndexOf(t.Name)>h.IndexOf(sf.Name))throw new Exception("Could not move "+t.Name+" before "+sf.Name+" (its own references may come later)");
  return true;
 }
 static bool TrySketchPlane(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="sketch_plane")return false;
  string[] keys={"face_of_sketch","plane","face_reference","coplanar_from"};
  if(keys.Count(k=>a.ContainsKey(k))!=1)throw new Exception("Give exactly one target: face_of_sketch, plane, face_reference or coplanar_from");
  if(d.GetType()!=1)throw new Exception("sketch_plane works on part documents (component sketches need their own context)");
  var sf=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"sketch"));var sk=sf==null?null:sf.GetSpecificFeature2() as ISketch;
  if(sk==null)throw new Exception("Sketch not found: "+Str(a,"sketch"));
  if(sk.Is3D())throw new Exception(sf.Name+" is a 3D sketch: it has no single plane to move");
  int t0=0;object before=null;try{before=sk.GetReferenceEntity(ref t0);}catch{}
  var f0=SpFrame(sk);
  object target;string targetDesc;bool reordered=false;
  if(a.ContainsKey("face_of_sketch")){
   var of=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"face_of_sketch"));var osk=of==null?null:of.GetSpecificFeature2() as ISketch;
   if(osk==null)throw new Exception("Sketch not found: "+Str(a,"face_of_sketch"));
   int t1=0;target=osk.GetReferenceEntity(ref t1);if(target==null)throw new Exception(of.Name+" has no reference face/plane");
   targetDesc=(target is IFace2?"face":"plane")+" of "+of.Name;
  }else if(a.ContainsKey("coplanar_from")){
   var bf=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"coplanar_from")&&x.GetTypeName2()=="RefPlane");if(bf==null)throw new Exception("Reference plane not found: "+Str(a,"coplanar_from"));
   var ba=(double[])((IRefPlane)bf.GetSpecificFeature2()).Transform.ArrayData;
   if(SpCross(f0,ba)>1e-8)throw new Exception(bf.Name+" is not parallel to "+sf.Name);
   double off=SpOffset(f0,ba);
   if(Math.Abs(off)<1e-9){target=bf;targetDesc="plane "+bf.Name;}
   else{
    IFeature np=null;bool rolled=false,back=true;
    try{
     rolled=d.FeatureManager.EditRollback((int)swMoveRollbackBarTo_e.swMoveRollbackBarToBeforeFeature,sf.Name);
     if(!rolled)throw new Exception("Cannot roll back before "+sf.Name);
     foreach(bool flip in new[]{off<0,off>=0}){
      d.ClearSelection2(true);if(!bf.Select2(false,0))throw new Exception("Cannot select "+bf.Name);
      int cst=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance;if(flip)cst|=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_OptionFlip;
      np=(IFeature)d.FeatureManager.InsertRefPlane(cst,Math.Abs(off),0,0,0,0);d.ClearSelection2(true);if(np==null)continue;
      if(Math.Abs(SpOffset((double[])((IRefPlane)np.GetSpecificFeature2()).Transform.ArrayData,ba)-off)<1e-7)break;
      string bad=np.Name;np=null;
      if(!HistoryNames(d).Contains(bad))continue;
      var badF=AllFeatures(d).First(x=>x.Name==bad);
      if(!badF.Select2(false,0)||!d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed))throw new Exception("Could not delete the wrong-side plane "+bad);
      d.ClearSelection2(true);if(HistoryNames(d).Contains(bad))throw new Exception("The wrong-side plane "+bad+" is still there");
     }
    }finally{d.ClearSelection2(true);if(rolled)back=d.FeatureManager.EditRollback((int)swMoveRollbackBarTo_e.swMoveRollbackBarToEnd,"");}
    if(!back)throw new Exception("Could not move the rollback bar back to the end");
    if(np==null)throw new Exception("Could not create the plane at "+SpMm(off)+" mm from "+bf.Name);
    target=np;targetDesc="new plane "+np.Name+" ("+SpMm(off)+" mm from "+bf.Name+")";
   }
  }else if(a.ContainsKey("plane")){
   target=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"plane")&&x.GetTypeName2()=="RefPlane");if(target==null)throw new Exception("Reference plane not found: "+Str(a,"plane"));targetDesc="plane "+Str(a,"plane");
  }else{
   var face=Resolve(d,Str(a,"face_reference")) as IFace2;if(face==null)throw new Exception("face_reference must be a face from sw_topology");target=face;targetDesc="face";
  }
  if(target is IFace2){
   if(!((ISurface)((IFace2)target).GetSurface()).IsPlane())throw new Exception("The new support must be planar");
   var ff=((IFace2)target).GetFeature() as IFeature;var h=HistoryNames(d);
   if(ff!=null&&h.IndexOf(ff.Name)>h.IndexOf(sf.Name))throw new Exception("That face is made by "+ff.Name+", which comes after "+sf.Name);
  }
  if(target is IFeature)reordered=SpEnsureBefore(d,(IFeature)target,sf);
  bool ok=false;string how=null;
  try{
   d.ClearSelection2(true);
   if(!sf.Select2(false,0)||!SpSelect(target,true))throw new Exception("Cannot select "+sf.Name+" and the new support ("+targetDesc+")");
   try{ok=d.Extension.ChangeSketchPlane(0,null);if(ok)how="IModelDocExtension.ChangeSketchPlane";}catch{}
   if(!ok){
    d.ClearSelection2(true);
    if(!sf.Select2(false,0)||!SpSelect(target,true))throw new Exception("Cannot select "+sf.Name+" and the new support ("+targetDesc+")");
    try{ok=d.ChangeSketchPlane();if(ok)how="IModelDoc2.ChangeSketchPlane";}catch{}
   }
  }finally{d.ClearSelection2(true);}
  if(!ok)throw new Exception("SolidWorks refused to move "+sf.Name+" to the "+targetDesc);
  d.ForceRebuild3(false);
  var f1=SpFrame(sk);double shift=SpOffset(f1,f0);bool parallel=SpCross(f1,f0)<1e-8;bool flipped=parallel&&(f1[6]*f0[6]+f1[7]*f0[7]+f1[8]*f0[8])<0;
  if(a.ContainsKey("coplanar_from")&&(!parallel||Math.Abs(shift)>1e-9))throw new Exception(sf.Name+" moved ("+SpMm(shift)+" mm) instead of staying on its plane");
  var hist=HistoryNames(d);int t2=0;object after=null;try{after=sk.GetReferenceEntity(ref t2);}catch{}
  bool warn;int code=sf.GetErrorCode2(out warn);
  result=new{sketch=sf.Name,moved_to=targetDesc,method=how,support_before=FiRef(before,t0,typeof(swSelectType_e)),support_after=FiRef(after,t2,typeof(swSelectType_e)),
   support_reordered_before_sketch=reordered,support_before_sketch_in_history=!(target is IFeature)||hist.IndexOf(((IFeature)target).Name)<hist.IndexOf(sf.Name),
   plane_shift_mm=Math.Round(shift*1000,6),plane_parallel=parallel,normal_flipped=flipped,error_code=code,is_warning=warn,
   note="Compare volume/mass against a rebuild WITHOUT changes (a stored value can be stale) before saving."};
  return true;
 }
}
