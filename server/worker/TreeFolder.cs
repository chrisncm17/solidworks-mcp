using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

// v3.25 tree_folder: put named features of a managed part (reference planes, sketches...) in one folder of the FeatureManager
// tree, so a model with many stations stays readable. The folder keeps the SolidWorks default name (Carpeta1...); features
// are never renamed. SolidWorks only folds features that are next to each other in the tree.
partial class Worker {
 static bool TryTreeFolder(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="tree_folder")return false;
  if(d.GetType()!=1)throw new Exception("tree_folder works on a managed PART");
  var names=Items(a["features"]).Select(Convert.ToString).ToList();if(names.Count==0)throw new Exception("features: at least one feature name");
  // top-level features only: a sketch picture (Imagen de croquis) lives under its sketch and does not break the run
  var all=new List<IFeature>();for(var t=(IFeature)d.FirstFeature();t!=null;t=(IFeature)t.GetNextFeature())all.Add(t);var order=all.Select(f=>f.Name).ToList();
  var feats=names.Select(n=>{var f=all.FirstOrDefault(x=>x.Name==n);if(f==null)throw new Exception("Feature not found: "+n);return f;}).ToList();
  var idx=feats.Select(f=>order.IndexOf(f.Name)).OrderBy(i=>i).ToList();
  var between=new List<string>();for(int i=idx.First();i<=idx.Last();i++)if(!names.Contains(order[i]))between.Add(order[i]);
  if(between.Count>0)throw new Exception("SolidWorks folds only features next to each other in the tree; between them are: "+string.Join(", ",between.Take(10))+(between.Count>10?"...":""));
  var before=FeatureNames(d);IFeature folder=null;
  try{d.ClearSelection2(true);foreach(var f in feats)if(!f.Select2(true,-1))throw new Exception("Cannot select "+f.Name);
   folder=(IFeature)d.FeatureManager.InsertFeatureTreeFolder2((int)swFeatureTreeFolderType_e.swFeatureTreeFolder_Containing);}
  finally{d.ClearSelection2(true);}
  if(folder==null)folder=AllFeatures(d).FirstOrDefault(x=>!before.Contains(x.Name)&&x.GetTypeName2()=="FtrFolder");
  if(folder==null)throw new Exception("SolidWorks did not create the folder");
  d.SetSaveFlag();
  result=new{folder=folder.Name,features=names.Count,note="Folder made with the default name; unsaved until sw_save."};return true;
 }
}
