using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v1.6 batch A: sweep (boss/cut, circular profile), shell, rib, draft, helix. Features keep SolidWorks default names.
partial class Worker {
 static HashSet<string> FeatureNames(IModelDoc2 d){var s=new HashSet<string>();IFeature f=(IFeature)d.FirstFeature();while(f!=null){s.Add(f.Name);f=(IFeature)f.GetNextFeature();}return s;}
 // For APIs that return void: the newest feature that did not exist before (sketches excluded).
 static IFeature NewFeature(IModelDoc2 d,HashSet<string> before){IFeature f=(IFeature)d.FirstFeature(),hit=null;while(f!=null){if(!before.Contains(f.Name)&&!(f.GetSpecificFeature2() is ISketch))hit=f;f=(IFeature)f.GetNextFeature();}return hit;}
 static void SelectMarked(IModelDoc2 d,object entity,int mark,string what){
  var e=entity as IEntity;if(e==null)throw new Exception(what+" is not a face/edge reference");
  var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mark;if(!e.Select4(true,sd))throw new Exception("Cannot select "+what);
 }
 static IFace2 FaceRef(IModelDoc2 d,string r,string what){var f=Resolve(d,r) as IFace2;if(f==null)throw new Exception(what+" must be a face reference from sw_topology");return f;}

