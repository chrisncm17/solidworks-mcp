using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.0: sheet_metal (chapa metálica) on a managed part:
//  base_flange  — closed (or open + depth) profile sketch → Base-Flange via CreateDefinition(swFmBaseFlange) (the legacy
//                 InsertSheetMetalBaseFlange2 returns null on SolidWorks 2026); thickness, bend radius, K-factor.
//  edge_flange  — straight edge picked by a point in PART coordinates → profile sketch (InsertSketchForEdgeFlange) →
//                 InsertSheetMetalEdgeFlange2 → length forced through ModifyDefinition (the generated sketch has a default length).
//  flatten      — unsuppress (flat=true) or suppress the Flat-Pattern feature, which is what the Flatten button does.
//  export_flat  — flat pattern to a new DXF/DWG in generated (IPartDoc.ExportToDWG2, geometry + bend lines).
partial class Worker {
 static IFeature FlatPatternFeature(IModelDoc2 d){var all=AllFeatures(d).Where(f=>f.GetTypeName2()=="FlatPattern").ToList();if(all.Count>1)throw new Exception("The part has "+all.Count+" sheet metal bodies (flat patterns); only single-body sheet metal is supported");return all.FirstOrDefault();}
 static IEdge EdgeAtLocalPoint(IModelDoc2 d,double[] p){
  var hits=new List<IEdge>();
  foreach(IBody2 b in (object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0])
   foreach(IEdge e in (object[])b.GetEdges()??new object[0]){var cp=(double[])e.GetClosestPointOn(p[0],p[1],p[2]);if(cp!=null&&Math.Sqrt(Math.Pow(cp[0]-p[0],2)+Math.Pow(cp[1]-p[1],2)+Math.Pow(cp[2]-p[2],2))<=1e-5)hits.Add(e);}
  if(hits.Count==0)throw new Exception("No edge passes through ("+string.Join(", ",p.Select(v=>Math.Round(v*1000,4)))+") mm; use sw_topology to find the sheet edge");
  if(hits.Count>1)throw new Exception(hits.Count+" edges pass through that point (a corner?); pick a point in the middle of one edge");
  if(!((ICurve)hits[0].GetCurve()).IsLine())throw new Exception("The edge must be straight for an edge flange");
  return hits[0];
 }
 static bool TrySheetMetal(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  // v3.9 save_body: one solid body of a multibody part (picked by a point inside it or on its surface, or by index) to a NEW
  // managed part (IPartDoc.SaveToFile3); the source part is not changed. The new part is opened and returned.
  if(op=="save_body"){
   if(d.GetType()!=1)throw new Exception("save_body needs a part");
   var bodies=((object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0]).Cast<IBody2>().ToList();
   if(bodies.Count==0)throw new Exception("The part has no solid body");
   IBody2 body;
   if(a.ContainsKey("point_mm")){var p=Items(a["point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();
    // point_mm must lie ON the surface of the body (or use body_index)
    var hits=bodies.Where(b=>((object[])b.GetFaces()??new object[0]).Cast<IFace2>().Any(f=>{var cp=(double[])f.GetClosestPointOn(p[0],p[1],p[2]);return cp!=null&&Math.Sqrt(Math.Pow(cp[0]-p[0],2)+Math.Pow(cp[1]-p[1],2)+Math.Pow(cp[2]-p[2],2))<=1e-5;})).ToList();
    // Codex review: a bounding box is not the solid (a point in the hole of a tube is inside its box): surface points only
    if(hits.Count!=1)throw new Exception(hits.Count==0?"No body surface passes through that point (give a point ON one face of the body, or body_index)":"Several bodies touch that point; pick a point on a face of only one");body=hits[0];}
   else{int i=a.ContainsKey("body_index")?Convert.ToInt32(a["body_index"]):0;if(i<0||i>=bodies.Count)throw new Exception("body_index 0.."+(bodies.Count-1));body=bodies[i];}
   string path=OutputPath(Str(a,"name"),new[]{".sldprt"});
   d.ClearSelection2(true);if(!body.Select2(false,null))throw new Exception("Cannot select the body");
   int e=0,w=0;bool ok=((IPartDoc)d).SaveToFile3(path,0,0,false,"",out e,out w);d.ClearSelection2(true);
   if(!ok||!File.Exists(path))throw new Exception("SaveToFile3 failed ("+e+")");
   var nd=(IModelDoc2)sw.GetOpenDocumentByName(path);int oe=0,ow=0;if(nd==null)nd=(IModelDoc2)sw.OpenDoc6(path,1,1,"",ref oe,ref ow);
   if(nd==null)throw new Exception("The body was saved to "+path+" but it cannot be opened");
   string id=Guid.NewGuid().ToString("N");owned.Add(id,nd);int act=0;sw.ActivateDoc3(d.GetTitle(),false,1,ref act);
   var mp=(IMassProperty2)nd.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();
   result=new{document_id=id,path=path,bodies_in_source=bodies.Count,volume_mm3=Math.Round(mp.Volume*1e9,4),note="The new part is linked to the source body (derived part). Assign or check its material before reading mass."};return true;
  }
  if(op!="sheet_metal")return false;
  if(d.GetType()!=1)throw new Exception("sheet_metal needs a managed part");
  string action=Str(a,"action");var fm=d.FeatureManager;
  var before=new HashSet<string>(AllFeatures(d).Select(f=>f.Name));
  Func<object> report=()=>{var flat=FlatPatternFeature(d);var created=AllFeatures(d).Where(f=>!before.Contains(f.Name)).Select(f=>f.Name).ToArray();return new{action=action,created_features=created,flattened=flat!=null&&!flat.IsSuppressed(),inspection=Checked(d)};};
  if(action=="base_flange"){
   if(FlatPatternFeature(d)!=null)throw new Exception("The part is already sheet metal; use edge_flange");
   var sk=SketchFeature(d,Str(a,"sketch"));double t=Num(a,"thickness_mm")/1000,r=a.ContainsKey("bend_radius_mm")?Num(a,"bend_radius_mm")/1000:t,k=a.ContainsKey("k_factor")?Num(a,"k_factor"):0.5;
   if(k<=0||k>=1)throw new Exception("k_factor must be between 0 and 1");
   d.ClearSelection2(true);if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);
   var bf=fm.CreateDefinition((int)swFeatureNameID_e.swFmBaseFlange) as IBaseFlangeFeatureData;if(bf==null)throw new Exception("CreateDefinition(BaseFlange) returned null");
   bf.OverrideThickness=true;bf.Thickness=t;bf.OverrideRadius=true;bf.BendRadius=r;bf.OverrideKFactor=true;bf.KFactor=k;
   bool rev=Flag(a,"reverse");bf.ReverseThickness=rev;bf.ReverseDirection=rev;
   if(a.ContainsKey("depth_mm")){bf.D1EndConditionType=(int)swEndConditions_e.swEndCondBlind;bf.D1EndConditionDistance=Num(a,"depth_mm")/1000;}
   var f=fm.CreateFeature(bf) as IFeature;d.ClearSelection2(true);
   if(f==null)throw new Exception("Base flange failed (closed profile sketch? for an open profile give depth_mm)");
   d.EditRebuild3();result=report();return true;
  }
  if(action=="edge_flange"){
   if(FlatPatternFeature(d)==null)throw new Exception("Not a sheet metal part; create a base_flange first");
   var flat=FlatPatternFeature(d);if(!flat.IsSuppressed())throw new Exception("Fold the part first (flatten with flat=false)");
   var p=Items(a["edge_point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();var edge=EdgeAtLocalPoint(d,p);
   double len=Num(a,"length_mm")/1000,ang=(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):90)*Math.PI/180;
   string pos=a.ContainsKey("position")?Str(a,"position"):"material_inside";
   int bp=pos=="material_outside"?(int)swFlangePositionTypes_e.swFlangePositionTypeMaterialOutside:pos=="bend_outside"?(int)swFlangePositionTypes_e.swFlangePositionTypeBendOutside:(int)swFlangePositionTypes_e.swFlangePositionTypeMaterialInside;
   // everything this call creates is removed again if any step fails (never a half-made flange or an orphan sketch)
   Action undo=()=>{
    if(d.SketchManager.ActiveSketch!=null)try{d.SketchManager.InsertSketch(true);}catch{}
    foreach(var nf in AllFeatures(d).Where(x=>!before.Contains(x.Name)).Reverse().ToList()){d.ClearSelection2(true);try{if(nf.Select2(false,0))d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed);}catch{}}
    d.ClearSelection2(true);d.EditRebuild3();
    var left=AllFeatures(d).Where(x=>!before.Contains(x.Name)).Select(x=>x.Name).ToArray();
    if(left.Length>0)throw new Exception("Edge flange failed and these features could NOT be removed: "+string.Join(", ",left)+"; delete them (sw_delete_feature) or close without saving");};
   IFeature f=null;double got=double.NaN;
   try{
    var sk=d.InsertSketchForEdgeFlange(edge,ang,Flag(a,"flip")) as IFeature;
    if(d.SketchManager.ActiveSketch!=null)d.SketchManager.InsertSketch(true);
    if(sk==null)throw new Exception("Could not create the edge flange profile (is it a long boundary edge of the sheet, not a thickness edge?)");
    d.ClearSelection2(true);((IEntity)edge).Select4(false,null);
    int opts=(int)(swInsertEdgeFlangeOptions_e.swInsertEdgeFlangeUseDefaultRadius|swInsertEdgeFlangeOptions_e.swInsertEdgeFlangeUseReliefRatio|swInsertEdgeFlangeOptions_e.swInsertEdgeFlangeUseDefaultRelief);
    if(Flag(a,"flip"))opts|=(int)swInsertEdgeFlangeOptions_e.swInsertEdgeFlangeFlipDir;
    f=fm.InsertSheetMetalEdgeFlange2(new Edge[]{(Edge)edge},new Feature[]{(Feature)sk},opts,ang,0,bp,len,(int)swSheetMetalReliefTypes_e.swSheetMetalReliefRectangular,0.5,0.001,0.001,0,null) as IFeature;
    d.ClearSelection2(true);
    if(f==null)throw new Exception("InsertSheetMetalEdgeFlange2 returned no feature");
    // the generated profile has a default length: force the requested one
    var def=f.GetDefinition() as IEdgeFlangeFeatureData;if(def==null||!def.AccessSelections(d,null))throw new Exception("Cannot edit the flange definition to set its length");
    bool modified=false;try{def.OffsetDistance=len;modified=f.ModifyDefinition(def,d,null);}finally{if(!modified)def.ReleaseSelectionAccess();}
    if(!modified)throw new Exception("Could not set the flange length");
    d.EditRebuild3();
    var after=f.GetDefinition() as IEdgeFlangeFeatureData;got=after==null?double.NaN:after.OffsetDistance;
    if(!(Math.Abs(got-len)<1e-7))throw new Exception("Flange length is "+Math.Round(got*1000,4)+" mm, not "+len*1000+" mm");
    Checked(d);
   }catch(Exception ex){undo();throw new Exception("Edge flange failed, nothing was left in the tree: "+ex.Message);}
   result=new{report=report(),edge_flange=f.Name,length_mm=Math.Round(got*1000,4)};return true;
  }
  if(action=="flatten"){
   var flat=FlatPatternFeature(d);if(flat==null)throw new Exception("No Flat-Pattern feature: not a sheet metal part");
   bool wantFlat=!a.ContainsKey("flat")||Flag(a,"flat");
   flat.SetSuppression2(wantFlat?(int)swFeatureSuppressionAction_e.swUnSuppressFeature:(int)swFeatureSuppressionAction_e.swSuppressFeature,(int)swInConfigurationOpts_e.swThisConfiguration,null);
   d.EditRebuild3();if(flat.IsSuppressed()==wantFlat)throw new Exception("Could not "+(wantFlat?"flatten":"fold")+" the part");
   result=report();return true;
  }
  if(action=="export_flat"){
   if(FlatPatternFeature(d)==null)throw new Exception("Not a sheet metal part");
   if(d.GetSaveFlag())throw new Exception("Save the part first (sw_save); the flat pattern is exported from the saved file");
   string path=OutputPath(Str(a,"name"),new[]{".dxf",".dwg"});
   // geometry (bit 0) + bend lines (bit 2)
   bool ok=((IPartDoc)d).ExportToDWG2(path,d.GetPathName(),(int)swExportToDWG_e.swExportToDWG_ExportSheetMetal,true,null,false,false,1|4,null);
   if(!ok||!File.Exists(path))throw new Exception("Flat pattern export failed");
   result=new{path=path,bytes=new FileInfo(path).Length,source=d.GetPathName()};return true;
  }
  // v3.9 sketched bend (Pliegue croquizado): a sketch with the bend line(s) drawn on a flat face of the folded sheet; the
  // face through fixed_point_mm stays in place. hem (Dobladillo): on a straight sheet edge picked by a point.
  if(action=="sketched_bend"||action=="hem"){
   var flat=FlatPatternFeature(d);if(flat==null)throw new Exception("Not a sheet metal part; create a base_flange first");if(!flat.IsSuppressed())throw new Exception("Fold the part first (flatten with flat=false)");
   Action undo=()=>{
    foreach(var nf in AllFeatures(d).Where(x=>!before.Contains(x.Name)).Reverse().ToList()){d.ClearSelection2(true);try{if(nf.Select2(false,0))d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed);}catch{}}
    d.ClearSelection2(true);d.EditRebuild3();};
   IFeature f=null;
   try{
    d.ClearSelection2(true);
    if(action=="sketched_bend"){
     var sk=SketchFeature(d,Str(a,"sketch"));var fp=Items(a["fixed_point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();var face=PlanarFaceAt(d,fp);
     string pos=a.ContainsKey("position")?Str(a,"position"):"material_inside";if(pos!="material_inside"&&pos!="material_outside"&&pos!="bend_outside")throw new Exception("sketched_bend position: material_inside (default), material_outside or bend_outside");
     short bp=(short)(pos=="material_inside"?swFlangePositionTypes_e.swFlangePositionTypeMaterialInside:pos=="material_outside"?swFlangePositionTypes_e.swFlangePositionTypeMaterialOutside:swFlangePositionTypes_e.swFlangePositionTypeBendOutside);
     if(!sk.Select2(false,0))throw new Exception("Cannot select sketch "+sk.Name);
     var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=0;if(!((IEntity)face).Select4(true,sd))throw new Exception("Cannot select the fixed face");
     bool defR=!a.ContainsKey("bend_radius_mm");
     f=fm.InsertSheetMetal3dBend((a.ContainsKey("angle_deg")?Num(a,"angle_deg"):90)*Math.PI/180,defR,defR?0:Num(a,"bend_radius_mm")/1000,Flag(a,"flip"),bp,null) as IFeature;
     if(f==null)throw new Exception("SolidWorks did not create the sketched bend (one straight line on a flat face of the sheet, fixed point on that face?)");}
    else{
     var p=Items(a["edge_point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();var edge=EdgeAtLocalPoint(d,p);
     string type=a.ContainsKey("hem_type")?Str(a,"hem_type"):"closed";
     int ht=type=="open"?(int)swHemTypes_e.swHemTypeOpen:type=="teardrop"?(int)swHemTypes_e.swHemTypeTearDrop:type=="rolled"?(int)swHemTypes_e.swHemTypeRolled:(int)swHemTypes_e.swHemTypeClosed;
     int hp=a.ContainsKey("position")&&Str(a,"position")=="outside"?(int)swHemPositionTypes_e.swHemPositionTypeOutside:(int)swHemPositionTypes_e.swHemPositionTypeInside;
     ((IEntity)edge).Select4(false,null);
     f=fm.InsertSheetMetalHem2(ht,hp,Flag(a,"flip"),a.ContainsKey("length_mm")?Num(a,"length_mm")/1000:0.01,a.ContainsKey("gap_mm")?Num(a,"gap_mm")/1000:0.0001,(a.ContainsKey("angle_deg")?Num(a,"angle_deg"):200)*Math.PI/180,a.ContainsKey("bend_radius_mm")?Num(a,"bend_radius_mm")/1000:0.001,0,null,true,0,0,true,0.5,0.001,0.001) as IFeature;
     if(f==null)throw new Exception("SolidWorks did not create the hem (a long straight edge of the sheet, not a thickness edge?)");}
    d.ClearSelection2(true);d.EditRebuild3();
    bool warn;int code=f.GetErrorCode2(out warn);if(code!=0&&!warn)throw new Exception(f.Name+" has rebuild error "+code);
    Checked(d);
   }catch(Exception ex){d.ClearSelection2(true);undo();var left=AllFeatures(d).Where(x=>!before.Contains(x.Name)).Select(x=>x.Name).ToArray();
    throw new Exception((action=="hem"?"Hem":"Sketched bend")+" failed"+(left.Length>0?"; could NOT remove "+string.Join(", ",left):", nothing was left in the tree")+": "+ex.Message);}
   result=new{report=report(),feature=f.Name};return true;
  }
  throw new Exception("action: base_flange, edge_flange, flatten, export_flat, sketched_bend or hem");
 }
}
