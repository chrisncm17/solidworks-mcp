import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { dxfEvidence } from './dxf.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(root, 'generated', 'drawing_read');
const exec = promisify(execFile);
let pythonCache=null;
// pdftotext (Poppler; Git for Windows ships it): SW_MCP_PDFTOTEXT, else Git's copy, else the one on PATH
export function pdftotext(){const env=process.env.SW_MCP_PDFTOTEXT;if(env)return env;const git='C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe';return existsSync(git)?git:'pdftotext';}
export async function drawingPython() {
  if(process.env.SW_DRAWING_PYTHON) return process.env.SW_DRAWING_PYTHON;
  // A system Python that really has pypdf and Pillow (often in the user site-packages). Never another tool's private runtime:
  // a different pypdf there placed some PDF words at the page corner (tested). Which "python" wins depends on PATH, so probe.
  if(pythonCache) return pythonCache;
  let found=[];try{found=(await exec('where',['python'],{windowsHide:true,encoding:'utf8',timeout:10000})).stdout.split(/[\r\n]+/).map(x=>x.trim()).filter(Boolean);}catch{}
  for(const c of [...found,'python'].filter(c=>!/codex-runtimes|WindowsApps/i.test(c))){
    try{await exec(c,['-E','-P','-c','import pypdf, PIL'],{windowsHide:true,timeout:20000});return pythonCache=c;}catch{}
  }
  throw new Error('drawing_read: no hay un Python con pypdf y Pillow (define SW_DRAWING_PYTHON)');
}
const number = String.raw`\d+(?:[.,]\d+)?`;
const patterns = [
  ['scale', new RegExp(`^(?:(?:ESCALA|SCALE)\\s*:?)?\\s*(${number})\\s*:\\s*(${number})$`, 'i')],
  ['count_prefix', new RegExp(`^(${number})\\s*[xX]\\s*[Øø⌀]\\s*(${number})$`)],
  ['count_prefix', new RegExp(`^(${number})\\s*[xX]$`)],
  ['chamfer', new RegExp(`^(${number})\\s*[xX×]\\s*(${number})\\s*°$`)],
  ['diameter', new RegExp(`^[Øø⌀]\\s*(${number})$`)],
  ['radius', new RegExp(`^R\\s*(${number})$`, 'i')],
  ['thread', new RegExp(`^M\\s*(${number})(?:\\s*[xX×]\\s*${number})?$`, 'i')],
  ['angle', new RegExp(`^(${number})\\s*°$`)],
  ['tolerance', new RegExp(`^(?:±\\s*(${number})|\\+(${number})\\s*/\\s*-(${number}))$`)],
  ['linear', new RegExp(`^(${number})$`)],
];
const union = words => [Math.min(...words.map(w=>w.bbox_mm[0])),Math.min(...words.map(w=>w.bbox_mm[1])),Math.max(...words.map(w=>w.bbox_mm[2])),Math.max(...words.map(w=>w.bbox_mm[3]))];
const angleDiff = (a,b) => Math.abs(((a-b+540)%360)-180);
export function groupDrawingLines(words) {
  const groups=[];
  for(const word of words) {
    const a=(word.angle_deg||0)*Math.PI/180, perpendicular=w=>w.bbox_mm[0]*Math.sin(a)+w.bbox_mm[1]*Math.cos(a);
    const along=w=>w.bbox_mm[0]*Math.cos(a)-w.bbox_mm[1]*Math.sin(a);
    let line=groups.find(g=>angleDiff(g[0].angle_deg||0,word.angle_deg||0)<3 && Math.abs(perpendicular(g[0])-perpendicular(word))<Math.max(0.6,(word.font_size_mm||2)*0.45) && g.some(w=>Math.abs(along(w)-along(word))<Math.hypot(w.bbox_mm[2]-w.bbox_mm[0],w.bbox_mm[3]-w.bbox_mm[1])+Math.max(8,(word.font_size_mm||2)*3)));
    if(!line) groups.push(line=[]);
    line.push(word);
  }
  return groups.map(g=>{
    const a=(g[0].angle_deg||0)*Math.PI/180;
    g.sort((u,v)=>(u.bbox_mm[0]-v.bbox_mm[0])*Math.cos(a)-(u.bbox_mm[1]-v.bbox_mm[1])*Math.sin(a));
    return {text:g.map(w=>w.text).join(' '),bbox_mm:union(g),angle_deg:g[0].angle_deg||0,words:g};
  });
}
export function parseDimensionTokens(words) {
  const result=[];
  for(const line of groupDrawingLines(words)) for(let i=0;i<line.words.length;i++) {
    let found;
    for(let n=Math.min(6,line.words.length-i);n>=1;n--) {
      const chunk=line.words.slice(i,i+n);
      // Do not combine unrelated annotations just because they share a baseline.
      if(chunk.some((w,j)=>{
        if(!j) return false;
        const prev=chunk[j-1],a=(w.angle_deg||0)*Math.PI/180;
        const project=v=>{const b=v.bbox_mm;return [b[0]*Math.cos(a)-b[1]*Math.sin(a),b[2]*Math.cos(a)-b[1]*Math.sin(a),b[0]*Math.cos(a)-b[3]*Math.sin(a),b[2]*Math.cos(a)-b[3]*Math.sin(a)];};
        return Math.min(...project(w))-Math.max(...project(prev))>Math.max(4,(w.font_size_mm||2)*3);
      })) continue;
      const raw=chunk.map(w=>w.text).join(' ');
      for(const [kind,re] of patterns) {
        const m=raw.match(re); if(!m) continue;
        const nums=m.slice(1).filter(x=>x!==undefined).map(x=>Number(x.replace(',','.')));
        found={kind,value:kind==='scale'?(nums[1]===0?null:nums[0]/nums[1]):kind==='count_prefix'?(nums[1]??nums[0]):nums[0],raw,bbox_mm:union(chunk)};
        if(kind==='count_prefix') found.count=nums[0];
        if(kind==='tolerance' && nums.length===2) {found.value=null;found.upper=nums[0];found.lower=-nums[1];}
        if(kind==='chamfer') found.angle_deg=nums[1];
        if(kind==='scale' && nums[1]===0) found.kind='unknown';
        i+=n-1; break;
      }
      if(found) break;
    }
    if(found) result.push(found);
    else if(/[\dØø⌀±°]/.test(line.words[i].text)) result.push({kind:'unknown',value:null,raw:line.words[i].text,bbox_mm:line.words[i].bbox_mm});
  }
  return result;
}
async function run(command,args,signal) {
  try {return (await exec(command,args,{timeout:60000,maxBuffer:32*1024*1024,windowsHide:true,encoding:'utf8',signal})).stdout;}
  catch(e) {throw new Error(`drawing_read: ${e.killed?'tiempo límite (60 s)':e.stderr?.trim()||e.message}`);}
}
// v3.8: the title block puts the next fields on the same line (MATERIAL: AISI 1020 ESCALA: 1:2 HOJA 1 DE 1): cut at the next LABEL:
export function materialsFrom(lines){return lines.flatMap(l=>{const m=l.text.match(/\bMATERIAL\s*:?\s*(.+)$/i);if(!m)return[];const raw=m[1].split(/\s+[A-ZÁÉÍÓÚÑ.]{3,}\s*:/i)[0].trim();return raw?[{raw,bbox_mm:l.bbox_mm,ir_material:{name:raw.replace(/\s+/g,' ')},note:'material del cajetín: úsalo en el IR (material.name) tal cual o con el nombre de la biblioteca de SolidWorks'}]:[];});}

