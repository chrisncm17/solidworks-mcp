using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

partial class Worker {
 class SelectionRef {public byte[] Data;public string Path;public int Stamp;}
 static readonly Dictionary<string,SelectionRef> refs=new Dictionary<string,SelectionRef>();
 static bool Flag(Dictionary<string,object>a,string k,bool fallback=false){return a.ContainsKey(k)?Convert.ToBoolean(a[k]):fallback;}
 static double OptionalNum(Dictionary<string,object>a,string k,double fallback=0){return a.ContainsKey(k)?Num(a,k):fallback;}
 static object[] Items(object value){return ((IEnumerable)value).Cast<object>().ToArray();}
 static IFeature Feature(IModelDoc2 d,string name){var f=(IFeature)((IPartDoc)d).FeatureByName(name);if(f==null)throw new Exception("Feature not found: "+name);return f;}
 // Geometry fingerprint of a sketch (segment end/center points and radii, meters) to prove dimensioning moved nothing.
 static List<double> SketchGeometry(ISketch sk){
  var r=new List<double>();
  foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0]){
   r.Add(s.GetType());
   if(s is ISketchLine){var l=(ISketchLine)s;foreach(ISketchPoint p in new[]{(ISketchPoint)l.GetStartPoint2(),(ISketchPoint)l.GetEndPoint2()}){r.Add(p.X);r.Add(p.Y);}}
   else if(s is ISketchArc){var c=(ISketchArc)s;foreach(ISketchPoint p in new[]{(ISketchPoint)c.GetStartPoint2(),(ISketchPoint)c.GetEndPoint2(),(ISketchPoint)c.GetCenterPoint2()}){r.Add(p.X);r.Add(p.Y);}r.Add(c.GetRadius());}}
  return r;
 }
 // Add relations + driving dimensions to the origin (SolidWorks "Fully Define Sketch"), keeping the geometry where it is.
 // Must run with the sketch ACTIVE. Fails (and removes nothing it cannot verify) if the sketch moved or is not fully defined.
 static object FullyDefine(IModelDoc2 d,ISketch sketch,IFeature sf){
  var before=SketchGeometry(sketch);
  bool prompt=sw.GetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate);int status;
  try{
   sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,false);d.ClearSelection2(true);
   int rel=(int)(swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Horizontal|swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Vertical|swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Tangent|swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Concentric|swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Coincident);
   // datum = a sketch point ON the part origin (FullyDefineSketch needs a datum inside the active sketch; otherwise it only adds sizes)
   var of=AllFeatures(d).FirstOrDefault(x=>x.GetTypeName2()=="OriginProfileFeature");string on=of==null?"Origin":of.Name;
   bool db=d.SketchManager.AddToDB;d.SketchManager.AddToDB=true;ISketchPoint origin;try{origin=d.SketchManager.CreatePoint(0,0,0);}finally{d.SketchManager.AddToDB=db;}
   if(origin==null)throw new Exception("Cannot create the datum point at the origin");
   d.ClearSelection2(true);if(!origin.Select4(false,null))throw new Exception("Cannot select the datum point");
   if(!d.Extension.SelectByID2("Point1@"+on,"EXTSKETCHPOINT",0,0,0,true,0,null,0))throw new Exception("Cannot select the part origin");
   int relBefore=((object[])sketch.RelationManager.GetRelations(0)??new object[0]).Length;d.SketchAddConstraints("sgCOINCIDENT");d.ClearSelection2(true);
   if(((object[])sketch.RelationManager.GetRelations(0)??new object[0]).Length<=relBefore)throw new Exception("The datum point could not be tied to the part origin");
   status=d.SketchManager.FullyDefineSketch(true,true,rel,true,(int)swAutodimScheme_e.swAutodimSchemeBaseline,origin,(int)swAutodimScheme_e.swAutodimSchemeBaseline,origin,(int)swAutodimHorizontalPlacement_e.swAutodimHorizontalPlacementBelow,(int)swAutodimVerticalPlacement_e.swAutodimVerticalPlacementLeft);
  }finally{sw.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,prompt);d.ClearSelection2(true);}
  if(status!=(int)swAutodimStatus_e.swAutodimStatusSuccess)throw new Exception("Fully define sketch failed: "+((swAutodimStatus_e)status));
  var after=SketchGeometry(sketch);double moved=before.Count!=after.Count?double.PositiveInfinity:before.Zip(after,(x,y)=>Math.Abs(x-y)).DefaultIfEmpty(0).Max();
  if(moved>1e-8)throw new Exception("Dimensioning moved the sketch geometry ("+Math.Round(moved*1000,6)+" mm)");
  int n=0;var dd=(IDisplayDimension)sf.GetFirstDisplayDimension();while(dd!=null&&n<1000){n++;dd=(IDisplayDimension)sf.GetNextDisplayDimension(dd);}
  int cs=sketch.GetConstrainedStatus();
  if(cs!=(int)swConstrainedStatus_e.swFullyConstrained)throw new Exception("Sketch is not fully defined after dimensioning (status "+cs+", "+n+" dimensions, "+((object[])sketch.RelationManager.GetRelations(0)??new object[0]).Length+" relations, active="+(d.SketchManager.ActiveSketch!=null)+")");
  return new{dimensions_added=n,fully_defined=true,max_geometry_change_mm=Math.Round(moved*1000,9)};
 }
 static IFeature SketchFeature(IModelDoc2 d,string name){var f=Feature(d,name);if(!(f.GetSpecificFeature2() is ISketch))throw new Exception("Not a sketch: "+name);return f;}
 static List<ISketchPoint> SegmentEndpoints(ISketch sk){
  var pts=new List<ISketchPoint>();
  foreach(ISketchSegment s in (object[])sk.GetSketchSegments()??new object[0]){
   var l=s as ISketchLine;if(l!=null){pts.Add((ISketchPoint)l.GetStartPoint2());pts.Add((ISketchPoint)l.GetEndPoint2());continue;}
   var c=s as ISketchArc;if(c!=null&&c.IsCircle()==0){pts.Add((ISketchPoint)c.GetStartPoint2());pts.Add((ISketchPoint)c.GetEndPoint2());}}
  return pts;}
 static string PointKey(ISketchPoint p){var id=(int[])p.GetID();return id[0]+":"+id[1];}
 // Merges endpoints that coincide (within 1e-8 m) but are separate sketch points. Call with the sketch active.
 // Unit normal of the sketch plane in model coordinates (sketch +Z mapped to the model).
 static double[] SketchNormal(ISketch sk){
  var inv=(MathTransform)((MathTransform)sk.ModelToSketchTransform).Inverse();var mu=(IMathUtility)sw.GetMathUtility();
  var v=(MathVector)((MathVector)mu.CreateVector(new double[]{0,0,1})).MultiplyTransform(inv);var n=(double[])v.ArrayData;
  double l=Math.Sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);return new[]{n[0]/l,n[1]/l,n[2]/l};
 }
 // Calibrated with direction-test.mjs (SolidWorks 2026): whether Dir=false goes AGAINST the sketch normal, and StartOffset sense.
 const bool ExtrudeReversed=false, CutReversed=true, StartOffsetFlipped=false;
 static double[] AxisVector(string s){var v=new double[3];v["XYZ".IndexOf(s[1])]=s[0]=='-'?-1:1;return v;}
 static ISketchSegment Seg(IModelDoc2 d,ISketchSegment s,string kind){if(s==null)throw new Exception("Sketch entity creation failed: "+kind);return s;}
 // The single joined vertex of the sketch at `at` (local mm); used by sketch fillets and chamfers.
 static ISketchPoint Corner(ISketch sketch,double[] at){
  var found=SegmentEndpoints(sketch).Where(sp=>Math.Abs(sp.X*1000-at[0])<1e-4&&Math.Abs(sp.Y*1000-at[1])<1e-4).GroupBy(PointKey).Select(g=>g.First()).ToList();
  if(found.Count==0)throw new Exception("No sketch corner at ("+at[0]+", "+at[1]+") mm");
  if(found.Count>1)throw new Exception("Ambiguous sketch corner at ("+at[0]+", "+at[1]+") mm: "+found.Count+" separate vertices (endpoints not joined)");
  return found[0];
 }
 static string Str2(Dictionary<string,object>a,string k,string def){return a.ContainsKey(k)?Str(a,k):def;}
 static int MergeCoincidentEndpoints(IModelDoc2 d,ISketch sk){
  int merged=0;
  for(int guard=0;guard<500;guard++){
   var pts=SegmentEndpoints(sk);ISketchPoint p1=null,p2=null;
   for(int i=0;i<pts.Count&&p1==null;i++)for(int j=i+1;j<pts.Count;j++){
    if(PointKey(pts[i])==PointKey(pts[j]))continue;
    if(Math.Abs(pts[i].X-pts[j].X)<1e-8&&Math.Abs(pts[i].Y-pts[j].Y)<1e-8&&Math.Abs(pts[i].Z-pts[j].Z)<1e-8){p1=pts[i];p2=pts[j];break;}}
   if(p1==null)break;
   d.ClearSelection2(true);p1.Select4(false,null);p2.Select4(true,null);d.SketchAddConstraints("sgMERGEPOINTS");d.ClearSelection2(true);merged++;
  }
  return merged;}
 static IEnumerable<IFeature> AllFeatures(IModelDoc2 d){
  var visited=new HashSet<string>();var stack=new Stack<IFeature>();IFeature f=(IFeature)d.FirstFeature();int limit=0;
  while(f!=null&&limit++<2000){stack.Push(f);f=(IFeature)f.GetNextFeature();}
  while(stack.Count>0){f=stack.Pop();if(!visited.Add(f.Name))continue;yield return f;var child=(IFeature)f.GetFirstSubFeature();limit=0;while(child!=null&&limit++<2000){stack.Push(child);child=(IFeature)child.GetNextSubFeature();}}
 }
 static void AvailableName(IModelDoc2 d,string name){if(((IPartDoc)d).FeatureByName(name)!=null)throw new Exception("Feature name already exists: "+name);}
 // name is optional: when omitted the feature keeps the SolidWorks default name (Croquis1, Saliente-Extruir1...), which the user prefers.
 static string NewName(IModelDoc2 d,Dictionary<string,object>a){if(a.ContainsKey("name"))throw new Exception("Features keep their SolidWorks default names (user rule): do not pass name");return null;}
 static void Rename(IFeature f,string n){if(n!=null)f.Name=n;}
 static string Token(IModelDoc2 d,object entity){
  byte[] data=(byte[])d.Extension.GetPersistReference3(entity);if(data==null||data.Length==0)throw new Exception("Cannot identify geometry persistently");
  string key=Guid.NewGuid().ToString("N");refs[key]=new SelectionRef{Data=data,Path=d.GetPathName(),Stamp=d.GetUpdateStamp()};return key;
 }
 static object Resolve(IModelDoc2 d,string key){
  SelectionRef r;if(!refs.TryGetValue(key,out r)||r.Path!=d.GetPathName()||r.Stamp!=d.GetUpdateStamp())throw new Exception("Geometry reference is stale or belongs to another document. Run sw_topology again.");
  int state=0;object entity=d.Extension.GetObjectByPersistReference3(r.Data,out state);if(entity==null||state!=0)throw new Exception("Geometry reference no longer resolves; inspect topology again.");return entity;
 }
 // v3.8 speed: edges picked by a point ON them, exactly (GetClosestPointOn), without listing the whole topology with persistent
 // references (2.7 s on a plate with 37 holes). Same rules as the IR: nearest edge within 0.5 mm, no tie closer than 0.05 mm.
 static void SelectEdgesAt(IModelDoc2 d,object input){
  var all=new List<IEdge>();foreach(IBody2 b in (object[])((IPartDoc)d).GetBodies2(0,false)??new object[0])foreach(IEdge e in (object[])b.GetEdges()??new object[0])all.Add(e);
  var pick=new List<IEdge>();int k=0;
  foreach(var it in Items(input)){var p=Items(it).Select(v=>Convert.ToDouble(v)/1000).ToArray();if(p.Length!=3)throw new Exception("edge_points_mm["+k+"]: [x,y,z] mm");
   var ranked=all.Select(e=>{var c=(double[])e.GetClosestPointOn(p[0],p[1],p[2]);return new{e,dist=c==null?double.MaxValue:Math.Sqrt(Math.Pow(c[0]-p[0],2)+Math.Pow(c[1]-p[1],2)+Math.Pow(c[2]-p[2],2))};}).OrderBy(x=>x.dist).ToList();
   string at=" ("+string.Join(", ",p.Select(v=>Math.Round(v*1000,4)))+") mm";
   if(ranked.Count==0||ranked[0].dist>0.5e-3)throw new Exception("edge_points_mm["+k+"]: no edge within 0.5 mm of"+at);
   if(ranked.Count>1&&ranked[1].dist-ranked[0].dist<0.05e-3)throw new Exception("edge_points_mm["+k+"]: the point"+at+" is as close to two edges; use a point on only one");
   if(!pick.Contains(ranked[0].e))pick.Add(ranked[0].e);k++;}
  d.ClearSelection2(true);foreach(var e in pick)if(!((IEntity)e).Select4(true,null))throw new Exception("Edge selection failed");
 }
 // v3.8 speed: planar face that contains a point (smallest one if several, like pickPlanarFace), without the topology listing
 static IFace2 PlanarFaceAt(IModelDoc2 d,double[] p){
  if(p.Length!=3)throw new Exception("face_point_mm: [x,y,z] mm");IFace2 best=null;double area=double.MaxValue;var hits=new List<IFace2>();
  foreach(IBody2 b in (object[])((IPartDoc)d).GetBodies2(0,false)??new object[0])foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){
   if(!((ISurface)f.GetSurface()).IsPlane())continue;var c=(double[])f.GetClosestPointOn(p[0],p[1],p[2]);
   if(c==null||Math.Sqrt(Math.Pow(c[0]-p[0],2)+Math.Pow(c[1]-p[1],2)+Math.Pow(c[2]-p[2],2))>1e-6)continue;hits.Add(f);double ar=f.GetArea();if(ar<area){area=ar;best=f;}}
  if(best==null)throw new Exception("No planar face contains ("+string.Join(", ",p.Select(v=>Math.Round(v*1000,4)))+") mm");
  // Codex review: on a shared edge two faces in DIFFERENT planes contain the point: refuse instead of guessing
  var bp=(double[])((ISurface)best.GetSurface()).PlaneParams;
  if(hits.Any(h=>{var q=(double[])((ISurface)h.GetSurface()).PlaneParams;return Math.Abs(q[0]*bp[0]+q[1]*bp[1]+q[2]*bp[2])<0.9999||Math.Abs((q[3]-bp[3])*bp[0]+(q[4]-bp[4])*bp[1]+(q[5]-bp[5])*bp[2])>1e-7;}))
   throw new Exception("face_point_mm ("+string.Join(", ",p.Select(v=>Math.Round(v*1000,4)))+") mm lies on an edge shared by faces in different planes; use a point inside one face");
  return best;
 }
 static void SelectEdges(IModelDoc2 d,object input){
  var edges=Items(input).Select(x=>Resolve(d,Convert.ToString(x)) as IEdge).ToArray();if(edges.Any(x=>x==null))throw new Exception("Every reference must be an edge");
  d.ClearSelection2(true);foreach(var edge in edges)if(!((IEntity)edge).Select4(true,null))throw new Exception("Edge selection failed");
 }
 static void SaveNew(IModelDoc2 d,string path,bool copy=false){
  int e=0,w=0;d.ClearSelection2(true);if(!d.Extension.SaveAs(path,0,copy?3:1,null,ref e,ref w)||e!=0)throw new Exception("SaveAs failed: "+e+" warnings: "+w);
  if(!File.Exists(path)||new FileInfo(path).Length==0)throw new Exception("SaveAs produced no file");
 }
 static string OutputPath(string name,string[] extensions){
  if(string.IsNullOrWhiteSpace(name)||Path.GetFileName(name)!=name||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||!extensions.Contains(Path.GetExtension(name).ToLowerInvariant()))throw new Exception("Invalid managed output filename");
  string path=Path.Combine(Root,name);if(File.Exists(path))throw new Exception("Destination already exists");return path;
 }
 static IEnumerable<string> ThreadFiles(){
  string directories=sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swFileLocationsThreadProfiles);
  return directories.Split(';').Where(Directory.Exists).SelectMany(x=>Directory.GetFiles(x,"*.sldlfp")).Distinct(StringComparer.OrdinalIgnoreCase);
 }
 static bool TryGlobal(string op,Dictionary<string,object>a,out object result){
  result=null;
  if(op=="environment"){
   var templates=new List<string>();string locations=sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swFileLocationsDocumentTemplates);
   foreach(string folder in locations.Split(';').Where(Directory.Exists))templates.AddRange(Directory.GetFiles(folder,"*.prtdot"));
   result=new{part_templates=templates,default_part_template=sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swDefaultTemplatePart),default_assembly_template=sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swDefaultTemplateAssembly),default_drawing_template=sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swDefaultTemplateDrawing),material_databases=sw.GetMaterialDatabases(),thread_profiles=ThreadFiles().Select(x=>new{path=x,type=Path.GetFileNameWithoutExtension(x),sizes=sw.GetConfigurationNames(x)}).ToArray(),managed_parts=Directory.GetFiles(Root,"*.sldprt").Select(Path.GetFileName).ToArray()};return true;
  }
  if(op=="create_part"){
   string path=ManagedPath(Str(a,"name"));if(File.Exists(path))throw new Exception("Destination already exists");
   string template=Str(a,"template");if(!Path.IsPathRooted(template)||!File.Exists(template)||!template.EndsWith(".prtdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing absolute PRTDOT template required");
   var d=(IModelDoc2)sw.NewDocument(template,0,0,0);if(d==null)throw new Exception("New part failed");lastDoc=d;
   SaveNew(d,path);string id=Guid.NewGuid().ToString("N");owned.Add(id,d);createdHere.Add(id);result=new{document_id=id,inspection=Inspect(d)};return true;
  }
  return TryDocuments(op,a,out result);
 }
 static bool TryModel(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="topology"){
   foreach(var key in refs.Where(x=>x.Value.Path==d.GetPathName()).Select(x=>x.Key).ToArray())refs.Remove(key);
   var bodies=(object[])((IPartDoc)d).GetBodies2(0,false)??new object[0];var faces=new List<object>();var edges=new List<object>();int bi=0;
   foreach(IBody2 b in bodies){
    foreach(IFace2 f in (object[])b.GetFaces()??new object[0]){var s=(ISurface)f.GetSurface();faces.Add(new{reference=Token(d,f),body=bi,area_mm2=f.GetArea()*1e6,box_m=f.GetBox(),plane=s.IsPlane()?s.PlaneParams:null,cylinder=s.IsCylinder()?s.CylinderParams:null});}
    foreach(IEdge e in (object[])b.GetEdges()??new object[0]){var c=(ICurve)e.GetCurve();var p=(IVertex)e.GetStartVertex();var q=(IVertex)e.GetEndVertex();edges.Add(new{reference=Token(d,e),body=bi,circle=c.IsCircle()?c.CircleParams:null,start_m=p==null?null:p.GetPoint(),end_m=q==null?null:q.GetPoint()});}bi++;
   }
   result=new{faces=faces,edges=edges,usage="References expire after document changes or another sw_topology call. Coordinates are meters."};return true;
  }
  if(op=="create_sketch"){
   string name=NewName(d,a);d.ClearSelection2(true);
   if(a.ContainsKey("face_point_mm")){var face=PlanarFaceAt(d,Items(a["face_point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray());if(!((IEntity)face).Select4(false,null))throw new Exception("Cannot select face");}
   else if(a.ContainsKey("face_reference")){var face=Resolve(d,Str(a,"face_reference")) as IFace2;if(face==null||!((ISurface)face.GetSurface()).IsPlane())throw new Exception("Sketch support must be a planar face");if(!((IEntity)face).Select4(false,null))throw new Exception("Cannot select face");}
   else {int target=Convert.ToInt32(a["plane_index"]),i=0;IFeature f=(IFeature)d.FirstFeature();while(f!=null){if(f.GetTypeName2()=="RefPlane"&&i++==target)break;f=(IFeature)f.GetNextFeature();}if(f==null||!f.Select2(false,0))throw new Exception("Reference plane not found");}
   if(Flag(a,"dimension")&&Flag(a,"fix_geometry"))throw new Exception("dimension and fix_geometry are exclusive: dimensions define the sketch, fixed constraints only freeze it");
   IModelView gview=null;bool gupd=true,gdisp=true;
   ISketch sketch=null;IFeature sf=null;int merged=0,openContours=0,filleted=0,chamfered=0;object dimInfo=null;string dimFail=null;List<double> dimRef=null;
   var skw=System.Diagnostics.Stopwatch.StartNew();var skt=new long[5];
   try {
    d.SketchManager.InsertSketch(true);sketch=(ISketch)d.SketchManager.ActiveSketch;if(sketch==null)throw new Exception("Could not enter sketch");
    // v3.8 speed: no screen redraw per entity while drawing and dimensioning (restored in the finally below)
    gview=d.ActiveView as IModelView;if(gview!=null){gupd=gview.EnableGraphicsUpdate;gview.EnableGraphicsUpdate=false;}gdisp=d.SketchManager.DisplayWhenAdded;d.SketchManager.DisplayWhenAdded=false;
    sf=(IFeature)sketch;Rename(sf,name);
    // AddToDB bypasses inference snapping: small features (1 mm sheet) otherwise snap onto nearby entities and CreateLine returns null.
    bool oldDb=d.SketchManager.AddToDB;
    try { d.SketchManager.AddToDB=true;
    foreach(Dictionary<string,object> item in Items(a["entities"])){
     string kind=Str(item,"kind");ISketchSegment segment=null;
     if(kind=="slot"){
      var c1=Items(item["start_center_mm"]).Select(Convert.ToDouble).ToArray();var c2=Items(item["end_center_mm"]).Select(Convert.ToDouble).ToArray();double r=Num(item,"width_mm")/2;
      double dx=c2[0]-c1[0],dy=c2[1]-c1[1],len=Math.Sqrt(dx*dx+dy*dy);if(len<1e-9)throw new Exception("Slot centers must be distinct");double nx=-dy/len*r,ny=dx/len*r;var sm=d.SketchManager;
      var segs=new[]{
       Seg(d,(ISketchSegment)sm.CreateLine((c1[0]+nx)/1000,(c1[1]+ny)/1000,0,(c2[0]+nx)/1000,(c2[1]+ny)/1000,0),"slot"),
       Seg(d,(ISketchSegment)sm.CreateArc(c2[0]/1000,c2[1]/1000,0,(c2[0]+nx)/1000,(c2[1]+ny)/1000,0,(c2[0]-nx)/1000,(c2[1]-ny)/1000,0,-1),"slot"),
       Seg(d,(ISketchSegment)sm.CreateLine((c2[0]-nx)/1000,(c2[1]-ny)/1000,0,(c1[0]-nx)/1000,(c1[1]-ny)/1000,0),"slot"),
       Seg(d,(ISketchSegment)sm.CreateArc(c1[0]/1000,c1[1]/1000,0,(c1[0]-nx)/1000,(c1[1]-ny)/1000,0,(c1[0]+nx)/1000,(c1[1]+ny)/1000,0,-1),"slot")};
      foreach(var sg in segs){sg.ConstructionGeometry=Flag(item,"construction");if(Flag(a,"fix_geometry")){d.ClearSelection2(true);sg.Select2(false,0);d.SketchAddConstraints("sgFIXED");}}
      continue;
     }
     if(kind=="circle"){var c=Items(item["center_mm"]).Select(Convert.ToDouble).ToArray();segment=(ISketchSegment)d.SketchManager.CreateCircleByRadius(c[0]/1000,c[1]/1000,0,Num(item,"radius_mm")/1000);}
     if(kind=="line"){var p=Items(item["start_mm"]).Select(Convert.ToDouble).ToArray();var q=Items(item["end_mm"]).Select(Convert.ToDouble).ToArray();if(p.SequenceEqual(q))throw new Exception("Zero-length line");segment=(ISketchSegment)d.SketchManager.CreateLine(p[0]/1000,p[1]/1000,0,q[0]/1000,q[1]/1000,0);}
     if(kind=="arc"){var c=Items(item["center_mm"]).Select(Convert.ToDouble).ToArray();var p=Items(item["start_mm"]).Select(Convert.ToDouble).ToArray();var q=Items(item["end_mm"]).Select(Convert.ToDouble).ToArray();double rp=Math.Sqrt(Math.Pow(p[0]-c[0],2)+Math.Pow(p[1]-c[1],2)),rq=Math.Sqrt(Math.Pow(q[0]-c[0],2)+Math.Pow(q[1]-c[1],2));if(rp<0.000001||Math.Abs(rp-rq)>0.000001||p.SequenceEqual(q))throw new Exception("Arc endpoints must be distinct and equidistant from center");segment=(ISketchSegment)d.SketchManager.CreateArc(c[0]/1000,c[1]/1000,0,p[0]/1000,p[1]/1000,0,q[0]/1000,q[1]/1000,0,(short)(Flag(item,"clockwise")?-1:1));}
     if(segment==null)throw new Exception("Sketch entity creation failed: "+kind);segment.ConstructionGeometry=Flag(item,"construction");
     if(Flag(a,"fix_geometry")){d.ClearSelection2(true);segment.Select2(false,0);d.SketchAddConstraints("sgFIXED");}
    }
    skt[0]=skw.ElapsedMilliseconds;
    // SolidWorks does not always merge coincident endpoints (e.g. line + semicircle), leaving contours open: merge them explicitly.
    merged=MergeCoincidentEndpoints(d,sketch);skt[1]=skw.ElapsedMilliseconds;
    if(a.ContainsKey("fillets"))foreach(Dictionary<string,object> fi in Items(a["fillets"])){
     var at=Items(fi["at_mm"]).Select(Convert.ToDouble).ToArray();var hit=Corner(sketch,at);
     d.ClearSelection2(true);if(!hit.Select4(false,null))throw new Exception("Cannot select sketch corner");
     if(d.SketchManager.CreateFillet(Num(fi,"radius_mm")/1000,1)==null)throw new Exception("Sketch fillet failed at ("+at[0]+", "+at[1]+") mm; radius too large or not a corner of two segments");
     filleted++;d.ClearSelection2(true);
    }
    if(a.ContainsKey("chamfers"))foreach(Dictionary<string,object> ch in Items(a["chamfers"])){
     var at=Items(ch["at_mm"]).Select(Convert.ToDouble).ToArray();var hit=Corner(sketch,at);
     int type=ch.ContainsKey("distance2_mm")?(int)swSketchChamferType_e.swSketchChamfer_DistanceDistance:ch.ContainsKey("angle_deg")?(int)swSketchChamferType_e.swSketchChamfer_DistanceAngle:(int)swSketchChamferType_e.swSketchChamfer_DistanceEqual;
     double second=ch.ContainsKey("distance2_mm")?Num(ch,"distance2_mm")/1000:ch.ContainsKey("angle_deg")?Num(ch,"angle_deg")*Math.PI/180:Num(ch,"distance_mm")/1000;
     d.ClearSelection2(true);if(!hit.Select4(false,null))throw new Exception("Cannot select sketch corner");
     if(d.SketchManager.CreateChamfer(type,Num(ch,"distance_mm")/1000,second)==null)throw new Exception("Sketch chamfer failed at ("+at[0]+", "+at[1]+") mm; distance too large or not a corner of two lines");
     chamfered++;d.ClearSelection2(true);
    }
    var contours=(object[])sketch.GetSketchContours()??new object[0];openContours=contours.Cast<ISketchContour>().Count(c=>!c.IsClosed());
    } finally {d.SketchManager.AddToDB=oldDb;}
    if(Flag(a,"dimension")){try{dimInfo=FullyDefine(d,sketch,sf);dimRef=SketchGeometry(sketch);}catch(Exception ex){dimFail=ex.Message;}}skt[2]=skw.ElapsedMilliseconds;
   } finally {try{d.SketchManager.DisplayWhenAdded=gdisp;if(gview!=null)gview.EnableGraphicsUpdate=gupd;}catch{}if(d.SketchManager.ActiveSketch!=null)d.SketchManager.InsertSketch(true);d.ClearSelection2(true);}
   if(Flag(a,"dimension")){
    // re-check after leaving the sketch and rebuilding; on any failure remove the whole new sketch (never leave it half-dimensioned)
    if(dimFail==null){d.EditRebuild3();var now=SketchGeometry(sketch);double mv=dimRef==null||now.Count!=dimRef.Count?double.PositiveInfinity:now.Zip(dimRef,(x,y)=>Math.Abs(x-y)).DefaultIfEmpty(0).Max();
     if(sketch.GetConstrainedStatus()!=(int)swConstrainedStatus_e.swFullyConstrained)dimFail="sketch is not fully defined after rebuild (status "+sketch.GetConstrainedStatus()+")";else if(mv>1e-8)dimFail="geometry moved "+Math.Round(mv*1000,6)+" mm after rebuild";}
    if(dimFail!=null){string nm=sf.Name;d.ClearSelection2(true);bool gone=sf.Select2(false,0)&&d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed);d.ClearSelection2(true);d.ForceRebuild3(false);
     gone=gone&&!AllFeatures(d).Any(x=>x.Name==nm);
     throw new Exception("Dimensioning failed: "+dimFail+(gone?"; the new sketch "+nm+" was removed":"; the new sketch "+nm+" could NOT be removed, delete it with sw_delete_feature"));}
   }
   skt[3]=skw.ElapsedMilliseconds;var insp=Checked(d,false,!Flag(a,"light_guard"));skt[4]=skw.ElapsedMilliseconds;
   result=new{sketch=sf.Name,status=sketch.GetConstrainedStatus(),fixed_geometry=Flag(a,"fix_geometry"),dimensioning=dimInfo,merged_endpoints=merged,sketch_fillets=filleted,sketch_chamfers=chamfered,sketch_normal=SketchNormal(sketch),open_contours=openContours,inspection=insp,split_ms=skt};return true;
  }
  if(op=="extrude"||op=="cut"){
   string name=NewName(d,a);var sketch=Feature(d,Str(a,"sketch"));if(!(sketch.GetSpecificFeature2() is ISketch))throw new Exception("Selected feature is not a sketch");
   d.ClearSelection2(true);if(!sketch.Select2(false,0))throw new Exception("Sketch selection failed");
   double depth=OptionalNum(a,"depth_mm",1)/1000;bool reverse=Flag(a,"reverse");string end=a.ContainsKey("end_condition")?Str(a,"end_condition"):"blind";IFeature f;
   var ends=new Dictionary<string,int>{{"blind",0},{"through_all",1},{"mid_plane",6},{"up_to_next",11},{"up_to_surface",4},{"offset_from_surface",5},{"through_all_both",9}};
   if(!ends.ContainsKey(end))throw new Exception("Unknown end_condition "+end);int type=ends[end];
   bool both=a.ContainsKey("depth2_mm")||end=="through_all_both";int type2=end=="through_all_both"?1:0;double depth2=a.ContainsKey("depth2_mm")?Num(a,"depth2_mm")/1000:0;if(end=="through_all_both")type=1;
   bool drafted=a.ContainsKey("draft_deg");double draft=drafted?Num(a,"draft_deg")*Math.PI/180:0;bool draftOut=Flag(a,"draft_outward");
   bool offsetRev=Flag(a,"offset_reverse");
   // direction: world axis (+X..-Z) the material goes toward; resolved against the sketch normal so no trial-and-error is needed.
   double[] normal=SketchNormal((ISketch)sketch.GetSpecificFeature2());
   if(a.ContainsKey("direction")){var want=AxisVector(Str(a,"direction"));double dot=normal[0]*want[0]+normal[1]*want[1]+normal[2]*want[2];
    if(Math.Abs(Math.Abs(dot)-1)>1e-9)throw new Exception("direction "+Str(a,"direction")+" is not perpendicular to the sketch plane (normal "+string.Join(", ",normal.Select(x=>Math.Round(x,4)))+")");
    reverse=(dot<0)!=(op=="cut"?CutReversed:ExtrudeReversed);}
   // start_offset_mm: the extrusion starts that far from the sketch plane, measured along the extrusion direction.
   int t0=0;double startOffset=0;bool flipStart=false;
   if(a.ContainsKey("start_offset_mm")){t0=3;startOffset=Num(a,"start_offset_mm")/1000;bool alongNormal=reverse==(op=="cut"?CutReversed:ExtrudeReversed);flipStart=alongNormal==StartOffsetFlipped;}
   // up_to_surface / offset_from_surface: the face is selected with mark 1 next to the sketch.
   if(type==4||type==5){var face=(Resolve(d,Str(a,"face_reference")) as IFace2) as IEntity;if(face==null)throw new Exception("face_reference must be a face (refresh sw_topology)");var sdf=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sdf.Mark=1;if(!face.Select4(true,sdf))throw new Exception("Cannot select the end face");}
   if(op=="extrude")f=d.FeatureManager.FeatureExtrusion3(!both,false,reverse,type,type2,type==5?Num(a,"offset_mm")/1000:depth,depth2,drafted,drafted&&both,draftOut,draftOut,draft,draft,offsetRev,false,false,false,Flag(a,"merge",true),true,true,t0,startOffset,flipStart);
   else f=d.FeatureManager.FeatureCut4(!both,false,reverse,type,type2,type==5?Num(a,"offset_mm")/1000:depth,depth2,drafted,drafted&&both,draftOut,draftOut,draft,draft,offsetRev,false,false,false,false,true,true,false,false,false,t0,startOffset,flipStart,true);
   if(f==null)throw new Exception(op+" failed; check closed contours, direction and body intersection");Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="fillet"||op=="chamfer"){
   string name=NewName(d,a);if(a.ContainsKey("edge_points_mm"))SelectEdgesAt(d,a["edge_points_mm"]);else if(a.ContainsKey("edge_references"))SelectEdges(d,a["edge_references"]);else throw new Exception("give edge_points_mm (a point on each edge, mm) or edge_references");IFeature f;
   if(op=="fillet")f=d.FeatureManager.FeatureFillet3(2|(Flag(a,"tangent_propagation")?1:0),Num(a,"radius_mm")/1000,0,0,0,0,0,null,null,null,null,null,null,null) as IFeature;
   else f=d.FeatureManager.InsertFeatureChamfer(Flag(a,"tangent_propagation")?1:0,1,Num(a,"distance_mm")/1000,Num(a,"angle_deg")*Math.PI/180,0,0,0,0);
   if(f==null)throw new Exception(op+" failed; selected edges or size may be incompatible");Rename(f,name);result=new{feature=f.Name,inspection=Checked(d)};return true;
  }
  if(op=="thread"){
   string name=NewName(d,a);var edge=Resolve(d,Str(a,"edge_reference")) as IEdge;if(edge==null||!((ICurve)edge.GetCurve()).IsCircle())throw new Exception("Thread needs a circular edge bordering a cylinder");
   var adjacent=(object[])edge.GetTwoAdjacentFaces2();if(adjacent==null||!adjacent.OfType<IFace2>().Any(x=>((ISurface)x.GetSurface()).IsCylinder()))throw new Exception("Thread edge has no adjacent cylindrical face");
   string profile=ThreadFiles().FirstOrDefault(x=>string.Equals(Path.GetFileNameWithoutExtension(x),Str(a,"profile_type"),StringComparison.OrdinalIgnoreCase));if(profile==null)throw new Exception("Thread profile not installed; inspect sw_environment");
   var sizes=Items(sw.GetConfigurationNames(profile)).Select(Convert.ToString);if(!sizes.Contains(Str(a,"size")))throw new Exception("Thread size not found in installed profile");
   d.ClearSelection2(true);var data=(IThreadFeatureData)d.FeatureManager.CreateDefinition((int)swFeatureNameID_e.swFmSweepThread);data.InitializeThreadData();
   data.Edge=(Edge)edge;data.Type=Path.GetFileNameWithoutExtension(profile);data.Size=Str(a,"size");data.EndCondition=0;data.BlindDepth=Num(a,"depth_mm")/1000;data.ThreadMethod=Str2(a,"method","cut")=="extrude"?(int)swThreadMethod_e.swThreadMethod_Extrude:(int)swThreadMethod_e.swThreadMethod_Cut;data.RightHanded=Flag(a,"right_handed",true);data.ReverseDirection=Flag(a,"reverse");data.MultipleStart=false;data.Offset=false;
   var f=d.FeatureManager.CreateFeature(data);if(f==null)throw new Exception("Thread creation failed; check profile, diameter and direction");Rename(f,name);result=new{feature=f.Name,thread_method=Str2(a,"method","cut"),inspection=Checked(d)};return true;
  }
  if(op=="delete_feature"){
   // Removes a feature plus its absorbed sketch (e.g. a failed attempt) so the tree stays clean instead of keeping suppressed leftovers.
   string n=Str(a,"name");var f=Feature(d,n);
   var children=((object[])f.GetChildren()??new object[0]).OfType<IFeature>().Select(x=>x.Name).ToArray();
   if(children.Length>0)throw new Exception("Feature has dependents ("+string.Join(", ",children)+"); delete those first");
   d.ClearSelection2(true);if(!f.Select2(false,0))throw new Exception("Cannot select feature "+n);
   if(!d.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed))throw new Exception("Delete failed (other features may depend on it)");
   d.ClearSelection2(true);if(((IPartDoc)d).FeatureByName(n)!=null)throw new Exception("Feature still present after delete");d.ForceRebuild3(false);result=Checked(d);return true;
  }
  if(op=="suppress_feature"){
   var f=Feature(d,Str(a,"name"));bool state=Flag(a,"suppressed");if(!f.SetSuppression2(state?0:1,1,null))throw new Exception("Cannot change feature suppression");result=Checked(d);return true;
  }
  if(op=="checkpoint"||op=="export"){
   Checked(d);string path=OutputPath(Str(a,"name"),op=="checkpoint"?new[]{Path.GetExtension(d.GetPathName()).ToLowerInvariant()}:d.GetType()==3?new[]{".pdf",".dxf",".dwg"}:new[]{".step",".stp",".stl",".x_t",".igs",".iges"});string source=d.GetPathName();SaveNew(d,path,true);if(d.GetPathName()!=source)throw new Exception("Unexpected active-document path change; inspect before continuing");result=new{path=path,bytes=new FileInfo(path).Length,source=source};return true;
  }
  if(op=="compare_volume"){
   if(d.GetType()==3)throw new Exception("Drawings have no solid volume");
   var mass=(IMassProperty2)d.Extension.CreateMassProperty2();mass.UseSystemUnits=true;mass.AccuracyLevel=2;mass.IncludeHiddenBodiesOrComponents=true;mass.Recalculate();double actual=mass.Volume*1e9,target=Num(a,"target_mm3"),signed=100*(actual-target)/target;
   result=new{actual_mm3=actual,target_mm3=target,difference_mm3=actual-target,signed_error_percent=signed,absolute_error_percent=Math.Abs(signed),tolerance_percent=Num(a,"tolerance_percent"),within_tolerance=Math.Abs(signed)<=Num(a,"tolerance_percent"),inspection=Inspect(d)};return true;
  }
  return false;
 }
}
