using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.4 document_units: the units the Mass Properties dialog uses with "Utilizar configuraciones de documento"
// (Document Properties > Units > Mass/Section properties). Those values only take effect with the Custom unit system, so the
// system becomes Custom while linear/angular units are kept exactly as they were (drawing dimensions do not change).
partial class Worker {
 static readonly Dictionary<string,int> UnLen=new Dictionary<string,int>{{"mm",0},{"cm",1},{"m",2},{"in",3},{"ft",4}};
 static readonly Dictionary<string,int> UnMass=new Dictionary<string,int>{{"mg",1},{"g",2},{"kg",3},{"lb",4}};
 static readonly Dictionary<string,int> UnVol=new Dictionary<string,int>{{"mm3",4},{"cm3",5},{"m3",6},{"in3",9},{"ft3",10}};
 static object UnitsInfo(IModelDoc2 d){var x=d.Extension;Func<int,int> g=k=>x.GetUserPreferenceInteger(k,(int)swUserPreferenceOption_e.swDetailingNoOptionSpecified);
  Func<Dictionary<string,int>,int,string> name=(m,v)=>m.Where(kv=>kv.Value==v).Select(kv=>kv.Key).FirstOrDefault()??("#"+v);
  return new{unit_system=g((int)swUserPreferenceIntegerValue_e.swUnitSystem),linear=name(UnLen,g((int)swUserPreferenceIntegerValue_e.swUnitsLinear)),linear_decimals=g((int)swUserPreferenceIntegerValue_e.swUnitsLinearDecimalPlaces),
   mass_properties=new{length=name(UnLen,g((int)swUserPreferenceIntegerValue_e.swUnitsMassPropLength)),mass=name(UnMass,g((int)swUserPreferenceIntegerValue_e.swUnitsMassPropMass)),volume=name(UnVol,g((int)swUserPreferenceIntegerValue_e.swUnitsMassPropVolume)),decimals=g((int)swUserPreferenceIntegerValue_e.swUnitsMassPropDecimalPlaces)},
   note="unit_system: 1 CGS, 2 MKS, 3 IPS, 4 Custom, 5 MMGS. mass_properties are what Calcular > Propiedades fisicas shows with 'Utilizar configuraciones de documento'."};}
 static bool TryDocumentUnits(string op,Dictionary<string,object>a,IModelDoc2 d,out object result){
  result=null;if(op!="document_units")return false;
  if(d.GetType()!=1&&d.GetType()!=2)throw new Exception("document_units needs a part or an assembly");
  if(Str(a,"action")=="get"){result=UnitsInfo(d);return true;}
  var x=d.Extension;int opt=(int)swUserPreferenceOption_e.swDetailingNoOptionSpecified;
  Func<swUserPreferenceIntegerValue_e,int> g=k=>x.GetUserPreferenceInteger((int)k,opt);
  string len=a.ContainsKey("mass_length")?Str(a,"mass_length"):"in",mass=a.ContainsKey("mass")?Str(a,"mass"):"lb",vol=a.ContainsKey("volume")?Str(a,"volume"):"mm3";
  int dec=a.ContainsKey("decimals")?Convert.ToInt32(a["decimals"]):4;
  if(!UnLen.ContainsKey(len)||!UnMass.ContainsKey(mass)||!UnVol.ContainsKey(vol)||dec<0||dec>8)throw new Exception("mass_length mm|cm|m|in|ft, mass mg|g|kg|lb, volume mm3|cm3|m3|in3|ft3, decimals 0-8");
  // keep what the drawing/dimensions use
  int linear=g(swUserPreferenceIntegerValue_e.swUnitsLinear),linDec=g(swUserPreferenceIntegerValue_e.swUnitsLinearDecimalPlaces),before=g(swUserPreferenceIntegerValue_e.swUnitSystem);
  var want=new Dictionary<swUserPreferenceIntegerValue_e,int>{{swUserPreferenceIntegerValue_e.swUnitSystem,(int)swUnitSystem_e.swUnitSystem_Custom},{swUserPreferenceIntegerValue_e.swUnitsLinear,linear},{swUserPreferenceIntegerValue_e.swUnitsLinearDecimalPlaces,linDec},
   {swUserPreferenceIntegerValue_e.swUnitsMassPropLength,UnLen[len]},{swUserPreferenceIntegerValue_e.swUnitsMassPropMass,UnMass[mass]},{swUserPreferenceIntegerValue_e.swUnitsMassPropVolume,UnVol[vol]},{swUserPreferenceIntegerValue_e.swUnitsMassPropDecimalPlaces,dec}};
  var failed=new List<string>();
  foreach(var kv in want){if(!x.SetUserPreferenceInteger((int)kv.Key,opt,kv.Value))failed.Add(kv.Key.ToString());}
  foreach(var kv in want)if(g(kv.Key)!=kv.Value)failed.Add(kv.Key+" quedó en "+g(kv.Key));
  if(failed.Count>0)throw new Exception("No se pudieron fijar las unidades: "+string.Join("; ",failed.Distinct()));
  d.SetSaveFlag();
  result=new{set=true,unit_system_before=before,units=UnitsInfo(d),note="Calcular > Propiedades fisicas > Opciones > 'Utilizar configuraciones de documento' now shows these units. Linear units for dimensions unchanged. Unsaved until sw_save."};return true;
 }
}