 static bool TryFeatures2(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="sweep"){
   NewName(d,a);bool cut=Flag(a,"cut"),circ=a.ContainsKey("circular_diameter_mm");
   if(circ==a.ContainsKey("profile"))throw new Exception("Give exactly one of profile or circular_diameter_mm");
   if(cut&&circ)throw new Exception("circular_diameter_mm is only available for a boss sweep");
   IFeature f;
   try{
    d.ClearSelection2(true);
    if(!circ&&!SketchFeature(d,Str(a,"profile")).Select2(true,1))throw new Exception("Cannot select the profile sketch");
    if(!Feature(d,Str(a,"path")).Select2(true,4))throw new Exception("Cannot select the path (sketch or helix)");
    f=cut
     ?d.FeatureManager.InsertCutSwept4(false,false,0,false,false,0,0,false,0,0,0,0,true,true,0,true,true,true,false)
     :d.FeatureManager.InsertProtrusionSwept4(false,false,0,false,false,0,0,false,0,0,0,0,Flag(a,"merge",true),true,true,0,true,circ,circ?Num(a,"circular_diameter_mm")/1000:0,0);
   }finally{d.ClearSelection2(true);}
   if(f==null)throw new Exception("Sweep failed: the path must start on the profile plane (pierce it) and the profile must be closed"+(cut?"; the sweep must intersect the body":""));
   result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  // v3.8 move_body (Mover/Copiar sólido): a part sketched on the wrong plane keeps its shape but its origin/axes do not match the
  // drawing. Rotate the solid bodies (90° steps about the part axes, through rotate_about_mm) and/or translate them, without
  // redrawing; mass is unchanged (checked), the center of mass moves with the body.
  if(op=="move_body"){
   var part=d as IPartDoc;if(part==null)throw new Exception("move_body works on parts");
   double[] rot=a.ContainsKey("rotate_deg")?Items(a["rotate_deg"]).Select(Convert.ToDouble).ToArray():new double[3];
   double[] at=a.ContainsKey("rotate_about_mm")?Items(a["rotate_about_mm"]).Select(Convert.ToDouble).ToArray():new double[3];
   double[] tr=a.ContainsKey("translate_mm")?Items(a["translate_mm"]).Select(Convert.ToDouble).ToArray():new double[3];
   if(rot.Length!=3||at.Length!=3||tr.Length!=3)throw new Exception("rotate_deg, rotate_about_mm and translate_mm are [x, y, z]");
   if(rot.All(v=>v==0)&&tr.All(v=>v==0))throw new Exception("Nothing to move: give rotate_deg and/or translate_mm");
   var mp0=(IMassProperty)d.Extension.CreateMassProperty();double vol0=mp0.Volume;var cm0=((double[])mp0.CenterOfMass).Select(v=>Math.Round(v*1000,4)).ToArray();
   var feats=new List<string>();
   // steps 0..2 = one rotation per axis in the order X, Y, Z (predictable), step 3 = translation.
   // Measured on SolidWorks 2026: InsertMoveCopyBody2 takes the angles as (about Z, about Y, about X), not X, Y, Z.
   for(int step=0;step<4;step++){bool isRot=step<3;if(isRot?rot[step]==0:tr.All(v=>v==0))continue;
    var ang=new double[3];if(isRot)ang[2-step]=rot[step]*Math.PI/180;
    var before=FeatureNames(d);
    try{
     d.ClearSelection2(true);var sm=(ISelectionMgr)d.SelectionManager;var sd=sm.CreateSelectData();sd.Mark=1;
     foreach(object bo in (object[])part.GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0])((IBody2)bo).Select2(true,sd);
     if(isRot)d.FeatureManager.InsertMoveCopyBody2(0,0,0,0,at[0]/1000,at[1]/1000,at[2]/1000,ang[0],ang[1],ang[2],false,1);
     else d.FeatureManager.InsertMoveCopyBody2(tr[0]/1000,tr[1]/1000,tr[2]/1000,0,0,0,0,0,0,0,false,1);
    }finally{d.ClearSelection2(true);}
    var f=NewFeature(d,before);if(f==null)throw new Exception("Move/Copy Body failed ("+(isRot?"rotation":"translation")+")");feats.Add(f.Name);}
   var mp1=(IMassProperty)d.Extension.CreateMassProperty();var cm1=((double[])mp1.CenterOfMass).Select(v=>Math.Round(v*1000,4)).ToArray();
   // Codex review: same units on both sides (m3): 1e-7 relative plus 1e-15 m3 (0.000001 mm3) absolute
   if(double.IsNaN(mp1.Volume)||double.IsInfinity(mp1.Volume)||Math.Abs(mp1.Volume-vol0)>1e-7*Math.Abs(vol0)+1e-15)throw new Exception("Volume changed after moving the body ("+vol0*1e9+" -> "+mp1.Volume*1e9+" mm3); undo it");
   result=new{features=feats.ToArray(),center_of_mass_before_mm=cm0,center_of_mass_after_mm=cm1,volume_mm3=Math.Round(mp1.Volume*1e9,4),inspection=Checked(d)};return true;
  }
  if(op=="shell"){
   NewName(d,a);var before=FeatureNames(d);
   try{
    d.ClearSelection2(true);
    if(a.ContainsKey("face_references"))foreach(var r in Items(a["face_references"]).Select(Convert.ToString))SelectMarked(d,FaceRef(d,r,"face_references"),0,"face to remove");
    d.InsertFeatureShell(Num(a,"thickness_mm")/1000,Flag(a,"outward"));
   }finally{d.ClearSelection2(true);}
   var f=NewFeature(d,before);if(f==null)throw new Exception("Shell failed: thickness may be larger than the smallest radius/wall, or a face cannot be removed");
   result=new{feature=f.Name,type=f.GetTypeName2(),inspection=Checked(d)};return true;
  }
  if(op=="rib"){
   NewName(d,a);var sk=SketchFeature(d,Str(a,"sketch"));var before=FeatureNames(d);
   try{
    d.ClearSelection2(true);if(!sk.Select2(false,0))throw new Exception("Cannot select the rib sketch");
    d.FeatureManager.InsertRib(Flag(a,"two_sided",true),Flag(a,"flip_thickness"),Num(a,"thickness_mm")/1000,0,Flag(a,"flip_material"),false,false,0,Flag(a,"normal_to_sketch"),false);
   }finally{d.ClearSelection2(true);}
   var f=NewFeature(d,before);if(f==null)throw new Exception("Rib failed: the open sketch must be able to reach the walls in the material direction (try flip_material)");
   result=new{feature=f.Name,type=f.GetTypeName2(),inspection=Checked(d)};return true;
  }
  if(op=="draft"){
   NewName(d,a);IFeature f;
   try{
    d.ClearSelection2(true);
    SelectMarked(d,FaceRef(d,Str(a,"neutral_face_reference"),"neutral_face_reference"),1,"neutral plane face");
    foreach(var r in Items(a["face_references"]).Select(Convert.ToString))SelectMarked(d,FaceRef(d,r,"face_references"),2,"face to draft");
    f=d.FeatureManager.InsertMultiFaceDraft(Num(a,"angle_deg")*Math.PI/180,Flag(a,"flip"),false,0,false,false);
   }finally{d.ClearSelection2(true);}
   if(f==null)throw new Exception("Draft failed: faces must meet the neutral plane face");
   result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="helix"){
   NewName(d,a);var sk=SketchFeature(d,Str(a,"sketch"));
   var segs=((object[])((ISketch)sk.GetSpecificFeature2()).GetSketchSegments()??new object[0]).Cast<ISketchSegment>().Where(s=>!s.ConstructionGeometry).ToList();
   if(segs.Count!=1||!(segs[0] is ISketchArc)||((ISketchArc)segs[0]).IsCircle()!=1)throw new Exception("The helix sketch must contain exactly one circle (its diameter and centre define the helix)");
   var before=FeatureNames(d);
   try{
    d.ClearSelection2(true);if(!sk.Select2(false,0))throw new Exception("Cannot select the helix sketch");
    d.InsertHelix(Flag(a,"reverse"),Flag(a,"clockwise"),false,false,(int)swHelixDefinedBy_e.swHelixDefinedByPitchAndRevolution,0,Num(a,"pitch_mm")/1000,Num(a,"revolutions"),0,(a.ContainsKey("start_angle_deg")?Num(a,"start_angle_deg"):0)*Math.PI/180);
   }finally{d.ClearSelection2(true);}
   var f=NewFeature(d,before);if(f==null)throw new Exception("Helix failed");
   result=new{feature=f.Name,type=f.GetTypeName2(),height_mm=Num(a,"pitch_mm")*Num(a,"revolutions"),inspection=Checked(d)};return true;
  }
  return false;
 }
}
