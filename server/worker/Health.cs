using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

partial class Worker {
 static List<string> HealthNames(Dictionary<string,object> h,string k){return h.ContainsKey(k)?Items(h[k]).Select(Convert.ToString).OrderBy(x=>x,StringComparer.Ordinal).ToList():new List<string>();}
 static Dictionary<string,object> HealthMap(Dictionary<string,object> h,string k){return (Dictionary<string,object>)h[k];}
 static Dictionary<string,object> Health(IModelDoc2 d){return Health(d,false);}
 // v3.8 speed: light = no volume (mass properties); the volume is only used to verify a restore, and light_guard never restores
 static Dictionary<string,object> Health(IModelDoc2 d,bool light){
  var h=new Dictionary<string,object>();int type=d.GetType();h["doc_type"]=type;
  var errors=new Dictionary<string,object>();var sketches=new Dictionary<string,object>();var suppressed=new SortedSet<string>(StringComparer.Ordinal);
  try{
   d.ClearSelection2(true);
   var features=AllFeatures(d).ToList();if(type==2)features.AddRange(Mates(d));
   // v3.9: the sub-features of a sheet metal Flat-Pattern (its bounding box, bend lines...) are internal state that SolidWorks
   // lists in memory but not always after reopening the file: they are left out so a verified restore compares like with like
   var internalNames=new HashSet<string>(StringComparer.Ordinal);
   foreach(var f in features){string tn=f.GetTypeName2();if(tn=="FlatPattern")for(var sf=f.GetFirstSubFeature() as IFeature;sf!=null;sf=sf.GetNextSubFeature() as IFeature)internalNames.Add(sf.Name);if(tn.IndexOf("BoundingBox",StringComparison.OrdinalIgnoreCase)>=0)internalNames.Add(f.Name);}
   features=features.Where(f=>!internalNames.Contains(f.Name)).ToList();
   // sheet metal also creates internal sub-features (bend sketches, transforms) that change on reopening: there, suppression and
   // names are compared on the top-level features only (errors are still read on every feature)
   HashSet<string> top=null;
   if(type==1&&features.Any(f=>f.GetTypeName2()=="FlatPattern")){top=new HashSet<string>(StringComparer.Ordinal);for(var f=d.FirstFeature() as IFeature;f!=null;f=f.GetNextFeature() as IFeature)top.Add(f.Name);}
   foreach(var f in features){bool warning;int code=f.GetErrorCode2(out warning);if(code!=0)errors[f.Name]=new Dictionary<string,object>{{"code",code},{"warning",warning},{"meaning",DoctorObject(DoctorError(code))["meaning"]}};
    if(f.IsSuppressed()&&(top==null||top.Contains(f.Name)))suppressed.Add(f.Name);
    var sk=f.GetSpecificFeature2() as ISketch;if(sk!=null){int s=sk.GetConstrainedStatus();if(s==4||s==5||s==6)sketches[f.Name]=s;}
   }
   h["feature_errors"]=errors;h["bad_sketches"]=sketches;h["suppressed"]=suppressed.ToArray();
   // v3.9: every feature name, so a feature CREATED suppressed (sheet metal Flat-Pattern, bounding box) is not taken for one
   // that an edit suppressed
   h["feature_names"]=features.Select(f=>f.Name).Where(n=>top==null||top.Contains(n)).OrderBy(x=>x,StringComparer.Ordinal).ToArray();
   // Codex review: a verified restore must also prove no feature is missing: top-level feature names are stable across a
   // reopen (internal sub-features are not), so they are compared; feature_names stays only for telling new from old
   var topAll=new List<string>();for(var f=d.FirstFeature() as IFeature;f!=null;f=f.GetNextFeature() as IFeature)if(!internalNames.Contains(f.Name))topAll.Add(f.Name);
   h["top_features"]=topAll.OrderBy(x=>x,StringComparer.Ordinal).ToArray();
   if(type==1){int count=Items(((IPartDoc)d).GetBodies2(0,true)??new object[0]).Count();h["bodies"]=count;double volume=0;
    if(count>0&&!light){var mp=(IMassProperty2)d.Extension.CreateMassProperty2();if(mp==null)throw new Exception("No se pudo medir el volumen");mp.UseSystemUnits=true;if(!mp.Recalculate())throw new Exception("No se pudo recalcular el volumen");volume=mp.Volume*1e9;if(double.IsNaN(volume)||double.IsInfinity(volume))throw new Exception("Volumen no finito");}h["volume_mm3"]=volume;
   }
   if(type==2){h["broken_mates"]=BrokenMates(d).OrderBy(x=>x,StringComparer.Ordinal).ToArray();h["mate_warnings"]=Mates(d).Where(f=>{bool w;return f.GetErrorCode2(out w)!=0&&w;}).Select(f=>f.Name).OrderBy(x=>x,StringComparer.Ordinal).ToArray();
    var names=new List<string>();var sup=new List<string>();var missing=new List<string>();var unloaded=new List<string>();
    foreach(IComponent2 c in Items(((IAssemblyDoc)d).GetComponents(false)??new object[0])){string n=c.Name2;names.Add(n);bool s=c.IsSuppressed();if(s)sup.Add(n);else if(!c.IsLoaded()){unloaded.Add(n);if(!c.IsVirtual&&!File.Exists(c.GetPathName()))missing.Add(n);}}
    h["components"]=names.Count;h["component_names"]=names.OrderBy(x=>x,StringComparer.Ordinal).ToArray();h["suppressed_components"]=sup.OrderBy(x=>x,StringComparer.Ordinal).ToArray();h["missing_components"]=missing.OrderBy(x=>x,StringComparer.Ordinal).ToArray();h["unloaded_components"]=unloaded.OrderBy(x=>x,StringComparer.Ordinal).ToArray();
   }
   object fs,cs,ws;bool ok=d.Extension.GetWhatsWrong(out fs,out cs,out ws);var codes=Items(cs??new object[0]).ToArray();var warnings=Items(ws??new object[0]).ToArray();
   // v2.9 (Claude): an incomplete GetWhatsWrong must not make every guarded edit impossible: record -1 (unknown) instead of throwing
   if((!ok&&d.Extension.GetWhatsWrongCount()>0)||codes.Length!=warnings.Length)h["whats_wrong"]=-1;
   else h["whats_wrong"]=codes.Where((x,i)=>Convert.ToInt32(x)!=0&&!Convert.ToBoolean(warnings[i])).Count();return h;
  }finally{d.ClearSelection2(true);}
 }
 static List<string> HealthProblems(Dictionary<string,object> h){
  var p=new List<string>();foreach(var kv in HealthMap(h,"feature_errors")){var e=(Dictionary<string,object>)kv.Value;if(!Convert.ToBoolean(e["warning"]))p.Add("Error en "+kv.Key+": "+e["meaning"]);}
  foreach(var kv in HealthMap(h,"bad_sketches"))p.Add("Croquis inv\u00e1lido "+kv.Key+" (estado "+kv.Value+")");
  foreach(string n in HealthNames(h,"broken_mates"))p.Add("Relaci\u00f3n rota "+n);
  foreach(string n in HealthNames(h,"missing_components"))p.Add("Componente faltante "+n);
  if(h.ContainsKey("bodies")&&Convert.ToInt32(h["bodies"])==0)p.Add("Pieza sin cuerpos s\u00f3lidos");
  if(Convert.ToInt32(h["whats_wrong"])>0)p.Add("GetWhatsWrong: "+h["whats_wrong"]+" errores");return p.OrderBy(x=>x,StringComparer.Ordinal).ToList();
 }
 static List<string> HealthRegressions(Dictionary<string,object> before,Dictionary<string,object> after){
  var p=new List<string>();var old=HealthMap(before,"feature_errors");foreach(var kv in HealthMap(after,"feature_errors")){var e=(Dictionary<string,object>)kv.Value;object prev;bool had=old.TryGetValue(kv.Key,out prev)&&!Convert.ToBoolean(((Dictionary<string,object>)prev)["warning"]);if(!Convert.ToBoolean(e["warning"])&&!had)p.Add("Error nuevo en "+kv.Key+": "+e["meaning"]);}
  foreach(var kv in HealthMap(after,"bad_sketches"))if(!HealthMap(before,"bad_sketches").ContainsKey(kv.Key))p.Add("Croquis qued\u00f3 inv\u00e1lido "+kv.Key);
  var existedF=new HashSet<string>(HealthNames(before,"feature_names"),StringComparer.Ordinal);var existedC=new HashSet<string>(HealthNames(before,"component_names"),StringComparer.Ordinal);
  bool knowF=before.ContainsKey("feature_names"),knowC=before.ContainsKey("component_names");
  foreach(string k in new[]{"broken_mates","missing_components","unloaded_components","suppressed","suppressed_components"})foreach(string n in HealthNames(after,k).Except(HealthNames(before,k)).Where(n=>k=="suppressed"?!knowF||existedF.Contains(n):k=="suppressed_components"?!knowC||existedC.Contains(n):true))p.Add((k=="broken_mates"?"Se rompi\u00f3 la relaci\u00f3n ":k=="suppressed"||k=="suppressed_components"?"Qued\u00f3 suprimida ":"Componente faltante o no cargado ")+n);
  foreach(string n in HealthNames(before,"component_names").Except(HealthNames(after,"component_names")))p.Add("Desapareci\u00f3 el componente "+n);
  if(before.ContainsKey("bodies")&&after.ContainsKey("bodies")&&Convert.ToInt32(after["bodies"])==0&&Convert.ToInt32(before["bodies"])>0)p.Add("Disminuy\u00f3 el n\u00famero de cuerpos: "+before["bodies"]+" a "+after["bodies"]);
  if(before.ContainsKey("components")&&after.ContainsKey("components")&&Convert.ToInt32(after["components"])<Convert.ToInt32(before["components"]))p.Add("Disminuy\u00f3 el n\u00famero de componentes");
  if(Convert.ToInt32(after["whats_wrong"])>Convert.ToInt32(before["whats_wrong"]))p.Add("Aumentaron los errores GetWhatsWrong");return p.Distinct().OrderBy(x=>x,StringComparer.Ordinal).ToList();
 }
 static void HealthCompare(object a,object b,string path,double tol,List<string> diffs){
  var da=a as Dictionary<string,object>;var db=b as Dictionary<string,object>;
  if(da!=null&&db!=null){foreach(string k in da.Keys.Union(db.Keys).OrderBy(x=>x,StringComparer.Ordinal)){if(path==""&&k=="feature_names")continue;/* feature_names only tells new features from old ones */if(!da.ContainsKey(k)||!db.ContainsKey(k))diffs.Add(path+k+": campo ausente");else HealthCompare(da[k],db[k],path+k+".",tol,diffs);}return;}
  if(path=="volume_mm3."&&a!=null&&b!=null){double x=Convert.ToDouble(a),y=Convert.ToDouble(b);if(double.IsNaN(x)||double.IsNaN(y)||double.IsInfinity(x)||double.IsInfinity(y)||Math.Abs(x-y)>tol)diffs.Add("volume_mm3: volumen diferente");return;}
  if(a is IEnumerable&&!(a is string)&&b is IEnumerable&&!(b is string)){var aa=((IEnumerable)a).Cast<object>().ToArray();var bb=((IEnumerable)b).Cast<object>().ToArray();if(aa.Length!=bb.Length)diffs.Add(path+"cantidad diferente");for(int i=0;i<Math.Min(aa.Length,bb.Length);i++)HealthCompare(aa[i],bb[i],path+i+".",tol,diffs);return;}
  if(!object.Equals(a,b))diffs.Add(path.TrimEnd('.')+": "+Convert.ToString(a)+" -> "+Convert.ToString(b));
 }
 static List<string> HealthDifferences(Dictionary<string,object> a,Dictionary<string,object> b,double volTolMm3){if(double.IsNaN(volTolMm3)||double.IsInfinity(volTolMm3)||volTolMm3<0)throw new ArgumentOutOfRangeException("volTolMm3");var p=new List<string>();HealthCompare(a,b,"",volTolMm3,p);return p;}
}