export async function drawingRead(args,{signal}={}) {
  const {path:input,action,page=1,width_px=1600,grid=false}=args;
  if(typeof input!=='string'||!path.isAbsolute(input)||(process.platform==='win32'&&!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(input))) throw new Error('path debe ser absoluto (unidad o recurso UNC completo en Windows)');
  // v3.6 analyze: the whole drawing (or photo) in one call -> drawing_analyze.mjs
  if(action==='analyze'){if(typeof input!=='string'||!path.isAbsolute(input)) throw new Error('path debe ser absoluto');if(!await stat(input).then(s=>s.isFile(),()=>false)) throw new Error('El archivo no existe, no es accesible o no es un archivo regular');return (await import('./drawing_analyze.mjs')).analyzeDrawing(args,{signal});}
  if(!['info','text','render'].includes(action)) throw new Error('action debe ser info, text, render o analyze');
  if(!Number.isInteger(page)||page<1||!Number.isInteger(width_px)||width_px<1||width_px>3000) throw new Error('page >= 1; width_px entero entre 1 y 3000');
  if(typeof grid!=='boolean') throw new Error('grid debe ser booleano');
  const pdf=path.extname(input).toLowerCase()==='.pdf';
  if(/\.dwg$/i.test(input)) throw new Error('DWG es binario y no se lee directo: expórtalo a DXF (en SolidWorks o con sw_export) y lee el .dxf');
  if(!/\.(pdf|dxf|png|jpe?g|tiff?|bmp)$/i.test(input)) throw new Error('Formato no admitido');
  if(!await stat(input).then(s=>s.isFile(),()=>false)) throw new Error('El archivo no existe, no es accesible o no es un archivo regular');
  // v3.3 DXF: texts, hole callouts (block inserts) and DIMENSION entities whose value is recomputed from their geometry
  if(/\.dxf$/i.test(input)){
    // v3.9: a DXF has no page image: it is drawn from its geometry (visible black, hidden grey, centre green, section cut red, dimensions blue)
    if(action==='render'){await mkdir(outputDir,{recursive:true});if((await realpath(outputDir)).toLowerCase()!==outputDir.toLowerCase()) throw new Error('Directorio de salida redirigido: rechazado');
      const {renderDxf}=await import('./dxf_geometry.mjs');const r=await renderDxf(input,path.join(outputDir,`${randomUUID()}.png`),width_px,await drawingPython());
      return {path:r.path,page:1,format:'dxf',size_mm:r.size_mm,note:'Dibujado desde la geometría del DXF (negro visible, gris oculta, verde ejes, rojo línea de corte, azul cotas).'};}
    const ev=dxfEvidence(input);
    if(action==='info') return {path:input,page_count:1,pages:[{page:1,kind:'vector',format:'dxf',version:ev.version,units:ev.units,extents:ev.extents,entity_counts:ev.entity_counts,word_count:ev.words.length,dimension_count:ev.dimensions.length}]};
    const words=ev.words.filter(w=>!args.region_mm||(w.bbox_mm[2]>=args.region_mm[0]&&w.bbox_mm[0]<=args.region_mm[2]&&w.bbox_mm[3]>=args.region_mm[1]&&w.bbox_mm[1]<=args.region_mm[3]));
    const lines=groupDrawingLines(words).map(({words,...line})=>line);
    return {...ev,path:input,page:1,origin:'top-left of the DXF extents',coordinate_units:'mm',words,lines,dimension_candidates:parseDimensionTokens(words),materials:materialsFrom(lines),
      note:'v3.9: con action dimensions cada cota trae su vista y sus puntos en coordenadas de la pieza (desde los puntos de definición del DXF y DIMLFAC).'};
  }
  for(const key of ['region_mm','region_px']) if(args[key] && (!Array.isArray(args[key])||args[key].length!==4||!args[key].every(Number.isFinite)||args[key][0]<0||args[key][1]<0||args[key][2]<=args[key][0]||args[key][3]<=args[key][1])) throw new Error(`${key}: se requiere [x0,y0,x1,y1] creciente y no negativo`);
  if(pdf && args.region_px || !pdf && args.region_mm) throw new Error(pdf?'PDF requiere region_mm':'Imagen requiere region_px');
  if(!pdf && action==='text') throw new Error('text solo admite PDF; usa render y lectura visual');
  const python=await drawingPython();
  const invoke=async request=>JSON.parse(await run(python,['-E','-P','-B',path.join(root,'drawing_read.py'),JSON.stringify(request)],signal));
  const info=await invoke({path:input,action:'info',page,pdf});
  if(action==='info') {
    if(pdf) for(const p of info.pages) {
      // pdftotext is optional (Codex review): without it the words are counted with the Python reader
      try{const text=await run(pdftotext(),['-enc','UTF-8','-f',String(p.page),'-l',String(p.page),'-layout',input,'-'],signal);p.word_count=text.trim().split(/\s+/).filter(Boolean).length;}
      catch(e){if(signal?.aborted)throw e;try{p.word_count=(await invoke({path:input,action:'text',page:p.page,pdf:true})).words?.length??0;}catch{p.word_count=0;}p.word_count_source='python';}
      p.has_vector_text=p.word_count>0;
      p.kind=p.has_images?(p.has_vector_text?'mixed':'raster'):'vector';
    }
    return info;
  }
  if(action==='text') {
    const result=await invoke({...args,pdf});
    if(!result.words.length) throw new Error('Este PDF no tiene texto vectorial en la página/región: usa render y lectura visual');
    result.lines=groupDrawingLines(result.words).map(({words,...line})=>line);
    result.dimension_candidates=parseDimensionTokens(result.words);
    result.scales=result.dimension_candidates.filter(c=>c.kind==='scale');
    result.units=[...new Set(result.words.map(w=>w.text).filter(t=>/^(mm|in|IPS|MMGS)$/i.test(t)))];
    // v3.8: the title block puts the next fields on the same line (MATERIAL: AISI 1020 ESCALA: 1:2 HOJA 1 DE 1): cut at the next LABEL:
    result.materials=materialsFrom(result.lines);
    return result;
  }
  await mkdir(outputDir,{recursive:true});
  // Refuse directory junctions/symlinks escaping the managed output tree.
  if((await realpath(outputDir)).toLowerCase()!==outputDir.toLowerCase()) throw new Error('Directorio de salida redirigido: rechazado');
  const output=path.join(outputDir,`${randomUUID()}.png`);
  if(pdf) await run('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'render-pdf.ps1'),'-InputPath',input,'-OutputPath',output,'-Page',String(page),'-Width',String(width_px),...(args.region_mm?['-Region',args.region_mm.join(',')]:[])],signal);
  return invoke({...args,pdf,action:'render',page,width_px,grid,output});
}
