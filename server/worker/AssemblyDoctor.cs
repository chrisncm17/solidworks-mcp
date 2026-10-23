using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// Read only: do not select, resolve, rebuild, or invoke MateSummary (it changes shared mateRoot).
partial class Worker {
 static Dictionary<string,object> DoctorObject(object o){return o.GetType().GetProperties().ToDictionary(p=>p.Name,p=>p.GetValue(o,null));}
 static string DoctorConstraint(int s){switch(s){case 2:return "under_defined";case 3:return "fully_defined";case 4:return "over_defined";case 5:case 6:return "no_solution";default:return "unknown";}}
 static object DoctorError(int code){
  string symbol=Enum.GetName(typeof(swFeatureError_e),code)??"unknown";
  string meaning;
  switch(code){case 0:meaning="sin error";break;case 38:meaning="arista no v\u00e1lida";break;case 39:meaning="cara no v\u00e1lida";break;case 40:meaning="no se pudo crear la superficie";break;case 41:meaning="entidad no v\u00e1lida";break;case 42:meaning="tangencia indeterminada";break;case 43:meaning="referencia perdida (dangling)";break;case 44:meaning="la entidad no es lineal";break;case 45:meaning="fallo de entidad de relaci\u00f3n";break;case 46:meaning="relaci\u00f3n sobredefinida";break;case 47:meaning="relaci\u00f3n mal definida; no se puede resolver";break;case 48:meaning="relaci\u00f3n rota; no se puede resolver";break;case 51:meaning="fallo de referencia externa de croquis";break;case 73:meaning="faltan elementos de la operaci\u00f3n";break;default:meaning="error de operaci\u00f3n: "+symbol;break;}
  return new{code=code,symbol=symbol,meaning=meaning};
 }
 static string DoctorAxis(double[] v){
  if(v==null||v.Length<3)return "direcci\u00f3n no disponible";
  double len=Math.Sqrt(v.Take(3).Sum(x=>x*x));
  if(len>0)for(int i=0;i<3;i++)if(Math.Abs(v[i])/len>0.999999)return new[]{"X","Y","Z"}[i];
  return "["+string.Join(", ",v.Take(3).Select(x=>x.ToString("G6",System.Globalization.CultureInfo.InvariantCulture)))+"]";
 }
 static object DoctorDofItem(int status,MathVector vector,MathPoint point,int pointStatus,bool rotation,List<string> moves){
  var v=vector==null?null:(double[])vector.ArrayData;
  var p=point==null?null:((double[])point.ArrayData).Select(x=>x*1000).ToArray();
  string name=Enum.GetName(typeof(swDofStatus_e),status)??"unknown";
  // Tested in SW 2026: any status other than Unused IS a remaining DOF; the status describes its axis/direction:
  // Static = the axis stays put (e.g. a disk turning on a fixed shaft), Free = the axis itself can move, *Normal = the vector is a plane normal
  // (motion within that plane). Instantaneous is only local mobility.
  if(status>=1&&status<=6){string text=(rotation?"gira ":"se desliza ")+(status==2||status==4||status==6?"en el plano normal a ":rotation?"alrededor de ":"en ")+DoctorAxis(v);
   if(rotation&&p!=null&&(status==1||status==3))text+=" por ("+string.Join(", ",p.Select(x=>Math.Round(x,3).ToString(System.Globalization.CultureInfo.InvariantCulture)))+") mm";
   if(status==3||status==4)text+=" (el eje tambi\u00e9n puede desplazarse)";
   if(status==5||status==6)text+=" (movilidad instant\u00e1nea, no garantiza recorrido finito)";moves.Add(text);}
  return new{status=status,status_name=name,direction=v,point_mm=p,point_status=pointStatus,point_status_name=Enum.GetName(typeof(swDofStatus_e),pointStatus)};
 }
 static object DoctorDofs(IComponent2 c,List<string> moves){
  int p1s,r1s,p2s,r2s,t1s,t2s;MathPoint p1,p2;MathVector r1,r2,t1,t2;
  int status=c.GetRemainingDOFs(out p1s,out p1,out r1s,out r1,out p2s,out p2,out r2s,out r2,out t1s,out t1,out t2s,out t2);
  var rotations=new[]{DoctorDofItem(r1s,r1,p1,p1s,true,moves),DoctorDofItem(r2s,r2,p2,p2s,true,moves)};
  var translations=new[]{DoctorDofItem(t1s,t1,null,0,false,moves),DoctorDofItem(t2s,t2,null,0,false,moves)};
  if(status==(int)swRemainingDofs_e.swRemainingDofs_Unrestricted){moves.Clear();moves.Add("se desliza en X, Y y Z; gira alrededor de X, Y y Z");}
  else if(status!=(int)swRemainingDofs_e.swRemainingDofs_Restricted)moves.Clear();
  return new{status=status,status_name=Enum.GetName(typeof(swRemainingDofs_e),status),rotations=rotations,translations=translations,movements=moves.ToArray(),coordinate_frame="assembly; directions dimensionless, points mm"};
 }
 static string DoctorRigidParent(IComponent2 c){
  var p=c.GetParent() as IComponent2;
  while(p!=null){if(!p.IsRoot()&&p.Solving==(int)swComponentSolvingOption_e.swComponentRigidSolving)return p.Name2;p=p.GetParent() as IComponent2;}return null;
 }
 static string DoctorMateKey(IModelDoc2 d,IFeature f,IMate2 m){
  // Component pairs alone cannot prove duplicates: require persistent entity identities.
  var entities=new List<string>();
  for(int i=0;i<m.GetMateEntityCount();i++){var e=m.MateEntity(i);var bytes=d.Extension.GetPersistReference3(e.Reference) as byte[];if(bytes==null||bytes.Length==0)return null;
   var c=e.ReferenceComponent as IComponent2;entities.Add((c==null?"<assembly>":c.Name2)+":"+Convert.ToBase64String(bytes));}
  if(entities.Count!=2)return null;entities.Sort(StringComparer.Ordinal);
  var values=new List<string>();var dd=f.GetFirstDisplayDimension() as IDisplayDimension;
  while(dd!=null){var dim=dd.GetDimension2(0) as IDimension;if(dim!=null)values.Add(dim.SystemValue.ToString("R",System.Globalization.CultureInfo.InvariantCulture));dd=f.GetNextDisplayDimension(dd) as IDisplayDimension;}
  return m.Type+"|"+m.Alignment+"|"+string.Join("|",entities)+"|"+string.Join("|",values);
 }
 static bool TryAssemblyDoctor(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="assembly_doctor")return false;var asm=RequireAssembly(d);
  bool include=!a.ContainsKey("include_dofs")||Flag(a,"include_dofs"),only=Flag(a,"only_problems");
  var components=new List<object>();var missing=new List<object>();var mates=new List<object>();var wrong=new List<object>();var duplicates=new List<object>();var incomplete=new List<string>();
  var priorities=new SortedDictionary<int,List<string>>();int free=0,over=0,mateErrors=0,warnings=0,total=0;
  Action<int,string> problem=(rank,text)=>{if(!priorities.ContainsKey(rank))priorities[rank]=new List<string>();priorities[rank].Add(text);};
  foreach(IComponent2 c in Items(asm.GetComponents(false)??new object[0])){
   total++;string n="#"+total;var errors=new List<string>();var row=new Dictionary<string,object>();bool issue=false;
   try{
    n=c.Name2;row["name"]=n;string path=c.GetPathName();bool virt=c.IsVirtual,exists=File.Exists(path),loaded=c.IsLoaded();int sup=c.GetSuppression2();bool suppressed=sup==(int)swComponentSuppressionState_e.swComponentSuppressed;
    string suppression=suppressed?"suppressed":sup==(int)swComponentSuppressionState_e.swComponentLightweight||sup==(int)swComponentSuppressionState_e.swComponentFullyLightweight?"lightweight":sup==(int)swComponentSuppressionState_e.swComponentResolved||sup==(int)swComponentSuppressionState_e.swComponentFullyResolved?"resolved":"unknown";
    bool fixedComp=c.IsFixed();string rigid=DoctorRigidParent(c);
    row["file"]=path;row["exists_on_disk"]=exists;row["loaded"]=loaded;row["suppression_code"]=sup;row["suppression"]=suppression;row["fixed"]=fixedComp;row["visible"]=c.Visible==(int)swComponentVisibilityState_e.swComponentVisible;row["virtual"]=virt;row["referenced_configuration"]=c.ReferencedConfiguration;row["rigid_ancestor"]=rigid;
    if((!exists&&!virt)||!loaded){bool expected=suppressed||virt;missing.Add(new{source="component",component=n,file=path,exists_on_disk=exists,loaded=loaded,possible_missing=!expected,reason=suppressed?"suprimido; no cargar es esperado":virt?"virtual; no requiere archivo independiente":"posible pieza no encontrada o componente no cargado"});if(!expected){issue=true;problem(1,n+": posible pieza no encontrada / no cargada");}}
    int constrained=0;try{constrained=c.GetConstrainedStatus();row["constrained_status_code"]=constrained;row["definition"]=DoctorConstraint(constrained);}catch(Exception ex){errors.Add("GetConstrainedStatus: "+ex.Message);}
    try{row["mate_count"]=Items(c.GetMates()??new object[0]).Count();}catch(Exception ex){errors.Add("GetMates: "+ex.Message);}
    var moves=new List<string>();
    if(rigid!=null)row["dofs"]=new{status="inherited_rigid",note="Sin DOF propios en el ensamble superior; se mueve con "+rigid};
    else if(include&&!suppressed){try{var dofs=DoctorDofs(c,moves);row["dofs"]=dofs;int dofStatus=(int)DoctorObject(dofs)["status"];
     // Unavailable (tested): fixed components, pattern instances and components with no mates. Decide those without the API.
     int mc=row.ContainsKey("mate_count")?(int)row["mate_count"]:-1;
     if(dofStatus==2&&fixedComp){moves.Clear();row["dofs_note"]="fijo: sin movimientos";}
     else if(dofStatus==2&&mc==0&&constrained==2){moves.Clear();moves.Add("sin relaciones: se desliza en X, Y y Z y gira alrededor de X, Y y Z (6 GDL)");row["dofs_note"]="sin relaciones ni fijo";}
     else if(dofStatus==2&&mc==0&&constrained==3){moves.Clear();row["dofs_note"]="definido por un patr\u00f3n u operaci\u00f3n (sin relaciones propias)";}
     else if(dofStatus==2||dofStatus==3)errors.Add("GetRemainingDOFs: "+DoctorObject(dofs)["status_name"]);
     // publish ONE coherent list (dofs.movements was frozen before the Unavailable corrections)
     var dd=DoctorObject(dofs);dd["movements"]=moves.ToArray();row["dofs"]=dd;row["movements"]=moves.ToArray();}catch(Exception ex){errors.Add("GetRemainingDOFs: "+ex.Message);}}
    else row["dofs"]=new{status=include?"suppressed":"not_requested"};
    if(!suppressed&&rigid==null){if(constrained==4){over++;issue=true;problem(3,n+": sobredefinido");}else if(constrained==5||constrained==6){issue=true;problem(3,n+": sin soluci\u00f3n");}
     else if(constrained==2&&!fixedComp){free++;issue=true;problem(4,n+": "+(moves.Count>0?string.Join("; ",moves):include?"movimientos libres no disponibles; consultar dofs / read_errors":"movimientos no consultados (include_dofs=false)"));}}
   }catch(Exception ex){errors.Add(ex.Message);row["name"]=n;}
   if(errors.Count>0){issue=true;incomplete.Add(n+": "+string.Join("; ",errors));}row["read_errors"]=errors.ToArray();if(!only||issue)components.Add(row);
  }
  try{var deps=Items(sw.GetDocumentDependencies2(d.GetPathName(),true,false,false)??new object[0]).Select(Convert.ToString).ToArray();for(int i=1;i<deps.Length;i+=2)if(!File.Exists(deps[i])){missing.Add(new{source="dependency",name=deps[i-1],file=deps[i],possible_missing=true});problem(1,"Referencia no encontrada: "+deps[i]);}}
  catch(Exception ex){incomplete.Add("GetDocumentDependencies2: "+ex.Message);}
  mateRoot=Path.GetFullPath(d.GetPathName());var keys=new Dictionary<string,string>();int mateCount=0;
  foreach(var f in Mates(d)){
   mateCount++;try{var row=DoctorObject(MateInfo(f));int code=(int)row["error_code"];bool warning=(bool)row["is_warning"],suppressed=(bool)row["suppressed"];row["error"]=DoctorError(code);
    if(code!=0&&warning)warnings++;if(!suppressed&&MateBroken(f)){mateErrors++;problem(2,f.Name+": "+DoctorObject(DoctorError(code))["meaning"]);}
    string key=null;try{key=DoctorMateKey(d,f,(IMate2)f.GetSpecificFeature2());}catch(Exception ex){row["duplicate_check_error"]=ex.Message;incomplete.Add(f.Name+": duplicate check: "+ex.Message);}
    bool duplicate=false;if(!suppressed&&key!=null){if(keys.ContainsKey(key)){duplicate=true;duplicates.Add(new{mate=f.Name,duplicate_of=keys[key],reason="mismo tipo, alineaci\u00f3n, entidades persistentes y valores SI; posible redundancia"});problem(5,f.Name+": posible duplicada de "+keys[key]);}else keys[key]=f.Name;}
    row["duplicate_candidate"]=duplicate;if(!only||code!=0||duplicate)mates.Add(row);
   }catch(Exception ex){incomplete.Add(f.Name+": "+ex.Message);mates.Add(new{name=f.Name,read_error=ex.Message});}
  }
  try{object features,codes,warns;bool ok=d.Extension.GetWhatsWrong(out features,out codes,out warns);var fs=Items(features??new object[0]).ToArray();var cs=Items(codes??new object[0]).ToArray();var ws=Items(warns??new object[0]).ToArray();
   if(!ok&&d.Extension.GetWhatsWrongCount()>0)incomplete.Add("GetWhatsWrong returned false with pending items");
   for(int i=0;i<fs.Length;i++){var f=fs[i] as IFeature;int code=i<cs.Length?Convert.ToInt32(cs[i]):-1;bool warning=i<ws.Length&&Convert.ToBoolean(ws[i]);wrong.Add(new{feature=f==null?Convert.ToString(fs[i]):f.Name,error=DoctorError(code),is_warning=warning});if(code!=0)problem(6,(warning?"Advertencia: ":"Error de operaci\u00f3n: ")+(f==null?Convert.ToString(fs[i]):f.Name)+"; "+DoctorObject(DoctorError(code))["meaning"]);}
  }catch(Exception ex){incomplete.Add("GetWhatsWrong: "+ex.Message);}
  foreach(string e in incomplete)problem(7,"Diagn\u00f3stico incompleto: "+e);
  result=new{components=components.ToArray(),missing=missing.ToArray(),mates=mates.ToArray(),duplicates=duplicates.ToArray(),whats_wrong=wrong.ToArray(),summary=new{component_count=total,mate_count=mateCount,missing_entries=missing.Count,mate_errors=mateErrors,mate_warnings=warnings,over_defined=over,free_components=free,duplicate_candidates=duplicates.Count,whats_wrong_count=wrong.Count,complete=incomplete.Count==0,verdict=priorities.Count==0?"sin problemas":"problemas detectados",problems=priorities.SelectMany(kv=>kv.Value.Select(s=>new{priority=kv.Key,message=s})).ToArray()},read_errors=incomplete.ToArray(),rebuilt=false,note="Solo lectura; estados del \u00faltimo c\u00e1lculo. Orientaci\u00f3n incorrecta requiere una referencia de dise\u00f1o: una relaci\u00f3n volteada puede ser v\u00e1lida.",dof_status_legend=new{remaining="0 Restricted: consultar salidas; 1 Unrestricted: 6 DOF; 2 Unavailable; 3 Failed; 4 RootComponent",individual="0 Unused; 1 Static; 2 StaticNormal; 3 Free; 4 FreeNormal; 5 Instantaneous; 6 InstantaneousNormal. Normal indica normal del plano, no eje libre; Instantaneous solo movilidad local. Puntos de rotaci\u00f3n y direcciones conservan su status; no se inventan ejes cuando no est\u00e1n disponibles."}};
  return true;
 }
}
