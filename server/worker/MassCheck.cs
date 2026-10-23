using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v2.6 mass_check (READ-ONLY): mass / volume / center of mass of a part or assembly, optionally in a named coordinate system,
// compared with the reference values of a drawing (any length/mass units), per-part breakdown (material, density, count, mass
// per instance, overrides, hidden/suppressed/lightweight) and a diagnosis of likely causes when they differ. Nothing is changed.
partial class Worker {
 static readonly Dictionary<string,double> LenToMm=new Dictionary<string,double>{{"mm",1},{"cm",10},{"m",1000},{"in",25.4}};
 static readonly Dictionary<string,double> MassToG=new Dictionary<string,double>{{"g",1},{"kg",1000},{"lb",453.59237}};
 static double[] MassVals(IModelDoc2 d,MathTransform cs,bool hidden){
  d.ClearSelection2(true);   // CreateMassProperty2 uses the current selection as scope: start from nothing selected = whole document
  var mp=(IMassProperty2)d.Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.AccuracyLevel=2;mp.IncludeHiddenBodiesOrComponents=hidden;
  if(cs!=null&&!mp.SetCoordinateSystem(cs))throw new Exception("Could not use the coordinate system for mass properties");
  if(!mp.Recalculate())throw new Exception("Mass properties could not be computed");
  var c=(double[])mp.CenterOfMass;return new[]{mp.Mass*1000,mp.Volume*1e9,c[0]*1000,c[1]*1000,c[2]*1000,mp.Density};
 }
 // ---- SolidWorks material library (spanish + english "solidworks materials.sldmat"; the same matid in both languages)
 class MatEntry{public int id;public string es,en,classification;public double density;}
 static List<MatEntry> matLib;
 static string Fold(string x){if(x==null)return "";var n=x.Normalize(System.Text.NormalizationForm.FormD);var sb=new System.Text.StringBuilder();foreach(var ch in n)if(System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch)!=System.Globalization.UnicodeCategory.NonSpacingMark)sb.Append(char.ToLowerInvariant(ch));return System.Text.RegularExpressions.Regex.Replace(sb.ToString(),"\\s+"," ").Trim();}
 static List<MatEntry> MaterialLibrary(){
  if(matLib!=null)return matLib;
  string exe=sw.GetExecutablePath();string root=exe.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)?Path.GetDirectoryName(exe):exe;
  Func<string,Dictionary<int,Tuple<string,string,double>>> load=lang=>{var r=new Dictionary<int,Tuple<string,string,double>>();var f=Path.Combine(root,"lang",lang,"sldmaterials","solidworks materials.sldmat");if(!File.Exists(f))return r;
   var t=File.ReadAllText(f);string cls="";
   foreach(System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(t,"<classification name=\"([^\"]+)\"|<material name=\"([^\"]+)\" matid=\"(\\d+)\"[\\s\\S]*?<DENS [^>]*value=\"([^\"]+)\"")){
    if(m.Groups[1].Success){cls=m.Groups[1].Value;continue;}
    int id=int.Parse(m.Groups[3].Value);double dv;double.TryParse(m.Groups[4].Value,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out dv);
    if(!r.ContainsKey(id))r[id]=Tuple.Create(System.Net.WebUtility.HtmlDecode(m.Groups[2].Value),cls,dv);}
   return r;};
  var es=load("spanish");var en=load("english");
  matLib=es.Keys.Union(en.Keys).Select(id=>new MatEntry{id=id,es=es.ContainsKey(id)?es[id].Item1:null,en=en.ContainsKey(id)?en[id].Item1:null,classification=es.ContainsKey(id)?es[id].Item2:en[id].Item2,density=es.ContainsKey(id)?es[id].Item3:en[id].Item3}).ToList();
  return matLib;
 }
 // exact (accent/case-insensitive) name in either language; null when unknown
 static MatEntry FindMaterial(string name){var f=Fold(name);if(f=="")return null;return MaterialLibrary().FirstOrDefault(m=>Fold(m.es)==f||Fold(m.en)==f);}
 // set_material (replaces the part-only version): library material by its Spanish or English name, verified by library id.
 // Part: the active configuration. Assembly: component (its referenced configuration) — this changes that PART file (backed up by
 // sw_open_project when it is a user file); save with sw_save include_references:true.
 static bool TrySetMaterial(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="set_material")return false;
  string want=Str(a,"material");string db=a.ContainsKey("database")?Str(a,"database"):"SOLIDWORKS Materials";
  IPartDoc part;string cfg;string label;IComponent2 comp=null;
  if(d.GetType()==1){part=(IPartDoc)d;cfg=((IConfiguration)d.ConfigurationManager.ActiveConfiguration).Name;label=d.GetTitle();if(a.ContainsKey("component"))throw new Exception("component is only for assemblies");}
  else if(d.GetType()==2){if(!a.ContainsKey("component"))throw new Exception("In an assembly give component (e.g. Abrazadera-1); all instances of that part file get the material");
   comp=CompByName((IAssemblyDoc)d,Str(a,"component"));var md=comp.GetModelDoc2() as IModelDoc2;if(md==null||md.GetType()!=1)throw new Exception(comp.Name2+" is not a resolved part");
   if(recoveryPending.Contains(md.GetPathName()))throw new Exception(Path.GetFileName(md.GetPathName())+" is blocked after an altered state; close without saving");
   part=(IPartDoc)md;cfg=comp.ReferencedConfiguration;label=Path.GetFileName(md.GetPathName());}
  else throw new Exception("set_material needs a part or an assembly");
  var lib=FindMaterial(want);
  var candidates=new List<string>{want};if(lib!=null){if(lib.es!=null)candidates.Add(lib.es);if(lib.en!=null)candidates.Add(lib.en);}
  string before;string bdb;before=part.GetMaterialPropertyName2(cfg,out bdb);
  string got=null;string gdb="";
  foreach(var name in candidates.Distinct()){part.SetMaterialPropertyName2(cfg,db,name);got=part.GetMaterialPropertyName2(cfg,out gdb);var g=FindMaterial(got);
   if(!string.IsNullOrEmpty(got)&&(got==name||lib!=null&&g!=null&&g.id==lib.id))break;got=null;}
  var gm=FindMaterial(got);
  if(got==null||(lib!=null&&(gm==null||gm.id!=lib.id))){
   // put the previous material back (or none) so a failed request leaves nothing changed
   try{part.SetMaterialPropertyName2(cfg,bdb??"",before??"");}catch{}
   throw new Exception("Material '"+want+"' could not be assigned from "+db+(lib==null?" (not found in the SolidWorks library: check the spelling, e.g. Hierro dúctil, Oro puro, Caucho, AISI 304, AISI 1020)":"")+"; previous material kept: "+(string.IsNullOrEmpty(before)?"none":before));}
  ((IModelDoc2)part).ForceRebuild3(false);if(d!=part)d.ForceRebuild3(false);
  var mp=(IMassProperty2)((IModelDoc2)part).Extension.CreateMassProperty2();mp.UseSystemUnits=true;mp.Recalculate();
  result=new{part=label,configuration=cfg,requested=want,assigned=got,database=gdb,library_id=gm==null?(int?)null:gm.id,density_kg_m3=Math.Round(mp.Density,3),part_mass_g=Math.Round(mp.Mass*1000,4),previous=string.IsNullOrEmpty(before)?null:before,
   note=d.GetType()==2?"The PART file changed: save with sw_save include_references:true. Every instance of "+label+" uses this material.":"Unsaved until sw_save."};
  return true;
 }
 static bool TryMassCheck(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="mass_check")return false;var mw=System.Diagnostics.Stopwatch.StartNew();var mt=new long[5];
  if(d.GetType()==3)throw new Exception("mass_check needs a part or assembly");
  string lu=a.ContainsKey("length_units")?Str(a,"length_units"):"mm",mu=a.ContainsKey("mass_units")?Str(a,"mass_units"):"g";
  if(!LenToMm.ContainsKey(lu)||!MassToG.ContainsKey(mu))throw new Exception("length_units mm|cm|m|in, mass_units g|kg|lb");
  // v3.6 user rule: a difference under 0.5 % is not corrected. Mass: percent. CM: each component ok within com_tolerance_percent of the
  // drawing value OR com_tolerance (absolute, default 0.05 mm) so a value near zero (Y = 0.0110 in) does not fail on its last digit.
  double tolPct=a.ContainsKey("mass_tolerance_percent")?Num(a,"mass_tolerance_percent"):0.5,tolCm=a.ContainsKey("com_tolerance")?Num(a,"com_tolerance")*LenToMm[lu]:0.05,tolCmPct=a.ContainsKey("com_tolerance_percent")?Num(a,"com_tolerance_percent"):0.5;
  Func<double,double,bool> cmOk=(diff,refv)=>Math.Abs(diff)<=Math.Max(tolCm,Math.Abs(refv)*tolCmPct/100);
  // coordinate systems of the model, and the one requested (CM measured from it, as SolidWorks "Mass properties > report relative to")
  var csNames=AllFeatures(d).Where(f=>f.GetTypeName2()=="CoordSys").Select(f=>f.Name).ToArray();
  MathTransform cs=null;string csName=null;
  if(a.ContainsKey("coordinate_system")){csName=Str(a,"coordinate_system");if(!csNames.Contains(csName))throw new Exception("Coordinate system not found: "+csName+" (have: "+(csNames.Length==0?"none":string.Join(", ",csNames))+")");cs=(MathTransform)d.Extension.GetCoordinateSystemTransformByName(csName);if(cs==null)throw new Exception("Coordinate system "+csName+" exists but its transform could not be read; nothing reported");}
  mt[4]=mw.ElapsedMilliseconds;var tot=MassVals(d,cs,true);mt[0]=mw.ElapsedMilliseconds;var totNoHidden=MassVals(d,cs,false);mt[1]=mw.ElapsedMilliseconds;
  Func<double,double> L=x=>Math.Round(x/LenToMm[lu],6);Func<double,double> M=x=>Math.Round(x/MassToG[mu],6);
  // ---- per part
  var parts=new List<Dictionary<string,object>>();var notes=new List<string>();
  if(d.GetType()==1){var pd=(IPartDoc)d;string db;string mat=pd.GetMaterialPropertyName2("",out db);
   parts.Add(new Dictionary<string,object>{{"part",d.GetTitle()},{"count",1},{"material",string.IsNullOrEmpty(mat)?null:mat},{"density_kg_m3",Math.Round(tot[5],3)},{"mass_each",M(tot[0])},{"volume_mm3",Math.Round(tot[1],3)}});
   if(string.IsNullOrEmpty(mat))notes.Add("The part has NO material: SolidWorks uses its default density ("+Math.Round(tot[5],1)+" kg/m³).");}
  else{
   var asm=(IAssemblyDoc)d;var groups=new Dictionary<string,Dictionary<string,object>>();
   foreach(IComponent2 c in (object[])asm.GetComponents(false)??new object[0]){
    string path=c.GetPathName()??"";bool isPart=path.EndsWith(".sldprt",StringComparison.OrdinalIgnoreCase);if(!isPart)continue;
    int sup=c.GetSuppression2();string state=sup==(int)swComponentSuppressionState_e.swComponentSuppressed?"suppressed":(sup==(int)swComponentSuppressionState_e.swComponentLightweight||sup==(int)swComponentSuppressionState_e.swComponentFullyLightweight)?"lightweight":"resolved";
    bool hidden=c.Visible==(int)swComponentVisibilityState_e.swComponentHidden;
    string key=Path.GetFullPath(path).ToLowerInvariant()+"|"+c.ReferencedConfiguration+"|"+state+"|"+hidden;
    if(!groups.ContainsKey(key)){
     var md=c.GetModelDoc2() as IModelDoc2;string mat=null,matDb=null;double dens=double.NaN,mEach=double.NaN,vEach=double.NaN;bool ovr=false;bool known=md!=null&&state!="suppressed";
     if(known){string db;mat=((IPartDoc)md).GetMaterialPropertyName2(c.ReferencedConfiguration,out db);if(mat=="")mat=null;matDb=db;
      d.ClearSelection2(true);if(c.Select4(false,null,false)){int st=0;var v=(double[])d.Extension.GetMassProperties2(2,out st,true);if(v!=null&&st==0){mEach=v[5]*1000;vEach=v[3]*1e9;dens=v[3]>0?v[5]/v[3]:double.NaN;}}d.ClearSelection2(true);
      try{var pmp=(IMassProperty2)md.Extension.CreateMassProperty2();var oo=pmp.GetOverrideOptions() as IMassPropertyOverrideOptions;ovr=oo!=null&&(oo.OverrideMass||oo.OverrideCenterOfMass);}catch{}}
     groups[key]=new Dictionary<string,object>{{"part",Path.GetFileName(path)},{"configuration",c.ReferencedConfiguration},{"count",0},{"material",mat},{"density_kg_m3",double.IsNaN(dens)?(object)null:Math.Round(dens,3)},{"mass_each",double.IsNaN(mEach)?(object)null:M(mEach)},{"volume_each_mm3",double.IsNaN(vEach)?(object)null:Math.Round(vEach,3)},{"state",state},{"hidden",hidden},{"mass_override",ovr},{"material_database",matDb},{"material_known",known},{"_m",mEach}};
    }
    groups[key]["count"]=(int)groups[key]["count"]+1;
   }
   parts=groups.Values.OrderByDescending(g=>double.IsNaN((double)g["_m"])?0:(double)g["_m"]*(int)g["count"]).ToList();
   foreach(var g in parts){
    if(!(bool)g["material_known"]&&(string)g["state"]!="suppressed")notes.Add(g["part"]+" ×"+g["count"]+": material and mass UNKNOWN (component not loaded) — resolve it.");
    else if(g["material"]==null&&(string)g["state"]!="suppressed")notes.Add(g["part"]+": NO material (default density "+g["density_kg_m3"]+" kg/m³).");
    if((bool)g["mass_override"])notes.Add(g["part"]+": has a MASS OVERRIDE (its mass is not computed from geometry).");
    if((string)g["state"]=="suppressed")notes.Add(g["part"]+" ×"+g["count"]+": SUPPRESSED (not in the total).");
    if((string)g["state"]=="lightweight")notes.Add(g["part"]+" ×"+g["count"]+": lightweight; mass may be approximate — resolve it.");
    if((bool)g["hidden"])notes.Add(g["part"]+" ×"+g["count"]+": hidden (included in the total; total without hidden components = "+M(totNoHidden[0])+" "+mu+").");}
  }
  if(d.GetType()==2){double sum=parts.Where(g=>(string)g["state"]!="suppressed"&&!double.IsNaN((double)g["_m"])).Sum(g=>(double)g["_m"]*(int)g["count"]);
   if(Math.Abs(sum-tot[0])>Math.Max(0.01,tot[0]*1e-4))notes.Add("The per-part masses add up to "+M(sum)+" "+mu+" but the total is "+M(tot[0])+" "+mu+": some component is not counted (lightweight, virtual, assembly-level feature or mass override) — check before trusting the total.");}
  mt[2]=mw.ElapsedMilliseconds;foreach(var g in parts)g.Remove("_m");
  // ---- expected materials from the drawing table (e.g. Hierro ductil, Oro puro): same library material (matid) in any language
  var matChecks=new List<object>();
  if(a.ContainsKey("expected_materials"))foreach(Dictionary<string,object> em in Items(a["expected_materials"])){
   string pname=Str(em,"part"),want=Str(em,"material");var lib=FindMaterial(want);
   string q=Fold(pname);Func<Dictionary<string,object>,string> fn=g=>Fold(Path.GetFileNameWithoutExtension(Convert.ToString(g["part"])));
   var hits=parts.Where(g=>fn(g)==q).ToList();
   if(hits.Count==0){var loose=parts.Where(g=>fn(g).Contains(q)).Select(fn).Distinct().ToList();if(loose.Count==1)hits=parts.Where(g=>fn(g)==loose[0]).ToList();
    else if(loose.Count>1){matChecks.Add(new{part=pname,expected=want,assigned=(string)null,status="AMBIGUOUS part name ("+string.Join(", ",loose)+")",expected_density_kg_m3=lib==null?(double?)null:lib.density,assigned_density_kg_m3=(object)null,library_names=lib==null?null:new[]{lib.es,lib.en}});notes.Add("Part name "+pname+" matches several parts: "+string.Join(", ",loose)+"; use the exact file name.");continue;}}
   if(hits.Count==0){matChecks.Add(new{part=pname,expected=want,assigned=(string)null,status="part not found",expected_density_kg_m3=lib==null?(double?)null:lib.density,assigned_density_kg_m3=(object)null,library_names=lib==null?null:new[]{lib.es,lib.en}});notes.Add("Expected material for "+pname+" but no part with that name is in the model.");continue;}
   foreach(var g in hits){string have=g["material"] as string;var cur=FindMaterial(have);string status;
    if(have==null)status="MISSING (no material)";
    else if(!(bool)g["material_known"])status="UNKNOWN (component not loaded)";
    else if((bool)g["mass_override"])status="MASS OVERRIDE (mass not from material)";
    else if(lib!=null&&cur!=null&&cur.id==lib.id){
     string mdb=Convert.ToString(g["material_database"]??"");bool stdDb=mdb==""||Fold(mdb).Contains("solidworks materials");
     double eff=g["density_kg_m3"]==null?double.NaN:Convert.ToDouble(g["density_kg_m3"]);
     status=!stdDb?"same name in a CUSTOM library ("+mdb+"): verify its density":double.IsNaN(eff)||Math.Abs(eff-lib.density)>lib.density*0.001?"name ok but effective density "+(double.IsNaN(eff)?"unknown":eff.ToString(System.Globalization.CultureInfo.InvariantCulture))+" kg/m3 differs from the library "+lib.density:"ok";}
    else if(lib!=null&&g["density_kg_m3"]!=null&&Math.Abs(Convert.ToDouble(g["density_kg_m3"])-lib.density)<=lib.density*0.001)status="same density, different name";
    else status="DIFFERENT";
    if(status!="ok")notes.Add(g["part"]+": material "+(have??"none")+" but the drawing says "+want+(lib!=null?" ("+lib.density+" kg/m3; library name es '"+lib.es+"' / en '"+lib.en+"')":" (not found in the SolidWorks library: check the spelling)")+".");
    matChecks.Add(new{part=(string)g["part"],expected=want,assigned=have,status=status,expected_density_kg_m3=lib==null?(double?)null:lib.density,assigned_density_kg_m3=g["density_kg_m3"],library_names=lib==null?null:new[]{lib.es,lib.en}});}
  }
  // ---- comparison with the drawing
  object comparison=null;var causes=new List<string>();
  if(a.ContainsKey("reference")){
   var r=(Dictionary<string,object>)a["reference"];var rows=new List<object>();bool allOk=true;
   if(r.ContainsKey("mass")){double rm=Convert.ToDouble(r["mass"])*MassToG[mu];double dp=100*(tot[0]-rm)/rm;bool ok=Math.Abs(dp)<=tolPct;allOk&=ok;
    rows.Add(new{quantity="mass",model=M(tot[0]),reference=M(rm),difference=M(tot[0]-rm),difference_percent=Math.Round(dp,4),ok=ok});
    // causes for a mass difference
    double delta=rm-tot[0];
    foreach(var kv in MassToG)if(kv.Key!=mu&&Math.Abs(tot[0]-Convert.ToDouble(r["mass"])*kv.Value)<=Math.Abs(Convert.ToDouble(r["mass"])*kv.Value)*tolPct/100)causes.Add("Mass matches if the reference is read in "+kv.Key+" instead of "+mu+".");
    if(!ok&&Math.Abs(totNoHidden[0]-rm)<=Math.Abs(rm)*tolPct/100)causes.Add("Mass matches WITHOUT the hidden components.");
    if(!ok&&d.GetType()==2){var pm=parts.Where(g=>g["mass_each"]!=null).Select(g=>new{n=(string)g["part"],m=Convert.ToDouble(g["mass_each"])*MassToG[mu]}).ToList();
     foreach(var p in pm)for(int k=1;k<=4;k++)if(Math.Abs(Math.Abs(delta)-k*p.m)<=Math.Max(Math.Abs(rm)*tolPct/100,0.01))causes.Add((delta>0?"Missing ":"Extra ")+k+" × "+p.n+" would explain the difference ("+M(delta)+" "+mu+").");
     for(int i=0;i<pm.Count;i++)for(int j=i+1;j<pm.Count;j++)if(Math.Abs(Math.Abs(delta)-(pm[i].m+pm[j].m))<=Math.Max(Math.Abs(rm)*tolPct/100,0.01))causes.Add((delta>0?"Missing ":"Extra ")+pm[i].n+" + "+pm[j].n+" would explain the difference.");
     foreach(var g in parts.Where(g=>g["mass_each"]!=null&&g["volume_each_mm3"]!=null)){double ve=Convert.ToDouble(g["volume_each_mm3"])*(int)g["count"];if(ve<=0)continue;double need=Convert.ToDouble(g["density_kg_m3"])+delta/(ve*1e-9)/1000;   // g → kg
      if(need>1)causes.Add(g["part"]+" would need density "+Math.Round(need,1)+" kg/m³ (now "+g["density_kg_m3"]+", material "+(g["material"]??"none")+") to explain it alone.");}}
    if(!ok&&d.GetType()==1&&r.ContainsKey("mass")&&tot[1]>0){double need=rm/1000/(tot[1]*1e-9);causes.Add("The part would need density "+Math.Round(need,1)+" kg/m³ (now "+Math.Round(tot[5],1)+") — or its volume is "+Math.Round(100*(rm/tot[0]-1),3)+" % off.");}
   }
   if(r.ContainsKey("volume_mm3")){double rv=Convert.ToDouble(r["volume_mm3"]);double dp=100*(tot[1]-rv)/rv;bool ok=Math.Abs(dp)<=tolPct;allOk&=ok;rows.Add(new{quantity="volume_mm3",model=Math.Round(tot[1],3),reference=rv,difference=Math.Round(tot[1]-rv,3),difference_percent=Math.Round(dp,4),ok=ok});}
   if(r.ContainsKey("center_of_mass")){var rc=Items(r["center_of_mass"]).Select(v=>Convert.ToDouble(v)*LenToMm[lu]).ToArray();var dv=new double[3];
    bool comAll=true;for(int i=0;i<3;i++){dv[i]=tot[2+i]-rc[i];bool ok=cmOk(dv[i],rc[i]);allOk&=ok;comAll&=ok;rows.Add(new{quantity="center_of_mass_"+"XYZ"[i],model=L(tot[2+i]),reference=L(rc[i]),difference=L(dv[i]),difference_percent=Math.Abs(rc[i])>1e-12?(double?)Math.Round(100*dv[i]/Math.Abs(rc[i]),4):null,ok=ok});}
    double dn=Math.Sqrt(dv.Sum(x=>x*x));
    if(!comAll&&dn>0){
     foreach(var kv in LenToMm)if(kv.Key!=lu){var rcx=Items(r["center_of_mass"]).Select(v=>Convert.ToDouble(v)*kv.Value).ToArray();if(Enumerable.Range(0,3).All(i=>Math.Abs(tot[2+i]-rcx[i])<=tolCm))causes.Add("Center of mass matches if the reference is in "+kv.Key+" instead of "+lu+".");}
     for(int i=0;i<3;i++)for(int j=0;j<3;j++)if(i!=j){int k=3-i-j;foreach(var sgn in new[]{1,-1})if(Math.Abs(tot[2+i]-rc[i])<=tolCm&&Math.Abs(tot[2+j]-sgn*rc[k])<=tolCm&&Math.Abs(tot[2+k]-(-sgn)*rc[j])<=tolCm)causes.Add("Center of mass matches with axes "+"XYZ"[j]+"/"+"XYZ"[k]+" swapped (model rotated 90° about "+"XYZ"[i]+" vs the drawing).");}
     causes.Add("If the drawing measures from another origin, the offset is ("+string.Join(", ",dv.Select(x=>L(x)))+") "+lu+(csNames.Length>0?"; coordinate systems in the model: "+string.Join(", ",csNames)+" (pass coordinate_system)":"; the model has no coordinate system — the drawing may define one"));
     if(totNoHidden!=null){var dh=Enumerable.Range(0,3).Select(i=>totNoHidden[2+i]-rc[i]).ToArray();if(dh.All(x=>Math.Abs(x)<=tolCm))causes.Add("Center of mass matches WITHOUT the hidden components.");}}
   }
   if(rows.Count==0)throw new Exception("reference needs mass, volume_mm3 or center_of_mass");
   comparison=new{verdict=(allOk?"coincide":"no coincide")+" ("+string.Join(", ",rows.Select(x=>(string)x.GetType().GetProperty("quantity").GetValue(x,null)))+")",compared=rows.Select(x=>(string)x.GetType().GetProperty("quantity").GetValue(x,null)).ToArray(),rows=rows.ToArray(),tolerances=new{mass_percent=tolPct,center_of_mass_percent=tolCmPct,center_of_mass_absolute=Math.Round(tolCm/LenToMm[lu],6)},
    rule=allOk?"Dentro de la tolerancia (criterio del usuario: menos de 0.5 % no se corrige).":"Fuera de la tolerancia: revisar las causas antes de cambiar nada."};
  }
  var blockers=new List<string>();
  if(matChecks.Count==0)blockers.Add("materials not checked against the drawing (pass expected_materials)");
  else foreach(var mc in matChecks){string st=(string)mc.GetType().GetProperty("status").GetValue(mc,null);if(st!="ok")blockers.Add("material: "+mc.GetType().GetProperty("part").GetValue(mc,null)+" → "+st);}
  if(csName==null)blockers.Add("center of mass is measured from the MODEL origin: if the drawing marks another ORIGIN create it with sw_coordinate_system and pass coordinate_system");
  foreach(var nt in notes.Where(x=>x.Contains("UNKNOWN")||x.Contains("add up")||x.Contains("OVERRIDE")))blockers.Add(nt);
  var exam=new{materials_verified=matChecks.Count>0&&matChecks.All(x=>(string)x.GetType().GetProperty("status").GetValue(x,null)=="ok"),origin=csName==null?"model origin (not verified against the drawing)":"coordinate system "+csName,blockers=blockers.Distinct().ToArray(),
   note="Without reference values this cannot certify the numbers; it verifies the inputs that decide them (materials, origin, complete breakdown). Also check the assembly pose against the drawing."};
  mt[3]=mw.ElapsedMilliseconds;result=new{split_ms=mt,document=d.GetTitle(),exam_check=exam,type=d.GetType()==1?"part":"assembly",units=new{length=lu,mass=mu},coordinate_system=csName??"model origin",coordinate_systems_available=csNames,
   mass=M(tot[0]),volume_mm3=Math.Round(tot[1],3),density_kg_m3=Math.Round(tot[5],3),center_of_mass=new[]{L(tot[2]),L(tot[3]),L(tot[4])},
   materials=matChecks.ToArray(),materials_ok=matChecks.Count==0?(bool?)null:matChecks.All(x=>(string)x.GetType().GetProperty("status").GetValue(x,null)=="ok"),comparison=comparison,possible_causes=causes.Distinct().ToArray(),parts=parts.ToArray(),warnings=notes.ToArray(),
   note="Read-only: no geometry, material or configuration was changed (the selection is cleared). Causes are hypotheses computed from the numbers; confirm them against the drawing before editing."};
  return true;
 }
}
