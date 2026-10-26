using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.11 (ideas from HarrierPigeon/Solidworks-MCP-Server):
//  wrap      — Envolver: a closed sketch on a plane tangent/parallel to a face wrapped onto that face (cylinder, cone or
//              extruded face): emboss (relieve), deboss/engrave (grabar) or scribe (only split lines), depth in mm.
//  boundary  — Recubrir por límite: like a loft but each profile pulls the shape across the whole surface (smoother
//              transitions than a loft). Profiles in order, optional guide curves in the second direction, boss or cut.
// Both verify the new feature exists, the part rebuilds and report volume before/after.
partial class Worker {
 static double PartVolumeMm3(IModelDoc2 d){try{return Math.Round(((IMassProperty)d.Extension.CreateMassProperty()).Volume*1e9,3);}catch{return -1;}}
 static bool TryWrapBoundary(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="wrap"&&op!="boundary")return false;
  if(d.GetType()!=1)throw new Exception(op+" works on a managed PART");
  double v0=PartVolumeMm3(d);var featsBefore=new HashSet<string>(AllFeatures(d).Select(x=>x.Name));
  IFeature f=null;
  if(op=="wrap"){
   var sk=SketchFeature(d,Str(a,"sketch"));string type=a.ContainsKey("type")?Str(a,"type"):"emboss";
   int t=type=="emboss"?(int)swWrapSketchType_e.swWrapSketchType_Emboss:type=="deboss"?(int)swWrapSketchType_e.swWrapSketchType_Engrave:type=="scribe"?(int)swWrapSketchType_e.swWrapSketchType_Scribe:-1;
   if(t<0)throw new Exception("type must be emboss, deboss or scribe");
   double depth=type=="scribe"?0:Num(a,"depth_mm")/1000;if(type!="scribe"&&depth<=0)throw new Exception("depth_mm must be > 0");
   var fp=Items(a["face_point_mm"]).Select(Convert.ToDouble).ToArray();
   var face=FaceAtPoint(d,fp);if(face==null)throw new Exception("No face of the part passes through face_point_mm "+string.Join(",",fp));
   try{
    d.ClearSelection2(true);var sm=(ISelectionMgr)d.SelectionManager;
    var sd1=(SelectData)sm.CreateSelectData();sd1.Mark=4;if(!sk.Select2(false,4))throw new Exception("Cannot select sketch "+sk.Name);
    var sd2=(SelectData)sm.CreateSelectData();sd2.Mark=1;if(!((IEntity)face).Select4(true,sd2))throw new Exception("Cannot select the target face");
    int method=a.ContainsKey("method")&&Str(a,"method")=="spline"?(int)swWrapMethods_e.swWrapMethods_SplineSurface:(int)swWrapMethods_e.swWrapMethods_Analytical;
    f=d.FeatureManager.InsertWrapFeature2(t,depth,Flag(a,"reverse"),method,0) as IFeature;
   }finally{d.ClearSelection2(true);}
   if(f==null)throw new Exception("Wrap failed: the sketch must be closed, on a plane parallel/tangent to the face, and the face must be cylindrical, conical or extruded (analytical) — try method spline");
  }else{
   var profiles=Items(a["profiles"]).Select(Convert.ToString).ToList();if(profiles.Count<2)throw new Exception("boundary needs at least 2 profiles");
   var guides=a.ContainsKey("guides")?Items(a["guides"]).Select(Convert.ToString).ToList():new List<string>();bool cut=Flag(a,"cut");
   // Type 1 = boss (SolidWorks' own boundary example). How the curves must be handed over is not settled by the docs (a
   // sketch selected by name returned null, tested): try sketch / contour selection with InsertNetBlend2 and InsertNetBlend
   // and keep the first feature whose volume moves the right way (boss grows, cut shrinks); anything else is deleted again
   var tried=new List<string>();
   foreach(bool contour in new[]{true,false})foreach(bool v2 in new[]{true,false})foreach(short ty in cut?new short[]{2,0}:new short[]{1}){if(f!=null)break;bool solid=true;tried.Add((contour?"contour":"sketch")+(v2?" NetBlend2":" NetBlend")+" type "+ty);
    try{
     d.ClearSelection2(true);var sm=(ISelectionMgr)d.SelectionManager;
     // each curve carries its own mark: direction + 8192*(index+1) (8193, 16385... in SolidWorks' own boundary example)
     Action<string,int> pick=(n,mark)=>{var s=SketchFeature(d,n);
      if(contour){var ct=((object[])((ISketch)s.GetSpecificFeature2()).GetSketchContours()??new object[0]).Cast<ISketchContour>().FirstOrDefault();var sd=(SelectData)sm.CreateSelectData();sd.Mark=mark;
       if(ct==null||!ct.Select2(true,sd))throw new Exception("Cannot select the contour of "+n);}
      else if(!d.Extension.SelectByID2(s.Name,"SKETCH",0,0,0,true,mark,null,0))throw new Exception("Cannot select "+n);};
     for(int i=0;i<profiles.Count;i++)pick(profiles[i],1+8192*(i+1));
     for(int i=0;i<guides.Count;i++)pick(guides[i],2+8192*(i+1));
     // like a recorded macro: per-curve data (no tangency) and per-direction influence (global = 32) must be set first,
     // without them InsertNetBlend2 returns null for any Type (tested)
     var fm=d.FeatureManager;
     for(short i=0;i<profiles.Count;i++)fm.SetNetBlendCurveData(0,i,(short)swBoundaryBossTangencyType_e.swBoundaryBossTangency_None,0,1,true);
     for(short i=0;i<guides.Count;i++)fm.SetNetBlendCurveData(1,i,(short)swBoundaryBossTangencyType_e.swBoundaryBossTangency_None,0,1,true);
     fm.SetNetBlendDirectionData(0,(short)swBoundaryBossCurveInfluenceType_e.swBoundaryBossCurve_GlobalInfluence,0,false,false);
     fm.SetNetBlendDirectionData(1,(short)swBoundaryBossCurveInfluenceType_e.swBoundaryBossCurve_GlobalInfluence,0,false,false);
     f=(v2?fm.InsertNetBlend2(ty,(short)profiles.Count,(short)guides.Count,false,0.0001,true,Flag(a,"merge",true),true,true,false,-1,-1,false,-1,false,false,-1,false,-1,false,solid)
      :fm.InsertNetBlend(ty,(short)profiles.Count,(short)guides.Count,false,0.0001,true,Flag(a,"merge",true),true,true,false,-1,-1,false,-1,false,false,-1,false,-1,true)) as IFeature;
    }catch(Exception ex){tried[tried.Count-1]+=" ("+ex.Message+")";f=null;}finally{d.ClearSelection2(true);}
    if(f==null){tried[tried.Count-1]+=" → null";continue;}
    double dv=PartVolumeMm3(d)-v0;tried[tried.Count-1]+=" → "+f.Name+" dV "+Math.Round(dv,1);if(cut?dv<-1e-6:dv>1e-6)break;
    d.ClearSelection2(true);if(f.Select2(false,0))d.Extension.DeleteSelection2(0);d.ClearSelection2(true);f=null;}
   // known limit (2026 SP3.2 Standard, tested): every variant returns null for two sketch profiles that sw_loft joins fine
   if(f==null)throw new Exception("Boundary failed ("+string.Join(", ",tried)+"). In SolidWorks 2026 SP3.2 the API refused even profiles that a loft accepts: use sw_loft with the same profiles (and guides) instead. Profiles must be closed, in order and on different planes; guides must touch every profile"+(cut?"; a cut must intersect the body":""));
  }
  d.ForceRebuild3(false);
  var newFeats=AllFeatures(d).Where(x=>!featsBefore.Contains(x.Name)).Select(x=>x.Name).ToArray();
  double v1=PartVolumeMm3(d);
  result=new{feature=f.Name,new_features=newFeats,volume_before_mm3=v0,volume_after_mm3=v1,volume_change_mm3=Math.Round(v1-v0,3),inspection=Checked(d)};return true;
 }
 // first solid-body face that contains the point (part coordinates, mm)
 static IFace2 FaceAtPoint(IModelDoc2 d,double[] pmm){
  var q=pmm.Select(v=>v/1000).ToArray();IFace2 best=null;double bd=1e-5;
  foreach(IBody2 b in (object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,false)??new object[0])
   foreach(IFace2 fc in (object[])b.GetFaces()??new object[0]){var cp=(double[])fc.GetClosestPointOn(q[0],q[1],q[2]);if(cp==null)continue;double dd=Math.Sqrt(Math.Pow(cp[0]-q[0],2)+Math.Pow(cp[1]-q[1],2)+Math.Pow(cp[2]-q[2],2));if(dd<bd){bd=dd;best=fc;}}
  return best;
 }
}
