using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.22 part_stages: the same part saved in steps, so the student finishes it by hand. By default three files: "1 croquis" (only
// the first sketch, dimensioned), "2 extrusion" (everything up to the first cut, hole, fillet, chamfer or shell) and
// "3 terminada" (the whole part). Each stage is a copy of the open part with the later features deleted (their own sketches with
// them), the equations that pointed at deleted features removed, rebuilt and checked. The open part is not changed.
partial class Worker {
 static readonly HashSet<string> StageNeutral=new HashSet<string>{"ProfileFeature","3DProfileFeature","RefPlane","RefAxis","RefPoint","CoordSys","MaterialFolder","SketchBlockDef"};
 static readonly HashSet<string> StageAdds=new HashSet<string>{"Extrusion","Boss","BaseBody","Revolution","RevolutionThin","Sweep","Blend","Thicken","ExtrusionThin","BossThin","Dome"};

 static bool TryPartStages(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="part_stages")return false;result=PartStages(d,a);return true;
 }

 // the history in order (after the origin), each absorbed sketch just before the feature that uses it; owner[sketch] = that feature
 static List<IFeature> StageHistory(IModelDoc2 d,Dictionary<string,string> owner){
  var list=new List<IFeature>();var seen=new HashSet<string>();bool started=false;
  for(var f=(IFeature)d.FirstFeature();f!=null;f=(IFeature)f.GetNextFeature()){
   if(!started){if(f.GetTypeName2()=="OriginProfileFeature")started=true;continue;}
   for(var s=f.GetFirstSubFeature() as IFeature;s!=null;s=s.GetNextSubFeature() as IFeature){string tn=s.GetTypeName2();
    if(tn!="ProfileFeature"&&tn!="3DProfileFeature")continue;if(!owner.ContainsKey(s.Name))owner[s.Name]=f.Name;if(seen.Add(s.Name))list.Add(s);}
   if(seen.Add(f.Name))list.Add(f);
  }
  return list;
 }

 static object PartStages(IModelDoc2 d,Dictionary<string,object> a){
  if(d.GetType()!=1)throw new Exception("part_stages works on parts");
  var owner=new Dictionary<string,string>();var hist=StageHistory(d,owner);var names=hist.Select(f=>f.Name).ToList();
  if(hist.Count==0)throw new Exception("The part has no features");
  int firstSketch=hist.FindIndex(f=>f.GetTypeName2()=="ProfileFeature"||f.GetTypeName2()=="3DProfileFeature");
  int firstStop=hist.FindIndex(f=>!StageNeutral.Contains(f.GetTypeName2())&&!StageAdds.Contains(f.GetTypeName2()));
  // stages: [{name, until?}] (until = last feature kept, by tree name; none = the whole part)
  var stages=new List<Tuple<string,string>>();
  if(a.ContainsKey("stages")){foreach(var o in Items(a["stages"])){var s=(Dictionary<string,object>)o;string nm=Str(s,"name");string un=s.ContainsKey("until")?Str(s,"until"):null;
    if(un!=null&&!names.Contains(un))throw new Exception("until: no feature "+un+" in the tree ("+string.Join(", ",names.Take(40))+")");stages.Add(Tuple.Create(nm,un));}}
  else{
   if(firstSketch<0)throw new Exception("The part has no sketch for the first stage");
   stages.Add(Tuple.Create("1 croquis",names[firstSketch]));
   int lastAdd=(firstStop<0?hist.Count:firstStop)-1;while(lastAdd>=0&&StageNeutral.Contains(hist[lastAdd].GetTypeName2()))lastAdd--;
   if(lastAdd>=0&&firstStop>=0)stages.Add(Tuple.Create("2 extrusion",names[lastAdd]));
   else if(lastAdd>=0&&firstStop<0){} // nothing to cut: the finished part is the extruded one
   stages.Add(Tuple.Create((stages.Count+1)+" terminada",(string)null));
  }
  if(stages.Select(s=>s.Item1).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=stages.Count)throw new Exception("Two stages with the same name");
  string baseName=Path.GetFileNameWithoutExtension(d.GetPathName());if(string.IsNullOrEmpty(baseName))baseName=Path.GetFileNameWithoutExtension(d.GetTitle());
  if(a.ContainsKey("base_name"))baseName=Str(a,"base_name");
  string copyTo=a.ContainsKey("copy_to")?Str(a,"copy_to"):null;
  if(copyTo!=null&&(!Path.IsPathRooted(copyTo)))throw new Exception("copy_to must be an absolute folder");
  // every destination checked before anything is written
  var plan=stages.Select(s=>new{s,path=ManagedPath(baseName+" "+s.Item1+".SLDPRT")}).ToList();
  foreach(var p in plan){if(File.Exists(p.path))throw new Exception("Destination already exists: "+p.path+" (give base_name)");
   if(copyTo!=null&&File.Exists(Path.Combine(copyTo,Path.GetFileName(p.path))))throw new Exception("Already in copy_to: "+Path.GetFileName(p.path)+" (nothing is overwritten)");}
  var rows=new List<object>();int e=0,w=0;
  try{
   foreach(var p in plan){
    if(!d.Extension.SaveAs(p.path,0,(int)(swSaveAsOptions_e.swSaveAsOptions_Silent|swSaveAsOptions_e.swSaveAsOptions_Copy),null,ref e,ref w)||e!=0||!File.Exists(p.path))throw new Exception("Save as copy failed ("+e+"): "+p.path);
    if(p.s.Item2==null){rows.Add(new{stage=p.s.Item1,path=p.path,until=(string)null,kept=names.Count,deleted=new string[0]});continue;}
    int cut=names.IndexOf(p.s.Item2);
    var keep=new HashSet<string>(names.Take(cut+1));
    // a sketch whose feature goes is deleted with it, unless it is what this stage ends with
    foreach(var k in keep.ToList())if(k!=p.s.Item2&&owner.ContainsKey(k)&&!keep.Contains(owner[k]))keep.Remove(k);
    var od=(IModelDoc2)sw.OpenDoc6(p.path,(int)swDocumentTypes_e.swDocPART,(int)swOpenDocOptions_e.swOpenDocOptions_Silent,"",ref e,ref w);
    if(od==null)throw new Exception("Could not open the copy ("+e+"): "+p.path);
    try{
     var deleted=new List<string>();var failed=new List<string>();
     for(int i=names.Count-1;i>=0;i--){if(keep.Contains(names[i]))continue;var f=(IFeature)((IPartDoc)od).FeatureByName(names[i]);if(f==null)continue;
      od.ClearSelection2(true);if(!f.Select2(false,0)||!od.Extension.DeleteSelection2(0)){failed.Add(names[i]);continue;}deleted.Add(names[i]);}
     od.ClearSelection2(true);
     if(failed.Count>0)throw new Exception("Could not delete "+string.Join(", ",failed));
     // equations that name a deleted feature or sketch ("D1@Saliente-Extruir3") would stay broken
     var left=FeatureNames(od);var m=(IEquationMgr)od.GetEquationMgr();var dropped=new List<string>();
     for(int i=m.GetCount()-1;i>=0;i--){string eq=m.get_Equation(i)??"";
      var refs=System.Text.RegularExpressions.Regex.Matches(eq,"\"[^\"@]+@([^\"@]+)(@[^\"]*)?\"").Cast<System.Text.RegularExpressions.Match>().Select(x=>x.Groups[1].Value).ToList();
      if(refs.Any(r=>!left.Contains(r))){dropped.Add(eq);m.Delete(i);}}
     // what is left of the sketches with nothing using them is shown, with its dimensions
     foreach(var k in keep){if(owner.ContainsKey(k)&&keep.Contains(owner[k]))continue;var f=(IFeature)((IPartDoc)od).FeatureByName(k);
      if(f!=null&&(f.GetTypeName2()=="ProfileFeature"||f.GetTypeName2()=="3DProfileFeature")){od.ClearSelection2(true);if(f.Select2(false,0))try{od.UnblankSketch();}catch{}}}
     od.ClearSelection2(true);od.ForceRebuild3(false);
     var problems=HealthProblems(Health(od));
     // the sketch stage has no body on purpose
     if(keep.All(k=>{var ff=(IFeature)((IPartDoc)od).FeatureByName(k);return ff==null||StageNeutral.Contains(ff.GetTypeName2());}))problems=problems.Where(x=>!x.StartsWith("Pieza sin cuerpos")).ToList();
     double vol=0;var bodies=(object[])((IPartDoc)od).GetBodies2((int)swBodyType_e.swSolidBody,true);
     if(bodies!=null&&bodies.Length>0){var mp=(IMassProperty)od.Extension.CreateMassProperty();if(mp!=null)vol=mp.Volume*1e9;}
     if(problems.Count>0)throw new Exception("Stage "+p.s.Item1+" does not rebuild clean: "+string.Join("; ",problems));
     int e2=0,w2=0;if(!od.Save3(1,ref e2,ref w2)||e2!=0)throw new Exception("Save failed ("+e2+"): "+p.path);
     rows.Add(new{stage=p.s.Item1,path=p.path,until=p.s.Item2,kept=keep.Count,deleted=deleted.AsEnumerable().Reverse().ToArray(),equations_removed=dropped.Count,solid_bodies=bodies==null?0:bodies.Length,volume_mm3=Math.Round(vol,3)});
    }finally{sw.CloseDoc(od.GetTitle());int ee=0;sw.ActivateDoc3(d.GetTitle(),false,1,ref ee);}
   }
  }catch{
   // a stage that failed leaves no half files behind (the copies are new files of this call)
   foreach(var p in plan)try{if(File.Exists(p.path)&&sw.GetOpenDocumentByName(p.path)==null)File.Delete(p.path);}catch{}
   throw;
  }
  var copied=new List<string>();
  if(copyTo!=null){Directory.CreateDirectory(copyTo);foreach(var p in plan){string t=Path.Combine(copyTo,Path.GetFileName(p.path));File.Copy(p.path,t,false);copied.Add(t);}}
  return new{stages=rows.ToArray(),copied_to=copyTo==null?null:copied.ToArray(),
   note="Each stage is a separate file in generated; the open part was not changed. Open them in SolidWorks to continue by hand."};
 }
}
