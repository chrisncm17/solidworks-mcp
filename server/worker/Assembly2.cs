using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v1.7: build assemblies with real mates. assembly_new (new file next to the user's parts, never overwrites),
// insert_component (part or subassembly, initial position), add_mate (coincident, concentric, distance, parallel,
// perpendicular, angle, width, screw, symmetric) on component planes, assembly planes or faces/edges picked at world points.
partial class Worker {
 static HashSet<string> batchMates;
 // v3.8 speed: inside assembly_batch the part documents opened to insert components stay open until the batch ends (six bolts of
 // one file used to open and close it six times); closed by AssemblyBatch
 static List<IModelDoc2> batchOpened;
 static readonly Dictionary<string,int> MateTypes=new Dictionary<string,int>{
  {"coincident",(int)swMateType_e.swMateCOINCIDENT},{"concentric",(int)swMateType_e.swMateCONCENTRIC},{"perpendicular",(int)swMateType_e.swMatePERPENDICULAR},
  {"parallel",(int)swMateType_e.swMatePARALLEL},{"distance",(int)swMateType_e.swMateDISTANCE},{"angle",(int)swMateType_e.swMateANGLE},
  {"symmetric",(int)swMateType_e.swMateSYMMETRIC},{"width",(int)swMateType_e.swMateWIDTH},{"screw",(int)swMateType_e.swMateSCREW},{"tangent",(int)swMateType_e.swMateTANGENT}};

 // Entity for a mate: {component, plane} (a reference plane of that component, e.g. "Alzado"), {assembly_plane},
 // or {point_mm:[x,y,z], kind:"face"|"edge"} = the face/edge of any component under that world point.
 static void SelectMateEntity(IModelDoc2 d,Dictionary<string,object> e,int mark,string what){
  bool ok;
  if(e.ContainsKey("plane")){string comp=Str(e,"component");string id=Str(e,"plane")+"@"+comp+"@"+Path.GetFileNameWithoutExtension(d.GetTitle());
   ok=d.Extension.SelectByID2(id,"PLANE",0,0,0,true,mark,null,0);if(!ok)throw new Exception(what+": plane "+id+" not found (component name and plane name as in the tree, e.g. Alzado/Planta/Vista lateral)");return;}
  if(e.ContainsKey("assembly_plane")){ok=d.Extension.SelectByID2(Str(e,"assembly_plane"),"PLANE",0,0,0,true,mark,null,0);if(!ok)throw new Exception(what+": assembly plane "+Str(e,"assembly_plane")+" not found");return;}
  if(e.ContainsKey("local_point_mm")){
   // Face/edge of a component that passes through a point given in THAT PART's coordinates (independent of the view and of where the component is).
   var comp=((object[])((IAssemblyDoc)d).GetComponents(false)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==Str(e,"component"));
   if(comp==null)throw new Exception(what+": component "+Str(e,"component")+" not found");
   var lp=Items(e["local_point_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();bool edge=e.ContainsKey("kind")&&Str(e,"kind")=="edge";
   var mu=(IMathUtility)sw.GetMathUtility();var wp=(double[])((MathPoint)((MathPoint)mu.CreatePoint(lp)).MultiplyTransform(comp.Transform2)).ArrayData;
   // Component bodies may report geometry in part or in assembly space; test each context SEPARATELY (never mix them),
   // and refuse when several entities pass through the point (shared edge/ambiguous) or the two contexts disagree.
   object info;var allEnts=new List<object>();
   foreach(IBody2 b in (object[])comp.GetBodies3((int)swBodyType_e.swSolidBody,out info)??new object[0])allEnts.AddRange(edge?((object[])b.GetEdges()??new object[0]):((object[])b.GetFaces()??new object[0]));
   Func<double[],List<object>> hits=q=>allEnts.Where(en=>{var cp=edge?(double[])((IEdge)en).GetClosestPointOn(q[0],q[1],q[2]):(double[])((IFace2)en).GetClosestPointOn(q[0],q[1],q[2]);return cp!=null&&Math.Sqrt(Math.Pow(cp[0]-q[0],2)+Math.Pow(cp[1]-q[1],2)+Math.Pow(cp[2]-q[2],2))<=1e-5;}).ToList();
   var hw=hits(wp);var hl=hits(lp);bool same=lp.Zip(wp,(x,y)=>Math.Abs(x-y)).Max()<1e-9;
   List<object> pick=hl.Count>0&&hw.Count>0&&!same?null:(hl.Count>0?hl:hw);
   // v3.8: both contexts hit (a rotated fixed component whose face also passes through the same numbers in assembly space):
   // decide which space the bodies really use by comparing the first body box with the part document's own body box
   if(pick==null){int sp=same?1:BodySpace(comp,mu);pick=sp==1?hl:sp==2?hw:null;}
   string at=" through local point ("+string.Join(", ",lp.Select(v=>Math.Round(v*1000,4)))+") mm";
   if(pick==null)throw new Exception(what+": "+comp.Name2+at+" is ambiguous (matches in part and assembly coordinates); use another point");
   if(pick.Count==0){
    // v3.8: a point computed from nominal dimensions often misses by a few tenths (a Hole Wizard hole resolves its centre
    // ~0.2 mm away from the nominal value). Snap when exactly ONE entity is within 0.5 mm and the next one is clearly farther;
    // otherwise report the nearest entities with their EXACT part point so the next call can use it.
    // Codex review: measure in the space the bodies really use; when it cannot be told, report but never snap
    int space=same?1:BodySpace(comp,mu);
    var near=NearEntities(allEnts,edge,space==1?new[]{lp}:space==2?new[]{wp}:new[]{lp,wp},lp,comp,mu);
    if(space!=0&&near.Count>0&&near[0].d<=5e-4&&(near.Count==1||near[1].d>=Math.Max(1e-3,3*near[0].d))){
     if(mateSnaps!=null)mateSnaps.Add(what+": "+comp.Name2+at+" no toca la geometría; se ajustó "+Math.Round(near[0].d*1000,3)+" mm a "+near[0].desc+" (punto exacto "+Json.Serialize(near[0].local)+")");
     var sd0=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd0.Mark=mark;if(!((IEntity)near[0].ent).Select4(true,sd0))throw new Exception(what+": cannot select the "+(edge?"edge":"face"));return;}
    throw new Exception(what+": no "+(edge?"edge":"face")+" of "+comp.Name2+at+". Nearest: "+string.Join("; ",near.Take(3).Select(n=>n.desc+" at "+Math.Round(n.d*1000,3)+" mm, exact local_point_mm "+Json.Serialize(n.local)))+". Retry with one of those points or use {component, find:{...}} (sw_find_faces).");}
   if(pick.Count>1)throw new Exception(what+": "+pick.Count+" "+(edge?"edges":"faces")+" of "+comp.Name2+" pass"+at+" (on a shared edge/vertex?); pick a point inside one "+(edge?"edge":"face"));
   object best=pick[0];
   var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=mark;if(!((IEntity)best).Select4(true,sd))throw new Exception(what+": cannot select the "+(edge?"edge":"face"));return;}
  if(e.ContainsKey("point_mm")){var p=Items(e["point_mm"]).Select(Convert.ToDouble).ToArray();string kind=e.ContainsKey("kind")?Str(e,"kind").ToUpperInvariant():"FACE";
   ok=d.Extension.SelectByID2("",kind,p[0]/1000,p[1]/1000,p[2]/1000,true,mark,null,0);if(!ok)throw new Exception(what+": no "+kind.ToLowerInvariant()+" at ("+string.Join(", ",p)+") mm");return;}
  throw new Exception(what+": give {component,plane}, {component,local_point_mm,kind}, {assembly_plane} or {point_mm,kind}");
 }

 // snaps made by SelectMateEntity during one add_mate (null outside add_mate)
 static List<string> mateSnaps;
 // requested transform of every component inserted by the running assembly_batch (null outside a batch)
 static Dictionary<string,double[]> batchWant;
 class NearEnt{public object ent;public double d;public double[] local;public string desc;}
 // which space the component bodies report geometry in: 1 part, 2 assembly, 0 cannot tell. A matching box alone proves
 // nothing (a centred cube turned 90 deg keeps its box): compare with BOTH interpretations and decide only when exactly one fits.
 static int BodySpace(IComponent2 comp,IMathUtility mu){
  try{object info;var pd=comp.GetModelDoc2() as IPartDoc;var cbs=(object[])comp.GetBodies3((int)swBodyType_e.swSolidBody,out info);var pbs=pd==null?null:(object[])pd.GetBodies2((int)swBodyType_e.swSolidBody,true);
   if(cbs==null||pbs==null||cbs.Length==0||pbs.Length==0)return 0;var cb=(double[])((IBody2)cbs[0]).GetBodyBox();var pb=(double[])((IBody2)pbs[0]).GetBodyBox();
   var cs=new List<double[]>();for(int k=0;k<8;k++){var c=new[]{(k&1)==0?pb[0]:pb[3],(k&2)==0?pb[1]:pb[4],(k&4)==0?pb[2]:pb[5]};cs.Add((double[])((MathPoint)((MathPoint)mu.CreatePoint(c)).MultiplyTransform(comp.Transform2)).ArrayData);}
   var ab=new[]{cs.Min(c=>c[0]),cs.Min(c=>c[1]),cs.Min(c=>c[2]),cs.Max(c=>c[0]),cs.Max(c=>c[1]),cs.Max(c=>c[2])};
   bool partSpace=cb.Zip(pb,(x,y)=>Math.Abs(x-y)).Max()<1e-7,asmSpace=cb.Zip(ab,(x,y)=>Math.Abs(x-y)).Max()<1e-7;
   return partSpace&&!asmSpace?1:asmSpace&&!partSpace?2:0;}catch{return 0;}
 }
 static List<NearEnt> NearEntities(List<object> ents,bool edge,double[][] qs,double[] lp,IComponent2 comp,IMathUtility mu){
  var inv=((MathTransform)comp.Transform2).Inverse() as MathTransform;var r=new List<NearEnt>();
  foreach(var en in ents){NearEnt best=null;
   foreach(var q in qs){var cp=edge?(double[])((IEdge)en).GetClosestPointOn(q[0],q[1],q[2]):(double[])((IFace2)en).GetClosestPointOn(q[0],q[1],q[2]);if(cp==null)continue;
    double dd=Math.Sqrt(Math.Pow(cp[0]-q[0],2)+Math.Pow(cp[1]-q[1],2)+Math.Pow(cp[2]-q[2],2));if(best!=null&&best.d<=dd)continue;
    var loc=q==lp?new[]{cp[0],cp[1],cp[2]}:(double[])((MathPoint)((MathPoint)mu.CreatePoint(new[]{cp[0],cp[1],cp[2]})).MultiplyTransform(inv)).ArrayData;
    best=new NearEnt{ent=en,d=dd,local=loc.Take(3).Select(v=>Math.Round(v*1000,4)).ToArray()};}
   if(best==null)continue;string desc=edge?"edge":"face";
   try{if(edge){var c=(ICurve)((IEdge)en).GetCurve();if(c.IsCircle()){var p=(double[])c.CircleParams;desc="circular edge Ø"+Math.Round(p[6]*2000,3);}else if(c.IsLine())desc="straight edge";}
    else{var s=(ISurface)((IFace2)en).GetSurface();if(s.IsCylinder()){var p=(double[])s.CylinderParams;desc="cylindrical face Ø"+Math.Round(p[6]*2000,3);}else if(s.IsPlane())desc="planar face";else if(s.IsCone())desc="conical face";}}catch{}
   best.desc=desc;r.Add(best);}
  return r.OrderBy(x=>x.d).ToList();}

 static Dictionary<string,double[]> Transforms(IAssemblyDoc asm){
  var r=new Dictionary<string,double[]>();foreach(IComponent2 c in (object[])asm.GetComponents(false)??new object[0]){var t=c.Transform2 as MathTransform;if(t!=null)r[c.Name2]=(double[])t.ArrayData;}return r;}
 static double MaxDiff(double[] x,double[] y){double m=0;for(int i=0;i<12&&i<x.Length&&i<y.Length;i++)m=Math.Max(m,Math.Abs(x[i]-y[i]));return m;}

 static bool TryAssemblyGlobal(string op,Dictionary<string,object>a,out object result){
  result=null;
  if(op!="assembly_new")return false;
  string path=Str(a,"path");if(!Path.IsPathRooted(path)||Path.GetFullPath(path)!=path||!path.EndsWith(".sldasm",StringComparison.OrdinalIgnoreCase))throw new Exception("path must be an absolute .SLDASM path");
  if(File.Exists(path))throw new Exception("File already exists (never overwritten): "+path);
  if(!Directory.Exists(Path.GetDirectoryName(path)))throw new Exception("Folder does not exist: "+Path.GetDirectoryName(path));
  string template=Str(a,"template");if(!File.Exists(template)||!template.EndsWith(".asmdot",StringComparison.OrdinalIgnoreCase))throw new Exception("Existing ASMDOT template required");
  var d=(IModelDoc2)sw.NewDocument(template,0,0,0);if(d==null)throw new Exception("New assembly failed");
  int errors=0,warnings=0;if(!d.Extension.SaveAs(path,0,1,null,ref errors,ref warnings)||errors!=0)throw new Exception("Initial save failed: "+errors);
  string id=Guid.NewGuid().ToString("N");owned.Add(id,d);external[id]=Path.GetFullPath(d.GetPathName());lastDoc=d;
  result=new{document_id=id,path=d.GetPathName()};return true;
 }

 static bool TryAssembly2(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(op=="mass_override"){
   // Override mass (and optionally center of mass, in this document's own coordinates) when the drawing specifies it,
   // e.g. "Ensamblaje 1: Masa 50 g, Centro de masa (15, 20, 25) mm". Never used to hide a modelling error.
   var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;
   var o=(IMassPropertyOverrideOptions)mp.GetOverrideOptions();if(o==null)throw new Exception("Mass override not available");
   o.OverrideMass=true;if(!o.SetOverrideMassValue(Num(a,"mass_g")/1000))throw new Exception("Cannot set override mass");
   if(a.ContainsKey("center_of_mass_mm")){var c=Items(a["center_of_mass_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();o.OverrideCenterOfMass=true;if(!o.SetOverrideCenterOfMassValue(c,""))throw new Exception("Cannot set override center of mass");}
   else o.OverrideCenterOfMass=false;
   if(!mp.SetOverrideOptions(o,1,null))throw new Exception("SetOverrideOptions failed");
   d.ForceRebuild3(false);
   var chk=(IMassProperty2)d.Extension.CreateMassProperty2();chk.UseSystemUnits=true;chk.Recalculate();
   result=new{mass_g=chk.Mass*1000,center_of_mass_mm=((double[])chk.CenterOfMass).Select(v=>Math.Round(v*1000,4)).ToArray(),inspection=Inspect(d)};return true;
  }
  if(op=="insert_component"){
   if(d.GetType()!=2)throw new Exception("insert_component needs an assembly");var asm=(IAssemblyDoc)d;
   string path=Str(a,"path");if(!Path.IsPathRooted(path)||!File.Exists(path))throw new Exception("Component file not found: "+path);
   string ext=Path.GetExtension(path).ToLowerInvariant();if(ext!=".sldprt"&&ext!=".sldasm")throw new Exception("Component must be .SLDPRT or .SLDASM");
   var p=a.ContainsKey("position_mm")?Items(a["position_mm"]).Select(Convert.ToDouble).ToArray():new double[3];
   double[] initial=a.ContainsKey("transform")?Items(a["transform"]).Select(Convert.ToDouble).ToArray():null;
   if(initial!=null){
    if(initial.Length!=16||initial.Any(x=>double.IsNaN(x)||double.IsInfinity(x))||Math.Abs(initial[12]-1)>1e-6||initial.Skip(13).Any(x=>Math.Abs(x)>1e-9))throw new Exception("transform needs rigid ArrayData 16 (SI)");
    for(int i=0;i<3;i++){double norm=0;for(int j=0;j<3;j++)norm+=initial[i*3+j]*initial[i*3+j];if(Math.Abs(norm-1)>1e-6)throw new Exception("transform axes must be unit vectors");}
    for(int i=0;i<3;i++)for(int j=i+1;j<3;j++){double dot=0;for(int k=0;k<3;k++)dot+=initial[i*3+k]*initial[j*3+k];if(Math.Abs(dot)>1e-6)throw new Exception("transform axes must be perpendicular");}
    double det=initial[0]*(initial[4]*initial[8]-initial[5]*initial[7])-initial[1]*(initial[3]*initial[8]-initial[5]*initial[6])+initial[2]*(initial[3]*initial[7]-initial[4]*initial[6]);if(Math.Abs(det-1)>1e-6)throw new Exception("transform must be right handed");
    if(a.ContainsKey("position_mm")&&Enumerable.Range(0,3).Any(i=>Math.Abs(p[i]-initial[9+i]*1000)>1e-6))throw new Exception("position_mm contradicts transform");
    p=initial.Skip(9).Take(3).Select(x=>x*1000).ToArray();
   }
   // the component document must be open for AddComponent5
   int e=0,w=0;var cd=(IModelDoc2)sw.GetOpenDocumentByName(path);bool opened=false;if(cd==null){cd=(IModelDoc2)sw.OpenDoc6(path,ext==".sldprt"?1:2,1,"",ref e,ref w);opened=cd!=null;if(opened&&batchOpened!=null)batchOpened.Add(cd);}
   if(cd==null)throw new Exception("Cannot open component "+path+" ("+e+")");
   string configuration=a.ContainsKey("configuration")?Str(a,"configuration"):null;
   if(configuration!=null&&!((object[])cd.GetConfigurationNames()??new object[0]).Select(Convert.ToString).Contains(configuration)){if(opened)sw.CloseDoc(cd.GetTitle());throw new Exception("Component configuration not found: "+configuration);}
   // v3.8 speed: inside assembly_batch every file was opened beforehand and the assembly stays active (re-activating it on
   // every insert redraws the whole window)
   var act=0;var ad=sw.ActiveDoc as IModelDoc2;if(batchWant==null||ad==null||ad.GetTitle()!=d.GetTitle())sw.ActivateDoc3(d.GetTitle(),false,1,ref act);
   var c=(IComponent2)asm.AddComponent5(path,0,"",false,"",p[0]/1000,p[1]/1000,p[2]/1000);if(c==null)throw new Exception("Component insertion failed");
   if(configuration!=null){c.ReferencedConfiguration=configuration;if(c.ReferencedConfiguration!=configuration)throw new Exception("Could not set component configuration");}
   if(opened&&batchOpened==null)try{sw.CloseDoc(cd.GetTitle());}catch{}
   // AddComponent5 centers the component's bounding box on the point; put the component ORIGIN there instead (identity rotation)
   {var mu=(IMathUtility)sw.GetMathUtility();if(c.IsFixed()){d.ClearSelection2(true);if(!c.Select4(false,null,false))throw new Exception("Cannot select inserted component to position it");asm.UnfixComponent();d.ClearSelection2(true);}
    var want=initial??new double[]{1,0,0,0,1,0,0,0,1,p[0]/1000,p[1]/1000,p[2]/1000,1,0,0,0};c.Transform2=(MathTransform)mu.CreateTransform(want);
    // inside assembly_batch the assembly is rebuilt ONCE after the last insert and every transform is checked then
    if(batchWant!=null)batchWant[c.Name2]=want;
    else{d.EditRebuild3();
    var actual=c.Transform2 as IMathTransform;if(actual==null||MaxDiff((double[])actual.ArrayData,want)>1e-8)throw new Exception("Inserted component did not retain the requested transform");}}
   bool fix=Flag(a,"fixed");d.ClearSelection2(true);if(c.Select4(false,null,false)){if(fix)asm.FixComponent();else if(c.IsFixed())asm.UnfixComponent();}d.ClearSelection2(true);
   if(c.IsFixed()!=fix)throw new Exception("Cannot set inserted component fixed state");
   result=new{component=c.Name2,fixed_position=c.IsFixed(),inspection=Flag(a,"_quick")?null:Inspect(d)};return true;
  }
  // v3.8 speed: inside assembly_batch the mate names are kept in batchMates (each mate used to walk every mate twice: ~350 ms
  // late in a 23-mate batch); outside a batch it is null and add_mate reads them as before
  if(op=="add_mate"){
   if(d.GetType()!=2)throw new Exception("add_mate needs an assembly");var asm=(IAssemblyDoc)d;
   string type=Str(a,"type");if(!MateTypes.ContainsKey(type))throw new Exception("type: "+string.Join(", ",MateTypes.Keys));
   var ents=Items(a["entities"]).Cast<Dictionary<string,object>>().ToList();
   string align=a.ContainsKey("align")?Str(a,"align"):"closest";int al=align=="aligned"?(int)swMateAlign_e.swMateAlignALIGNED:align=="anti_aligned"?(int)swMateAlign_e.swMateAlignANTI_ALIGNED:(int)swMateAlign_e.swMateAlignCLOSEST;
   double dist=a.ContainsKey("distance_mm")?Num(a,"distance_mm")/1000:0,ang=a.ContainsKey("angle_deg")?Num(a,"angle_deg")*Math.PI/180:0,pitch=a.ContainsKey("pitch_mm")?Num(a,"pitch_mm")/1000:0;
   int status=0;IMate2 m;
   var swm=System.Diagnostics.Stopwatch.StartNew();var tm=new long[5];var before=batchMates!=null?new HashSet<string>(batchMates):new HashSet<string>(Mates(d).Select(x=>x.Name));
   var tBefore=Transforms(asm);tm[0]=swm.ElapsedMilliseconds;
   var snaps=new List<string>();mateSnaps=snaps;
   try{
    d.ClearSelection2(true);
    if(type=="width"){ // width: entities 0,1 = width faces (slot walls), mark 1; entities 2,3 = tab faces, mark 16 (AddMate5 width contract)
     if(ents.Count!=4)throw new Exception("width needs 4 entities: 2 width + 2 tab");
     for(int i=0;i<4;i++)SelectMateEntity(d,ents[i],i<2?1:16,"entity "+(i+1));}
    else if(type=="symmetric"){if(ents.Count!=3)throw new Exception("symmetric needs 3 entities: 2 + symmetry plane");SelectMateEntity(d,ents[0],1,"entity 1");SelectMateEntity(d,ents[1],1,"entity 2");SelectMateEntity(d,ents[2],4,"symmetry plane");}
    else{if(ents.Count!=2)throw new Exception(type+" needs 2 entities");for(int i=0;i<2;i++)SelectMateEntity(d,ents[i],1,"entity "+(i+1));}
    // v3.8 limit mates: an angle/distance mate with min and max (upper != lower) lets the part move ONLY inside that range
    double angMax=a.ContainsKey("angle_max_deg")?Num(a,"angle_max_deg")*Math.PI/180:ang,angMin=a.ContainsKey("angle_min_deg")?Num(a,"angle_min_deg")*Math.PI/180:ang;
    double dMax=a.ContainsKey("distance_max_mm")?Num(a,"distance_max_mm")/1000:dist,dMin=a.ContainsKey("distance_min_mm")?Num(a,"distance_min_mm")/1000:dist;
    if(angMin>angMax||dMin>dMax)throw new Exception("limit: min must be <= max");
    if((a.ContainsKey("angle_min_deg")||a.ContainsKey("angle_max_deg"))&&(ang<angMin-1e-12||ang>angMax+1e-12))throw new Exception("angle_deg must lie between angle_min_deg and angle_max_deg");
    try{m=asm.AddMate5(MateTypes[type],al,Flag(a,"flip"),dist,dMax,dMin,type=="screw"?1:1,type=="screw"?pitch:1,ang,angMax,angMin,false,Flag(a,"lock_rotation"),0,out status);}catch{m=null;if(status==0)status=-1;}
   }finally{d.ClearSelection2(true);mateSnaps=null;}
   tm[1]=swm.ElapsedMilliseconds;tm[2]=tm[1];
   if(m==null||status!=(int)swAddMateError_e.swAddMateError_NoError){var created=Mates(d).Where(x=>!before.Contains(x.Name)).ToList();
    // never leave a half-made mate behind: delete exactly the mate(s) this call created, then report
    var removed=new List<string>();foreach(var x in created){d.ClearSelection2(true);if(x.Select2(false,0)&&d.Extension.DeleteSelection2(0))removed.Add(x.Name);}d.ClearSelection2(true);d.EditRebuild3();
    var left=Mates(d).Where(x=>!before.Contains(x.Name)).Select(x=>x.Name).ToArray();if(left.Length>0)throw new Exception("Mate "+type+" failed (status "+status+") and the partial mate(s) "+string.Join(",",left)+" could NOT be removed; delete them (sw_delete_mate) or close without saving");
    string[] names={"","no error","wrong entity type","alignment impossible","wrong selections","over-defined","cannot satisfy"};
    throw new Exception("Mate "+type+" failed (status "+status+" "+(status>=0&&status<names.Length?names[status]:"unknown")+")"+(removed.Count>0?"; removed the partial mate "+string.Join(",",removed):""));}
   // v3.8: inside assembly_batch with defer_rebuild the whole assembly is rebuilt ONCE after the last mate and every mate's error
   // is read then (AddMate5 already solves the mate it creates)
   if(!Flag(a,"_norebuild"))d.EditRebuild3();tm[3]=swm.ElapsedMilliseconds;
   var f=m as IFeature;bool warn=false;int code=f==null?0:f.GetErrorCode2(out warn);if(batchMates!=null&&f!=null)batchMates.Add(f.Name);
   var tAfter=Transforms(asm);tm[4]=swm.ElapsedMilliseconds;
   var moved=tAfter.Where(kv=>tBefore.ContainsKey(kv.Key)&&MaxDiff(tBefore[kv.Key],kv.Value)>1e-9).Select(kv=>new{component=kv.Key,origin_mm=kv.Value.Skip(9).Take(3).Select(v=>Math.Round(v*1000,4)).ToArray(),x_axis=kv.Value.Take(3).Select(v=>Math.Round(v,5)).ToArray(),y_axis=kv.Value.Skip(3).Take(3).Select(v=>Math.Round(v,5)).ToArray(),z_axis=kv.Value.Skip(6).Take(3).Select(v=>Math.Round(v,5)).ToArray()}).ToArray();
   object limits=null;
   if(a.ContainsKey("angle_min_deg")||a.ContainsKey("angle_max_deg")||a.ContainsKey("distance_min_mm")||a.ContainsKey("distance_max_mm"))
    try{var md=f.GetDefinition();var am=md as IAngleMateFeatureData;var dm=md as IDistanceMateFeatureData;
     limits=am!=null?(object)new{min_deg=Math.Round(am.MinimumAngle*180/Math.PI,6),max_deg=Math.Round(am.MaximumAngle*180/Math.PI,6),angle_deg=Math.Round(am.Angle*180/Math.PI,6)}:dm!=null?(object)new{min_mm=Math.Round(dm.MinimumDistance*1000,6),max_mm=Math.Round(dm.MaximumDistance*1000,6),distance_mm=Math.Round(dm.Distance*1000,6)}:null;}catch{}
   result=new{mate=f==null?null:f.Name,type=type,error_code=code,is_warning=warn,moved_components=moved,limits=limits,snapped=snaps.Count>0?snaps:null,inspection=Flag(a,"_quick")?null:Inspect(d),split_ms=tm};return true;
  }
  if(op=="move_component"){
   // Place an under-defined component: origin at position_mm and rotation rotation_deg [rx,ry,rz] (applied X then Y then Z, world axes).
   if(d.GetType()!=2)throw new Exception("move_component needs an assembly");var asm=(IAssemblyDoc)d;
   var c=((object[])asm.GetComponents(false)??new object[0]).Cast<IComponent2>().FirstOrDefault(x=>x.Name2==Str(a,"component"));if(c==null)throw new Exception("component not found: "+Str(a,"component"));
   if(c.IsFixed())throw new Exception(c.Name2+" is fixed; unfix it first");
   var p=Items(a["position_mm"]).Select(v=>Convert.ToDouble(v)/1000).ToArray();var r=a.ContainsKey("rotation_deg")?Items(a["rotation_deg"]).Select(v=>Convert.ToDouble(v)*Math.PI/180).ToArray():new double[3];
   Func<double,double[,]> Rx=t=>new double[,]{{1,0,0},{0,Math.Cos(t),-Math.Sin(t)},{0,Math.Sin(t),Math.Cos(t)}},Ry=t=>new double[,]{{Math.Cos(t),0,Math.Sin(t)},{0,1,0},{-Math.Sin(t),0,Math.Cos(t)}},Rz=t=>new double[,]{{Math.Cos(t),-Math.Sin(t),0},{Math.Sin(t),Math.Cos(t),0},{0,0,1}};
   Func<double[,],double[,],double[,]> Mul=(A,B)=>{var C=new double[3,3];for(int i=0;i<3;i++)for(int j=0;j<3;j++)for(int k=0;k<3;k++)C[i,j]+=A[i,k]*B[k,j];return C;};
   var R=Mul(Rz(r[2]),Mul(Ry(r[1]),Rx(r[0])));
   // SolidWorks ArrayData rows are the component axes expressed in world coordinates (row-vector convention)
   var arr=new double[]{R[0,0],R[1,0],R[2,0],R[0,1],R[1,1],R[2,1],R[0,2],R[1,2],R[2,2],p[0],p[1],p[2],1,0,0,0};
   if(a.ContainsKey("axes")){var ax=Items(a["axes"]).Select(Convert.ToDouble).ToArray();if(ax.Length!=9)throw new Exception("axes needs 9 numbers: component X, Y, Z axes in world coordinates");
    for(int i=0;i<9;i++)arr[i]=ax[i];
    for(int i=0;i<3;i++){double n=Math.Sqrt(arr[3*i]*arr[3*i]+arr[3*i+1]*arr[3*i+1]+arr[3*i+2]*arr[3*i+2]);if(Math.Abs(n-1)>1e-6)throw new Exception("axes must be unit vectors");}
    for(int i=0;i<3;i++)for(int j=i+1;j<3;j++){double dot=arr[3*i]*arr[3*j]+arr[3*i+1]*arr[3*j+1]+arr[3*i+2]*arr[3*j+2];if(Math.Abs(dot)>1e-6)throw new Exception("axes must be mutually perpendicular");}
    double det=arr[0]*(arr[4]*arr[8]-arr[5]*arr[7])-arr[1]*(arr[3]*arr[8]-arr[5]*arr[6])+arr[2]*(arr[3]*arr[7]-arr[4]*arr[6]);if(det<0.999999)throw new Exception("axes must be a rotation (right-handed, determinant +1), not a mirror");}
   var mu=(IMathUtility)sw.GetMathUtility();c.Transform2=(MathTransform)mu.CreateTransform(arr);d.EditRebuild3();
   var now=(double[])((MathTransform)c.Transform2).ArrayData;
   result=new{component=c.Name2,origin_mm=now.Skip(9).Take(3).Select(v=>Math.Round(v*1000,4)).ToArray(),held_by_mates=MaxDiff(now,arr)>1e-6,note=MaxDiff(now,arr)>1e-6?"Existing mates moved it away from the requested placement (it is constrained).":"Placed.",inspection=Inspect(d)};return true;
  }
  if(op=="configuration"){
   // list configurations or activate one (parts and assemblies); activation is a document change (unsaved until sw_save)
   var names=((object[])d.GetConfigurationNames()??new object[0]).Select(Convert.ToString).ToArray();
   string action=Str(a,"action");
   if(action=="activate"){string n=Str(a,"name");if(!names.Contains(n))throw new Exception("Configuration not found: "+n+" (have: "+string.Join(", ",names)+")");string cur=((IConfiguration)d.ConfigurationManager.ActiveConfiguration).Name;if(cur!=n){d.ShowConfiguration2(n);if(((IConfiguration)d.ConfigurationManager.ActiveConfiguration).Name!=n)throw new Exception("Could not activate "+n+" (active: "+cur+")");}d.ForceRebuild3(false);}
   result=new{configurations=names,active=((IConfiguration)d.ConfigurationManager.ActiveConfiguration).Name,inspection=action=="activate"?Inspect(d):null};return true;
  }
  if(op=="delete_mate"){
   if(d.GetType()!=2)throw new Exception("delete_mate needs an assembly");
   var names=Items(a["names"]).Select(Convert.ToString).ToList();var byName=Mates(d).ToDictionary(x=>x.Name,x=>x);
   var missing=names.Where(n=>!byName.ContainsKey(n)).ToArray();if(missing.Length>0)throw new Exception("Mates not found (nothing deleted): "+string.Join(", ",missing));
   var deleted=new List<string>();
   foreach(var n in names){d.ClearSelection2(true);if(!byName[n].Select2(false,0)||!d.Extension.DeleteSelection2(0))throw new Exception("Could not delete "+n+(deleted.Count>0?"; already deleted: "+string.Join(",",deleted):""));deleted.Add(n);}
   d.ClearSelection2(true);d.EditRebuild3();
   var left=new HashSet<string>(Mates(d).Select(x=>x.Name));if(names.Any(left.Contains))throw new Exception("Delete did not remove: "+string.Join(",",names.Where(left.Contains)));
   result=new{deleted=deleted.ToArray(),note="Unsaved; call sw_save after reviewing.",after=MateSummary(d,true)};return true;
  }
  return false;
 }
}
