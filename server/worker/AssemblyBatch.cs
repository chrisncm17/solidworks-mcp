using System;
using System.Linq;
using System.Diagnostics;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

// v3.7 assembly_batch: insert every component and add every mate of an assembly plan in ONE worker call (one safe-edit
// health check instead of two per item, no whole-assembly mass inspection per item). Mates refer to components by the plan id;
// they are translated to the real names SolidWorks gives on insertion. Stops at the first failure unless stop_on_error=false.
// v3.7 review: with stop_on_error the call THROWS at the first failure, so the safe edit (Guarded) rolls the whole batch back
// instead of accepting a half-built assembly; a mate marked suppressed is suppressed right after it is created.
partial class Worker {
 // v3.8 speed: no window redraw and no FeatureManager tree refresh while the batch inserts and mates (restored after;
 // SW_MCP_BATCH_GFX=1 keeps them on for an A/B measurement)
 static bool TryAssemblyBatch(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="assembly_batch")return false;
  bool quiet=System.Environment.GetEnvironmentVariable("SW_MCP_BATCH_GFX")!="1";var v=quiet?d.ActiveView as IModelView:null;var fm=quiet?d.FeatureManager:null;bool g0=true,t0=true,w0=true;
  try{if(v!=null){g0=v.EnableGraphicsUpdate;v.EnableGraphicsUpdate=false;}if(fm!=null){t0=fm.EnableFeatureTree;w0=fm.EnableFeatureTreeWindow;fm.EnableFeatureTree=false;fm.EnableFeatureTreeWindow=false;}}catch{}
  try{return AssemblyBatchCore(a,d,out result);}
  finally{try{if(fm!=null){fm.EnableFeatureTreeWindow=w0;fm.EnableFeatureTree=t0;}if(v!=null)v.EnableGraphicsUpdate=g0;}catch{}}
 }
 static bool AssemblyBatchCore(Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;
  if(d.GetType()!=2)throw new Exception("assembly_batch needs an assembly");
  bool stop=!a.ContainsKey("stop_on_error")||Flag(a,"stop_on_error"),defer=Flag(a,"defer_rebuild");
  var names=new Dictionary<string,string>();var comps=new List<object>();var mates=new List<object>();var failures=new List<object>();
  var sw0=Stopwatch.StartNew();
  batchOpened=new List<IModelDoc2>();batchWant=new Dictionary<string,double[]>();bool compsDone=false;
  try{
  // v3.8 speed: open each distinct file once and activate the assembly once (inserts then skip the activation)
  if(a.ContainsKey("components")){foreach(var pth in Items(a["components"]).Cast<Dictionary<string,object>>().Where(c=>c.ContainsKey("path")).Select(c=>Str(c,"path")).Distinct(StringComparer.OrdinalIgnoreCase)){
    if(!System.IO.File.Exists(pth)||sw.GetOpenDocumentByName(pth)!=null)continue;string ext=System.IO.Path.GetExtension(pth).ToLowerInvariant();if(ext!=".sldprt"&&ext!=".sldasm")continue;
    int oe=0,ow=0;var od=(IModelDoc2)sw.OpenDoc6(pth,ext==".sldprt"?1:2,1,"",ref oe,ref ow);if(od!=null)batchOpened.Add(od);}
   int act0=0;sw.ActivateDoc3(d.GetTitle(),false,1,ref act0);}
  if(a.ContainsKey("components"))foreach(Dictionary<string,object> c in Items(a["components"])){
   var t=Stopwatch.StartNew();string id=c.ContainsKey("id")?Str(c,"id"):null;
   var args=c.Where(kv=>kv.Key!="id").ToDictionary(kv=>kv.Key,kv=>kv.Value);args["_quick"]=true;
   try{var r=ExecuteOnDoc("insert_component",args,d);string name=(string)r.GetType().GetProperty("component").GetValue(r,null);if(id!=null)names[id]=name;comps.Add(new{id=id,component=name,ms=t.ElapsedMilliseconds});}
   catch(Exception e){failures.Add(new{stage="component",id=id,error=e.Message});if(stop)break;}
  }
  compsDone=true;}finally{var opened=batchOpened;batchOpened=null;foreach(var od in opened)try{sw.CloseDoc(od.GetTitle());}catch{}
   if(opened.Count>0){int act=0;sw.ActivateDoc3(d.GetTitle(),false,1,ref act);}
   var want=batchWant;batchWant=null;
   // one rebuild for all the inserts, then every component must still be where it was put
   if(compsDone&&want.Count>0){d.EditRebuild3();var tr=Transforms((IAssemblyDoc)d);
    var bad=want.Where(kv=>!tr.ContainsKey(kv.Key)||MaxDiff(tr[kv.Key],kv.Value)>1e-8).Select(kv=>kv.Key).ToList();
    if(bad.Count>0)throw new Exception("Inserted component(s) did not retain the requested transform: "+string.Join(", ",bad));}}
  long tComponents=sw0.ElapsedMilliseconds;
  long tPre=0;
  if(failures.Count==0||!stop){
   d.EditRebuild3();int i=0;
   // v3.8 preflight: resolve EVERY {component, find} first (part coordinates do not depend on placement) and report all the
   // ambiguous or missing faces at once, instead of one per build; the resolved entities are reused below
   var swPre=Stopwatch.StartNew();findTimes.Clear();var pre=new Dictionary<int,List<object>>();var preErr=new List<string>();int pi=0;
   if(a.ContainsKey("mates"))foreach(Dictionary<string,object> m in Items(a["mates"])){
    string lab=m.ContainsKey("name")?Str(m,"name"):("#"+pi);var list=new List<object>();bool okm=true;
    foreach(var o in Items(m["entities"])){var e=((Dictionary<string,object>)o).ToDictionary(kv=>kv.Key,kv=>kv.Value);
     if(e.ContainsKey("component")){string cid=Str(e,"component");if(names.ContainsKey(cid))e["component"]=names[cid];}
     if(e.ContainsKey("find"))try{e=ResolveFind(d,e);}catch(Exception ex){preErr.Add("mate "+pi+" "+lab+": "+ex.Message);okm=false;}
     list.Add(e);}
    if(okm)pre[pi]=list;pi++;}
   tPre=swPre.ElapsedMilliseconds;if(preErr.Count>0&&stop)throw new Exception("assembly_batch preflight: "+preErr.Count+" mate entities cannot be resolved (no mate was added):\n"+string.Join("\n",preErr.Take(30)));
   batchMates=new HashSet<string>(Mates(d).Select(x=>x.Name));
   try{
   if(a.ContainsKey("mates"))foreach(Dictionary<string,object> m in Items(a["mates"])){
    var t=Stopwatch.StartNew();var args=m.Where(kv=>kv.Key!="name"&&kv.Key!="suppressed").ToDictionary(kv=>kv.Key,kv=>kv.Value);args["_quick"]=true;if(defer)args["_norebuild"]=true;
    // plan ids -> real component names
    args["entities"]=Items(m["entities"]).Select(o=>{var e=((Dictionary<string,object>)o).ToDictionary(kv=>kv.Key,kv=>kv.Value);if(e.ContainsKey("component")){string cid=Str(e,"component");if(names.ContainsKey(cid))e["component"]=names[cid];}return (object)e;}).ToList();
    if(args.ContainsKey("expect")){var ex=((Dictionary<string,object>)args["expect"]).ToDictionary(kv=>kv.Key,kv=>kv.Value);string ecid=Str(ex,"component");if(names.ContainsKey(ecid))ex["component"]=names[ecid];args["expect"]=ex;}
    string label=m.ContainsKey("name")?Str(m,"name"):("#"+i);
    try{
     // v3.7: entities described by the drawing ({component, find:{cylinder Ø / plane normal}}) become local points here
     args["entities"]=pre.ContainsKey(i)?pre[i]:((List<object>)args["entities"]).Select(o=>{var e=(Dictionary<string,object>)o;return (object)(e.ContainsKey("find")?ResolveFind(d,e):e);}).ToList();
     var r=ExecuteOnDoc("add_mate",args,d);var pt=r.GetType();
     mates.Add(new{index=i,name=label,mate=pt.GetProperty("mate").GetValue(r,null),error_code=pt.GetProperty("error_code").GetValue(r,null),is_warning=pt.GetProperty("is_warning").GetValue(r,null),moved_components=pt.GetProperty("moved_components").GetValue(r,null),snapped=pt.GetProperty("snapped")==null?null:pt.GetProperty("snapped").GetValue(r,null),ms=t.ElapsedMilliseconds,split_ms=pt.GetProperty("split_ms")==null?null:pt.GetProperty("split_ms").GetValue(r,null)});
     int code=Convert.ToInt32(pt.GetProperty("error_code").GetValue(r,null));bool warn=Convert.ToBoolean(pt.GetProperty("is_warning").GetValue(r,null));
     if(code!=0&&!warn){failures.Add(new{stage="mate",index=i,name=label,error="Mate creado con error "+code});if(stop)break;}
     else if(Flag(m,"suppressed")){string mn=Convert.ToString(pt.GetProperty("mate").GetValue(r,null));if(string.IsNullOrEmpty(mn))throw new Exception("add_mate no devolvió el nombre necesario para suprimir");
      ExecuteOnDoc("mates",new Dictionary<string,object>{{"action","suppress"},{"names",new List<object>{mn}}},d);}}
    catch(Exception e){failures.Add(new{stage="mate",index=i,name=label,error=e.Message});if(stop)break;}
    i++;
   }
   }finally{batchMates=null;}
  }
  d.EditRebuild3();
  // v3.8 defer_rebuild: every mate this call created is checked AFTER the single rebuild; any error stops like before, by name
  if(defer&&failures.Count==0){
   var made=new HashSet<string>(mates.Select(x=>Convert.ToString(x.GetType().GetProperty("mate").GetValue(x,null))));
   foreach(var mf in Mates(d).Where(x=>made.Contains(x.Name))){bool w=false;int code=mf.GetErrorCode2(out w);
    if(code!=0&&!w){var idx=mates.FirstOrDefault(x=>Convert.ToString(x.GetType().GetProperty("mate").GetValue(x,null))==mf.Name);var it=idx==null?null:idx.GetType();
     failures.Add(new{stage="mate",index=it==null?(object)null:it.GetProperty("index").GetValue(idx,null),name=it==null?mf.Name:Convert.ToString(it.GetProperty("name").GetValue(idx,null)),error="Mate con error "+code+" tras reconstruir ("+mf.Name+")"});}}
  }
  if(stop&&failures.Count>0){var f0=failures[0];var ft=f0.GetType();
   throw new Exception("assembly_batch stopped: "+ft.GetProperty("stage").GetValue(f0,null)+" "+(Convert.ToString((ft.GetProperty("name")??ft.GetProperty("id")).GetValue(f0,null)))+": "+ft.GetProperty("error").GetValue(f0,null)+" | done before it: "+comps.Count+" components, "+mates.Count+" mates");}
  result=new{components=comps,mates=mates,names=names,failures=failures,recovery_unproven=failures.Count>0,timings_ms=new{components=tComponents,mates=sw0.ElapsedMilliseconds-tComponents,preflight=tPre,find_ms=findTimes.ToArray()}};
  return true;
 }
}
