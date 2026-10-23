using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.5 extrude_edit: change an EXISTING extrusion (boss or cut) without rebuilding it: end condition of direction 1
// (blind / mid_plane / through_all), depth and reverse direction, through IExtrudeFeatureData2 + ModifyDefinition.
// Typical use: a part extruded with "plano medio" whose plane must be a face (the plane-based mate then rests it on the
// other part). Guarded like every edit; returns the definition before and after and the faces the feature now makes.
partial class Worker {
 static readonly Dictionary<string,swEndConditions_e> ExEnds=new Dictionary<string,swEndConditions_e>{{"blind",swEndConditions_e.swEndCondBlind},{"mid_plane",swEndConditions_e.swEndCondMidPlane},{"through_all",swEndConditions_e.swEndCondThroughAll}};
 static object ExState(IExtrudeFeatureData2 ex){return new{end_condition=Enum.GetName(typeof(swEndConditions_e),ex.GetEndCondition(true)),depth_mm=Math.Round(ex.GetDepth(true)*1000,6),reverse=ex.ReverseDirection,both_directions=ex.BothDirections};}
 static bool TryExtrudeEdit(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="extrude_edit")return false;
  if(!a.ContainsKey("end_condition")&&!a.ContainsKey("depth_mm")&&!a.ContainsKey("reverse"))throw new Exception("Nothing to change: give end_condition, depth_mm and/or reverse");
  var f=AllFeatures(d).FirstOrDefault(x=>x.Name==Str(a,"name"));if(f==null)throw new Exception("Feature not found: "+Str(a,"name"));
  var ex=f.GetDefinition() as IExtrudeFeatureData2;if(ex==null)throw new Exception(f.Name+" is not an extrusion");
  if(ex.BothDirections&&a.ContainsKey("end_condition")&&Str(a,"end_condition")!="mid_plane")throw new Exception(f.Name+" extrudes in both directions; this tool only edits direction 1");
  var before=ExState(ex);
  if(!ex.AccessSelections(d,null))throw new Exception("Cannot edit "+f.Name+" (selection access refused, e.g. suppressed)");
  bool ok=false;
  try{
   if(a.ContainsKey("end_condition")){swEndConditions_e ec;if(!ExEnds.TryGetValue(Str(a,"end_condition"),out ec))throw new Exception("end_condition must be blind, mid_plane or through_all");ex.SetEndCondition(true,(int)ec);}
   if(a.ContainsKey("depth_mm")){double mm=Num(a,"depth_mm");if(!(mm>0)||mm>10000)throw new Exception("depth_mm must be > 0");ex.SetDepth(true,mm/1000);}
   if(a.ContainsKey("reverse"))ex.ReverseDirection=Flag(a,"reverse");
   ok=f.ModifyDefinition(ex,d,null);
  }finally{if(!ok)try{ex.ReleaseSelectionAccess();}catch{}}
  if(!ok)throw new Exception("SolidWorks rejected the new definition of "+f.Name+" (nothing changed)");
  d.ForceRebuild3(false);
  var now=f.GetDefinition() as IExtrudeFeatureData2;bool warn;int code=f.GetErrorCode2(out warn);
  if(code!=0&&!warn)throw new Exception(f.Name+" fails with the new definition: "+(Enum.GetName(typeof(swFeatureError_e),code)??code.ToString()));
  // v3.6 review: the definition SolidWorks kept must be the one requested (a mismatch throws, so Guarded undoes the edit)
  if(now==null)throw new Exception("Cannot read "+f.Name+" back after the edit");
  if(a.ContainsKey("end_condition")&&now.GetEndCondition(true)!=(int)ExEnds[Str(a,"end_condition")])throw new Exception(f.Name+" kept end condition "+Enum.GetName(typeof(swEndConditions_e),now.GetEndCondition(true))+" instead of "+Str(a,"end_condition"));
  if(a.ContainsKey("depth_mm")&&now.GetEndCondition(true)!=(int)swEndConditions_e.swEndCondThroughAll&&Math.Abs(now.GetDepth(true)*1000-Num(a,"depth_mm"))>1e-6)throw new Exception(f.Name+" kept depth "+(now.GetDepth(true)*1000)+" mm instead of "+Num(a,"depth_mm"));
  if(a.ContainsKey("reverse")&&now.ReverseDirection!=Flag(a,"reverse"))throw new Exception(f.Name+" did not take reverse="+Flag(a,"reverse"));
  var faces=new List<object>();try{foreach(IFace2 fc in (object[])f.GetFaces()??new object[0]){var su=(ISurface)fc.GetSurface();if(su.IsPlane())faces.Add(new{area_mm2=Math.Round(fc.GetArea()*1e6,4),plane=FiPlane((double[])su.PlaneParams)});}}catch{}
  result=new{feature=f.Name,before=before,after=now==null?null:ExState(now),error_code=code,is_warning=warn,planar_faces=faces,note="Compare volume before saving; check on which side the material went (planar_faces)."};
  return true;
 }
}
