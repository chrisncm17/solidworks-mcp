using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;

partial class Worker {
 static object ReadEquations(Dictionary<string,object> args) {
  var d=(IModelDoc2)sw.ActiveDoc;
  if(d==null)throw new Exception("No active document");
  if(!string.Equals(d.GetTitle(),Str(args,"expected_title"),StringComparison.Ordinal))
   throw new Exception("Active document mismatch. Current title: "+d.GetTitle());
  if(d.GetType()!=1&&d.GetType()!=2)throw new Exception("Equations require a part or assembly");
  var m=(IEquationMgr)d.GetEquationMgr();
  if(m==null)throw new Exception("Equation manager unavailable");
  var rows=new List<object>();
  for(int i=0;i<m.GetCount();i++) {
   try {
    string expression=m.get_Equation(i);
    int textStatus=m.Status;
    double value=m.get_Value(i);
    int valueStatus=m.Status;
    rows.Add(new {index=i,expression=expression,
     character_codes=expression.Select(c=>"U+"+((int)c).ToString("X4")).ToArray(),
     value_api=double.IsNaN(value)||double.IsInfinity(value)?(double?)null:value,
     equation_read_status=textStatus,value_read_status=valueStatus,
     global_variable=m.get_GlobalVariable(i),disabled=m.get_Disabled(i)});
   } catch(Exception e) {rows.Add(new{index=i,read_error=e.Message});}
  }
  return new {title=d.GetTitle(),path=d.GetPathName(),unsaved_changes=d.GetSaveFlag(),
   configuration=d.ConfigurationManager.ActiveConfiguration.Name,document_units=d.GetUnits(),
   count=m.GetCount(),equations=rows,automatic_solve_order=m.AutomaticSolveOrder,
   automatic_rebuild=m.AutomaticRebuild,angular_equation_units=m.AngularEquationUnits,
   linked_to_file=m.LinkToFile,external_file=m.FilePath,
   note="Read only. Dialog edits not yet committed may be absent. Status is the result of the indexed API read (-1 error), not a complete syntax check. Values are returned as reported by the API; no unit conversion or evaluation performed."};
 }
}
