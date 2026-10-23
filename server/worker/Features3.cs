using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v1.6 batch B: hole wizard (ISO), general reference plane (up to 3 references with constraints), reference axis.
partial class Worker {
 // SelectByID2 picks along the view direction, so a face seen edge-on (a shaft end in the front view) is missed or a neighbour is hit.
 // Find the planar face that contains the point and shoot a ray along its normal: the pick point stays where the hole goes.
 static bool SelectPlanarFaceAt(IModelDoc2 d,double[] p){
  var part=d as IPartDoc;if(part==null)return false;double x=p[0]/1000,y=p[1]/1000,z=p[2]/1000;
  foreach(object bo in (object[])part.GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0])
   foreach(object fo in (object[])((IBody2)bo).GetFaces()??new object[0]){
    var fc=(IFace2)fo;if(!((ISurface)fc.GetSurface()).IsPlane())continue;
    var q=fc.GetClosestPointOn(x,y,z) as double[];if(q==null||Math.Sqrt((q[0]-x)*(q[0]-x)+(q[1]-y)*(q[1]-y)+(q[2]-z)*(q[2]-z))>1e-7)continue;
    var n=(double[])fc.Normal;d.ClearSelection2(true);
    if(d.Extension.SelectByRay(x+n[0]*0.001,y+n[1]*0.001,z+n[2]*0.001,-n[0],-n[1],-n[2],0.0001,(int)swSelectType_e.swSelFACES,false,0,0)){
     // Codex review: the ray must have selected THIS face (not a neighbour in front of it)
     var sel=((ISelectionMgr)d.SelectionManager).GetSelectedObject6(1,-1);
     if(sel!=null&&sw.IsSame(sel,fc)==(int)swObjectEquality.swObjectSame){holeFaceNormal=n;return true;}
     d.ClearSelection2(true);}
   }
  return false;
 }
 // normal of the face SelectByID2 really selected (null when it is not planar)
 static double[] SelectedPlanarNormal(IModelDoc2 d){
  try{var fc=((ISelectionMgr)d.SelectionManager).GetSelectedObject6(1,-1) as IFace2;if(fc==null||!((ISurface)fc.GetSurface()).IsPlane())return null;return (double[])fc.Normal;}catch{return null;}
 }
 static double[] holeFaceNormal;
 // v3.8: a hole that went in tilted or away from point_mm used to pass silently (found 20 min later as an over-defined washer).
 static string HoleAxisProblem(IFeature f,double[] p,double[] n){
  if(n==null)return "Hole start face is not planar or could not be read; the hole axis cannot be verified";
  double x=p[0]/1000,y=p[1]/1000,z=p[2]/1000;int cyl=0;
  foreach(object o in (object[])f.GetFaces()??new object[0]){var s=(ISurface)((IFace2)o).GetSurface();if(!s.IsCylinder())continue;var c=(double[])s.CylinderParams;cyl++;
   double dot=Math.Abs(c[3]*n[0]+c[4]*n[1]+c[5]*n[2]),dx=x-c[0],dy=y-c[1],dz=z-c[2],t=dx*c[3]+dy*c[4]+dz*c[5],off=Math.Sqrt(Math.Max(0,dx*dx+dy*dy+dz*dz-t*t));
   if(dot<0.9999||off>1e-5)return "Hole went in tilted or away from point_mm (axis to face normal cos "+Math.Round(dot,4)+", axis "+Math.Round(off*1000,3)+" mm from the point)";}
  return cyl==0?"The hole has no cylindrical face to verify its axis":null;
 }
 // type -> [GenericHoleType, ISO fastener table]
 static readonly Dictionary<string,int[]> HoleKinds=new Dictionary<string,int[]>{
  {"hole",new[]{(int)swWzdGeneralHoleTypes_e.swWzdHole,(int)swWzdHoleStandardFastenerTypes_e.swStandardISODrillSizes}},
  {"counterbore",new[]{(int)swWzdGeneralHoleTypes_e.swWzdCounterBore,(int)swWzdHoleStandardFastenerTypes_e.swStandardISOSocketHeadCap}},
  {"countersink",new[]{(int)swWzdGeneralHoleTypes_e.swWzdCounterSink,(int)swWzdHoleStandardFastenerTypes_e.swStandardISOCTSKFlatHead}},
  {"tap",new[]{(int)swWzdGeneralHoleTypes_e.swWzdTap,(int)swWzdHoleStandardFastenerTypes_e.swStandardISOTappedHole}}};
 static readonly Dictionary<string,int[]> HoleKindsAnsi=new Dictionary<string,int[]>{
  {"hole",new[]{(int)swWzdGeneralHoleTypes_e.swWzdHole,(int)swWzdHoleStandardFastenerTypes_e.swStandardAnsiMetricDrillSizes}},
  {"counterbore",new[]{(int)swWzdGeneralHoleTypes_e.swWzdCounterBore,(int)swWzdHoleStandardFastenerTypes_e.swStandardAnsiMetricSocketHeadCapScrew}},
  {"countersink",new[]{(int)swWzdGeneralHoleTypes_e.swWzdCounterSink,(int)swWzdHoleStandardFastenerTypes_e.swStandardAnsiMetricFlatHead82}},
  {"tap",new[]{(int)swWzdGeneralHoleTypes_e.swWzdTap,(int)swWzdHoleStandardFastenerTypes_e.swStandardAnsiMetricTappedHole}}};
 static readonly Dictionary<string,int> PlaneConstraints=new Dictionary<string,int>{
  {"parallel",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Parallel},
  {"perpendicular",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Perpendicular},
  {"coincident",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Coincident},
  {"distance",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance},
  {"angle",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Angle},
  {"midplane",(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_MidPlane}};

 // A reference given as plane_index, face_reference, edge_reference, point_mm (a vertex picked at world mm) or feature_name (reference axis/plane).
 static void SelectReference(IModelDoc2 d,Dictionary<string,object> r,int mark,string what){
  int n=new[]{"plane_index","face_reference","edge_reference","point_mm","feature_name"}.Count(r.ContainsKey);
  if(n!=1)throw new Exception(what+": give exactly one of plane_index, face_reference, edge_reference, point_mm or feature_name");
  if(r.ContainsKey("feature_name")){var rf=Feature(d,Str(r,"feature_name"));var t=rf.GetTypeName2();if(t!="RefAxis"&&t!="RefPlane")throw new Exception(what+": feature_name must be a reference axis or plane");if(!rf.Select2(true,mark))throw new Exception("Cannot select "+what);return;}
  if(r.ContainsKey("plane_index")){if(!PlaneByIndex(d,Convert.ToInt32(r["plane_index"])).Select2(true,mark))throw new Exception("Cannot select "+what);return;}
  if(r.ContainsKey("point_mm")){var p=Items(r["point_mm"]).Select(Convert.ToDouble).ToArray();
   if(!d.Extension.SelectByID2("","VERTEX",p[0]/1000,p[1]/1000,p[2]/1000,true,mark,null,0))throw new Exception(what+": no vertex at ("+string.Join(", ",p)+") mm");return;}
  bool isFace=r.ContainsKey("face_reference");var resolved=Resolve(d,Str(r,isFace?"face_reference":"edge_reference"));
  if(isFace?!(resolved is IFace2):!(resolved is IEdge))throw new Exception(what+": "+(isFace?"face_reference must be a face":"edge_reference must be an edge")+" (refresh sw_topology)");
  var ent=(IEntity)resolved;
  var sd2=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd2.Mark=mark;if(!ent.Select4(true,sd2))throw new Exception("Cannot select "+what);
 }

 // Deletes a just-created feature (and its absorbed sketch) and confirms it is gone.
 static void RemoveConfirmed(IModelDoc2 d,IFeature f,string why){
  string n=f.Name;d.ClearSelection2(true);
  bool ok=f.Select2(false,0)&&d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed);d.ClearSelection2(true);
  if(!ok||((IPartDoc)d).FeatureByName(n)!=null)throw new Exception(why+" — and the bad feature "+n+" could NOT be removed; inspect before continuing.");
 }
 static bool TryFeatures3(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="hole_wizard"){
   NewName(d,a);string type=Str(a,"type");if(!HoleKinds.ContainsKey(type))throw new Exception("type must be hole, counterbore, countersink or tap");
   // v3.8 standard ansi_metric: the class drawings say "Avellanado Ansi Metric Tornillo con cabeza plana M5"; ISO and ANSI Metric
   // countersinks differ in size (mass)
   bool ansi=a.ContainsKey("standard")&&Str(a,"standard")=="ansi_metric";if(a.ContainsKey("standard")&&!ansi&&Str(a,"standard")!="iso")throw new Exception("standard must be iso or ansi_metric");
   var k=ansi?HoleKindsAnsi[type]:HoleKinds[type];var p=Items(a["point_mm"]).Select(Convert.ToDouble).ToArray();bool through=!a.ContainsKey("depth_mm");
   IFeature f;double volBefore=-1;try{volBefore=((IMassProperty)d.Extension.CreateMassProperty()).Volume;}catch{}
   try{
    d.ClearSelection2(true);
    // planar face by geometry FIRST: SelectByID2 can return true on a neighbour (the 0.5x45 cone of a shaft end) and the hole goes in tilted
    holeFaceNormal=null;
    if(!SelectPlanarFaceAt(d,p)&&!d.Extension.SelectByID2("","FACE",p[0]/1000,p[1]/1000,p[2]/1000,false,0,null,0))throw new Exception("No face at ("+string.Join(", ",p)+") mm: point_mm must lie on the planar face where the hole starts");
    if(holeFaceNormal==null)holeFaceNormal=SelectedPlanarNormal(d);   // fallback path: verify with the face SelectByID2 really picked
    // Measured on SolidWorks 2026 (batchB-test): ThroughAll needs zeros in the unused values and, for drill holes, the nominal
    // diameter (Ø6.0 -> 0.006); blind holes need -1 (zeros break the tapped-hole sketch).
    double nominal=-1;if(type=="hole"){double v;if(double.TryParse(Str(a,"size").TrimStart('Ø',' '),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out v))nominal=v/1000;}
    f=d.FeatureManager.HoleWizard5(k[0],ansi?(int)swWzdHoleStandards_e.swStandardAnsiMetric:(int)swWzdHoleStandards_e.swStandardISO,k[1],Str(a,"size"),(short)(through?(int)swEndConditions_e.swEndCondThroughAll:(int)swEndConditions_e.swEndCondBlind),
      through?nominal:-1,through?0.01:Num(a,"depth_mm")/1000,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,through?0:-1,"",false,true,true,true,true,false);
   }finally{d.ClearSelection2(true);}
   if(f==null)throw new Exception("Hole wizard failed: size must exist in the ISO table for "+type+" (e.g. M6 for counterbore/countersink/tap, Ø6.0 for hole)");
   // An unknown size does NOT fail: SolidWorks silently falls back to a tiny default (Ø0.16 mm). Read the real diameter and refuse it.
   var wd=f.GetDefinition() as IWizardHoleFeatureData2;double dia=wd==null?0:Math.Max(wd.HoleDiameter,Math.Max(wd.ThruHoleDiameter,Math.Max(wd.TapDrillDiameter,wd.Diameter)))*1000;
   if(dia<0.5){string why="Size '"+Str(a,"size")+"' is not in the ISO "+type+" table";RemoveConfirmed(d,f,why);
    throw new Exception("Size '"+Str(a,"size")+"' is not in the ISO "+type+" table (SolidWorks fell back to Ø"+Math.Round(dia,3)+" mm); use e.g. Ø6.0 for hole, M6 for counterbore/countersink/tap");}
   string tilt=HoleAxisProblem(f,p,holeFaceNormal);if(tilt!=null){RemoveConfirmed(d,f,tilt);throw new Exception(tilt+"; the hole was removed");}
   // v3.7 review (M6): for a tap the drill depth and the thread depth are different values; read back what SolidWorks really
   // made, force the requested ones through the definition and refuse a hole that does not match (it is removed).
   object holeDef=null;
   // v3.8 (measured, M6 drill 8): HoleWizard5 taps cut the thread at the MAJOR diameter (Ø6) to SolidWorks' default thread
   // depth 2xD = 12 mm, deeper than the 8 mm drill, so a 10 mm plate lost a Ø6 through hole (282.74 mm3). thread_depth_mm sets it
   // (verified); changing the hole subtype to cosmetic afterwards (Type 46) is NOT reliable (the depth is then ignored).
   if(wd!=null&&!through&&type=="tap"&&a.ContainsKey("thread_depth_mm")){
    double wantThread=Num(a,"thread_depth_mm")/1000;
    if(Math.Abs(wd.ThreadDepth-wantThread)>1e-7){try{wd.AccessSelections(d,null);wd.ThreadDepth=wantThread;if(!f.ModifyDefinition(wd,d,null))wd.ReleaseSelectionAccess();}catch{try{wd.ReleaseSelectionAccess();}catch{}}
     wd=f.GetDefinition() as IWizardHoleFeatureData2;}
    if(Math.Abs(wd.ThreadDepth-wantThread)>1e-6){string why="Hole depth not applied (drill "+Math.Round(wd.TapDrillDepth*1000,3)+" / depth "+Math.Round(wd.Depth*1000,3)+" / thread "+Math.Round(wd.ThreadDepth*1000,3)+" mm)";RemoveConfirmed(d,f,why);throw new Exception(why+"; the hole was removed");}
   }
   if(wd!=null)try{holeDef=new{end_condition=wd.EndCondition,depth_mm=Math.Round(wd.Depth*1000,4),tap_drill_diameter_mm=Math.Round(wd.TapDrillDiameter*1000,4),tap_drill_depth_mm=Math.Round(wd.TapDrillDepth*1000,4),thread_diameter_mm=Math.Round(wd.ThreadDiameter*1000,4),thread_depth_mm=Math.Round(wd.ThreadDepth*1000,4),hole_type=wd.Type,standard=wd.Standard,fastener_type=wd.FastenerType2,countersink_diameter_mm=Math.Round(wd.CounterSinkDiameter*1000,4),hole_diameter_mm=Math.Round(wd.HoleDiameter*1000,4)};}catch{}
   object insp;try{insp=Checked(d);}catch(Exception ex){RemoveConfirmed(d,f,"Hole wizard produced an invalid feature ("+ex.Message+")");throw new Exception("Hole wizard produced an invalid feature and it was removed: "+ex.Message);}
   string holeWarn=null;try{if(wd!=null&&type=="tap"&&!through&&wd.ThreadDepth>wd.TapDrillDepth+1e-9&&wd.TapDrillDepth>0)holeWarn="Thread depth "+Math.Round(wd.ThreadDepth*1000,3)+" mm is deeper than the drill ("+Math.Round(wd.TapDrillDepth*1000,3)+" mm): SolidWorks cuts Ø"+Math.Round(wd.ThreadDiameter*1000,3)+" down to the thread depth (it can go through the part). Give thread_depth_mm from the drawing.";}catch{}
   double removed=-1;try{if(volBefore>0)removed=Math.Round((volBefore-((IMassProperty)d.Extension.CreateMassProperty()).Volume)*1e9,3);}catch{}
   result=new{feature=f.Name,definition=holeDef,removed_volume_mm3=removed,warning=holeWarn,diameter_mm=Math.Round(dia,4),counterbore_diameter_mm=wd==null?0:Math.Round(wd.CounterBoreDiameter*1000,4),counterbore_depth_mm=wd==null?0:Math.Round(wd.CounterBoreDepth*1000,4),countersink_diameter_mm=wd==null?0:Math.Round(wd.CounterSinkDiameter*1000,4),inspection=insp};return true;
  }
  if(op=="ref_plane_advanced"){
   NewName(d,a);var refs=Items(a["references"]).Cast<Dictionary<string,object>>().ToList();if(refs.Count<1||refs.Count>3)throw new Exception("1 to 3 references");
   var c=new int[3];var v=new double[3];
   for(int i=0;i<refs.Count;i++){string con=Str(refs[i],"constraint");if(!PlaneConstraints.ContainsKey(con))throw new Exception("constraint: parallel, perpendicular, coincident, distance, angle or midplane");
    c[i]=PlaneConstraints[con]|(Flag(refs[i],"flip")?(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_OptionFlip:0);
    v[i]=con=="distance"?Num(refs[i],"value")/1000:con=="angle"?Num(refs[i],"value")*Math.PI/180:0;}
   object fo;
   try{d.ClearSelection2(true);for(int i=0;i<refs.Count;i++)SelectReference(d,refs[i],i,"reference "+(i+1));fo=d.FeatureManager.InsertRefPlane(c[0],v[0],c[1],v[1],c[2],v[2]);}
   finally{d.ClearSelection2(true);}
   var f=fo as IFeature;if(f==null)throw new Exception("Reference plane failed: the references/constraints do not define a plane");
   result=new{feature=f.Name,plane_index=RefPlanes(d).FindIndex(x=>x.Name==f.Name),inspection=Checked(d)};return true;
  }
  if(op=="ref_axis"){
   NewName(d,a);var refs=Items(a["references"]).Cast<Dictionary<string,object>>().ToList();if(refs.Count<1||refs.Count>2)throw new Exception("1 or 2 references");
   var before=FeatureNames(d);
   try{d.ClearSelection2(true);for(int i=0;i<refs.Count;i++)SelectReference(d,refs[i],0,"reference "+(i+1));if(!d.InsertAxis2(true))throw new Exception("Axis failed: use a cylindrical face, a linear edge, two planes or two points");}
   finally{d.ClearSelection2(true);}
   var f=NewFeature(d,before);if(f==null||f.GetTypeName2()!="RefAxis")throw new Exception("Axis was not created");
   result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  return false;
 }
}
