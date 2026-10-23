using System;
using System.Linq;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

partial class Worker {
 static double[] CsPoint(Dictionary<string,object> a,string key){
  var p=Items(a[key]).Select(Convert.ToDouble).ToArray();
  if(p.Length!=3||p.Any(x=>double.IsNaN(x)||double.IsInfinity(x)))throw new Exception(key+" must contain three finite numbers in mm");
  return p.Select(x=>x/1000).ToArray();
 }
 static double[] CsTransform(IModelDoc2 d,string name){
  var t=d.Extension.GetCoordinateSystemTransformByName(name) as IMathTransform;
  if(t==null)throw new Exception("Cannot read coordinate system transform: "+name);
  var v=(double[])t.ArrayData;
  if(v==null||v.Length<13||v.Any(x=>double.IsNaN(x)||double.IsInfinity(x)))throw new Exception("Invalid coordinate system transform: "+name);
  return v;
 }
 static object CsInfo(IModelDoc2 d,string name){var t=CsTransform(d,name);return new{name=name,origin_mm=t.Skip(9).Take(3).Select(x=>x*1000).ToArray(),x_axis=t.Take(3).ToArray(),y_axis=t.Skip(3).Take(3).ToArray(),z_axis=t.Skip(6).Take(3).ToArray()};}
 static void CsDelete(IModelDoc2 d,IFeature f){
  string name=f.Name;
  if(f.GetTypeName2()!="CoordSys")throw new Exception("Not a coordinate system: "+name);
  try{d.ClearSelection2(true);if(!f.Select2(false,0)||!d.Extension.DeleteSelection2(0))throw new Exception("Could not delete coordinate system: "+name);
   d.ForceRebuild3(false);if(AllFeatures(d).Any(x=>x.Name==name))throw new Exception("Coordinate system still exists: "+name);
  }finally{d.ClearSelection2(true);}
 }
 static object CsEntity(IModelDoc2 d,Dictionary<string,object> a,double[] p,out double[] world){
  IComponent2 c=null;IModelDoc2 part=d;world=p;
  if(d.GetType()==2){
   if(!a.ContainsKey("component"))throw new Exception("Assembly local_point_mm needs component");
   c=CompByName((IAssemblyDoc)d,Str(a,"component"));part=c.GetModelDoc2() as IModelDoc2;
   if(part==null||part.GetType()!=1||c.IsSuppressed())throw new Exception("Origin component must be a resolved part");
   // Never switch component configurations behind the user's back.
   if(((IConfiguration)part.ConfigurationManager.ActiveConfiguration).Name!=c.ReferencedConfiguration)throw new Exception("Open the component's referenced configuration first");
   if(c.Transform2==null)throw new Exception("Component transform is unavailable");
   world=(double[])((IMathPoint)((IMathPoint)((IMathUtility)sw.GetMathUtility()).CreatePoint(p)).MultiplyTransform(c.Transform2)).ArrayData;
  }else if(a.ContainsKey("component"))throw new Exception("component is only valid in an assembly");
  string kind=a.ContainsKey("kind")?Str(a,"kind"):"";
  if(kind=="circle_center"){
   // v3.2: origin at the centre of the circular edge that passes through local_point_mm (e.g. a bolt hole of a flange)
   var circles=new List<double[]>();
   foreach(IBody2 b in (object[])((IPartDoc)part).GetBodies2((int)swBodyType_e.swAllBodies,false)??new object[0])
    foreach(IEdge e in (object[])b.GetEdges()??new object[0]){var cv=e.GetCurve() as ICurve;if(cv==null||!cv.IsCircle())continue;
     var q=(double[])e.GetClosestPointOn(p[0],p[1],p[2]);if(q==null||Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(q[i]-p[i],2)))>1e-7)continue;
     var cp=(double[])cv.CircleParams;circles.Add(new[]{cp[0],cp[1],cp[2]});}
   if(circles.Count!=1)throw new Exception("Expected one circular edge through local_point_mm; found "+circles.Count+" (give a point on the hole edge)");
   if(Flag(a,"linked"))throw new Exception("circle_center is numerical (not linked); omit linked");
   var cen=circles[0];world=c==null?cen:(double[])((IMathPoint)((IMathPoint)((IMathUtility)sw.GetMathUtility()).CreatePoint(cen)).MultiplyTransform(c.Transform2)).ArrayData;
   return null;
  }
  if(kind!="vertex"&&kind!="edge"&&kind!="face")throw new Exception("Entity origin needs kind: vertex, edge, face or circle_center");
  var hits=new List<object>();
  foreach(IBody2 b in (object[])((IPartDoc)part).GetBodies2((int)swBodyType_e.swAllBodies,false)??new object[0]){
   var entities=(object[])(kind=="vertex"?b.GetVertices():kind=="edge"?b.GetEdges():b.GetFaces())??new object[0];
   foreach(var e in entities){double[] q=kind=="vertex"?(double[])((IVertex)e).GetPoint():kind=="edge"?(double[])((IEdge)e).GetClosestPointOn(p[0],p[1],p[2]):(double[])((IFace2)e).GetClosestPointOn(p[0],p[1],p[2]);
    if(q!=null&&Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(q[i]-p[i],2)))<=1e-7)hits.Add(e);
   }
  }
  if(hits.Count!=1)throw new Exception("Expected one "+kind+" at local_point_mm; found "+hits.Count+" (use an unambiguous point)");
  if(Flag(a,"linked")&&kind!="vertex")throw new Exception("linked requires kind vertex; edge/face points use numerical coordinates");
  object entity=c==null||!Flag(a,"linked")?hits[0]:c.GetCorresponding(hits[0]);if(entity==null)throw new Exception("Cannot map origin entity into assembly context");return entity;
 }
 static double[] CsUnit(Dictionary<string,object> a,string k){var v=Items(((Dictionary<string,object>)a["axes"])[k]).Select(Convert.ToDouble).ToArray();
  if(v.Length!=3||v.Any(x=>double.IsNaN(x)||double.IsInfinity(x)))throw new Exception("axes."+k+" must be three numbers");double n=Math.Sqrt(v.Sum(x=>x*x));if(n<1e-9)throw new Exception("axes."+k+" is zero");return v.Select(x=>x/n).ToArray();}
 // Euler angles for the rotation whose COLUMNS are the requested axes. conv 0: R=Rz(c)Ry(b)Rx(a); conv 1: R=Rx(a)Ry(b)Rz(c); 2/3: same for R transposed.
 static int csConvUsed=-1;
 static double[] CsAngles(double[] x,double[] y,double[] z,int conv){
  double[,] R=new double[3,3];for(int i=0;i<3;i++){R[i,0]=x[i];R[i,1]=y[i];R[i,2]=z[i];}
  if(conv>=2){var T=new double[3,3];for(int i=0;i<3;i++)for(int j=0;j<3;j++)T[i,j]=R[j,i];R=T;}
  if(conv%2==0){double b=Math.Asin(Math.Max(-1,Math.Min(1,-R[2,0])));double a2,c2;if(Math.Abs(Math.Cos(b))>1e-9){a2=Math.Atan2(R[2,1],R[2,2]);c2=Math.Atan2(R[1,0],R[0,0]);}else{a2=Math.Atan2(-R[1,2],R[1,1]);c2=0;}return new[]{a2,b,c2};}
  else{double b=Math.Asin(Math.Max(-1,Math.Min(1,R[0,2])));double a2,c2;if(Math.Abs(Math.Cos(b))>1e-9){a2=Math.Atan2(-R[1,2],R[2,2]);c2=Math.Atan2(-R[0,1],R[0,0]);}else{a2=Math.Atan2(R[2,1],R[1,1]);c2=0;}return new[]{a2,b,c2};}
 }
 static bool TryCoordinateSystem(string op,Dictionary<string,object> a,IModelDoc2 d,out object result){
  result=null;if(op!="coordinate_system")return false;
  if(d.GetType()!=1&&d.GetType()!=2)throw new Exception("coordinate_system needs a managed part or assembly");
  string action=Str(a,"action");
  if(action=="list"){result=new{coordinate_systems=AllFeatures(d).Where(f=>f.GetTypeName2()=="CoordSys").Select(f=>CsInfo(d,f.Name)).ToArray()};return true;}
  if(action=="delete"){
   if(!a.ContainsKey("name"))throw new Exception("delete needs name");string name=Str(a,"name");var f=AllFeatures(d).FirstOrDefault(x=>x.Name==name);
   if(f==null)throw new Exception("Coordinate system not found: "+name);CsDelete(d,f);result=new{deleted=name};return true;
  }
  if(action!="create")throw new Exception("action: list, create or delete");
  if(a.ContainsKey("name"))throw new Exception("Keep the SolidWorks default name; omit name when creating");
  bool local=a.ContainsKey("local_point_mm"),linked=Flag(a,"linked");
  if(local==a.ContainsKey("point_mm"))throw new Exception("create needs exactly one origin: point_mm or local_point_mm");
  if(!local&&(a.ContainsKey("component")||a.ContainsKey("kind")||linked))throw new Exception("component, kind and linked require local_point_mm");
  var requested=CsPoint(a,local?"local_point_mm":"point_mm");double[] origin=requested;object entity=null;
  if(local&&(d.GetType()==2||a.ContainsKey("kind")))entity=CsEntity(d,a,requested,out origin);
  else if(linked||a.ContainsKey("component"))throw new Exception("linked needs a vertex; component needs an assembly");
  if(entity==null&&linked)throw new Exception("linked needs kind vertex");
  double[] ax=null,ay=null,az=null;
  if(a.ContainsKey("axes")){
   if(linked||Flag(a,"flip_x")||Flag(a,"flip_y")||Flag(a,"flip_z"))throw new Exception("axes cannot be combined with linked or flip_*");
   ax=CsUnit(a,"x");ay=CsUnit(a,"y");double dot=ax[0]*ay[0]+ax[1]*ay[1]+ax[2]*ay[2];if(Math.Abs(dot)>1e-6)throw new Exception("axes.x and axes.y must be perpendicular (dot="+dot+")");
   az=new[]{ax[1]*ay[2]-ax[2]*ay[1],ax[2]*ay[0]-ax[0]*ay[2],ax[0]*ay[1]-ax[1]*ay[0]};
  }
  bool fx=Flag(a,"flip_x"),fy=Flag(a,"flip_y"),fz=Flag(a,"flip_z");
  var before=new HashSet<string>(AllFeatures(d).Select(f=>f.Name));
  try{
   d.ClearSelection2(true);IFeature f;
   if(ax!=null){
    // try the Euler conventions until SolidWorks reports exactly the requested axes (rows of the transform = X, Y, Z axes)
    f=null;string tried="";
    foreach(int conv in new[]{1,0,2,3}){if(f!=null)break;
     // tested on SW 2026: convention 1 (R = Rx*Ry*Rz) is the one SolidWorks uses; the others are a safety net
     var ang=CsAngles(ax,ay,az,conv);
     var g=d.FeatureManager.CreateCoordinateSystemUsingNumericalValues(true,origin[0],origin[1],origin[2],true,ang[0],ang[1],ang[2]) as IFeature;
     if(g==null){tried+=" conv"+conv+":null";continue;}
     d.ClearSelection2(true);d.ForceRebuild3(false);var tt=CsTransform(d,g.Name);
     double err=0;for(int i=0;i<3;i++){err=Math.Max(err,Math.Abs(tt[i]-ax[i]));err=Math.Max(err,Math.Abs(tt[3+i]-ay[i]));err=Math.Max(err,Math.Abs(tt[6+i]-az[i]));}
     if(err<=1e-8){f=g;csConvUsed=conv;}else{tried+=" conv"+conv+":"+err.ToString("G3");CsDelete(d,g);}
    }
    if(f==null)throw new Exception("No Euler convention reproduced the requested axes:"+tried);
   }
   else if(linked){
    // Official InsertCoordinateSystem marks: origin=1, X=2, Y=4, Z=8.
    var sd=(SelectData)((ISelectionMgr)d.SelectionManager).CreateSelectData();sd.Mark=1;
    if(!((IEntity)entity).Select4(false,sd))throw new Exception("Cannot select origin vertex");
    f=d.FeatureManager.InsertCoordinateSystem(fx,fy,fz) as IFeature;
   }else{
    // Numerical origins intentionally have no geometry dependency.
    int flips=(fx?1:0)+(fy?1:0)+(fz?1:0);
    bool numericRotation=flips==2;
    f=d.FeatureManager.CreateCoordinateSystemUsingNumericalValues(true,origin[0],origin[1],origin[2],numericRotation,fy&&fz?Math.PI:0,fx&&fz?Math.PI:0,fx&&fy?Math.PI:0) as IFeature;
    if(f!=null&&flips!=0&&!numericRotation){
     var def=f.GetDefinition() as ICoordinateSystemFeatureData;if(def==null)throw new Exception("Cannot read coordinate system definition");
     if(!def.AccessSelections((ModelDoc2)d,null))throw new Exception("Cannot access coordinate system definition");
     try{def.XFlipped=fx;def.YFlipped=fy;def.ZFlipped=fz;if(!f.ModifyDefinition(def,d,null))throw new Exception("Cannot flip coordinate system axes");}finally{def.ReleaseSelectionAccess();}
    }
   }
   if(f==null||f.GetTypeName2()!="CoordSys"||before.Contains(f.Name))throw new Exception("SolidWorks did not create a coordinate system");
   d.ClearSelection2(true);d.ForceRebuild3(false);
   var t=CsTransform(d,f.Name);double[] signs={fx?-1:1,fy?-1:1,fz?-1:1};
   double[] want=ax!=null?ax.Concat(ay).Concat(az).ToArray():Enumerable.Range(0,9).Select(i=>i%4==0?signs[i/3]:0.0).ToArray();
   if(Math.Sqrt(Enumerable.Range(0,3).Sum(i=>Math.Pow(t[9+i]-origin[i],2)))>1e-6)throw new Exception("Coordinate system origin verification failed");
   for(int i=0;i<9;i++)if(Math.Abs(t[i]-want[i])>1e-8)throw new Exception("Coordinate system axis verification failed");
   bool warning=false;if(f.IsSuppressed()||f.GetErrorCode2(out warning)!=0||Math.Abs(t[12]-1)>1e-8)throw new Exception("Coordinate system feature verification failed");
   result=new{coordinate_system=f.Name,geometry_linked=linked,verified=true,euler_convention=ax!=null?csConvUsed:(int?)null,system=CsInfo(d,f.Name),note=linked?"Origin follows its vertex. Unsaved until sw_save.":a.ContainsKey("kind")&&Str(a,"kind")=="circle_center"?"Origin at the hole centre, numerical (it does NOT follow if the component moves later). Unsaved until sw_save.":"Numerical origin is NOT linked to geometry and will NOT follow a moving component. Use linked:true with kind:vertex for a linked origin. Unsaved until sw_save."};return true;
  }catch(Exception ex){
   var cleanupErrors=new List<string>();
   try{foreach(var f in AllFeatures(d).Where(x=>!before.Contains(x.Name)).Reverse().ToList())try{CsDelete(d,f);}catch(Exception ce){cleanupErrors.Add(ce.Message);}}catch(Exception ce){cleanupErrors.Add(ce.Message);}
   bool clean=false;try{clean=!AllFeatures(d).Any(x=>!before.Contains(x.Name));}catch{}
   if(!clean)recoveryPending.Add(d.GetPathName());
   throw new Exception("Coordinate system creation failed: "+ex.Message+(clean?"; nothing was left in the tree":"; cleanup could NOT be verified, saving is blocked; close without saving. "+string.Join("; ",cleanupErrors)));
  }finally{d.ClearSelection2(true);}
 }
}
