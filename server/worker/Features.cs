using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// Part features beyond extrude/cut: revolve (boss/cut), mirror, circular/linear patterns, offset reference planes.
partial class Worker {
 static List<IFeature> RefPlanes(IModelDoc2 d){var l=new List<IFeature>();IFeature f=(IFeature)d.FirstFeature();while(f!=null){if(f.GetTypeName2()=="RefPlane")l.Add(f);f=(IFeature)f.GetNextFeature();}return l;}
 static IFeature PlaneByIndex(IModelDoc2 d,int index){var p=RefPlanes(d);if(index<0||index>=p.Count)throw new Exception("plane_index "+index+" not found ("+p.Count+" planes: 0=Front/Alzado, 1=Top/Planta, 2=Right/Vista lateral, then created planes)");return p[index];}

 // Axis NAMES per document (no COM objects retained); validated by type on reuse and dropped by close_document.
 static Dictionary<string,Dictionary<string,string>> axisCache=new Dictionary<string,Dictionary<string,string>>();
 static string DocKey(IModelDoc2 d){string p=d.GetPathName();return string.IsNullOrEmpty(p)?d.GetTitle():p;}
 // Reference axis X, Y or Z from intersections of the default planes (created once and reused).
 static IFeature DefaultAxis(IModelDoc2 d,string axis){
  // Reuse an axis already built from the same two default planes; it keeps the SolidWorks default name (Eje1...).
  string key=DocKey(d);if(!axisCache.ContainsKey(key))axisCache[key]=new Dictionary<string,string>();
  if(axisCache[key].ContainsKey(axis)){var old=(IFeature)((IPartDoc)d).FeatureByName(axisCache[key][axis]);if(old!=null&&old.GetTypeName2()=="RefAxis")return old;axisCache[key].Remove(axis);}
  int a=axis=="X"?0:axis=="Y"?0:1,b=axis=="X"?1:2; // X = Front∩Top, Y = Front∩Right, Z = Top∩Right
  d.ClearSelection2(true);PlaneByIndex(d,a).Select2(false,0);PlaneByIndex(d,b).Select2(true,0);
  if(!d.InsertAxis2(true))throw new Exception("Could not create axis "+axis);
  IFeature f=(IFeature)d.FeatureByPositionReverse(0);if(f==null||f.GetTypeName2()!="RefAxis")throw new Exception("Axis feature not found after creation");axisCache[key][axis]=f.Name;d.ClearSelection2(true);return f;
 }
 static bool SelectAxis(IModelDoc2 d,Dictionary<string,object>a,int mark){
  if(a.ContainsKey("axis_edge_reference")){var e=Resolve(d,Str(a,"axis_edge_reference")) as IEntity;if(e==null)throw new Exception("axis_edge_reference is not an edge");var sd=(ISelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mark;return e.Select4(true,(SelectData)sd);}
  return DefaultAxis(d,Str(a,"axis")).Select2(true,mark);
 }
 static void SelectFeatures(IModelDoc2 d,Dictionary<string,object>a,int mark){foreach(var n in Items(a["features"]).Select(Convert.ToString)){var f=Feature(d,n);if(!f.Select2(true,mark))throw new Exception("Could not select feature "+n);}}

 static bool TryFeatures(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="loft"){
   // Loft (recubrir) through the profile sketches in the given order; each must be a closed profile on its own plane.
   var names=Items(a["profiles"]).Select(Convert.ToString).ToList();bool cut=Flag(a,"cut");
   IFeature f;
   try{
    d.ClearSelection2(true);
    foreach(var n in names){var sk=SketchFeature(d,n);if(!sk.Select2(true,1))throw new Exception("Could not select profile "+n);}
    f=cut
     ?d.FeatureManager.InsertCutBlend(false,true,false,1,0,0,false,0,0,0,true,true) as IFeature
     :d.FeatureManager.InsertProtrusionBlend2(false,true,false,1,0,0,1,1,true,true,false,0,0,0,Flag(a,"merge",true),true,true,0) as IFeature;
   }finally{d.ClearSelection2(true);}
   if(f==null)throw new Exception("Loft failed: profiles must be closed, on different planes and in order"+(cut?", and the loft must intersect the body":""));
   result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="revolve"){
   string name=NewName(d,a);var sk=SketchFeature(d,Str(a,"sketch"));
   var segs=((object[])((ISketch)sk.GetSpecificFeature2()).GetSketchSegments()??new object[0]).Cast<ISketchSegment>();
   if(segs.Count(s=>s.ConstructionGeometry&&s is ISketchLine)!=1)throw new Exception("The sketch needs exactly one construction line (construction=true) as the revolve axis");
   double ang=(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):360)*Math.PI/180;bool cut=Flag(a,"cut");
   d.ClearSelection2(true);if(!sk.Select2(false,0))throw new Exception("Sketch selection failed");
   var f=d.FeatureManager.FeatureRevolve2(true,true,false,cut,Flag(a,"reverse"),false,(int)swEndConditions_e.swEndCondBlind,0,ang,0,false,false,0,0,0,0,0,true,true,true);
   if(f==null)throw new Exception("Revolve failed: closed profile on one side of the axis line required"+(cut?" and it must intersect the body":""));
   Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="mirror"){
   string name=NewName(d,a);d.ClearSelection2(true);
   SelectFeatures(d,a,1);if(!PlaneByIndex(d,Convert.ToInt32(a["plane_index"])).Select2(true,2))throw new Exception("Plane selection failed");
   var f=(IFeature)d.FeatureManager.InsertMirrorFeature2(false,false,false,false,(int)swFeatureScope_e.swFeatureScope_AllBodies);
   if(f==null)throw new Exception("Mirror failed");Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="circular_pattern"){
   string name=NewName(d,a);int n=Convert.ToInt32(a["count"]);double total=(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):360)*Math.PI/180;
   d.ClearSelection2(true);if(!SelectAxis(d,a,1))throw new Exception("Axis selection failed");SelectFeatures(d,a,4);
   var f=(IFeature)d.FeatureManager.FeatureCircularPattern5(n,total,Flag(a,"reverse"),"NULL",false,true,false,false,false,false,1,0,"NULL",false);
   if(f==null)throw new Exception("Circular pattern failed");Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="linear_pattern"){
   string name=NewName(d,a);int n=Convert.ToInt32(a["count"]);double sp=Num(a,"spacing_mm")/1000;
   d.ClearSelection2(true);if(!SelectAxis(d,a,1))throw new Exception("Direction selection failed");SelectFeatures(d,a,4);
   var f=(IFeature)d.FeatureManager.FeatureLinearPattern5(n,sp,1,0,Flag(a,"reverse"),false,"NULL","NULL",false,false,false,false,true,false,false,false,false,false,0,0,false,false);
   if(f==null)throw new Exception("Linear pattern failed");Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="ref_plane"){
   string name=NewName(d,a);d.ClearSelection2(true);
   if(a.ContainsKey("face_reference")){var face=Resolve(d,Str(a,"face_reference")) as IEntity;if(face==null||!face.Select4(false,null))throw new Exception("Face selection failed");}
   else if(!PlaneByIndex(d,Convert.ToInt32(a["plane_index"])).Select2(false,0))throw new Exception("Plane selection failed");
   int c=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance;if(Flag(a,"flip"))c|=(int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_OptionFlip;
   var f=(IFeature)d.FeatureManager.InsertRefPlane(c,Num(a,"offset_mm")/1000,0,0,0,0);
   if(f==null)throw new Exception("Reference plane failed");Rename(f,name);d.ClearSelection2(true);
   result=new{feature=f.Name,plane_index=RefPlanes(d).FindIndex(x=>x.Name==f.Name),note="Use plane_index with sw_create_sketch or sw_mirror."};return true;
  }
  return false;
 }
}
