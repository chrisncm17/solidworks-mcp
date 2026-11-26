using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.16 from the SolidWorks training manual on advanced part modeling, what the connector could not do yet:
//  sketch_3d       a path that is not in one plane: polyline (optional corner fillets) or spline through points
//  dome            Cúpula on a planar face
//  split_line      Línea de partición: a sketch projected onto faces, so a part of a face can be treated on its own
//  draft_analysis  read only, what a mold needs: each face against the pull direction (positive, negative, needs draft, straddle)
partial class Worker {
 static double[] Xyz(object o,string what){var p=Items(o).Select(Convert.ToDouble).ToArray();if(p.Length!=3)throw new Exception(what+" must be [x, y, z] in mm");return p;}
 static bool TryAdvanced(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="sketch_3d"&&op!="dome"&&op!="split_line"&&op!="draft_analysis")return false;
  if(d.GetType()!=1)throw new Exception(op+" works on a managed PART");
  if(op=="sketch_3d"){
   var pts=Items(a["points_mm"]).Select(o=>Xyz(o,"points_mm")).ToList();string type=Str2(a,"type","polyline");
   if(pts.Count<2)throw new Exception("points_mm needs at least 2 points");
   // v3.21 closed: the last point returns to the first (a closed spline is a loft profile; a closed polyline a planar loop)
   bool closed=Flag(a,"closed");
   if(closed){if(pts.Count<3)throw new Exception("closed needs at least 3 points");var f0=pts[0];var fl=pts[pts.Count-1];
    if(Math.Sqrt(Math.Pow(f0[0]-fl[0],2)+Math.Pow(f0[1]-fl[1],2)+Math.Pow(f0[2]-fl[2],2))>1e-9)pts.Add(new[]{f0[0],f0[1],f0[2]});}
   var before=FeatureNames(d);var sm=d.SketchManager;bool db=sm.AddToDB,show=sm.DisplayWhenAdded;var segs=new List<ISketchSegment>();
   try{
    d.ClearSelection2(true);sm.AddToDB=true;sm.DisplayWhenAdded=false;sm.Insert3DSketch(true);
    if(type=="spline"){var flat=pts.SelectMany(p=>p.Select(v=>v/1000)).ToArray();var s=sm.CreateSpline2(flat,false);if(s==null)throw new Exception("SolidWorks did not create the spline");}
    else for(int i=0;i+1<pts.Count;i++){var l=sm.CreateLine(pts[i][0]/1000,pts[i][1]/1000,pts[i][2]/1000,pts[i+1][0]/1000,pts[i+1][1]/1000,pts[i+1][2]/1000);if(l==null)throw new Exception("SolidWorks did not create segment "+i);segs.Add(l);}
    // a sweep needs a path without sharp corners unless its profile allows them
    if(a.ContainsKey("fillet_mm")&&type!="spline")for(int i=1;i<pts.Count-1;i++){
     d.ClearSelection2(true);var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();
     if(!segs[i-1].Select4(true,sd)||!segs[i].Select4(true,sd))throw new Exception("Cannot select the corner "+i);
     if(sm.CreateFillet(Num(a,"fillet_mm")/1000,(int)swConstrainedCornerAction_e.swConstrainedCornerInteract)==null)throw new Exception("Corner "+i+" does not fit a fillet of "+Num(a,"fillet_mm")+" mm");}
   }finally{d.ClearSelection2(true);sm.Insert3DSketch(true);sm.AddToDB=db;sm.DisplayWhenAdded=show;}
   var f=AllFeatures(d).LastOrDefault(x=>!before.Contains(x.Name)&&x.GetTypeName2()=="3DProfileFeature");if(f==null)throw new Exception("The 3D sketch was not created");
   result=new{feature=f.Name,type=type,closed=closed,points=pts.Count,segments=((object[])((ISketch)f.GetSpecificFeature2()).GetSketchSegments()??new object[0]).Length,note="Use it as path or guide of sw_sweep or as guide of sw_loft. Unsaved until sw_save."};return true;
  }
  if(op=="draft_analysis"){
   var dir=Xyz(a["direction"],"direction");double n=Math.Sqrt(dir.Sum(v=>v*v));if(n<1e-9)throw new Exception("direction has no length");dir=dir.Select(v=>v/n).ToArray();
   double need=a.ContainsKey("min_draft_deg")?Num(a,"min_draft_deg"):1;
   var rows=new List<object>();var count=new Dictionary<string,int>{{"positive",0},{"negative",0},{"requires_draft",0},{"straddle",0}};var area=new Dictionary<string,double>(count.ToDictionary(k=>k.Key,k=>0.0));
   foreach(object bo in (object[])((IPartDoc)d).GetBodies2((int)swBodyType_e.swSolidBody,true)??new object[0])
    foreach(object fo in (object[])((IBody2)bo).GetFaces()??new object[0]){
     var face=(IFace2)fo;var norms=face.GetTessNorms() as float[];if(norms==null||norms.Length<3)continue;
     double lo=90,hi=-90;for(int i=0;i+2<norms.Length;i+=3){double c=norms[i]*dir[0]+norms[i+1]*dir[1]+norms[i+2]*dir[2];double ang=Math.Asin(Math.Max(-1,Math.Min(1,c)))*180/Math.PI;if(ang<lo)lo=ang;if(ang>hi)hi=ang;}
     // a cylinder along the pull has no draft: within need on both ends, it comes out of neither half without help
     string cls=lo>=need?"positive":hi<=-need?"negative":lo<=-need&&hi>=need?"straddle":"requires_draft";
     count[cls]++;area[cls]+=face.GetArea()*1e6;var box=(double[])face.GetBox();
     rows.Add(new{cls=cls,min_deg=Math.Round(lo,2),max_deg=Math.Round(hi,2),area_mm2=Math.Round(face.GetArea()*1e6,2),center_mm=new[]{Math.Round((box[0]+box[3])*500,3),Math.Round((box[1]+box[4])*500,3),Math.Round((box[2]+box[5])*500,3)}});}
   int max=a.ContainsKey("max_faces")?Convert.ToInt32(a["max_faces"]):100;
   result=new{pull_direction=dir.Select(v=>Math.Round(v,4)).ToArray(),min_draft_deg=need,faces=count,area_mm2=area.ToDictionary(k=>k.Key,k=>Math.Round(k.Value,2)),moldable_without_changes=count["requires_draft"]==0&&count["straddle"]==0,
    details=rows.Cast<dynamic>().Where(r=>r.cls=="requires_draft"||r.cls=="straddle").Concat(rows.Cast<dynamic>().Where(r=>r.cls!="requires_draft"&&r.cls!="straddle")).Take(max).ToArray()};return true;
  }
  double v0=PartVolumeMm3(d);var had=FeatureNames(d);
  if(op=="dome"){
   var p=Xyz(a["face_point_mm"],"face_point_mm");var face=PlanarFaceAt(d,p.Select(v=>v/1000).ToArray());if(face==null)throw new Exception("No planar face passes through face_point_mm");
   // there is no definition for a dome: InsertDome with the face selected, plain and then with the mark some of the old calls want
   foreach(int mark in new[]{0,1}){try{d.ClearSelection2(true);if(!((IEntity)face).Select2(false,mark))throw new Exception("Cannot select the face of the dome");d.InsertDome(Num(a,"height_mm")/1000,Flag(a,"reverse"),Flag(a,"elliptical"));}finally{d.ClearSelection2(true);}if(NewFeature(d,had)!=null)break;}
   var f=NewFeature(d,had);if(f==null)throw new Exception("Dome failed: the height may not fit the face");
   result=new{feature=f.Name,type=f.GetTypeName2(),volume_before_mm3=v0,volume_after_mm3=PartVolumeMm3(d),inspection=Checked(d)};return true;
  }
  // split_line
  {bool inter=a.ContainsKey("tool_points_mm")||a.ContainsKey("tool_plane_index");
   if(inter==a.ContainsKey("sketch"))throw new Exception("split_line: give sketch (projection) or tool_points_mm / tool_plane_index (intersection), one of the two");
   var faces=Items(a["face_points_mm"]).Select(o=>{var p=Xyz(o,"face_points_mm");var x=FaceAtPoint(d,p)??AnyFaceAt(d,p,"face_points_mm");return x;}).ToList(); // v3.25 surface bodies too
   int f0=AllFaceCount(d);IFeature f=null;var tried=new List<string>();var toolNames=new List<string>();
   if(!inter){var sk=SketchFeature(d,Str(a,"sketch"));
    try{d.ClearSelection2(true);if(!sk.Select2(false,4))throw new Exception("Cannot select sketch "+sk.Name);foreach(var x in faces)SelectMarked(d,x,1,"face to split");d.InsertSplitLineProject(Flag(a,"reverse"),Flag(a,"single_direction"));}finally{d.ClearSelection2(true);}
    f=NewFeature(d,had);if(f==null)throw new Exception("Split line failed: the sketch must project onto the faces");}
   else{
    // v3.26 intersection: the faces are divided where planes or other bodies cross them (a band around a fuselage, where a
    // projection is tangent at the top and bottom). Which marks the call reads is not documented: the variants are tried in turn.
    var tools=a.ContainsKey("tool_points_mm")?Items(a["tool_points_mm"]).Select(o=>{var p=Xyz(o,"tool_points_mm");var h=BodiesOf(d,0).Concat(BodiesOf(d,1)).Select(b=>new{b,dd=BodyDistMm(b,p)}).OrderBy(x=>x.dd).FirstOrDefault();
     if(h==null||h.dd>0.05)throw new Exception("No body passes through tool_points_mm ["+string.Join(", ",p)+"]");return h.b;}).GroupBy(b=>b.Name).Select(g=>g.First()).ToList():new List<IBody2>();
    toolNames=tools.Select(b=>b.Name).ToList();
    IFeature plane=a.ContainsKey("tool_plane_index")?PlaneByIndex(d,Convert.ToInt32(a["tool_plane_index"])):null;
    foreach(int opt in new[]{0,1})foreach(int tm in new[]{0,1,2,4})foreach(int fmk in new[]{0,1,2,4}){
     if(f!=null||tm==fmk)continue;
     try{d.ClearSelection2(true);
      if(plane!=null&&!plane.Select2(true,tm))continue;
      foreach(var t in tools)Mark(d,t,tm,"tool "+t.Name);
      foreach(var x in faces)Mark(d,x,fmk,"face to split");
      f=d.FeatureManager.InsertSplitLineIntersect(opt) as IFeature??NewFeature(d,had);
      if(f!=null)tried.Add("intersection option "+opt+", tool mark "+tm+", faces mark "+fmk);
     }catch(Exception ex){if(tried.Count<3)tried.Add(ex.Message);}
     finally{d.ClearSelection2(true);}
    }
    if(f==null)throw new Exception("Split line by intersection failed: the planes or bodies must cross those faces"+(tried.Count>0?" ("+string.Join("; ",tried)+")":""));
    d.EditRebuild3();
   }
   int f1=AllFaceCount(d);if(f1<=f0)throw new Exception("The split line did not divide any face ("+f.Name+"): check that the "+(inter?"tools cross":"sketch falls on")+" those faces");
   // v3.26 hide_tools: the tool bodies of an intersection are hidden (they stay in the tree, the split line needs them)
   var hidden=new List<string>();
   if(inter&&Flag(a,"hide_tools"))foreach(var b in BodiesOf(d,0).Concat(BodiesOf(d,1)).Where(b=>toolNames.Contains(b.Name)).ToList()){b.HideBody(true);hidden.Add(b.Name);}
   if(hidden.Count>0){d.SetSaveFlag();d.GraphicsRedraw2();}
   result=new{feature=f.Name,type=f.GetTypeName2(),mode=inter?"intersection":"projection",faces_before=f0,faces_after=f1,tools=inter?toolNames.ToArray():null,hidden_tools=hidden.Count>0?hidden.ToArray():null,tried=tried.Count>0?tried.ToArray():null,inspection=Checked(d)};return true;}
 }
 static int AllFaceCount(IModelDoc2 d){return BodiesOf(d,0).Concat(BodiesOf(d,1)).Sum(b=>b.GetFaceCount());} // v3.25 surface bodies count too
}
