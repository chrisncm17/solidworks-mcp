import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { tools, argumentError, isToolError } from './tools.mjs';
import { WorkerClient } from './worker-client.mjs';
import { assemblyBuild, checkAssemblyPlan, compareInterferences } from './assembly_build.mjs';
const ajv = new Ajv({ strict: true });
const validate = new Map(tools.map(t => [t.name, ajv.compile(t.validationSchema || t.inputSchema)]));

test('v3.1: parameters schema requires exact fields for each action',()=>{
  const check=validate.get('sw_parameters');
  const cases=[{action:'list'},{action:'set_global',name:'L',value:40},{action:'link',dimension:'D1@Croquis1',expression:'"L"/2+5'},{action:'unlink',dimension:'D1@Saliente-Extruir1'},{action:'delete_global',name:'L'}];
  for(const row of cases){const args={document_id:'part',...row};assert.equal(check(args),true,JSON.stringify(args));assert.equal(argumentError('parameters',args),null);}
  for(const row of [{action:'set_global',name:'L'},{action:'set_global',name:'L',value:'40'},{action:'set_global',name:'"L"',value:40},{action:'link',dimension:'D1',expression:'1'},{action:'link',dimension:'D1@Sketch1'},{action:'list',value:4},{action:'unlink',dimension:'D1@Sketch1',expression:'4'},{action:'delete_global'},{action:'other'},{action:'list',keep_broken:true},{action:'link',dimension:'D1@Sketch1',expression:'1\n"L"=2'}])assert.equal(check({document_id:'part',...row}),false,JSON.stringify(row));
  assert.equal(check({action:'list'}),false);
  assert.equal(tools.find(t=>t.operation==='parameters').annotations.readOnlyHint,false);
  assert.ok(argumentError('parameters',{document_id:'part',action:'list',name:'L'}));
});

test('v3.1: part_flex schema bounds perturbations and dimension selection',()=>{
  const check=validate.get('sw_part_flex');
  for(const row of [{},{pct:0.05},{dimensions:['D1@Croquis1','D1@Saliente-Extruir1'],delta_mm:0.1,max_dimensions:2}])assert.equal(check({document_id:'part',...row}),true);
  for(const row of [{pct:0},{pct:1},{pct:-0.1},{delta_mm:0},{delta_mm:-1},{max_dimensions:0},{max_dimensions:501},{max_dimensions:1.5},{dimensions:[]},{dimensions:['D1']},{dimensions:['D1@S','D1@S']},{keep_broken:true},{unexpected:true}])assert.equal(check({document_id:'part',...row}),false,JSON.stringify(row));
  assert.equal(check({}),false);
  assert.equal(tools.find(t=>t.operation==='part_flex').annotations.readOnlyHint,false);
  assert.ok(argumentError('part_flex',{dimensions:['D1@A','D2@A'],max_dimensions:1}));
  assert.equal(argumentError('part_flex',{dimensions:['D1@A'],max_dimensions:1}),null);
});

test('v3.0: drawing_read schema is strict, local and read-only', () => {
  const check=validate.get('sw_drawing_read');
  assert.equal(check({path:'C:\\drawings\\test.pdf',action:'text'}),true);
  for(const arg of [{path:'relative.pdf',action:'info'},{path:'C:\\test.exe',action:'render'},{path:'C:\\test.pdf',action:'info',page:0},{path:'C:\\test.pdf',action:'render',width_px:3001},{path:'C:\\test.pdf',action:'text',execute:'x'}]) assert.equal(check(arg),false);
  assert.equal(tools.find(t=>t.operation==='drawing_read').annotations.readOnlyHint,true);
});
test('v3.0: drawing_read parser recognizes dimensions and preserves provenance', async () => {
  const {parseDimensionTokens}=await import('./drawing_read.mjs');
  const cases=[['Ø12','diameter',12],['4X Ø6','count_prefix',6],['R5','radius',5],['M8x1.25','thread',8],['30°','angle',30],['2 x 45°','chamfer',2],['12,5','linear',12.5],['±0.1','tolerance',0.1],['ESCALA 1:2','scale',0.5],['+0.2/-0.1','tolerance',null],['Ø 12','diameter',12],['12?','unknown',null]];
  for(const [raw,kind,value] of cases) {
    let x=0;
    const words=raw.split(' ').map(text=>{const left=x;x+=text.length+1;return {text,bbox_mm:[left,2,x-1,4]};});
    const result=parseDimensionTokens(words);
    assert.equal(result.length,1,raw);assert.equal(result[0].kind,kind,raw);assert.equal(result[0].value,value,raw);assert.equal(result[0].raw,raw);assert.equal(result[0].bbox_mm.length,4);
  }
  assert.equal(parseDimensionTokens([{text:'Ø',bbox_mm:[0,0,1,2]},{text:'12',bbox_mm:[50,0,52,2]}])[0].kind,'unknown');
});
test('v3.0: drawing_read rejects invalid paths and regions before processing', async()=>{
  const {drawingRead}=await import('./drawing_read.mjs');
  await assert.rejects(drawingRead({path:'relative.pdf',action:'info'}),/absoluto/);
  await assert.rejects(drawingRead({path:new URL('./tools.mjs',import.meta.url).pathname,action:'info'}),/Formato|absoluto/);
});
test('v3.0: drawing_read PDF text/info and PNG render integration', async()=>{
  const {drawingRead,drawingPython}=await import('./drawing_read.mjs');
  const {mkdir,writeFile}=await import('node:fs/promises');
  const {fileURLToPath}=await import('node:url');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const dir=fileURLToPath(new URL('./generated/drawing_read/',import.meta.url));
  await mkdir(dir,{recursive:true});
  const pdf=dir+'fixture.pdf',png=dir+'fixture.png';
  const content='BT /F1 12 Tf 1 0 0 1 72 700 Tm (80.00 R5 M8x1.25 ESCALA 1:2 MATERIAL ACERO mm) Tj ET\nBT /F1 12 Tf 0 1 -1 0 250 400 Tm (12.5) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let body='%PDF-1.4\n',offsets=[0];
  objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const start=Buffer.byteLength(body);body+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  await writeFile(pdf,body);
  const info=await drawingRead({path:pdf,action:'info'});
  assert.equal(info.page_count,1);assert.equal(info.pages[0].kind,'vector');assert.equal(info.pages[0].word_count,9);assert.ok(Math.abs(info.pages[0].size_mm[0]-215.9)<0.001);
  const text=await drawingRead({path:pdf,action:'text'});
  assert.equal(text.origin,'top-left');assert.equal(text.words[0].text,'80.00');assert.ok(Math.abs(text.words[0].bbox_mm[0]-25.4)<0.01);
  assert.ok(text.words.some(w=>w.text==='12.5' && Math.abs(w.angle_deg-90)<0.01));
  assert.ok(text.dimension_candidates.some(c=>c.kind==='thread'));assert.equal(text.scales[0].value,0.5);assert.ok(text.materials[0].raw.includes('ACERO'));assert.deepEqual(text.units,['mm']);
  const partial=await drawingRead({path:pdf,action:'text',region_mm:[20,25,50,40]});assert.ok(partial.words.length<text.words.length);
  await assert.rejects(drawingRead({path:pdf,action:'info',page:2}),/rango/);
  await assert.rejects(drawingRead({path:pdf,action:'render',region_mm:[0,0,1000,1000]}),/fuera/);
  const python=await drawingPython();
  await promisify(execFile)(python,['-E','-P','-c','from PIL import Image; import sys; Image.new("RGB",(100,80),"white").save(sys.argv[1],dpi=(100,100))',png],{timeout:60000,windowsHide:true});
  const imageInfo=await drawingRead({path:png,action:'info'});assert.equal(imageInfo.pages[0].width_px,100);assert.ok(imageInfo.pages[0].dpi);
  const rendered=await drawingRead({path:png,action:'render',region_px:[10,10,50,30],width_px:400,grid:true});assert.equal(rendered.width_px,400);assert.equal(rendered.height_px,200);assert.deepEqual(rendered.region_px,[10,10,50,30]);assert.equal(rendered.px_per_unit[0],10);
  await assert.rejects(drawingRead({path:png,action:'render',region_px:[0,0,101,80]}),/fuera/);
  await assert.rejects(drawingRead({path:png,action:'text'}),/solo admite PDF/);
  const raster=dir+'raster.pdf',mixed=dir+'mixed.pdf';
  await promisify(execFile)(python,['-E','-P','-c',`from PIL import Image
from pypdf import PdfReader,PdfWriter
import sys
Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'PDF',resolution=100)
p=PdfReader(sys.argv[3]).pages[0]
p.merge_page(PdfReader(sys.argv[2]).pages[0])
w=PdfWriter();w.add_page(p)
with open(sys.argv[4],'wb') as f:w.write(f)`,png,raster,pdf,mixed],{timeout:60000,windowsHide:true});
  assert.equal((await drawingRead({path:raster,action:'info'})).pages[0].kind,'raster');
  assert.equal((await drawingRead({path:mixed,action:'info'})).pages[0].kind,'mixed');
  await assert.rejects(drawingRead({path:raster,action:'text'}),/no tiene texto vectorial/);
  if(process.platform==='win32') {
    const pdfRender=await drawingRead({path:pdf,action:'render',region_mm:[20,20,100,80],width_px:800,grid:true});
    assert.equal(pdfRender.width_px,800);assert.ok(Math.abs(pdfRender.height_px-600)<=1);assert.equal(pdfRender.px_per_mm,10);
  }
});
test('managed filenames reject traversal and arbitrary paths', () => {
  const check = validate.get('sw_resume_copy');
  for (const name of ['../part.SLDPRT', 'C:\\part.SLDPRT', 'part.txt', 'x/part.sldprt']) assert.equal(check({name}), false);
  assert.equal(check({name: 'pieza corregida.SLDPRT'}), true);
});
test('dimension changes require explicit non-negative SI values and document identity', () => {
  const check = validate.get('sw_set_dimension');
  assert.equal(check({document_id:'demo',name:'D1@Distancia1',value_si:0}), true);
  for (const value_si of [-1, Infinity, NaN, '25']) assert.equal(check({document_id:'demo',name:'D1',value_si}), false);
  assert.equal(check({document_id:'demo',name:'D1',value_si:0.025}), true);
  assert.equal(check({name:'D1',value_si:0.025}), false);
});
test('constraints are allowlisted and unknown arguments rejected', () => {
  const check = validate.get('sw_tangent');
  const args = {document_id:'demo',sketch:'Sketch1',first:0,second:1};
  assert.equal(check(args), true);
  assert.equal(check({...args,constraint:'arbitrary code'}), false);
  assert.equal(check({...args,execute:'code'}), false);
});
test('sketch support and cut depth must be unambiguous before COM', () => {
  const args={entities:[{kind:'circle',center_mm:[0,0],radius_mm:5}]};
  assert.ok(argumentError('create_sketch',args));
  assert.ok(argumentError('create_sketch',{...args,plane_index:0,face_reference:'a'.repeat(32)}));
  assert.equal(argumentError('create_sketch',{...args,plane_index:0}),null);
  assert.ok(argumentError('cut',{end_condition:'blind'}));
  assert.equal(argumentError('cut',{end_condition:'through_all'}),null);
});
test('invalid arc geometry is rejected before any sketch is created', () => {
  assert.ok(argumentError('create_sketch',{plane_index:0,entities:[{kind:'arc',center_mm:[0,0],start_mm:[1,0],end_mm:[0,2],clockwise:false}]}));
});
test('edge selection rejects duplicate and malformed references', () => {
  const args={document_id:'demo',distance_mm:1,angle_deg:45,edge_references:['a'.repeat(32)]};
  const check=validate.get('sw_chamfer');assert.equal(check(args),true);
  assert.equal(check({...args,angle_deg:90}),false);
  assert.equal(check({...args,edge_references:[...args.edge_references,...args.edge_references]}),false);
});
function fakeWorker(code,timeoutMs=2000,hardTimeoutMs=10000){return new WorkerClient({executable:process.execPath,args:['--input-type=module','-e',code],timeoutMs,hardTimeoutMs});}
test('concurrent calls are serialized and input is captured at submission', async () => {
  const w=fakeWorker(`import {createInterface} from 'node:readline';let busy=false;createInterface({input:process.stdin}).on('line',line=>{if(busy)process.exit(3);busy=true;const r=JSON.parse(line);setTimeout(()=>{busy=false;console.log(JSON.stringify({ok:true,result:r.arguments}));},30);});`);
  try {const arg={x:1};const first=w.call('demo',arg);arg.x=9;const results=await Promise.all([first,w.call('demo',{x:2})]);assert.deepEqual(results.map(x=>x.result.x),[1,2]);}finally{w.close();}
});
test('v3.11 timeout keeps the worker: the late result is kept and the next call waits for it', async () => {
  const w=fakeWorker(`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>setTimeout(()=>console.log(JSON.stringify({ok:true,result:JSON.parse(line).operation})),150));`,60);
  try{await assert.rejects(w.call('slow',{}),/still running.*UNKNOWN/);const late0=w.takeLate().length;
   const next=await w.call('next',{}).catch(e=>e);assert.equal(late0,0);
   const late=w.takeLate();assert.equal(late.length,1);assert.equal(late[0].operation,'slow');assert.equal(late[0].response.result,'slow');
   assert.ok(next instanceof Error?/still running/.test(next.message):next.result==='next');}finally{w.close();}
});
test('v3.11 a silent worker is killed only after hardTimeoutMs and the outcome is UNKNOWN', async () => {
  const w=fakeWorker('process.stdin.resume();',30,200);
  try{await assert.rejects(w.call('demo',{}),/UNKNOWN/);await assert.rejects(w.call('demo',{}),/UNKNOWN/);}finally{w.close();}
});
test('malformed worker output cannot be mistaken for success', async () => {
  const w=fakeWorker(`process.stdin.once('data',()=>console.log('{}'));`);
  try{await assert.rejects(w.call('demo',{}),/Invalid worker/);}finally{w.close();}
});
test('cancelled queued requests never reach CAD', async () => {
  const w=fakeWorker(`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>setTimeout(()=>console.log(JSON.stringify({ok:true,result:JSON.parse(line).operation})),40));`);
  try{const first=w.call('first',{});const control=new AbortController();const second=w.call('forbidden',{}, {signal:control.signal});control.abort();await first;await assert.rejects(second,/before CAD execution/);assert.equal((await w.call('third',{})).result,'third');}finally{w.close();}
});
test('v3.11 active cancellation reports an unknown outcome without killing the worker', async () => {
  const w=fakeWorker(`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>setTimeout(()=>console.log(JSON.stringify({ok:true,result:JSON.parse(line).operation})),120));`);const control=new AbortController();
  try{const pending=w.call('demo',{}, {signal:control.signal});setTimeout(()=>control.abort(),30);await assert.rejects(pending,/cancelled.*UNKNOWN/);
   assert.equal((await w.call('next',{})).result,'next');const late=w.takeLate();assert.equal(late.length,1);assert.equal(late[0].reason,'cancelled');}finally{w.close();}
});

test('equation inspection requires document identity and forbids mutation arguments', () => {
  const check=validate.get('sw_equations');
  assert.equal(check({expected_title:'Pieza2'}),true);
  assert.equal(check({}),false);
  assert.equal(check({expected_title:'Pieza2',evaluate:true}),false);
  assert.equal(check({expected_title:'Pieza2',expression:'"A"=102'}),false);
  assert.equal(tools.find(t=>t.name==='sw_equations').annotations.readOnlyHint,true);
});

test('assembly mates and interference validate their arguments', () => {
  const mates=validate.get('sw_mates'),inter=validate.get('sw_interference');
  assert.equal(mates({document_id:'a',action:'list'}),true);
  assert.equal(mates({document_id:'a',action:'delete'}),false);
  assert.match(argumentError('mates',{document_id:'a',action:'suppress'}),/requires names/);
  assert.match(argumentError('mates',{document_id:'a',action:'list',names:['Coincidente1']}),/does not take names/);
  assert.equal(argumentError('mates',{document_id:'a',action:'suppress',names:['Coincidente1']}),null);
  assert.equal(inter({document_id:'a'}),true);
  assert.equal(inter({document_id:'a',max_pairs:0}),false);
  assert.equal(inter({document_id:'a',save:true}),false);
});

test('part_diff is read-only and pack_and_go rejects paths in folder names', () => {
  const diff=validate.get('sw_part_diff'),pack=validate.get('sw_pack_and_go');
  assert.equal(diff({document_id:'a',original_path:'C:\\x\\p.SLDPRT'}),true);
  assert.equal(diff({document_id:'a'}),false);
  assert.equal(tools.find(t=>t.name==='sw_part_diff').annotations.readOnlyHint,true);
  assert.equal(pack({document_id:'a',folder_name:'Triciclo entrega',zip:true}),true);
  assert.equal(pack({document_id:'a',folder_name:'..\\fuera'}),false);
  assert.equal(pack({document_id:'a',folder_name:'a/b'}),false);
});

test('user projects require native absolute paths and explicit restore targets', () => {
  const open=validate.get('sw_open_project'),restore=validate.get('sw_restore_backup'),close=validate.get('sw_close_document');
  assert.equal(open({path:'C:\\Proyectos\\Ensamblaje1.SLDASM'}),true);
  assert.equal(open({path:'C:\\Proyectos\\nota.txt'}),false);
  assert.match(argumentError('open_project',{path:'relativo\\pieza.SLDPRT'}),/absolute/);
  assert.equal(argumentError('open_project',{path:'C:\\Proyectos\\pieza.SLDPRT'}),null);
  assert.equal(restore({action:'list'}),true);
  assert.match(argumentError('restore_backup',{action:'restore'}),/backup_name/);
  assert.equal(restore({action:'restore',backup_name:'..\\x'}),false);
  assert.equal(close({document_id:'a',discard_changes:true}),true);
  assert.equal(open({path:'C:\\P\\a.SLDASM',allow_missing_references:true}),true);
});

test('drawing views require a target and a change for set', () => {
  const dv=validate.get('sw_drawing_views');
  assert.equal(dv({document_id:'a',action:'list'}),true);
  assert.equal(dv({document_id:'a',action:'set',sheet:'01',view:'V1',display:'shaded'}),true);
  assert.equal(dv({document_id:'a',action:'set',sheet:'01',view:'V1',display:'color'}),false);
  assert.match(argumentError('drawing_views',{document_id:'a',action:'set',display:'shaded'}),/sheet and view/);
  assert.match(argumentError('drawing_views',{document_id:'a',action:'set',sheet:'01',view:'V1'}),/scale, display or center_mm/);
  assert.equal(argumentError('drawing_views',{document_id:'a',action:'fix_sheet_scale'}),null);
});

test('feature tools validate axis and plane choices', () => {
  assert.equal(validate.get('sw_revolve')({document_id:'a',sketch:'S',angle_deg:360}),true);
  assert.equal(validate.get('sw_extrude')({document_id:'a',name:'Mi nombre',sketch:'S',depth_mm:5}),false); // never rename the tree
  assert.equal(validate.get('sw_revolve')({document_id:'a',sketch:'S',angle_deg:400}),false);
  assert.match(argumentError('circular_pattern',{document_id:'a',name:'P',features:['F'],count:6}),/exactly one/);
  assert.equal(argumentError('circular_pattern',{document_id:'a',name:'P',features:['F'],count:6,axis:'Y'}),null);
  assert.match(argumentError('linear_pattern',{document_id:'a',name:'P',features:['F'],count:3,spacing_mm:10,axis:'X',axis_edge_reference:'0123456789abcdef0123456789abcdef'}),/exactly one/);
  assert.match(argumentError('ref_plane',{document_id:'a',name:'P',offset_mm:10}),/exactly one/);
  assert.equal(validate.get('sw_create_sketch')({document_id:'a',plane_index:5,entities:[{kind:'circle',center_mm:[0,0],radius_mm:1}]}),true);
});

test('no creation tool accepts a feature name (user rule: keep SolidWorks default names)', () => {
  for (const op of ['create_sketch','extrude','cut','fillet','chamfer','thread','revolve','mirror','circular_pattern','linear_pattern','ref_plane','loft','sweep','shell','rib','draft','helix'])
    assert.equal('name' in tools.find(t=>t.operation===op).inputSchema.properties, false, op);
});

test('pack_and_go verification failure is reported as an MCP error', () => {
  assert.equal(isToolError('pack_and_go', {ok:true,result:{ok:true}}), false);
  assert.equal(isToolError('pack_and_go', {ok:true,result:{ok:false,missing:['x.SLDPRT']}}), true);
  assert.equal(isToolError('pack_and_go', {ok:false,error:'boom'}), true);
  assert.equal(isToolError('save', {ok:true,result:{ok:false}}), false); // only Pack and Go carries its own verdict
});

test('v1.5: loft needs 2-10 distinct profiles', () => {
  const lo = validate.get('sw_loft');
  assert.equal(lo({document_id:'a',profiles:['Croquis1','Croquis2']}), true);
  assert.equal(lo({document_id:'a',profiles:['Croquis1']}), false);
  assert.equal(lo({document_id:'a',profiles:['Croquis1','Croquis1']}), false);
  assert.equal('name' in tools.find(t=>t.operation==='loft').inputSchema.properties, false);
});

test('v1.5: direction, start offset, slots and sketch fillets validate', () => {
  const ex = validate.get('sw_extrude'), cut = validate.get('sw_cut'), sk = validate.get('sw_create_sketch');
  assert.equal(ex({document_id:'a',sketch:'S',depth_mm:5,direction:'+Z',start_offset_mm:3}), true);
  assert.equal(ex({document_id:'a',sketch:'S',depth_mm:5,direction:'Z'}), false);
  assert.match(argumentError('extrude',{document_id:'a',sketch:'S',depth_mm:5,direction:'+Z',reverse:true}), /not both/);
  assert.match(argumentError('extrude',{document_id:'a',sketch:'S',depth_mm:5,end_condition:'mid_plane',direction:'+Z'}), /mid_plane/);
  assert.equal(cut({document_id:'a',sketch:'S',end_condition:'through_all',direction:'-Y'}), true);
  const slot = {kind:'slot',start_center_mm:[0,0],end_center_mm:[10,0],width_mm:4};
  assert.equal(sk({document_id:'a',plane_index:0,entities:[slot],fillets:[{at_mm:[0,0],radius_mm:1}]}), true);
  assert.match(argumentError('create_sketch',{plane_index:0,entities:[{...slot,end_center_mm:[0,0]}]}), /distinct/);
  assert.match(argumentError('create_sketch',{plane_index:0,entities:[{...slot,end_center_mm:[5e-10,0]}]}), /distinct/);
});

test('v1.6 batch A: sweep, shell, rib, draft, helix and sketch chamfers validate', () => {
  const v = n => validate.get('sw_' + n);
  assert.equal(v('sweep')({document_id:'a',profile:'Croquis1',path:'Croquis2'}), true);
  assert.equal(v('sweep')({document_id:'a',circular_diameter_mm:2,path:'Hélice1'}), true);
  assert.match(argumentError('sweep',{document_id:'a',path:'P'}), /exactly one/);
  assert.match(argumentError('sweep',{document_id:'a',path:'P',profile:'S',circular_diameter_mm:2}), /exactly one/);
  assert.match(argumentError('sweep',{document_id:'a',path:'P',circular_diameter_mm:2,cut:true}), /only for a boss/);
  assert.equal(v('shell')({document_id:'a',thickness_mm:2,face_references:['0123456789abcdef0123456789abcdef']}), true);
  assert.equal(v('shell')({document_id:'a',thickness_mm:0}), false);
  assert.equal(v('rib')({document_id:'a',sketch:'Croquis3',thickness_mm:2}), true);
  assert.equal(v('draft')({document_id:'a',neutral_face_reference:'0123456789abcdef0123456789abcdef',face_references:['fedcba9876543210fedcba9876543210'],angle_deg:5}), true);
  assert.equal(v('draft')({document_id:'a',neutral_face_reference:'0123456789abcdef0123456789abcdef',face_references:[],angle_deg:5}), false);
  assert.equal(v('helix')({document_id:'a',sketch:'Croquis1',pitch_mm:5,revolutions:3}), true);
  assert.equal(v('helix')({document_id:'a',sketch:'Croquis1',pitch_mm:5,revolutions:0}), false);
  const line = {kind:'line',start_mm:[0,0],end_mm:[10,0]};
  assert.equal(v('create_sketch')({document_id:'a',plane_index:0,entities:[line],chamfers:[{at_mm:[0,0],distance_mm:1,angle_deg:45}]}), true);
  assert.match(argumentError('create_sketch',{plane_index:0,entities:[line],chamfers:[{at_mm:[0,0],distance_mm:1,angle_deg:45,distance2_mm:2}]}), /not both/);
});

test('v1.6 batch B: hole wizard, reference geometry and extrude end conditions validate', () => {
  const v = n => validate.get('sw_' + n);
  assert.equal(v('hole_wizard')({document_id:'a',type:'counterbore',size:'M6',point_mm:[0,20,0]}), true);
  assert.equal(v('hole_wizard')({document_id:'a',type:'slot',size:'M6',point_mm:[0,20,0]}), false);
  assert.match(argumentError('hole_wizard',{document_id:'a',type:'tap',size:'M6',point_mm:[0,20,0]}), /needs depth_mm/);
  assert.equal(v('ref_plane_advanced')({document_id:'a',references:[{plane_index:1,constraint:'angle',value:30},{feature_name:'Eje1',constraint:'coincident'}]}), true);
  assert.match(argumentError('ref_plane_advanced',{document_id:'a',references:[{plane_index:1,constraint:'distance'}]}), /needs value/);
  assert.match(argumentError('ref_axis',{document_id:'a',references:[{plane_index:0,feature_name:'Eje1'}]}), /exactly one/);
  assert.equal(v('ref_axis')({document_id:'a',references:[{plane_index:0},{plane_index:1}]}), true);
  assert.equal(v('extrude')({document_id:'a',sketch:'S',end_condition:'up_to_next',direction:'-Y'}), true);
  assert.match(argumentError('extrude',{document_id:'a',sketch:'S'}), /requires depth_mm/);
  assert.match(argumentError('extrude',{document_id:'a',sketch:'S',end_condition:'up_to_surface'}), /requires face_reference/);
  assert.match(argumentError('cut',{document_id:'a',sketch:'S',end_condition:'offset_from_surface',face_reference:'0123456789abcdef0123456789abcdef'}), /offset_mm/);
  assert.match(argumentError('extrude',{document_id:'a',sketch:'S',depth_mm:5,end_condition:'mid_plane',depth2_mm:2}), /depth2_mm/);
  for (const op of ['hole_wizard','ref_plane_advanced','ref_axis']) assert.equal('name' in tools.find(t=>t.operation===op).inputSchema.properties, false, op);
});

test('v1.8: move_component and delete_mate validate', () => {
  const mv = validate.get('sw_move_component'), dm = validate.get('sw_delete_mate');
  assert.equal(mv({document_id:'d',component:'ARM-1',position_mm:[0,0,0]}), true);
  assert.equal(mv({document_id:'d',component:'ARM-1',position_mm:[0,0,0],rotation_deg:[0,90,0]}), true);
  assert.equal(mv({document_id:'d',component:'ARM-1'}), false);
  assert.equal(mv({document_id:'d',component:'ARM-1',position_mm:[0,0]}), false);
  assert.equal(dm({document_id:'d',names:['Distancia1']}), true);
  assert.equal(dm({document_id:'d',names:[]}), false);
  assert.equal(dm({document_id:'d',names:['A','A']}), false);
});

test('v1.8: configuration validates', () => {
  const v = validate.get('sw_configuration');
  assert.equal(v({document_id:'d',action:'list'}), true);
  assert.equal(v({document_id:'d',action:'activate',name:'Free'}), true);
  assert.equal(v({document_id:'d',action:'delete',name:'Free'}), false);
});

test('v1.9: assembly_diff and drawing_annotate validate', () => {
  const ad = validate.get('sw_assembly_diff'), da = validate.get('sw_drawing_annotate');
  assert.equal(ad({path:'C:/x/mine.SLDASM',reference_path:'C:/x/orig.SLDASM'}), true);
  assert.equal(ad({path:'C:/x/mine.SLDASM',reference_path:'C:/x/orig.SLDASM',tolerance_mm:0.05,relative_to_file:'rod.sldprt'}), true);
  assert.equal(ad({path:'C:/x/mine.SLDASM'}), false);
  assert.equal(ad({path:'C:/x/mine.SLDASM',reference_path:'C:/x/orig.SLDASM',tolerance_mm:0}), false);
  assert.equal(da({document_id:'d'}), true);
  assert.equal(da({document_id:'d',center_marks:true,views:['Drawing View1']}), true);
  assert.equal(da({document_id:'d',views:[]}), false);
});

test('v1.9: diffSnapshots matches components, relative frames and mates', async () => {
  const { diffSnapshots } = await import('./compare.mjs');
  const I = (x, y, z) => [1,0,0, 0,1,0, 0,0,1, x/1000, y/1000, z/1000];
  const snap = (comps, mates, cm) => ({ path: 'p', configuration: 'Default', components: comps, mates, mass: { mass_g: 10, volume_mm3: 1, center_of_mass_mm: cm } });
  const c = (name, file, t) => ({ name, file, configuration: 'Default', suppressed: false, transform: t });
  const m = sig => ({ signature: sig, suppressed: false, error: 0 });
  const A = snap([c('a-1','a.sldprt',I(0,0,0)), c('b-1','b.sldprt',I(10,0,0))], [m('COINCIDENT(a|b)')], [5,0,0]);
  assert.equal(diffSnapshots(A, A).verdict, 'iguales dentro de tolerancia');
  const B = snap([c('a-1','a.sldprt',I(0,0,0)), c('b-1','b.sldprt',I(12,0,0))], [m('COINCIDENT(a|b)')], [6,0,0]);
  const d = diffSnapshots(A, B); assert.equal(d.verdict, 'diferentes'); assert.equal(d.components.different, 1); assert.equal(d.components.details.find(x => x.file === 'b.sldprt').position_diff_mm, 2);
  const C = snap([c('a-1','a.sldprt',I(100,0,0)), c('b-1','b.sldprt',I(110,0,0))], [m('COINCIDENT(a|b)')], [105,0,0]);
  assert.equal(diffSnapshots(A, C, { relative_to_file: 'a.sldprt' }).verdict, 'iguales dentro de tolerancia');
  const D = snap(A.components, [m('DISTANCE(a|b)')], [5,0,0]);
  assert.equal(diffSnapshots(A, D).mates.signature_differences.length, 2);
});

test('v1.9: diffSnapshots flags changed mate values, mate errors, volume and missing transforms', async () => {
  const { diffSnapshots } = await import('./compare.mjs');
  const I = (x) => [1,0,0, 0,1,0, 0,0,1, x/1000, 0, 0];
  const base = (over = {}) => ({ path: 'p', configuration: 'Default', components: [{ name: 'a-1', file: 'a.sldprt', configuration: 'Default', suppressed: false, loaded: true, transform: I(0) }], mates: [{ signature: 'DISTANCE(a|b)', suppressed: false, error: 0, values_si: [0.01] }], mass: { mass_g: 10, volume_mm3: 100, center_of_mass_mm: [0,0,0] }, ...over });
  const A = base();
  assert.equal(diffSnapshots(A, base()).verdict, 'iguales dentro de tolerancia');
  assert.equal(diffSnapshots(A, base({ mates: [{ signature: 'DISTANCE(a|b)', suppressed: false, error: 0, values_si: [0.02] }] })).verdict, 'diferentes');
  assert.equal(diffSnapshots(A, base({ mates: [{ signature: 'DISTANCE(a|b)', suppressed: false, error: 48, values_si: [0.01] }] })).verdict, 'diferentes');
  assert.equal(diffSnapshots(A, base({ mass: { mass_g: 10, volume_mm3: 101, center_of_mass_mm: [0,0,0] } })).verdict, 'diferentes');
  const noT = base({ components: [{ name: 'a-1', file: 'a.sldprt', configuration: 'Default', suppressed: false, loaded: true, transform: null }] });
  assert.equal(diffSnapshots(A, noT).verdict, 'diferentes');
});

test('v2.0: sheet_metal, hole callouts and new export formats validate', () => {
  const sm = validate.get('sw_sheet_metal'), ex = validate.get('sw_export'), da = validate.get('sw_drawing_annotate');
  assert.equal(sm({document_id:'d',action:'base_flange',sketch:'Croquis1',thickness_mm:2}), true);
  assert.equal(sm({document_id:'d',action:'base_flange',sketch:'Croquis1',thickness_mm:2,k_factor:1}), false);
  assert.equal(sm({document_id:'d',action:'edge_flange',edge_point_mm:[10,0,0],length_mm:20,position:'material_inside'}), true);
  assert.equal(sm({document_id:'d',action:'fold'}), false);
  assert.equal(sm({document_id:'d',action:'export_flat',name:'placa.dxf'}), true);
  assert.equal(sm({document_id:'d',action:'export_flat',name:'placa.step'}), false);
  assert.match(argumentError('sheet_metal',{document_id:'d',action:'edge_flange'}), /edge_point_mm, length_mm/);
  assert.equal(argumentError('sheet_metal',{document_id:'d',action:'flatten'}), null);
  for (const name of ['p.dxf','p.DWG','p.igs','p.iges','p.pdf','p.step']) assert.equal(ex({document_id:'d',name}), true);
  assert.equal(da({document_id:'d',hole_callouts:true,include_cut_holes:true}), true);
});

test('v2.1: create_sketch dimension option', () => {
  const v = validate.get('sw_create_sketch');
  const ent = [{kind:'circle',center_mm:[0,0],radius_mm:5}];
  assert.equal(v({document_id:'d',plane_index:0,entities:ent,dimension:true}), true);
  assert.match(argumentError('create_sketch',{document_id:'d',plane_index:0,entities:ent,dimension:true,fix_geometry:true}), /exclusive/);
  assert.equal(argumentError('create_sketch',{document_id:'d',plane_index:0,entities:ent,dimension:true}), null);
});

test('v2.2: collision and edit_mate validate', () => {
  const co = validate.get('sw_collision'), em = validate.get('sw_edit_mate');
  assert.equal(co({document_id:'d',mate:'Distancia1',to:140}), true);
  assert.equal(co({document_id:'d',mate:'Ángulo1',to:110,step:5,tolerance:0.001,components:['Step-1'],stay_at_contact:true}), true);
  assert.equal(co({document_id:'d',mate:'Distancia1',to:-5}), false);
  assert.equal(co({document_id:'d',mate:'Distancia1'}), false);
  assert.equal(em({document_id:'d',name:'Distancia1',distance_mm:12.5,flip_dimension:true}), true);
  assert.equal(em({document_id:'d',name:'Concéntrica1',align:'sideways'}), false);
  assert.match(argumentError('edit_mate',{document_id:'d',name:'X'}), /something to change/);
  assert.match(argumentError('edit_mate',{document_id:'d',name:'X',distance_mm:1,angle_deg:2}), /not both/);
  assert.equal(argumentError('edit_mate',{document_id:'d',name:'X',align:'aligned'}), null);
});

test('v2.3: replace_component, component_pattern and component_solving validate', () => {
  const rc = validate.get('sw_replace_component'), cp = validate.get('sw_component_pattern'), cs = validate.get('sw_component_solving');
  assert.equal(rc({document_id:'d',component:'Work disk-1',new_path:'C:/x/disk2.SLDPRT',all_instances:true}), true);
  assert.equal(rc({document_id:'d',component:'Work disk-1'}), false);
  const e = {component:'ROD-1',local_point_mm:[6.15,0,-80],kind:'face'};
  assert.equal(cp({document_id:'d',kind:'circular',seeds:['ARM-1'],count:3,axis:e}), true);
  assert.equal(cp({document_id:'d',kind:'linear',seeds:['Pin-1'],count:4,spacing_mm:20,direction:{...e,kind:'edge'}}), true);
  assert.equal(cp({document_id:'d',kind:'circular',seeds:['ARM-1'],count:1,axis:e}), false);
  assert.equal(cp({document_id:'d',kind:'circular',seeds:['ARM-1'],count:3,axis:{component:'ROD-1'}}), false);
  assert.match(argumentError('component_pattern',{document_id:'d',kind:'linear',seeds:['P'],count:2}), /direction and spacing_mm/);
  assert.match(argumentError('component_pattern',{document_id:'d',kind:'circular',seeds:['P'],count:2}), /needs axis/);
  assert.equal(cs({document_id:'d',component:'Conn Rod Assy-1',solving:'flexible'}), true);
  assert.equal(cs({document_id:'d',component:'Conn Rod Assy-1',solving:'soft'}), false);
});

test('v2.4: bom and balloons validate', () => {
  const b = validate.get('sw_bom'), bl = validate.get('sw_balloons');
  assert.equal(b({document_id:'d',action:'insert',type:'parts_only',columns:[{title:'MATERIAL',property:'SW-Material'},{title:'MASA',property:'SW-Mass'}]}), true);
  assert.equal(b({document_id:'d',action:'read'}), true);
  assert.equal(b({document_id:'d',action:'insert',columns:[{title:'X'}]}), false);
  assert.equal(b({document_id:'d',action:'insert',type:'flat'}), false);
  assert.equal(bl({document_id:'d',layout:'circle',views:['Vista de dibujo1']}), true);
  assert.equal(bl({document_id:'d',layout:'spiral'}), false);
});

test('v2.5: explode and drawing_sheets validate', () => {
  const ex = validate.get('sw_explode'), ds = validate.get('sw_drawing_sheets');
  assert.equal(ex({document_id:'d',action:'create',steps:[{components:['Work disk-1'],direction:'Z',distance_mm:60,reverse:true},{components:['ARM-1'],direction:{component:'ROD-1',local_point_mm:[8.5,4.9,-10],kind:'edge'},distance_mm:40}],replace:true}), true);
  assert.equal(ex({document_id:'d',action:'create',steps:[{components:['A-1'],direction:'W',distance_mm:5}]}), false);
  assert.match(argumentError('explode',{document_id:'d',action:'create'}), /needs steps/);
  assert.equal(ds({document_id:'d',action:'add',name:'02 Explosionada',size:'A3',format_from_drawing:'C:/x/cajetin.SLDDRW'}), true);
  assert.equal(ds({document_id:'d',action:'add_view',model_path:'C:/x/a.SLDASM',view_orientation:'isometric',exploded:true,scale:0.5,display:'shaded'}), true);
  assert.equal(ds({document_id:'d',action:'properties',values:{TITULO:'Extractor',AUTOR:'Autor'}}), true);
  assert.match(argumentError('drawing_sheets',{document_id:'d',action:'add'}), /needs: name/);
  assert.match(argumentError('drawing_sheets',{document_id:'d',action:'add',name:'x',width_mm:500}), /both width_mm/);
  assert.match(argumentError('drawing_sheets',{document_id:'d',action:'add',name:'x',format_path:'a',format_from_drawing:'b'}), /not both/);
});

test('v2.6: mass_check validates', () => {
  const v = validate.get('sw_mass_check');
  assert.equal(v({document_id:'d'}), true);
  assert.equal(v({document_id:'d',length_units:'in',reference:{center_of_mass:[0,0.027,5.682]}}), true);
  assert.equal(v({document_id:'d',reference:{mass:645.12,center_of_mass:[37.59,-39.79,0.47]},mass_tolerance_percent:0.05,com_tolerance:0.1,coordinate_system:'Sistema de coordenadas1'}), true);
  assert.equal(v({document_id:'d',reference:{}}), false);
  assert.equal(v({document_id:'d',reference:{center_of_mass:[1,2]}}), false);
  assert.equal(v({document_id:'d',length_units:'ft'}), false);
});


test('v2.7: coordinate_system validates', () => {
  const v = validate.get('sw_coordinate_system');
  const ok = a => v(a) && !argumentError('coordinate_system', a);
  for (const a of [
    {action:'list'}, {action:'delete',name:'Sistema de coordenadas1'},
    {action:'create',point_mm:[0,25,-30]}, {action:'create',local_point_mm:[1,2,3]},
    ...['vertex','edge','face'].map(kind => ({action:'create',component:'Base-1',kind,local_point_mm:[0,0,0]})),
    {action:'create',component:'Base-1',kind:'vertex',local_point_mm:[0,0,0],linked:true,flip_x:true,flip_y:true},
  ]) assert.equal(Boolean(ok({document_id:'d',...a})), true, JSON.stringify(a));
  for (const a of [
    {}, {action:'rename'}, {action:'create'}, {action:'delete'},
    {action:'create',point_mm:[1,2]}, {action:'create',point_mm:[1,2,3,4]},
    {action:'create',point_mm:[0,NaN,0]}, {action:'create',point_mm:[0,Infinity,0]},
    {action:'create',point_mm:[0,0,0],extra:true},
    {action:'create',point_mm:[0,0,0],local_point_mm:[0,0,0]},
    {action:'create',point_mm:[0,0,0],name:'Renamed'},
    {action:'create',point_mm:[0,0,0],component:'Base-1'},
    {action:'create',local_point_mm:[0,0,0],component:'Base-1'},
    {action:'create',local_point_mm:[0,0,0],kind:'plane'},
    {action:'create',local_point_mm:[0,0,0],kind:'face',linked:true},
    {action:'create',point_mm:[0,0,0],flip_x:'yes'},
    {action:'list',point_mm:[0,0,0]}, {action:'delete',name:'X',flip_z:true},
  ]) assert.equal(Boolean(ok({document_id:'d',...a})), false, JSON.stringify(a));
  assert.equal(v({action:'list'}), false);
  assert.match(argumentError('coordinate_system',{action:'create'}), /needs an origin/);
  assert.match(argumentError('coordinate_system',{action:'delete'}), /needs name/);
});

test('v2.7: set_material by drawing name, optional database, assembly component', () => {
  const v = validate.get('sw_set_material');
  assert.equal(v({document_id:'d',material:'Hierro dúctil'}), true);
  assert.equal(v({document_id:'d',material:'Oro puro',component:'Tapon-1'}), true);
  assert.equal(v({document_id:'d',database:'SOLIDWORKS Materials',material:'AISI 1020'}), true);
  assert.equal(v({document_id:'d'}), false);
});

test('v2.8: assembly_doctor validates', () => {
  const v = validate.get('sw_assembly_doctor');
  assert.equal(v({document_id:'d'}), true);
  assert.equal(v({document_id:'d',include_dofs:false,only_problems:true}), true);
  for (const a of [{},{document_id:''},{document_id:'d',include_dofs:'true'},{document_id:'d',only_problems:1},{document_id:'d',repair:true}]) assert.equal(v(a), false);
  const t = tools.find(t => t.name === 'sw_assembly_doctor');
  assert.equal(t.operation, 'assembly_doctor');
  assert.equal(t.annotations.readOnlyHint, true);
});

test('v2.8: assembly_repair validates', () => {
  const v = validate.get('sw_assembly_repair');
  assert.equal(v({document_id:'d',action:'snapshot',name:'antes'}), true);
  assert.equal(v({document_id:'d',action:'fix_mates',apply:true,allow_suppress:true,mates:['Distancia1'],reference:'buena',tolerance_mm:0.01}), true);
  for (const a of [{document_id:'d'},{document_id:'d',action:'delete'},{document_id:'d',action:'snapshot',name:'a/b'},{document_id:'d',action:'fix_mates',mates:[]},{document_id:'d',action:'fix_mates',apply:'yes'},{document_id:'d',action:'compare',name:'x',tolerance_mm:0},{document_id:'d',action:'fix_mates',reference:'../x'}]) assert.equal(v(a), false);
  const t = tools.find(t => t.name === 'sw_assembly_repair');
  assert.equal(t.operation, 'assembly_repair');
  assert.equal(t.annotations.readOnlyHint, false);
});

test('v2.9: save allow_errors validates', () => {
  const check=validate.get('sw_save');
  assert.equal(check({document_id:'a'}),true);
  for(const allow_errors of [true,false]) assert.equal(check({document_id:'a',allow_errors,include_references:true}),true);
  for(const allow_errors of ['true',1,null,{}]) assert.equal(check({document_id:'a',allow_errors}),false);
  assert.equal(check({allow_errors:true}),false);
});

test('v2.9: keep_broken only on modifying document tools', () => {
  const byName = n => tools.find(t => t.name === n);
  assert.equal(validate.get('sw_set_dimension')({document_id:'d',name:'D1@Croquis1',value_si:0.05,keep_broken:true}), true);
  assert.equal(validate.get('sw_set_dimension')({document_id:'d',name:'D1@Croquis1',value_si:0.05,keep_broken:'si'}), false);
  assert.ok(byName('sw_mates').inputSchema.properties.keep_broken);
  for (const n of ['sw_save','sw_inspect','sw_interference','sw_mass_check','sw_close_document']) assert.equal(byName(n).inputSchema.properties.keep_broken, undefined, n);
});

import { checkSheet, evalFormula, numbersIn } from './measure_sheet.mjs';


const words = [
  { text: '80', bbox_mm: [100, 50, 104, 53] },
  { text: 'Ø8', bbox_mm: [120, 70, 124, 73] },
  { text: '2X', bbox_mm: [115, 70, 119, 73] },
  { text: '12,5', bbox_mm: [60, 90, 66, 93] },
];
const base = () => ({ part: 'Placa', units: 'mm', drawing: { path: 'x.pdf', page: 1 }, dims: [
  { id: 'largo', feature: 'largo total', kind: 'linear', value: 80, status: 'ok', source: { method: 'pdf_text', page: 1, bbox_mm: [99, 49, 105, 54], text: '80' } },
  { id: 'barreno', feature: 'barrenos', kind: 'diameter', value: 8, count: 2, status: 'ok', source: { method: 'pdf_text', bbox_mm: [114, 69, 125, 74], text: '2X Ø8' } },
  { id: 'ancho', feature: 'ancho', kind: 'linear', value: 12.5, status: 'ok', source: { method: 'pdf_text', bbox_mm: [59, 89, 67, 94] } },
] });

test('v3.0 ficha: números con coma decimal y símbolos', () => { assert.deepEqual(numbersIn('Ø12,5 x 2'), [12.5, 2]); assert.deepEqual(numbersIn('R5'), [5]); });
test('v3.0 ficha: fórmulas derivadas: solo ids y aritmética', () => {
  assert.equal(evalFormula('largo - 2*borde', { largo: 80, borde: 10 }), 60);
  assert.throws(() => evalFormula('largo + x', { largo: 1 }), /unknown/);
  assert.throws(() => evalFormula('process.exit()', {}), /unknown|invalid|sobra|no permitido/);
});
test('v3.0 ficha: ficha correcta con texto del PDF verificado', () => { const r = checkSheet(base(), new Map([[1, words]])); assert.deepEqual(r.errors, []); });
test('v3.0 ficha: valor inventado: no está en el texto del PDF de esa zona', () => {
  const s = base(); s.dims[0].value = 81; s.dims[0].source.text = '81';
  const r = checkSheet(s, new Map([[1, words]])); assert.ok(r.errors.some(e => /el PDF dice "80"/.test(e)) && r.errors.some(e => /81 no aparece/.test(e)), r.errors.join('\n'));
});
test('v3.0 ficha: zona sin texto', () => { const s = base(); s.dims[0].source.bbox_mm = [0, 0, 5, 5]; assert.ok(checkSheet(s, new Map([[1, words]])).errors.some(e => /no hay texto del PDF/.test(e))); });
test('v3.0 ficha: faltante con valor = inventado; faltante sin valor = correcto', () => {
  const s = base(); s.dims.push({ id: 'prof', feature: 'profundidad ranura', kind: 'linear', value: 5, status: 'missing' });
  assert.ok(checkSheet(s, new Map([[1, words]])).errors.some(e => /missing" pero trae valor/.test(e)));
  s.dims[3] = { id: 'prof', feature: 'profundidad ranura', kind: 'linear', status: 'missing', notes: 'no acotada en ninguna vista' };
  assert.deepEqual(checkSheet(s, new Map([[1, words]])).errors, []);
});
test('v3.0 ficha: contradicción no declarada', () => {
  const s = base(); s.dims.push({ id: 'largo2', feature: 'Largo total', kind: 'linear', value: 82, status: 'ok', source: { method: 'vision', bbox_mm: [10, 10, 20, 20] } });
  assert.ok(checkSheet(s, new Map([[1, words]])).errors.some(e => /valores distintos 80 mm vs 82 mm/.test(e)));
  s.dims[0].status = 'contradictory'; s.dims[3].status = 'contradictory'; s.dims[0].notes = s.dims[3].notes = 'vista frontal vs superior';
  assert.deepEqual(checkSheet(s, new Map([[1, words]])).errors, []);
});
test('v3.0 ficha: sin fuente o visual sin zona', () => {
  const s = base(); delete s.dims[0].source; s.dims[1].source = { method: 'vision' };
  const e = checkSheet(s, new Map([[1, words]])).errors; assert.ok(e.some(x => /sin fuente/.test(x)) && e.some(x => /debe ubicar la cota/.test(x)));
});
test('v3.0 ficha: derivada que no cuadra', () => {
  const s = base(); s.dims.push({ id: 'resto', feature: 'resto', kind: 'linear', value: 70, status: 'ok', source: { method: 'derived', formula: 'largo - ancho' } });
  assert.ok(checkSheet(s, new Map([[1, words]])).errors.some(e => /fórmula da 67.5/.test(e)));
});

test('v3.0 ficha: measure_sheet schema', () => {
  const v = validate.get('sw_measure_sheet');
  const sheet = { part: 'Placa', units: 'mm', dims: [{ id: 'a', kind: 'linear', value: 80, status: 'ok', source: { method: 'pdf_text', bbox_mm: [1, 2, 3, 4], text: '80', symbol: 'vision' } }] };
  assert.equal(v({ action: 'validate', sheet }), true);
  assert.equal(v({ action: 'compare_model', document_id: 'd', sheet }), true);
  assert.equal(v({ action: 'validate', sheet: { ...sheet, units: 'cm' } }), false);
  assert.equal(v({ action: 'validate', sheet: { ...sheet, dims: [{ id: 'a', kind: 'linear', status: 'ok', invented: 1 }] } }), false);
});
test('v3.0 ficha: borrosa sin valor es válida; con valor es error (usar uncertain)', () => {
  const s = { part: 'P', units: 'mm', dims: [{ id: 'a', feature: 'cota a', kind: 'linear', status: 'blurry', notes: 'ilegible', source: { method: 'vision', region_px: [0, 0, 10, 10] } }] };
  assert.deepEqual(checkSheet(s, null).errors, []);
  s.dims[0].value = 18;
  assert.ok(checkSheet(s, null).errors.some(e => /no inventar/.test(e)));
});

test('v3.0 ficha: bypasses que encontró Codex quedan cerrados', () => {
  const W = new Map([[1, words]]);
  const one = d => checkSheet({ part: 'P', units: 'mm', drawing: { path: 'x.pdf', page: 1 }, dims: [d] }, W).errors;
  // pdf_text solo con region_px
  assert.ok(one({ id: 'a', kind: 'linear', value: 999, status: 'ok', source: { method: 'pdf_text', region_px: [0, 0, 1, 1] } }).some(e => /necesita bbox_mm/.test(e)));
  // zona que abarca toda la hoja
  assert.ok(one({ id: 'a', kind: 'linear', value: 80, status: 'ok', source: { method: 'pdf_text', bbox_mm: [0, 0, 300, 300], text: '80' } }).some(e => /demasiado grande/.test(e)));
  // texto citado 80 pero valor 20 en una zona con ambos no basta: el texto citado debe contener el valor
  assert.ok(one({ id: 'a', kind: 'linear', value: 12.5, status: 'ok', source: { method: 'pdf_text', bbox_mm: [59, 89, 67, 94], text: '12,5' } }).length === 0);
  assert.ok(one({ id: 'a', kind: 'linear', value: 80, status: 'ok', source: { method: 'pdf_text', bbox_mm: [59, 89, 67, 94], text: '12,5' } }).some(e => /no aparece|no contiene/.test(e)));
  // chaflán: el número se verifica igual
  assert.ok(one({ id: 'a', kind: 'chamfer', value: 999, status: 'ok', source: { method: 'pdf_text', bbox_mm: [99, 49, 105, 54] } }).some(e => /999 no aparece/.test(e)));
  // página distinta a la leída
  assert.ok(one({ id: 'a', kind: 'linear', value: 80, status: 'ok', source: { method: 'pdf_text', page: 2, bbox_mm: [99, 49, 105, 54] } }).some(e => /página 2/.test(e)));
  // signos: -5 no justifica 5 salvo ±
  assert.deepEqual(numbersIn('-5'), [-5]); assert.deepEqual(numbersIn('±0.1'), [0.1, -0.1]);
});
test('v3.0 ficha: derivadas sin constantes solas, sin ciclos, con estado heredado y unidades', () => {
  const S = dims => checkSheet({ part: 'P', units: 'mm', dims }, null).errors;
  const v = (id, value, status = 'ok') => ({ id, kind: 'linear', value, status, source: { method: 'vision', region_px: [0, 0, 1, 1] }, notes: 'x' });
  assert.ok(S([{ id: 'a', kind: 'linear', value: 999, status: 'ok', source: { method: 'derived', formula: '999' } }]).some(e => /solo tiene constantes/.test(e)));
  assert.ok(S([{ id: 'a', kind: 'linear', value: 1, status: 'ok', source: { method: 'derived', formula: 'b' } }, { id: 'b', kind: 'linear', value: 1, status: 'ok', source: { method: 'derived', formula: 'a' } }]).some(e => /circulares/.test(e)));
  assert.ok(S([v('l', 80, 'uncertain'), { id: 'm', kind: 'linear', value: 40, status: 'ok', source: { method: 'derived', formula: 'l/2' } }]).some(e => /depende de l \(uncertain\)/.test(e)));
  assert.ok(S([{ ...v('l', 1), unit: 'in' }, { id: 'm', kind: 'linear', value: 1, status: 'ok', source: { method: 'derived', formula: 'l' } }]).some(e => /mezcla unidades/.test(e)));
  assert.throws(() => evalFormula('2**3', {}), /token no permitido|sobra|incompleta/);
  // 25.4 mm y 1 in del mismo elemento NO son contradicción
  assert.deepEqual(S([{ ...v('a', 25.4), feature: 'largo' }, { ...v('b', 1), feature: 'largo', unit: 'in' }]), []);
});

import { resolveIR, evalExpr, exprSW } from './part_ir.mjs';
import { readFileSync as readIR } from 'node:fs';
const placa = JSON.parse(readIR(new URL('./fixtures/ir_plate.json', import.meta.url), 'utf8'));


test('v3.1 IR: expresiones con parámetros, pi, potencia y raíz; traducción a SolidWorks', () => {
  assert.equal(evalExpr('L-e', { L: 80, e: 20 }), 60);
  assert.ok(Math.abs(evalExpr('2*pi*(D/2)^2', { D: 8 }) - 32 * Math.PI) < 1e-9);
  assert.equal(evalExpr('sqrt(9)+2^3', {}), 11);
  assert.equal(exprSW('L-2*e'), '"L"-2*"e"');
  assert.equal(exprSW('sqrt(A)'), 'sqr("A")');
  assert.throws(() => evalExpr('L+X', { L: 1 }), /desconocido "X"/);
  assert.throws(() => evalExpr('process.exit()', {}), /no permitido|sobra|desconocido/);
});
test('v3.1 IR: la placa se resuelve en pasos con números y candidatos para ligar cotas', () => {
  const r = resolveIR(placa);
  assert.deepEqual(r.errors, []);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps[0].sketch.entities[1], { kind: 'line', start_mm: [80, 0], end_mm: [80, 50] });
  assert.equal(r.steps[0].args.depth_mm, 10);
  assert.equal(r.steps[1].sketch.entities[1].center_mm[0], 60);
  assert.ok(r.steps[0].candidates.some(c => c.expr === '(L)-(0)' && c.value === 80));
  assert.ok(Math.abs(r.expect.volume_mm3 - (40000 - 2 * Math.PI * 16 * 10 - (4 - Math.PI) * 10)) < 1e-9);
  assert.deepEqual(r.expect.box_mm, [80, 10, 50]);
});
test('v3.1 IR: errores claros y sin inventar valores', () => {
  const bad = JSON.parse(JSON.stringify(placa));
  bad.features[1].sketch.entities[0].circle.d = 'Dx';
  bad.features.push({ id: 'placa', op: 'cut', sketch: { plane: 'top', entities: [{ circle: { center: [0, 0], r: 1 } }] } });
  bad.features.push({ id: 'p2', op: 'linear_pattern', of: ['nada'], count: 1, spacing: 5, axis: 'Q' });
  bad.params.Z = 'abc';
  const e = resolveIR(bad).errors.join('\n');
  for (const re of [/desconocido "Dx"/, /id repetido/, /"nada" no es una operación anterior/, /count entero/, /axis X\|Y\|Z/, /params.Z: debe ser un número/]) assert.match(e, re);
  assert.match(resolveIR({ ...placa, features: [placa.features[1]] }).errors.join(), /primera operación sólida debe crear material/);
});

test('v3.1 IR: part_build schema', () => {
  const v = validate.get('sw_part_build');
  assert.equal(v({ action: 'check', ir: placa }), true);
  assert.equal(v({ action: 'build', ir: placa, flex_test: { pct: 0.05 } }), true);
  assert.equal(v({ action: 'edit', document_id: 'd', ir: placa, params: { L: 100 } }), true);
  assert.equal(v({ action: 'edit', document_id: 'd', ir: placa, params: { L: '100' } }), false);
  assert.equal(v({ action: 'build', ir: placa, flex_test: { pct: 2 } }), false);
});

test('v3.2: coordinate_system axes and circle_center', () => {
  const v = validate.get('sw_coordinate_system');
  assert.equal(v({ document_id: 'd', action: 'create', local_point_mm: [1, 2, 3], component: 'TUBO-1', kind: 'circle_center', axes: { x: [0, 1, 0], y: [-1, 0, 0] } }), true);
  assert.equal(v({ document_id: 'd', action: 'create', point_mm: [0, 0, 0], axes: { x: [0, 1, 0] } }), false);
  assert.equal(v({ document_id: 'd', action: 'create', point_mm: [0, 0, 0], axes: { x: [0, 1, 0], y: [1, 0, 0], z: [0, 0, 1] } }), false);
});
test('v3.1 IR: huella de expresiones y distancias entre puntos', async () => {
  const { fingerprint } = await import('./part_ir.mjs');
  const P = { L: 80, W: 50, e: 20 };
  assert.equal(fingerprint('L', P), fingerprint('(L)-(0)', P));
  assert.equal(fingerprint('L-2*e', P), fingerprint('(L-e)-(e)', P));
  assert.notEqual(fingerprint('L-e', P), fingerprint('W+10', P)); // 60 = 60 hoy, pero no son la misma función
  const r = resolveIR(placa);
  assert.ok(r.steps[1].candidates.some(c => c.value === 40 && fingerprint(c.signed, r.params) === fingerprint('L-2*e', r.params)), 'la cota de 40 entre barrenos tiene candidato L-2e');
});

test('v3.3: DXF: textos con códigos, cotas recalculadas de su geometría y bloques insertados', async () => {
  const { dxfText, dxfEvidence } = await import('./dxf.mjs');
  assert.equal(dxfText('%%c6.00 POR TODO'), 'Ø6.00 POR TODO');
  assert.equal(dxfText('{\\fArial|b0;\\H2.5;30%%d}\\P±0.1'), '30° ±0.1');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = new URL('./generated/drawing_read/', import.meta.url); mkdirSync(dir, { recursive: true });
  const f = new URL('test_v33.dxf', dir);
  const L = (...a) => a.join('\n');
  writeFileSync(f, L('0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '9', '$EXTMIN', '10', '0', '20', '0', '9', '$EXTMAX', '10', '200', '20', '100', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'HOLE', '0', 'MTEXT', '10', '0', '20', '0', '40', '3', '1', '%%c8.00 POR TODO', '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '5', 'A1', '2', '*D1', '10', '0', '20', '20', '11', '40', '21', '20', '70', '160', '1', '<>', '13', '10', '23', '10', '14', '90', '24', '10', '50', '0',
    '0', 'DIMENSION', '5', 'A2', '2', '*D2', '10', '50', '20', '50', '11', '60', '21', '60', '70', '163', '1', '25', '15', '100', '25', '50',
    '0', 'INSERT', '2', 'HOLE', '10', '120', '20', '30', '41', '1', '42', '1', '50', '0', '0', 'ENDSEC', '0', 'EOF'));
  const r = dxfEvidence(f);
  assert.equal(r.units, 'mm');
  assert.deepEqual(r.dimensions.map(d => [d.kind, d.measured_from_geometry]), [['linear', 80], ['diameter', 50]]);
  assert.ok(r.warnings.some(w => /sustituido a mano "25"/.test(w)), 'la cota cuyo texto dice 25 pero mide 50 se denuncia');
  assert.ok(r.words.some(w => w.text === 'Ø8.00' && w.source === 'INSERT:HOLE'));
  const v = validate.get('sw_drawing_read');
  assert.equal(v({ path: 'C:\\planos\\p.dxf', action: 'text' }), true);
});

test('v3.9: DXF: geometría por tipo de línea, vistas, DIMLFAC, cotas exactas en coordenadas de pieza y dibujo', async () => {
  const { dxfDimensions, lineClass } = await import('./dxf_geometry.mjs');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const { drawingRead } = await import('./drawing_read.mjs');
  assert.equal(lineClass('HIDDEN2'), 'hidden'); assert.equal(lineClass('CENTERX2'), 'center'); assert.equal(lineClass('PHANTOM'), 'phantom'); assert.equal(lineClass('Continuous'), 'visible');
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('./generated/drawing_read/', import.meta.url)); mkdirSync(dir, { recursive: true });
  const f = dir + 'test_v39.dxf', L = (...a) => a.join('\n');
  const line = (x1, y1, x2, y2, lt = 'Continuous') => ['0', 'LINE', '8', '0', '6', lt, '10', x1, '20', y1, '11', x2, '21', y2];
  const rect = (x0, y0, x1, y1) => [...line(x0, y0, x1, y0), ...line(x1, y0, x1, y1), ...line(x1, y1, x0, y1), ...line(x0, y1, x0, y0)];
  writeFileSync(f, L('0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '9', '$EXTMIN', '10', '0', '20', '0', '9', '$EXTMAX', '10', '200', '20', '100', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'DIMSTYLE', '0', 'DIMSTYLE', '2', 'S2', '144', '2.0', '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '0', 'LAYER', '2', 'OCULTAS', '6', 'HIDDEN', '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...rect(10, 50, 60, 80), '0', 'CIRCLE', '8', '0', '10', '35', '20', '65', '40', '5',
    '0', 'LINE', '8', 'OCULTAS', '10', '10', '20', '60', '11', '60', '21', '60',
    // second view: a rounded slot as LWPOLYLINE with bulges
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1', '10', '120', '20', '50', '10', '160', '20', '50', '42', '1', '10', '160', '20', '70', '10', '120', '20', '70', '42', '1',
    '0', 'DIMENSION', '5', 'B1', '2', '*D1', '3', 'S2', '10', '0', '20', '45', '11', '35', '21', '45', '70', '32', '1', '<>', '13', '10', '23', '50', '14', '60', '24', '50', '50', '0',
    '0', 'DIMENSION', '5', 'B2', '2', '*D2', '3', 'S2', '10', '35', '20', '65', '11', '45', '21', '75', '70', '36', '1', 'R10', '15', '40', '25', '65',
    '0', 'ENDSEC', '0', 'EOF'));
  const r = dxfDimensions(f);
  assert.equal(r.views.length, 2, 'dos vistas separadas');
  assert.ok(r.geometry.segments.some(s => s[4] === 'hidden'), 'la línea en la capa OCULTAS es oculta');
  const lin = r.dimensions.find(d => d.handle === 'B1');
  assert.equal(lin.value, 100, 'medida en hoja 50 x DIMLFAC 2'); assert.equal(lin.view, 1); assert.equal(lin.direction, 'horizontal');
  assert.deepEqual(lin.from_part_mm, [0, 0]); assert.deepEqual(lin.to_part_mm, [100, 0]); assert.equal(lin.scale_used, 0.5); assert.equal(lin.scale_ok, true);
  const rad = r.dimensions.find(d => d.handle === 'B2');
  assert.equal(rad.kind, 'radius'); assert.equal(rad.value, 10); assert.deepEqual(rad.center_part_mm, [50, 30]);
  assert.equal(r.views[0].scale, 0.5); assert.equal(r.views[1].scale, 0.5, 'la vista sin cotas toma la escala más común');
  const ev = (await import('./dxf.mjs')).dxfEvidence(f);
  assert.equal(ev.dimensions.find(d => d.handle === 'B1').value_mm, 100, 'text también aplica DIMLFAC');
  const out = dir + 'test_v39_cotas.png', dd = await drawingDimensions({ path: f, out_png: out });
  assert.equal(dd.format, 'dxf'); assert.equal(dd.dimensions.length, 2); assert.ok(existsSync(out));
  const pic = await drawingRead({ path: f, action: 'render', width_px: 600 }); assert.ok(existsSync(pic.path)); assert.equal(pic.format, 'dxf');
});

test('recipes as MCP resources: one per file of server/recipes, read-only, nothing outside', async () => {
  const { resourceList, readRecipe } = await import('./recipes.mjs');
  const list = resourceList();
  assert.ok(list.length >= 4 && list.every(r => r.uri.startsWith('solidworks://recipe/') && r.name && r.description));
  const r = await readRecipe('solidworks://recipe/assembly-from-drawing');
  assert.match(r.contents[0].text, /center of mass/i);
  await assert.rejects(() => readRecipe('solidworks://recipe/../../secret'), /Unknown recipe/);
  await assert.rejects(() => readRecipe('file:///C:/Windows/win.ini'), /Unknown recipe/);
});

test('v3.4: document_units', () => {
  const v = validate.get('sw_document_units');
  assert.equal(v({ document_id: 'd', action: 'set', mass_length: 'in', mass: 'lb', volume: 'mm3', decimals: 4 }), true);
  assert.equal(v({ document_id: 'd', action: 'get' }), true);
  assert.equal(v({ document_id: 'd', action: 'set', mass: 'libras' }), false);
});

test('v3.5: feature_info (solo lectura) y sketch_plane', () => {
  const fi = validate.get('sw_feature_info');
  assert.equal(fi({ document_id: 'd', name: 'Croquis15' }), true);
  assert.equal(fi({ document_id: 'd' }), false);
  const sp = validate.get('sw_sketch_plane');
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15', coplanar_from: 'Alzado' }), true);
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15', face_of_sketch: 'Croquis8' }), true);
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15', plane: 'Planta', keep_broken: false }), true);
  assert.equal(sp({ document_id: 'd', sketch: '' }), false);
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15', face_reference: 'r1' }), true);
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15' }), false, 'sin destino');
  assert.equal(sp({ document_id: 'd', sketch: 'Croquis15', plane: 'Planta', coplanar_from: 'Alzado' }), false, 'dos destinos');
  const t = tools.find(x => x.name === 'sw_sketch_plane');
  assert.ok(!('oneOf' in t.inputSchema) && !('anyOf' in t.inputSchema) && !('allOf' in t.inputSchema), 'el esquema publicado no lleva oneOf arriba');
  assert.ok(tools.every(x => !['oneOf', 'anyOf', 'allOf'].some(k => k in x.inputSchema)), 'ninguna herramienta publica oneOf/anyOf/allOf arriba');
  assert.equal(tools.find(x => x.name === 'sw_feature_info').annotations.readOnlyHint, true);
  assert.equal(t.annotations.readOnlyHint, false);
  assert.ok('keep_broken' in t.inputSchema.properties);
});

test('v3.5: copy_renamed', () => {
  const v = validate.get('sw_copy_renamed');
  assert.equal(v({ path: 'C:\\x\\a.SLDASM', folder_name: 'prueba', prefix: 'p_' }), true);
  assert.equal(v({ path: 'C:\\x\\a.SLDASM', folder_name: '..\\fuera' }), false);
  assert.equal(v({ path: 'C:\\x\\a.SLDASM', folder_name: 'ok', prefix: 'a/b' }), false);
  assert.equal(v({ folder_name: 'ok' }), false);
});

test('v3.5: extrude_edit', () => {
  const v = validate.get('sw_extrude_edit');
  assert.equal(v({ document_id: 'd', name: 'Saliente-Extruir1', end_condition: 'blind', depth_mm: 1.6, reverse: false }), true);
  assert.equal(v({ document_id: 'd', name: 'Saliente-Extruir1', end_condition: 'up_to_body' }), false);
  assert.equal(v({ document_id: 'd', name: 'Saliente-Extruir1', depth_mm: 0 }), false);
  assert.ok('keep_broken' in tools.find(x => x.name === 'sw_extrude_edit').inputSchema.properties);
});

test('v3.6: tolerancia 0.5 % en mass_check', () => {
  const v = validate.get('sw_mass_check');
  assert.equal(v({ document_id: 'd', reference: { mass: 17.2229, center_of_mass: [0.395, 0.011, -1.4189] }, length_units: 'in', mass_units: 'lb', com_tolerance_percent: 0.5 }), true);
  assert.equal(v({ document_id: 'd', com_tolerance_percent: 0 }), false);
  assert.match(tools.find(t => t.name === 'sw_mass_check').description, /default 0\.5/);
});

test('v3.6: session_health', () => {
  const v = validate.get('sw_session_health');
  assert.equal(v({}), true);
  assert.equal(v({ action: 'cleanup' }), true);
  assert.equal(v({ action: 'close_all' }), false);
});

test('v3.6: instance', () => {
  const v = validate.get('sw_instance');
  for (const action of ['status', 'start', 'show', 'minimize', 'use_shared', 'stop']) assert.equal(v({ action }), true);
  assert.equal(v({ action: 'kill' }), false);
});

test('v3.6: drawing_read analyze (vistas por su nombre, sin SolidWorks)', async () => {
  const { detectViews } = await import('./drawing_analyze.mjs');
  const w = (text, x, y, h = 2.5) => ({ text, bbox_mm: [x, y, x + text.length * h * 0.6, y + h], font_size_mm: h, angle_deg: 0 });
  // two views stacked: TUBO label at y=80 (its dims above it), EJE label at y=200 (its dims between both labels)
  const words = [w('TUBO', 40, 80, 8), w('EJE', 45, 200, 8), w('49.43', 30, 40), w('100.00', 70, 50), w('14.28', 35, 150), w('65.10', 80, 170), w('NOTA', 300, 260)];
  const v = detectViews(words, [420, 297]);
  assert.deepEqual(v.map(x => x.name), ['TUBO', 'EJE']);
  assert.deepEqual(v[0].words.map(x => x.text).sort(), ['100.00', '49.43']);
  assert.deepEqual(v[1].words.map(x => x.text).sort(), ['14.28', '65.10']);
  assert.ok(v.every(x => x.region_mm.every(Number.isFinite)));
  const t = tools.find(x => x.name === 'sw_drawing_read');
  assert.ok(t.inputSchema.properties.action.enum.includes('analyze'));
  assert.equal(validate.get('sw_drawing_read')({ path: 'C:\\x\\plano.pdf', action: 'analyze' }), true);
});

test('v3.6: etiquetas de varias palabras, secciones y texto chico (revisión de Codex)', async () => {
  const { detectViews } = await import('./drawing_analyze.mjs');
  const w = (text, x, y, h = 2.5) => ({ text, bbox_mm: [x, y, x + text.length * h * 0.6, y + h], font_size_mm: h, angle_deg: 0 });
  const words = [w('TAPA', 40, 80, 8), w('SUPERIOR', 70, 80, 8), w('A-A', 200, 80, 8), w('EJE', 45, 200, 8), w('CUERPO', 300, 200, 2.5),
    w('49.43', 30, 40), w('100.00', 70, 50), w('14.28', 35, 150), w('65.10', 80, 170)];
  const v = detectViews(words, [420, 297]);
  assert.deepEqual(v.map(x => x.name), ['TAPA SUPERIOR', 'EJE'], 'una etiqueta de dos palabras; A-A no es pieza; texto chico no es etiqueta');
  assert.deepEqual(v[0].words.map(x => x.text).sort(), ['100.00', '49.43']);
});


const assemblyPlan = () => ({
  ir: 'assembly-ir/1', name: 'fixture',
  components: [{ id: 'base-1', file: 'base.SLDPRT', fixed: true }, { id: 'eje-1', file: 'eje.SLDPRT', position_mm: [1, 2, 3] }],
  mates: [{ name: 'apoyo', type: 'coincident', align: 'aligned', flip: false, entities: [{ component: 'base-1', plane: 'Alzado' }, { component: 'eje-1', local_point_mm: [2, 3, 4], kind: 'face' }] }],
  coordinate_systems: [{ name: 'Origen del plano', origin_mm: [1, 2, 3], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }],
  units: { mass_length: 'in', mass: 'lb', volume: 'mm3', decimals: 4 }, expect: {},
});

test('v3.7: assembly_export schema es de lectura y exige document_id', () => {
  const t = tools.find(t => t.name === 'sw_assembly_export'), v = validate.get(t.name);
  assert.equal(v({ document_id: 'asm' }), true);
  for (const a of [{}, { document_id: '' }, { document_id: 'asm', keep_broken: true }, { document_id: 'asm', path: 'x' }]) assert.equal(v(a), false);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.equal(t.inputSchema.properties.keep_broken, undefined);
});

test('v3.7: assembly_build esquema publica objeto sin combinadores en la raiz', () => {
  const t = tools.find(t => t.name === 'sw_assembly_build'), v = validate.get(t.name);
  assert.equal(v({ action: 'check', plan: assemblyPlan() }), true);
  assert.equal(v({ action: 'build', batch: false, plan: assemblyPlan(), parts_dir: 'C:\\piezas', continue_on_error: true }), true);
  for (const a of [{ action: 'build', batch: false, plan: assemblyPlan() }, { action: 'other', plan: {} }, { action: 'check' }, { action: 'check', plan: [] }, { action: 'check', plan: {}, tolerance_percent: 0 }, { action: 'check', plan: {}, keep_broken: true }]) assert.equal(v(a), false);
  assert.equal(t.annotations.readOnlyHint, false);
  for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(key in t.inputSchema, false);
  assert.match(t.description, /assembly-ir\/1/);
  assert.match(t.description, /interferences_mm3/);
  assert.equal(validate.get('sw_insert_component')({ document_id: 'd', path: 'C:\\base.SLDPRT', transform: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], configuration: 'Default' }), true);
});

test('v3.7: assemblyBuild check valido no llama al worker ni escribe archivos', async () => {
  const r = await assemblyBuild({ action: 'check', plan: assemblyPlan() }, { worker: { call() { assert.fail('check llam? al worker'); } } });
  assert.equal(r.ok, true); assert.equal(r.verdict, 'checked'); assert.deepEqual(r.errors, []);
});

test('v3.7: check detecta componente inexistente, falta de entidades y distance_mm', async () => {
  for (const [change, pattern] of [
    [p => p.mates[0].entities[0].component = 'no-existe', /componente inexistente/],
    [p => delete p.mates[0].entities, /entities/],
    [p => p.mates[0].entities = [], /entities/],
    [p => p.mates[0].type = 'distance', /distance_mm/],
    [p => p.components.push({ ...p.components[0] }), /repetido/],
  ]) {
    const plan = assemblyPlan(); change(plan);
    const r = await assemblyBuild({ action: 'check', plan });
    assert.equal(r.ok, false); assert.match(r.errors.join(';'), pattern);
  }
});

test('v3.7: check cubre cardinalidad, valores, transformaciones, ejes y expectativas', () => {
  for (const [type, n] of Object.entries({ coincident: 2, concentric: 2, distance: 2, parallel: 2, perpendicular: 2, angle: 2, symmetric: 3, width: 4, screw: 2, tangent: 2 })) {
    const p = assemblyPlan(); const m = p.mates[0];
    Object.assign(m, { type, entities: Array.from({ length: n }, () => ({ component: 'base-1', plane: 'Planta' })), distance_mm: 10, angle_deg: 20, pitch_mm: 2 });
    assert.equal(checkAssemblyPlan(p).ok, true, type);
    m.entities.pop(); assert.equal(checkAssemblyPlan(p).ok, false, type);
  }
  for (const change of [
    p => p.mates[0].align = 'bad', p => p.mates[0].type = 'unsupported',
    p => p.mates[0].entities[0] = { kind: 'unsupported', reason: 'eje' },
    p => p.components[0].transform = [1], p => p.components[0].fixed = 'true',
    p => p.components[0].file = '..\\base.SLDPRT', p => p.name = '..',
    p => p.coordinate_systems[0].y_axis = [1, 0, 0],
    p => p.expect = { com: [{ coordinate_system: '#2', value: [0,0,0], length_units: 'mm' }] },
    p => p.expect = { mass: { value: NaN, units: 'g' } },
    p => p.expect = { interferences_mm3: [Infinity] },
  ]) { const p = assemblyPlan(); change(p); assert.equal(checkAssemblyPlan(p).ok, false); }
  for (const p of [null, {}, { ...assemblyPlan(), components: null }, { ...assemblyPlan(), mates: null }, { ...assemblyPlan(), coordinate_systems: {} }]) assert.equal(checkAssemblyPlan(p).ok, false);
  const p = assemblyPlan(); p.mates[0].align = 'closest'; assert.match(checkAssemblyPlan(p).warnings.join(';'), /closest/);
  delete p.mates[0].align; assert.equal(checkAssemblyPlan(p).ok, true); assert.ok(checkAssemblyPlan(p).warnings.length);
});

test('v3.7: interferencias son multiconjunto con tolerancia 1 % o 0.05 mm3', () => {
  assert.deepEqual(compareInterferences([207.8, 10.04, 207.79], [207.79, 207.79, 10]), []);
  assert.deepEqual(compareInterferences([0.96, 1.03], [1, 0.92]), [], 'reasigna coincidencias solapadas');
  assert.deepEqual(compareInterferences([0.05], [0]), []);
  assert.equal(compareInterferences([100, 100], [100]).length, 1);
  assert.equal(compareInterferences([100], [100, 100])[0].quantity, 'interference_missing_mm3');
  assert.equal(compareInterferences([100], [102]).length, 2);
  assert.deepEqual(compareInterferences([], []), []);
  assert.throws(() => compareInterferences([NaN], []), /finitos/);
});

async function assemblyFixture() {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const generated = fileURLToPath(new URL('./generated/', import.meta.url)); fs.mkdirSync(generated, { recursive: true });
  const root = fs.mkdtempSync(path.join(generated, 'assembly-test-')), parts_dir = path.join(root, 'parts'); fs.mkdirSync(parts_dir);
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true })); // mock fixtures only; don't leave them in generated/
  for (const file of ['base.SLDPRT', 'eje.SLDPRT']) fs.writeFileSync(path.join(parts_dir, file), 'mock CAD file; never opened');
  return { root, parts_dir, fs, path };
}
function assemblyWorker(overrides = {}) {
  const calls = [], holds = []; let inserts = 0, mates = 0, systems = 0, suppressed = 0;
  const worker = { async call(op, a, options) {
    if (op === 'fast_hold') { holds.push(a.on); return { ok: true, result: { fast_hold: a.on } }; }   // v3.8: infrastructure, not part of the call order
    calls.push({ op, a, options });
    const custom = overrides[op]; if (custom) { const result = await custom(a, calls); if (result !== undefined) return result; }
    const results = {
      environment: () => ({ default_assembly_template: 'C:\\templates\\a.asmdot' }),
      assembly_new: () => ({ document_id: 'built' }),
      insert_component: () => ({ component: `real-${++inserts}`, fixed_position: a.fixed }),
      add_mate: () => ({ mate: `Coincidente${++mates}`, error_code: 0, moved_components: [{ component: 'real-2', origin_mm: [1, 2, 3] }] }),
      coordinate_system: () => ({ coordinate_system: `Sistema de coordenadas${++systems}`, verified: true }),
      document_units: () => ({ set: true }), save: () => ({ saved: true }), inspect: () => ({ components: [] }),   // v3.14 posture
      mates: () => { if (a.action === 'suppress') { suppressed++; return {}; } return { mate_count: mates, errors: 0, warnings: 0, suppressed }; },
      assembly_doctor: () => ({ summary: { complete: true, missing_entries: 0, mate_errors: 0, over_defined: 0, whats_wrong_count: 0, free_components: 1 } }),
      mass_check: () => ({ mass: 100, center_of_mass: [1, 2, 3], coordinate_system: a.coordinate_system ?? 'model origin', units: { mass: a.mass_units, length: a.length_units }, warnings: [] }),
      interference: () => ({ interference_count: 2, pairs: [{ volume_mm3: 10.04 }, { volume_mm3: 20 }], pairs_truncated: false, components_repositioned_and_restored: 0, components_not_restored: [], save_blocked: false }),
    };
    assert.ok(results[op], `op inesperada ${op}`); return { ok: true, result: results[op]() };
  } };
  return { worker, calls, holds };
}

test('v3.7: build traduce ids, conserva orden/transform/config y no guarda tras interferencias', async () => {
  const f = await assemblyFixture(), { worker, calls, holds } = assemblyWorker(), plan = assemblyPlan();
  plan.components[0].transform = [0,1,0,-1,0,0,0,0,1,0.1,0.2,0.3,1,0,0,0]; plan.components[0].configuration = 'Config2';
  plan.mates.push({ name: 'distancia', type: 'distance', distance_mm: 4, align: 'anti_aligned', flip: true, suppressed: true, entities: [{ component: 'eje-1', plane: 'Planta' }, { assembly_plane: 'Planta' }] });
  plan.coordinate_systems.push({ origin_mm: [4, 5, 6], x_axis: [0, 1, 0], y_axis: [-1, 0, 0] });
  plan.expect = { mates: 2, mass: { value: 100, units: 'g' }, com: [{ coordinate_system: 'Origen del plano', value: [1, 2, 3], length_units: 'mm' }, { coordinate_system: '#2', value: [1, 2, 3], length_units: 'in' }], interferences_mm3: [20, 10] };
  const ctrl = new AbortController();
  const r = await assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir }, { worker, root: f.root, signal: ctrl.signal });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.verdict, 'pass');
  assert.equal(r.path, f.path.join(f.root, 'assemblies', 'fixture.SLDASM'));
  assert.equal(calls.at(-1).op, 'interference');
  assert.deepEqual(holds, [true, false], 'fast_hold se pone al empezar y se suelta al final');
  const saved = calls.findIndex(c => c.op === 'save'); assert.equal(calls.slice(saved + 1).some(c => c.op === 'save'), false);
  assert.deepEqual(calls.filter(c => c.op === 'add_mate').map(c => c.a.entities[0].component), ['real-1', 'real-2']);
  const mate = calls.filter(c => c.op === 'add_mate')[1].a; assert.equal(mate.align, 'anti_aligned'); assert.equal(mate.flip, true); assert.equal(mate.distance_mm, 4); assert.equal(mate.name, undefined);
  const inserted = calls.find(c => c.op === 'insert_component').a; assert.deepEqual(inserted.transform, plan.components[0].transform); assert.equal(inserted.configuration, 'Config2');
  const cs = calls.filter(c => c.op === 'coordinate_system'); assert.ok(cs.every(c => c.a.name === undefined)); assert.deepEqual(cs[0].a.axes, { x: [1,0,0], y: [0,1,0] });
  assert.deepEqual(calls.filter(c => c.op === 'mass_check').map(c => c.a.coordinate_system), ['Sistema de coordenadas1', 'Sistema de coordenadas2']);
  assert.equal(r.verification.mass_checks.length, 2); assert.equal(r.moved_components.length, 2);
  assert.ok(calls.every(c => c.options.signal === ctrl.signal));
  for (const v of Object.values(r.timings_ms)) assert.ok(Number.isFinite(v) && v >= 0);
  assert.deepEqual(calls.map(c => c.op), ['environment','assembly_new','insert_component','insert_component','add_mate','add_mate','mates','coordinate_system','coordinate_system','document_units','save','mates','inspect','assembly_doctor','mass_check','mass_check','session_health','interference']);
  assert.deepEqual(calls.find(c => c.op === 'session_health').a, { action: 'cleanup' }); // v3.11: leftovers closed before the last check
});

test('v3.7: primer mate fallido detiene build y conserva diagnostico de movimientos previos', async () => {
  const f = await assemblyFixture(), plan = assemblyPlan();
  plan.mates.push({ ...plan.mates[0], name: 'fallo' });
  let n = 0; const { worker, calls } = assemblyWorker({ add_mate: () => ++n === 2 ? { ok: false, error: 'cannot satisfy', safe_edit: { automatic_rollback: true, rollback_verified: true } } : undefined });
  const r = await assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir }, { worker, root: f.root });
  assert.equal(r.ok, false); assert.equal(r.failures[0].index, 1); assert.equal(r.failures[0].name, 'fallo'); assert.match(r.failures[0].error, /cannot satisfy/);
  assert.equal(r.moved_components.length, 1); assert.equal(calls.at(-1).op, 'add_mate'); assert.equal(calls.some(c => c.op === 'save'), false);
});

test('v3.7: continue_on_error sigue con errores conocidos y nunca entrega pass', async () => {
  const f = await assemblyFixture(), plan = assemblyPlan(); plan.mates.push({ ...plan.mates[0], name: 'fallo' }, { ...plan.mates[0], name: 'tercero' });
  let n = 0; const { worker, calls } = assemblyWorker({ add_mate: () => ++n === 2 ? { ok: false, error: 'no solution', safe_edit: { rollback_verified: true } } : undefined });
  const r = await assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir, continue_on_error: true }, { worker, root: f.root });
  assert.equal(r.ok, false); assert.equal(r.failures[0].index, 1); assert.equal(calls.filter(c => c.op === 'add_mate').length, 3); assert.equal(calls.at(-1).op, 'interference');
  assert.ok(r.differences.some(d => d.quantity === 'mates'));
});

test('v3.7: cancelacion, timeout y recuperacion desconocida detienen incluso continue_on_error', async () => {
  for (const failure of [() => { throw new Error('timeout UNKNOWN'); }, () => ({ ok: false, error: 'restore failed', safe_edit: { save_blocked: true, rollback_verified: false } })]) {
    const f = await assemblyFixture(), { worker, calls } = assemblyWorker({ add_mate: failure });
    const r = await assemblyBuild({ action: 'build', batch: false, plan: assemblyPlan(), parts_dir: f.parts_dir, continue_on_error: true }, { worker, root: f.root });
    assert.equal(r.ok, false); assert.equal(r.failures[0].outcome_unknown, true); assert.equal(calls.at(-1).op, 'add_mate');
  }
  const f = await assemblyFixture(), { worker, calls } = assemblyWorker(), ctrl = new AbortController(); ctrl.abort();
  const r = await assemblyBuild({ action: 'build', batch: false, plan: assemblyPlan(), parts_dir: f.parts_dir }, { worker, root: f.root, signal: ctrl.signal });
  assert.equal(r.ok, false); assert.equal(calls.length, 0);
});

test('v3.7: diferencias de masa/CM, mates, doctor e interferencias se reportan sin guardar despues', async () => {
  const f = await assemblyFixture(), plan = assemblyPlan();
  plan.expect = { mass: { value: 99, units: 'g' }, com: [{ coordinate_system: '#1', value: [1, 2, 4], length_units: 'mm' }], interferences_mm3: [20, 20] };
  const { worker, calls } = assemblyWorker({ assembly_doctor: () => ({ ok: true, result: { summary: { complete: false, mate_errors: 1 }, read_errors: ['missing'] } }) });
  const r = await assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir }, { worker, root: f.root });
  for (const quantity of ['assembly_doctor','mass','com.#1.z','interference_missing_mm3','interference_extra_mm3']) assert.ok(r.differences.some(d => d.quantity === quantity), quantity);
  assert.equal(r.ok, false); assert.equal(calls.at(-1).op, 'interference');
});

test('v3.7: tolerancias mass/CM y detecci?n incompleta o con movimiento nunca dan falso pass', async () => {
  const f = await assemblyFixture(), plan = assemblyPlan();
  plan.expect = { mass: { value: 100.4, units: 'g' }, com: [{ coordinate_system: '#1', value: [1.04, 2, 3], length_units: 'mm' }] };
  const { worker } = assemblyWorker();
  const good = await assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir }, { worker, root: f.root }); assert.equal(good.ok, true, JSON.stringify(good));
  for (const result of [{ interference_count: 1001, pairs: [], pairs_truncated: true }, { interference_count: 0, pairs: [], save_blocked: true, components_repositioned_and_restored: 1 }, { interference_count: 0, pairs: [], components_not_restored: ['real-1'] }]) {
    const fixture = await assemblyFixture(), mock = assemblyWorker({ interference: () => ({ ok: true, result }) });
    const r = await assemblyBuild({ action: 'build', batch: false, plan: assemblyPlan(), parts_dir: fixture.parts_dir }, { worker: mock.worker, root: fixture.root });
    assert.equal(r.ok, false); assert.equal(mock.calls.at(-1).op, 'interference');
  }
});

test('v3.7: no sobrescribe, rechaza piezas ausentes y no usa rutas absolutas del export', async () => {
  const f = await assemblyFixture(), mock = assemblyWorker(); f.fs.mkdirSync(f.path.join(f.root, 'assemblies'));
  const target = f.path.join(f.root, 'assemblies', 'fixture.SLDASM'); f.fs.writeFileSync(target, 'existing assembly');
  const r = await assemblyBuild({ action: 'build', batch: false, plan: assemblyPlan(), parts_dir: f.parts_dir }, { worker: mock.worker, root: f.root });
  assert.equal(r.ok, false); assert.equal(mock.calls.length, 0); assert.equal(f.fs.readFileSync(target, 'utf8'), 'existing assembly');
  const p = assemblyPlan(); p.components[0].file = 'ausente.SLDPRT'; p.components[0].path = 'C:\\otro\\base.SLDPRT';
  const r2 = await assemblyBuild({ action: 'build', batch: false, plan: p, parts_dir: f.parts_dir }, { worker: mock.worker, root: f.root }); assert.equal(r2.ok, false); assert.equal(mock.calls.length, 0);
});

test('v3.7: intenciones y caras por descripción (sin SolidWorks)', async () => {
  const { expandIntents, checkAssemblyPlan } = await import('./assembly_build.mjs');
  const plan = { ir: 'assembly-ir/1', name: 'eje_en_bloque', components: [{ id: 'B', file: 'bloque.SLDPRT', fixed: true }, { id: 'E', file: 'eje.SLDPRT' }],
    mates: [{ intent: 'insert', shaft: { component: 'E', diameter_mm: 10 }, hole: { component: 'B', diameter_mm: 10 }, seat: { a: { component: 'E', normal: [0, 0, -1] }, b: { component: 'B', normal: [0, 0, 1] } } }] };
  const x = expandIntents(plan);
  assert.equal(x.mates.length, 2);
  assert.deepEqual(x.mates.map(m => [m.type, m.align]), [['concentric', 'aligned'], ['coincident', 'anti_aligned']]);
  assert.equal(x.mates[0].entities[0].find.kind, 'cylinder');
  assert.equal(checkAssemblyPlan(plan).errors.length, 0);
  const bad = { ...plan, mates: [{ intent: 'coaxial', a: { component: 'E', diameter_mm: -1 }, b: { component: 'Z', diameter_mm: 5 } }] };
  const r = checkAssemblyPlan(bad);
  assert.ok(r.errors.some(e => /diameter_mm/.test(e)) && r.errors.some(e => /inexistente Z/.test(e)));
  assert.equal(validate.get('sw_find_faces')({ document_id: 'd', component: 'EJE-1', kind: 'cylinder', diameter_mm: 14.28 }), true);
});

test('v3.7: find_origin ordena orígenes candidatos por el CM (24 orientaciones)', async () => {
  const { orientations, rankOrigins } = await import('./find_origin.mjs');
  assert.equal(orientations().length, 24);
  // CM at (10, 20, 30) mm; true origin (0, 0, 25.4) with X=+Y, Y=+Z, Z=+X -> CM rel = (20, 4.6, 10) mm
  const r = rankOrigins([10, 20, 30], [{ source: 'a', point_mm: [0, 0, 0] }, { source: 'b', point_mm: [0, 0, 25.4] }], [20 / 25.4, 4.6 / 25.4, 10 / 25.4], 'in');
  assert.equal(r[0].source, 'b'); assert.deepEqual(r[0].axes.X, [0, 1, 0]); assert.ok(r[0].error < 1e-9);
  assert.equal(validate.get('sw_find_origin')({ document_id: 'd', center_of_mass: [0.395, 0.011, -1.4189], create: true }), true);
});

test('v3.7: repeticiones (count y repeat con # e index #)', async () => {
  const { expandIntents, checkAssemblyPlan } = await import('./assembly_build.mjs');
  const plan = { ir: 'assembly-ir/1', name: 'placa_tornillos', components: [{ id: 'P', file: 'placa.SLDPRT', fixed: true }, { id: 'T', file: 'tornillo.SLDPRT', count: 6 }],
    mates: [{ intent: 'insert', repeat: 6, shaft: { component: 'T#', diameter_mm: 8 }, hole: { component: 'P', diameter_mm: 8, index: '#' } }] };
  const x = expandIntents(plan);
  assert.deepEqual(x.components.map(c => c.id), ['P', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  assert.equal(x.mates.length, 6);
  assert.equal(x.mates[3].entities[0].component, 'T4'); assert.equal(x.mates[3].entities[1].find.index, 3);
  assert.equal(checkAssemblyPlan(plan).errors.length, 0);
});

test('v3.7: assembly_draft lee la tabla de piezas y las líneas clave', async () => {
  const { parseTable, parseExpect } = await import('./assembly_draft.mjs');
  const rows = parseTable(['1 BRAZO 1 TITANIO 97.92', 'B B 2 CUERPO 1 HIERRO DÚCTIL 1334.64', '4 PLATO 1', 'ALEACIÓN', 'DE', 'MAGNESIO', '5.88', '7 TUBO 2 AISI 304 3076.88']);
  assert.deepEqual(rows.map(r => [r.name, r.quantity, r.material, r.mass]), [['BRAZO', 1, 'TITANIO', 97.92], ['CUERPO', 1, 'HIERRO DÚCTIL', 1334.64], ['PLATO', 1, 'ALEACIÓN DE MAGNESIO', 5.88], ['TUBO', 2, 'AISI 304', 3076.88]]);
  const ex = parseExpect(['Interferencia 1: 207.79 mm^3', 'Masa = 17.2229 libras', 'Centro de masa 1 (in):', 'X = 0.3950', 'Y = 0.0110', 'Z = -1.4189', 'Centro de masa 2 (in):', 'X = 3.5459', 'Y = -3.6364', 'Z = 0.3950']);
  assert.deepEqual(ex.mass, { value: 17.2229, units: 'lb' });
  assert.deepEqual(ex.com.map(c => [c.coordinate_system, c.length_units, c.value[2]]), [['#1', 'in', -1.4189], ['#2', 'in', 0.395]]);
  assert.deepEqual(ex.interferences_mm3, [207.79]);
  assert.equal(validate.get('sw_assembly_draft')({ drawing: 'C:\\x\\plano.pdf', parts_dir: 'C:\\x' }), true);
});

test('v3.7 revisión Codex: count/repeat inválidos, intenciones conservan banderas, anclajes solo al ensamble', async () => {
  const { expandIntents, checkAssemblyPlan, replaceUnsupportedMates } = await import('./assembly_build.mjs');
  const base = { ir: 'assembly-ir/1', name: 'x', components: [{ id: 'P', file: 'p.SLDPRT', fixed: true }, { id: 'T', file: 't.SLDPRT' }] };
  for (const count of [0, -1, 1.5]) assert.ok(checkAssemblyPlan({ ...base, components: [base.components[0], { id: 'T', file: 't.SLDPRT', count }], mates: [] }).errors.some(e => /count/.test(e)), 'count ' + count);
  assert.ok(checkAssemblyPlan({ ...base, mates: [{ intent: 'coaxial', repeat: 0, a: { component: 'T', diameter_mm: 8 }, b: { component: 'P', diameter_mm: 8 } }] }).errors.some(e => /repeat/.test(e)));
  const x = expandIntents({ ...base, mates: [{ intent: 'insert', suppressed: true, lock_rotation: true, shaft: { component: 'T', diameter_mm: 8 }, hole: { component: 'P', diameter_mm: 8 }, seat: { a: { component: 'T', normal: [0, 0, 1] }, b: { component: 'P', normal: [0, 0, -1] } } }] });
  assert.equal(x.mates[0].suppressed, true); assert.equal(x.mates[0].lock_rotation, true); assert.equal(x.mates[1].suppressed, true);
  const T = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const plan = (owner, suppressed) => ({ ...base, components: [{ id: 'P', file: 'p.SLDPRT', transform: T }, { id: 'T', file: 't.SLDPRT', transform: T }],
    mates: [{ type: 'concentric', align: 'aligned', ...(suppressed ? { suppressed } : {}), entities: [{ component: 'P', local_point_mm: [0, 0, 0], kind: 'face' }, { kind: 'unsupported', reason: 'r', ...(owner ? { owner } : {}) }] }] });
  assert.equal(replaceUnsupportedMates(plan('assembly')).replaced.length, 1);
  assert.equal(replaceUnsupportedMates(plan(undefined)).replaced.length, 0);   // owner unknown: may be the second part of a mate
  assert.equal(replaceUnsupportedMates(plan('T')).replaced.length, 0);
  assert.equal(replaceUnsupportedMates(plan('assembly', true)).replaced.length, 0);   // a suppressed mate never fixes a part
});

test('v3.7 revisión Codex: find_origin no oculta empates; draft no inventa CM ni masa', async () => {
  const { rankOrigins } = await import('./find_origin.mjs');
  const r = rankOrigins([0, 0, 0], [{ source: 'o', point_mm: [0, 0, 0] }], [0, 0, 0], 'mm');
  assert.ok(r[1].error < 1e-9);   // the runner-up (another orientation) ties: it must be reported as ambiguous
  const { parseTable, parseExpect } = await import('./assembly_draft.mjs');
  const ex = parseExpect(['Centro de masa 1 (in):', 'Z = 3', 'X = 1', 'Y = 2', 'Centro de masa 2 (mm):', 'X = 1', 'X = 2', 'X = 3']);
  assert.deepEqual(ex.com.map(c => c.value), [[1, 2, 3]]); assert.equal(ex.warnings.length, 1);
  const rows = parseTable(['7 TUBO 2 AISI 304', '8 EJE 1 SAE 1020 12.5']);
  assert.deepEqual(rows.map(x => [x.material, x.mass]), [['AISI 304', null], ['SAE 1020', 12.5]]);
});

test('v3.8: fastener en una linea con repeat, rondana y tuerca (sin SolidWorks)', async () => {
  const { expandIntents, checkAssemblyPlan } = await import('./assembly_build.mjs');
  const plan = { ir: 'assembly-ir/1', name: 'placa_tornilleria', components: [{ id: 'PLACA', file: 'placa.SLDPRT', fixed: true },
    { id: 'T', make: { type: 'bolt', size: 'M8', length_mm: 30, material: 'AISI 1020' }, count: 4 }, { id: 'R', make: { type: 'washer', size: 'M8' }, count: 4 }, { id: 'N', make: { type: 'nut', size: 'M8' }, count: 4 }],
    mates: [{ intent: 'fastener', bolt: 'T#', washer: 'R#', nut: 'N#', lock_rotation: true, hole: { component: 'PLACA', find: { kind: 'cylinder', diameter_mm: 8, index: '#' } },
      head_side: { component: 'PLACA', find: { kind: 'plane', normal: [0, 0, 1] } }, nut_side: { component: 'PLACA', find: { kind: 'plane', normal: [0, 0, -1] } }, repeat: 4 }] };
  const x = expandIntents(plan);
  assert.equal(x.components.length, 13); assert.equal(x.components[1].file, 'ISO4017_M8x30_AISI_1020.SLDPRT'); assert.equal(x.components[5].file, 'ISO7089_M8.SLDPRT');
  assert.equal(x.mates.length, 24);
  const k3 = x.mates.slice(12, 18);
  assert.deepEqual(k3.map(m => [m.type, m.align]), [['coincident', 'anti_aligned'], ['concentric', undefined], ['coincident', 'anti_aligned'], ['concentric', undefined], ['coincident', 'anti_aligned'], ['concentric', undefined]]);
  assert.equal(k3[0].name, 'fastener #3 (rondana asiento)');
  assert.deepEqual(k3[0].entities.map(e => e.component), ['R3', 'PLACA']); assert.deepEqual(k3[0].entities[0].find.normal, [0, -1, 0]);
  assert.equal(k3[1].entities[0].find.diameter_mm, 8.4); assert.equal(k3[1].entities[1].find.index, 2); assert.equal(k3[1].lock_rotation, true);
  assert.deepEqual(k3[2].entities[0].find, { kind: 'plane', normal: [0, 1, 0], offset_mm: 0 }); assert.equal(k3[2].entities[1].component, 'R3'); assert.deepEqual(k3[2].entities[1].find.normal, [0, 1, 0]);
  assert.equal(k3[3].entities[0].find.diameter_mm, 8); assert.deepEqual(k3[4].entities.map(e => e.component), ['N3', 'PLACA']); assert.deepEqual(k3[4].entities[1].find.normal, [0, 0, -1]);
  assert.equal(k3[2].lock_rotation, undefined);   // lock_rotation is only for coaxial (concentric) mates
  const r = checkAssemblyPlan(plan);
  assert.deepEqual(r.errors, []); assert.ok(!r.warnings.some(w => /closest/.test(w)));
  const noNutSide = structuredClone(plan); delete noNutSide.mates[0].nut_side;
  assert.ok(checkAssemblyPlan(noNutSide).errors.some(e => /nut_side/.test(e)));
  const foreign = { ...plan, components: [plan.components[0], { id: 'T', file: 'mi_tornillo.SLDPRT' }], mates: [{ intent: 'fastener', bolt: 'T', hole: plan.mates[0].hole, head_side: plan.mates[0].head_side }] };
  assert.ok(checkAssemblyPlan(foreign).warnings.some(w => /no es tornilleria generada/.test(w)));
  assert.ok(checkAssemblyPlan({ ...plan, components: [plan.components[0], { id: 'T', make: { type: 'bolt', size: 'M7', length_mm: 30 } }], mates: [] }).errors.some(e => /make.size/.test(e)));
});

test('v3.8: kits (plan, integrados, en disco) y tornilleria ISO en part-ir', async () => {
  const { expandIntents, checkAssemblyPlan, saveKits, loadKits } = await import('./assembly_build.mjs');
  const { fastenerSpec, builtinKit } = await import('./fasteners.mjs');
  const { resolveIR } = await import('./part_ir.mjs');
  const at = { hole: { component: 'P', find: { kind: 'cylinder', diameter_mm: 8, index: '#' } }, head_side: { component: 'P', find: { kind: 'plane', normal: [0, 0, 1] } }, nut_side: { component: 'P', find: { kind: 'plane', normal: [0, 0, -1] } } };
  const plan = { ir: 'assembly-ir/1', name: 'k', components: [{ id: 'P', file: 'p.SLDPRT', fixed: true }],
    kits: { perno: { components: [{ id: 'B', make: { type: 'bolt', size: 'M8', length_mm: 25 } }, { id: 'N', make: { type: 'nut', size: 'M8' } }],
      mates: [{ intent: 'fastener', bolt: 'B', nut: 'N', size: 'M8', hole: '@hole', head_side: '@head_side', nut_side: '@nut_side' }] } },
    mates: [{ use: 'perno', at, repeat: 2, material: 'AISI 304' }, { use: 'tornilleria_M6x20', at, prefix: 'M6_' }] };
  const x = expandIntents(plan);
  assert.deepEqual(x.components.map(c => c.id), ['P', 'perno1_B', 'perno1_N', 'perno2_B', 'perno2_N', 'M6_1_T', 'M6_1_R', 'M6_1_N']);
  assert.equal(x.components[1].make.material, 'AISI 304'); assert.equal(x.components[1].file, 'ISO4017_M8x25_AISI_304.SLDPRT');
  assert.equal(x.mates.length, 2 * 4 + 6); assert.equal(x.mates[4].entities[0].component, 'perno2_B'); assert.equal(x.mates[5].entities[1].find.index, 1);
  assert.match(x.mates[0].name, /^perno #1/);
  assert.deepEqual(checkAssemblyPlan(plan).errors, []);
  assert.ok(checkAssemblyPlan({ ...plan, mates: [{ use: 'no_existe', at }] }).errors.some(e => /kit desconocido/.test(e)));
  assert.ok(checkAssemblyPlan({ ...plan, mates: [{ use: 'perno', at: { hole: at.hole } }] }).errors.some(e => /falta at.head_side/.test(e)));
  assert.equal(builtinKit('tornillo_tuerca_M10x40').components.length, 2); assert.equal(builtinKit('tornilleria_M7x10'), null);
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kits-'));
  assert.equal(saveKits(plan, root).saved.length, 1);
  assert.equal(saveKits({ kits: { perno: { components: [{ id: 'X', file: 'x.SLDPRT' }], mates: [] } } }, root).refused.length, 1);   // never replaces a different kit
  const reused = loadKits({ ...plan, kits: undefined, mates: [{ use: 'perno', at }] }, root);
  assert.equal(expandIntents(reused).mates.length, 4);
  for (const [make, vol] of [[{ type: 'bolt', size: 'M8', length_mm: 30 }, Math.sqrt(3) / 2 * 13 ** 2 * 5.3 + Math.PI * 16 * 30], [{ type: 'washer', size: 'M8' }, Math.PI / 4 * (16 ** 2 - 8.4 ** 2) * 1.6], [{ type: 'nut', size: 'M8' }, Math.sqrt(3) / 2 * 13 ** 2 * 6.8 - Math.PI * 16 * 6.8]]) {
    const s = fastenerSpec(make), res = resolveIR(s.ir);
    assert.deepEqual(res.errors, []); assert.ok(Math.abs(res.expect.volume_mm3 - vol) < 1e-6, make.type);
  }
});

test('v3.8: borrador sugiere fastener con repeat y diametro del plano; sw_exam_ready', async () => {
  const { holeCallouts, suggestMates } = await import('./assembly_draft.mjs');
  const holes = holeCallouts(['4x Ø8', 'PLACA 300x180', '2x45°', '10x45°', '6 X 10,5']);
  assert.deepEqual(holes.map(h => [h.count, h.diameter_mm]), [[4, 8], [6, 10.5]]);
  const s = suggestMates([{ id: 'PLACA', fixed: true }, { id: 'TORNILLO', count: 4 }, { id: 'RONDANA', count: 4 }, { id: 'TUERCA', count: 4 }], holes);
  assert.equal(s[0].intent, 'fastener'); assert.equal(s[0].bolt, 'TORNILLO#'); assert.equal(s[0].repeat, 4); assert.equal(s[0].hole.find.diameter_mm, 8); assert.equal(s[0].hole.component, 'PLACA');
  assert.deepEqual(suggestMates([{ id: 'EJE' }]), []);
  assert.equal(validate.get('sw_exam_ready')({}), true); assert.equal(validate.get('sw_exam_ready')({ start: true }), true);
  assert.equal(validate.get('sw_assembly_build')({ action: 'check', plan: {}, save_kits: true }), true);
  const { examReady } = await import('./exam_ready.mjs');
  const calls = [];
  const r = await examReady({}, { worker: { call: async (op, a) => { calls.push([op, a.action]); return { ok: true, result: { mode: 'shared', dedicated_running: false } }; } } });
  assert.deepEqual(calls, [['instance', 'status']]);   // without start nothing is opened
  assert.equal(r.tools, tools.length); assert.ok(r.todo.some(t => /sw_instance start/.test(t)));
  assert.ok(tools.every(t => !t.description.includes(String.fromCharCode(39))), 'sin apostrofos en las descripciones');
});

test('v3.8: hoja de respuestas (redondeo, orden de sistemas, avisos) y plano en una llamada', async () => {
  const { roundHalfUp, fmt, orderSystems, answerSheet } = await import('./answers.mjs');
  assert.equal(fmt(0.39505, 4), '0.3951'); assert.equal(fmt(-1.41875, 4), '-1.4188'); assert.equal(fmt(-0.00001, 4), '0.0000'); assert.equal(fmt(17.222931, 4), '17.2229');
  assert.equal(roundHalfUp(2.675, 2), 2.68);   // toFixed(2) gives 2.67
  assert.deepEqual(orderSystems(['Sistema de coordenadas2', 'Sistema de coordenadas10', 'Sistema de coordenadas1']), ['Sistema de coordenadas1', 'Sistema de coordenadas2', 'Sistema de coordenadas10']);
  const cms = { 'Sistema de coordenadas1': [0.395029, 0.010991, -1.418848], 'Sistema de coordenadas2': [3.545834, -3.636368, 0.395029] };
  const calls = [];
  const worker = { call: async (op, a) => { calls.push([op, a.coordinate_system ?? null]);
    return { ok: true, result: { document: 'Valvula', mass: 17.222931, volume_mm3: 1, center_of_mass: a.coordinate_system ? cms[a.coordinate_system] : [0, 0, 0], coordinate_systems_available: ['Sistema de coordenadas2', 'Sistema de coordenadas1'],
      parts: [{ part: 'a.SLDPRT', count: 1, material: 'AISI 304', mass_each: 1 }, { part: 'b.SLDPRT', count: 1, material: null, mass_each: 1 }] } }; } };
  const r = await answerSheet({ document_id: 'd' }, { worker });
  assert.deepEqual(r.lines, ['Masa = 17.2229 lb', 'Centro de masa 1 (in, Sistema de coordenadas1): X = 0.3950  Y = 0.0110  Z = -1.4188', 'Centro de masa 2 (in, Sistema de coordenadas2): X = 3.5458  Y = -3.6364  Z = 0.3950']);
  assert.ok(r.warnings.some(w => /Sin material.*b.SLDPRT/.test(w))); assert.equal(calls.length, 3);
  await assert.rejects(answerSheet({ document_id: 'd', coordinate_systems: ['Sistema9'] }, { worker }), /No existen/);
  const { layout, fitScale, scaleText, checkDrawingArgs } = await import('./assembly_drawing.mjs');
  const L = layout(420, 297, true);
  assert.ok(L.top[1] < L.front[1] && L.side[0] > L.front[0] && L.sideOrientation === 'left');   // first angle: top below, left view on the right
  assert.ok(layout(420, 297, false).top[1] > layout(420, 297, false).front[1]);
  assert.equal(fitScale([[0, 0, 300, 120]], L.cell), 0.25); assert.equal(scaleText(0.25), '1:4'); assert.equal(fitScale([[0, 0, 20, 10]], L.cell), 5);
  assert.deepEqual(checkDrawingArgs({ name: 'Plano', document_id: 'd' }), []);
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-'));
  const { recordStep, readState, summarize } = await import('./exam_state.mjs');
  recordStep(root, summarize('assembly_build', { action: 'build', plan: { name: 'X' } }, { verdict: 'pass', path: 'C:\\x.SLDASM', verification: { mates: { mate_count: 24 } } }));
  recordStep(root, summarize('answer_sheet', {}, { document: 'X', lines: ['Masa = 1 g'] }));
  const st = readState(root); assert.equal(st.length, 2); assert.equal(st[0].verdict, 'pass'); assert.equal(st[0].mates, 24); assert.deepEqual(st[1].lines, ['Masa = 1 g']);
  // a material version of a fastener is a COPY of the bare geometry with the material set (no rebuild)
  const { makeFasteners } = await import('./assembly_build.mjs');
  fs.writeFileSync(path.join(root, 'ISO4032_M8.SLDPRT'), 'base');
  const ops = [];
  const made = await makeFasteners({ components: [{ id: 'N', make: { type: 'nut', size: 'M8', material: 'AISI 304' }, file: 'ISO4032_M8_AISI_304.SLDPRT' }] },
    { root, worker: { call: async (op, a) => { ops.push(op); if (op === 'open_copy') fs.copyFileSync(a.source, path.join(root, a.name)); return { ok: true, result: op === 'open_copy' ? { document_id: 'c' } : {} }; } } });
  assert.deepEqual(ops, ['open_copy', 'set_material', 'save', 'close_document']); assert.equal(made[0].copied_from, 'ISO4032_M8.SLDPRT');
  // a failed material leaves no copy behind under the material name
  await assert.rejects(makeFasteners({ components: [{ id: 'N', make: { type: 'nut', size: 'M8', material: 'Nada' }, file: 'ISO4032_M8_Nada.SLDPRT' }] },
    { root, worker: { call: async (op, a) => { if (op === 'open_copy') { fs.copyFileSync(a.source, path.join(root, a.name)); return { ok: true, result: { document_id: 'c' } }; } return op === 'set_material' ? { ok: false, error: 'no existe' } : { ok: true, result: {} }; } } }), /set_material/);
  assert.equal(fs.existsSync(path.join(root, 'ISO4032_M8_Nada.SLDPRT')), false);
  assert.equal(validate.get('sw_exam_ready')({ start: true, prebuild: ['M8x30', 'm6x20'] }), true); assert.equal(validate.get('sw_exam_ready')({ prebuild: ['8x30'] }), false);
  for (const [n, a] of [['sw_answer_sheet',{ document_id: 'd', coordinate_systems: ['S1'] }], ['sw_assembly_drawing', { name: 'P', document_id: 'd', size: 'A3' }], ['sw_drawing_note', { document_id: 'd', lines: ['Masa = 1 g'], position_mm: [10, 10] }]]) assert.equal(validate.get(n)(a), true, n);
});

test('v3.8: IR shorthands rect center/w/h, polar and grid holes; rect without points gives a clear error', async () => {
  const { partBuild } = await import('./part_ir.mjs');
  const ir = { ir: 'part-ir/1', part: 'x', units: 'mm', params: { t: 12 }, features: [
    { id: 'p', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 580, h: 248 } }] }, depth: 't' },
    { id: 'h', op: 'cut', sketch: { plane: 'front', entities: [{ polar: { r: 20, count: 6, d: 9 } }, { polar: { r: 23, count: 6, start_deg: 30, d: 9 } }, { grid: { from: [-240, 20], count: [5, 1], step: [120, 0], d: 25.2 } }] } }] };
  const r = await partBuild({ action: 'check', ir }, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.steps.map(s => s.sketch.entities), [4, 17]);
  const bad = await partBuild({ action: 'check', ir: { ...ir, features: [{ id: 'p', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { w: 5 } }] }, depth: 5 }] } }, {});
  assert.match(bad.errors.join(' '), /rect usa from/);
});

test('v3.8: IR steps (stepped shaft) and countersunk fastener spec', async () => {
  const { partBuild } = await import('./part_ir.mjs');
  const r = await partBuild({ action: 'check', ir: { ir: 'part-ir/1', part: 'e', units: 'mm', features: [{ id: 'e', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { segments: [[25, 16.5], [100, 167], [25, 16.5]] } }] } }] } }, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(r.steps[0].sketch.entities, 9);
  const bad = await partBuild({ action: 'check', ir: { ir: 'part-ir/1', part: 'e', units: 'mm', features: [{ id: 'e', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { segments: [[0, 5]] } }] } }] } }, {});
  assert.match(bad.errors.join(' '), /steps.segments/);
  const { fastenerSpec } = await import('./fasteners.mjs');
  const c = fastenerSpec({ type: 'countersunk', size: 'M10', length_mm: 45 });
  assert.deepEqual(c.errors, []); assert.equal(c.file, 'ISO10642_M10x45.SLDPRT');
  assert.ok(fastenerSpec({ type: 'countersunk', size: 'M10', length_mm: 5 }).errors.length);
  const { expandIntents } = await import('./assembly_build.mjs');
  const x = expandIntents({ components: [{ id: 'S', make: { type: 'countersunk', size: 'M10', length_mm: 45 } }], mates: [{ name: 't', intent: 'fastener', bolt: 'S', hole: { component: 'T', find: { kind: 'cylinder', diameter_mm: 11 } }, head_side: { component: 'T', find: { kind: 'plane', normal: [0, 0, 1] } } }] });
  assert.equal(x.mates[0].align, 'aligned'); assert.deepEqual(x.mates[0].entities[0].find.normal, [0, -1, 0]);
});

test('v3.8 review: plan patterns/symmetric validated by check; answer_sheet create validates first and rolls back', async () => {
  const base = { ir: 'assembly-ir/1', name: 'P', components: [{ id: 'A', file: 'a.SLDPRT', fixed: true }, { id: 'B', file: 'b.SLDPRT' }], mates: [] };
  const bad = checkAssemblyPlan({ ...base, patterns: [{ kind: 'linear', seeds: ['Z'], count: 1, direction: { component: 'A', local_point_mm: [0, 0, 0], kind: 'edge' } }], expect: { symmetric: ['w'] } });
  assert.equal(bad.ok, false); assert.ok(bad.errors.some(e => /seeds/.test(e)) && bad.errors.some(e => /count/.test(e)) && bad.errors.some(e => /spacing_mm/.test(e)) && bad.errors.some(e => /symmetric/.test(e)), JSON.stringify(bad.errors));
  assert.equal(checkAssemblyPlan({ ...base, patterns: [{ kind: 'circular', seeds: ['B'], count: 6, axis: { component: 'A', local_point_mm: [1, 0, 0], kind: 'face' } }], expect: { symmetric: ['x', 'z'] } }).ok, true);
  const { answerSheet } = await import('./answers.mjs');
  const calls = [];
  const worker = { call: async (op, a) => { calls.push(op + ':' + a.action); if (op === 'coordinate_system' && a.action === 'create') return calls.filter(c => c === 'coordinate_system:create').length === 1 ? { ok: true, result: { coordinate_system: 'Sistema1', verified: true } } : { ok: true, result: { coordinate_system: 'Sistema2', verified: false } }; return { ok: true, result: {} }; } };
  await assert.rejects(answerSheet({ document_id: 'd', create: [{ point_mm: [0, 0, 0] }, {}] }, { worker }), /create\[1\]/);
  assert.equal(calls.length, 0, 'nothing is created when the list is invalid');
  await assert.rejects(answerSheet({ document_id: 'd', create: [{ point_mm: [0, 0, 0] }, { point_mm: [1, 0, 0] }] }, { worker }), /Se borraron los 2/);
  assert.deepEqual(calls.filter(c => /delete/.test(c)).length, 2);
});

test('v3.8 night: every new option is accepted by the public schemas (the chat validates before running)', () => {
  const ok = (n, a) => assert.equal(validate.get(n)(a), true, n + ' ' + JSON.stringify(validate.get(n).errors));
  const no = (n, a) => assert.equal(validate.get(n)(a), false, n + ' should refuse ' + JSON.stringify(a));
  ok('sw_part_build', { action: 'build', ir: {}, reuse: true });
  ok('sw_answer_sheet', { document_id: 'd', create: [{ label: 'A', point_mm: [0, 0, 0], axes: { x: '+Y', y: '-z' } }, { component: 'P-1', local_point_mm: [1, 2, 3], kind: 'circle_center' }] });
  no('sw_answer_sheet', { document_id: 'd', create: [{ axes: { x: 'Y+', y: 'Z' } }] });
  ok('sw_instance', { action: 'cleanup_orphans', include_unrecorded: true });
  ok('sw_move_body', { document_id: 'd', rotate_deg: [90, 0, 0], rotate_about_mm: [0, 0, 0], translate_mm: [0, 0, 10] });
  no('sw_move_body', { document_id: 'd', rotate_deg: [90, 0] });
  ok('sw_interference', { document_id: 'd', expected_count: 6 });
  ok('sw_add_mate', { document_id: 'd', type: 'angle', angle_deg: 0, angle_min_deg: 0, angle_max_deg: 90, entities: [{ component: 'a', plane: 'Planta' }, { component: 'b', plane: 'Planta' }] });
  ok('sw_assembly_build', { action: 'check', plan: { patterns: [], expect: { symmetric: ['x'] }, components: [{ id: 'T', up: '+Z' }] } });
  for (const t of tools) assert.ok(!/'/.test(t.description ?? ''), t.name + ': apostrophe in description');
});

test('v3.8: expect.mass_g is parsed and validated; sketch/sweep ops resolve', async () => {
  const { partBuild } = await import('./part_ir.mjs');
  const base = { ir: 'part-ir/1', part: 'x', units: 'mm', features: [{ id: 'a', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 10, h: 10 } }] }, depth: 10 }] };
  const r = await partBuild({ action: 'check', ir: { ...base, expect: { mass_g: 7.9 } } }, {});
  assert.equal(r.ok, true); assert.equal(r.expect.mass_g, 7.9);
  assert.equal((await partBuild({ action: 'check', ir: { ...base, expect: { mass_g: -1 } } }, {})).ok, false);
  const sw = await partBuild({ action: 'check', ir: { ir: 'part-ir/1', part: 's', units: 'mm', features: [
    { id: 'p', op: 'sketch', sketch: { plane: 'top', entities: [{ circle: { center: [0, 0], d: 4 } }] } },
    { id: 't', op: 'sketch', sketch: { plane: 'front', entities: [{ line: { from: [0, 0], to: [0, 50] } }] } },
    { id: 'b', op: 'sweep', profile: 'p', path: 't' }] } }, {});
  assert.equal(sw.ok, true, JSON.stringify(sw.errors));
  const bad = await partBuild({ action: 'check', ir: { ir: 'part-ir/1', part: 's', units: 'mm', features: [{ id: 'b', op: 'sweep', path: 'nada' }] } }, {});
  assert.ok(bad.errors.some(e => /path/.test(e)) && bad.errors.some(e => /profile/.test(e)));
});

test('v3.8: generated fasteners without material are refused before building (unless allow_no_material)', async () => {
  const plan = { ir: 'assembly-ir/1', name: 'P', components: [{ id: 'T', file: 't.SLDPRT', fixed: true }, { id: 'B', make: { type: 'bolt', size: 'M8', length_mm: 30 } }], mates: [] };
  const r = await assemblyBuild({ action: 'check', plan }, {});
  assert.equal(r.ok, false); assert.match(r.errors.join(' '), /sin material/);
  assert.equal((await assemblyBuild({ action: 'check', plan: { ...plan, allow_no_material: true } }, {})).ok, true);
  assert.equal((await assemblyBuild({ action: 'check', plan: { ...plan, components: [plan.components[0], { id: 'B', make: { type: 'bolt', size: 'M8', length_mm: 30, material: 'AISI 1020' } }] } }, {})).ok, true);
});

test('v3.8: drawing dimensions say FROM WHERE each dimension measures (pillow block "24" = base edge to boss centre)', async (t) => {
  const { fileURLToPath } = await import('node:url'), { existsSync } = await import('node:fs');
  const pdf = fileURLToPath(new URL('./generated/drawing_read/clase/s6.pdf', import.meta.url));
  if (!existsSync(pdf)) return t.skip('s6.pdf no está');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const r = await drawingDimensions({ path: pdf, page: 1 });
  const d24 = r.dimensions.find(d => d.raw === '24.00'), d88 = r.dimensions.find(d => d.raw === '88.00');
  assert.equal(r.sheet_scale, 0.5); assert.ok(r.views.length >= 3);
  assert.equal(d24.direction, 'horizontal'); assert.ok(Math.abs(d24.from_part_mm[0]) < 0.1 && Math.abs(d24.to_part_mm[0] - 24) < 0.1, JSON.stringify(d24));
  assert.equal(d88.direction, 'vertical'); assert.ok(Math.abs(d88.to_part_mm[1] - 88) < 0.2, JSON.stringify(d88));
  assert.ok(r.dimensions.filter(d => d.from_mm).every(d => d.scale_ok));
});

test('v3.8 Codex review: steps keep parameters, sweep only to earlier sketches, pattern/up validation', async () => {
  const { resolveIR } = await import('./part_ir.mjs');
  const ir = { ir: 'part-ir/1', part: 'e', units: 'mm', params: { d: 20, L: 50 }, features: [{ id: 'e', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { segments: [['d', 'L'], [10, 'L/2']] } }] } }] };
  const r = resolveIR(ir); assert.deepEqual(r.errors, []);
  const pts = r.steps[0].sketch.entities.map(e => e.end_mm ?? []).flat();
  assert.ok(pts.includes(75) && pts.includes(10), JSON.stringify(pts));
  assert.ok(r.steps[0].candidates.some(c => /d/.test(c.signed ?? c.expr ?? '')) && r.steps[0].candidates.some(c => /L/.test(c.signed ?? c.expr ?? '')), 'candidatos con d y L');
  const sw = { ir: 'part-ir/1', part: 's', units: 'mm', features: [{ id: 'b', op: 'sweep', path: 'p', circular_diameter: 4 }, { id: 'p', op: 'sketch', sketch: { plane: 'front', entities: [{ line: { from: [0, 0], to: [0, 50] } }] } }] };
  assert.match(resolveIR(sw).errors.join(' '), /path debe ser el id de un op sketch anterior/);
  const p = assemblyPlan(); p.patterns = [{ kind: 'linear', seeds: 'eje-1', count: 3, spacing_mm: 10, direction: { component: 'base-1', local_point_mm: [0, 0, 0], kind: 'edge' } }];
  assert.match(checkAssemblyPlan(p).errors.join(' '), /seeds/);
  p.patterns[0].seeds = ['eje-1']; p.patterns[0].direction.kind = 'face';
  assert.match(checkAssemblyPlan(p).errors.join(' '), /arista recta/);
});

test('v3.8 general: title block material alone, radii located on their arc (polyline circles)', async (t) => {
  const { fileURLToPath } = await import('node:url'), { existsSync } = await import('node:fs');
  const pdf = fileURLToPath(new URL('./generated/drawing_read/clase/s6.pdf', import.meta.url));
  if (!existsSync(pdf)) return t.skip('s6.pdf no está');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const r = await drawingDimensions({ path: pdf, page: 1 });
  assert.equal(r.materials[0].raw, 'AISI 1020');
  const r10 = r.dimensions.find(d => d.raw === 'R10.00');
  assert.ok(r10?.center_part_mm && Math.abs(r10.sheet_radius_mm - 5) < 0.1, JSON.stringify(r10));
  assert.equal(r.views.filter(v => v.scale).every(v => v.scale === 0.5), true);
});

test('v3.8 general: angle dimensions give their vertex and rays (pillow block 80°)', async (t) => {
  const { fileURLToPath } = await import('node:url'), { existsSync } = await import('node:fs');
  const pdf = fileURLToPath(new URL('./generated/drawing_read/clase/s6.pdf', import.meta.url));
  if (!existsSync(pdf)) return t.skip('s6.pdf no está');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const r = await drawingDimensions({ path: pdf, page: 1 });
  const a = r.dimensions.find(d => d.raw === '80°');
  assert.ok(a?.angular && Math.abs(a.measured_deg - 80) < 0.5 && a.vertex_part_mm, JSON.stringify(a));
  // the Ø symbol is drawn (not text): 36.00 and 23.00 are found as diameters of the boss, centre 24 from the base edge, 88 high
  for (const raw of ['36.00', '23.00']) { const d = r.dimensions.find(x => x.raw === raw); assert.ok(d?.kind === 'diameter' && Math.abs(d.center_part_mm[0] - 24) < 0.2 && Math.abs(d.center_part_mm[1] - 88) < 0.2, JSON.stringify(d)); }
});

test('v3.8 Codex review 2: exam_ready is not ready when the start failed; waits are not ready either', async () => {
  const { examReady } = await import('./exam_ready.mjs');
  const worker = { call: async (op, a) => op === 'instance' && a.action === 'status' ? { ok: true, result: { mode: 'dedicated', dedicated_running: false } } : op === 'instance' ? { ok: false, error: 'no license' } : { ok: true, result: {} } };
  const r = await examReady({ start: true }, { worker });
  assert.match(r.todo.join(' '), /No arrancó/); assert.equal(r.started.error, 'no license');
  if (r.ram.free_gb >= 3) assert.equal(r.ready, false);
});

test('v3.8 general: arcs are not chained through corners (Allen key R6 bend, pillow block R15, 6/6 angles)', async (t) => {
  const { fileURLToPath } = await import('node:url'), { existsSync } = await import('node:fs');
  const f = n => fileURLToPath(new URL('./generated/drawing_read/clase/' + n, import.meta.url));
  if (!existsSync(f('s5.pdf')) || !existsSync(f('s6.pdf'))) return t.skip('PDF de clase no están');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const allen = await drawingDimensions({ path: f('s5.pdf'), page: 1 });
  assert.ok(allen.dimensions.find(d => d.raw === 'R6.00')?.center_part_mm);
  const pillow = await drawingDimensions({ path: f('s6.pdf'), page: 1 });
  assert.ok(pillow.dimensions.find(d => d.raw === 'R15.00')?.center_part_mm);
  const angles = [];
  for (const [n, p] of [['s6.pdf', 1], ['s6.pdf', 2], ['s6.pdf', 3], ['s5.pdf', 3]]) angles.push(...(await drawingDimensions({ path: f(n), page: p })).dimensions.filter(d => d.kind === 'angle'));
  assert.equal(angles.filter(d => d.angular).length, angles.length, JSON.stringify(angles.map(d => d.raw + ':' + !!d.angular)));
});

test('v3.8: the chat gets a compact build result; the full one goes to details_file', async () => {
  const { compactBuildResult } = await import('./compact.mjs'), { tmpdir } = await import('node:os'), { existsSync, readFileSync } = await import('node:fs');
  const big = { ok: true, verdict: 'pass', answers: { ok: true, lines: ['Masa = 1 g'] }, verification: { assembly_doctor: { summary: { complete: true }, components: new Array(500).fill({ dof: 6 }) }, find_ms: new Array(50).fill([1, 2, 3, 4]) }, moved_components: new Array(90).fill({ a: 1 }), path: 'C:/x/T.SLDASM' };
  const c = compactBuildResult(big, tmpdir(), 'assembly_build');
  assert.ok(JSON.stringify(c).length < 1500); assert.deepEqual(c.answers.lines, ['Masa = 1 g']); assert.equal(c.verification.find_ms, undefined);
  assert.ok(existsSync(c.details_file) && JSON.parse(readFileSync(c.details_file, 'utf8')).verification.assembly_doctor.components.length === 500);
  const small = { ok: true, verdict: 'pass', path: 'x' }; assert.equal(compactBuildResult(small, tmpdir(), 'part_build'), small);
});

test('example drawing (support plate, 1:4): the DXF gives every dimension exactly, the PDF finds the same values', async () => {
  const { fileURLToPath } = await import('node:url');
  const { drawingDimensions } = await import('./dims_geometry.mjs');
  const f = n => fileURLToPath(new URL('../examples/drawings/' + n, import.meta.url));
  const want = [150, 300, 90, 180, 22, 22, 22, 22, 110, 220, 60, 120, 70, 15, 20].sort((a, b) => a - b);
  const dxf = await drawingDimensions({ path: f('support_plate.dxf') });
  assert.deepEqual(dxf.dimensions.map(d => d.value).sort((a, b) => a - b), want);
  assert.ok(dxf.dimensions.every(d => d.scale_ok && d.scale_used === 0.25));
  const hole = dxf.dimensions.find(d => d.kind === 'diameter' && d.value === 70);
  assert.deepEqual(hole.center_part_mm, [150, 90], 'the centre hole is in the middle of the 300 x 180 plate');
  const pdf = await drawingDimensions({ path: f('support_plate.pdf'), page: 1 });
  assert.deepEqual(pdf.dimensions.map(d => d.value).sort((a, b) => a - b), want);
});

test('DXF geometry: bulge over 180 deg, NURBS spline, block base point, inch dimensions (Codex review cases)', async () => {
  const { dxfGeometry, dxfDimensions } = await import('./dxf_geometry.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('./generated/drawing_read/', import.meta.url)); mkdirSync(dir, { recursive: true });
  const L = (...a) => a.join('\n'), head = units => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', units, '9', '$EXTMIN', '10', '0', '20', '0', '9', '$EXTMAX', '10', '200', '20', '100', '0', 'ENDSEC'];
  const f1 = dir + 'test_review_geom.dxf';
  writeFileSync(f1, L(...head('4'),
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B', '10', '10', '20', '10', '0', 'LINE', '8', '0', '10', '10', '20', '10', '11', '20', '21', '10', '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'B', '10', '100', '20', '50',
    '0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '2', '10', '2', '20', '0',
    '0', 'SPLINE', '8', '0', '70', '8', '71', '2', '72', '6', '73', '3', '40', '0', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1', '10', '50', '20', '0', '10', '51', '20', '1', '10', '52', '20', '0',
    '0', 'ENDSEC', '0', 'EOF'));
  const g = dxfGeometry(f1), ys = s => [s[1], s[3]];
  const ins = g.segments.filter(s => s[0] >= 99 && s[0] <= 111);
  assert.deepEqual(ins[0].slice(0, 4), [100, 50, 110, 50], 'block line placed from its base point (10,10) at the insert point');
  const bulge = g.segments.filter(s => s[0] <= 2 && s[2] <= 2 && s[0] >= 0);
  assert.ok(Math.max(...bulge.flatMap(ys)) > 101.9, 'bulge 2 from (0,0) to (2,0) is the major arc reaching y = -2');
  const spl = g.segments.filter(s => s[0] >= 50 && s[2] <= 52);
  assert.ok(Math.abs(Math.min(...spl.flatMap(ys)) - 99.5) < 0.01, 'quadratic spline peaks at y = 0.5, not at its control point');
  const f2 = dir + 'test_review_inch.dxf';
  writeFileSync(f2, L(...head('1'), '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '1', '20', '1', '11', '3', '21', '1', '0', 'LINE', '8', '0', '10', '3', '20', '1', '11', '3', '21', '2', '0', 'LINE', '8', '0', '10', '3', '20', '2', '11', '1', '21', '2',
    '0', 'DIMENSION', '5', 'C1', '2', '*D1', '10', '1', '20', '0.5', '11', '2', '21', '0.5', '70', '32', '1', '<>', '13', '1', '23', '1', '14', '3', '24', '1', '50', '0', '0', 'ENDSEC', '0', 'EOF'));
  const dd = dxfDimensions(f2).dimensions[0];
  assert.equal(dd.value, 50.8, '2 in = 50.8 mm'); assert.equal(dd.printed_value, 2); assert.equal(dd.measured_mm, 50.8); assert.equal(dd.scale_ok, true);
});
test('v3.10: detail view, manual drawing dimensions, labelled preview and combine are validated before running', () => {
  const ok = (n, a) => { assert.equal(validate.get(n)(a), true, n + ' ' + JSON.stringify(a)); assert.equal(argumentError(n.slice(3), a), null, JSON.stringify(a)); };
  const bad = (n, a) => assert.ok(!validate.get(n)(a) || argumentError(n.slice(3), a), n + ' should refuse ' + JSON.stringify(a));
  ok('sw_drawing_views', { document_id: 'd', action: 'detail', sheet: 'Hoja1', view: 'Vista de dibujo1', radius_mm: 8, through_mm: [10, 0, 5], scale: 2 });
  bad('sw_drawing_views', { document_id: 'd', action: 'detail', sheet: 'Hoja1', view: 'V' });
  bad('sw_drawing_views', { document_id: 'd', action: 'set', sheet: 'Hoja1', view: 'V', scale: 1, radius_mm: 3 });
  bad('sw_drawing_views', { document_id: 'd', action: 'detail', sheet: 'Hoja1', view: 'V', radius_mm: 3, flip: true });
  ok('sw_drawing_dimension', { document_id: 'd', action: 'probe', sheet: 'Hoja1', view: 'V', kind: 'circle' });
  ok('sw_drawing_dimension', { document_id: 'd', action: 'add', sheet: 'Hoja1', view: 'V', edges: [3, 7], type: 'angle', position_mm: [100, 80] });
  bad('sw_drawing_dimension', { document_id: 'd', action: 'add', sheet: 'Hoja1', view: 'V' });
  bad('sw_drawing_dimension', { document_id: 'd', action: 'add', sheet: 'Hoja1', view: 'V', edges: [1, 2, 3] });
  bad('sw_drawing_dimension', { document_id: 'd', action: 'probe', sheet: 'Hoja1', view: 'V', edges: [1] });
  const guided = { document_id: 'd', action: 'guided', sheet: 'Hoja1', view: 'V', guides: [{ edge: 3, at: 'end', turn_deg: 30, length_mm: 8 }], feet: [{ edge: 3 }, { guide: 0 }], type: 'angle', expect: 30 };
  ok('sw_drawing_dimension', guided);
  bad('sw_drawing_dimension', { ...guided, expect: undefined });
  bad('sw_drawing_dimension', { ...guided, type: 'diameter' });
  bad('sw_drawing_dimension', { ...guided, guides: [{ edge: 3, at: 'end' }] });
  bad('sw_drawing_dimension', { document_id: 'd', action: 'add', sheet: 'Hoja1', view: 'V', edges: [1], expect: 3 });
  ok('sw_drawing_edit', { document_id: 'd', action: 'list', sheet: 'Hoja1' });
  ok('sw_drawing_edit', { document_id: 'd', action: 'delete', sheet: 'Hoja1', near_mm: [120, 80], value: 1570.796 });
  ok('sw_drawing_edit', { document_id: 'd', action: 'move_text', sheet: 'Hoja1', near_mm: [120, 80], radius_mm: 5, to_mm: [130, 90] });
  ok('sw_drawing_edit', { document_id: 'd', action: 'move_view', sheet: 'Hoja1', view: 'V1', by_mm: [10, -5] });
  ok('sw_drawing_edit', { document_id: 'd', action: 'title_text', sheet: 'Hoja1', find: 'HOJA 1 DE 1', replace: 'HOJA 1 DE 2' });
  ok('sw_drawing_edit', { document_id: 'd', action: 'black', sheet: 'Hoja1', notes: true });
  bad('sw_drawing_edit', { document_id: 'd', action: 'delete', sheet: 'Hoja1' });
  bad('sw_drawing_edit', { document_id: 'd', action: 'move_text', sheet: 'Hoja1', near_mm: [1, 2] });
  bad('sw_drawing_edit', { document_id: 'd', action: 'move_view', sheet: 'Hoja1', view: 'V1', by_mm: [1, 2], to_mm: [3, 4] });
  bad('sw_drawing_edit', { document_id: 'd', action: 'title_text', sheet: 'Hoja1', replace: 'x' });
  bad('sw_drawing_edit', { document_id: 'd', action: 'list' });
  ok('sw_preview', { document_id: 'd' });
  ok('sw_preview', { document_id: 'd', views: ['front', 'top', 'iso'], label_faces: true, max_labels: 30 });
  bad('sw_preview', { document_id: 'd', views: ['side'] });
  bad('sw_preview', { document_id: 'd', max_labels: 5 });
  ok('sw_combine', { document_id: 'd', operation: 'subtract', main_point_mm: [0, 0, 10], tool_points_mm: [[5, 5, 20]] });
  ok('sw_combine', { document_id: 'd', operation: 'add' });
  bad('sw_combine', { document_id: 'd', operation: 'subtract' });
  bad('sw_combine', { document_id: 'd', operation: 'union' });
  bad('sw_combine', { document_id: 'd', operation: 'subtract', main_index: 0, main_point_mm: [0, 0, 0] });
  assert.equal(tools.find(t => t.operation === 'combine').annotations.readOnlyHint, false);
});

// ---------- v3.11 ----------
import { compactWorkerResponse } from './compact.mjs';
import { sessionRecipe, recordCall } from './session_recorder.mjs';
import { mkdtempSync, readFileSync as rf311, existsSync as ex311, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as j311 } from 'node:path';
test('v3.11: big assembly inspections are compacted to top-level components with a details file', () => {
  const root = mkdtempSync(j311(tmpdir(), 'sw311-'));
  const comps = [{ name: 'A-1', path: 'C:\\x\\A.SLDASM', fixed_position: true, transform: [1,0,0,0,1,0,0,0,1,-0.2,0,0,1,0,0,0], unsaved_changes: false }];
  for (let i = 0; i < 60; i++) comps.push({ name: `A-1/P${i}-1`, path: `C:\\x\\P${i}.SLDPRT`, fixed_position: true, transform: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], unsaved_changes: i < 3 });
  const raw = { ok: true, result: { component: 'A-1', inspection: { title: 'T', mass_g: 5, components: comps } } };
  const c = compactWorkerResponse(raw, root, 'insert_component');
  assert.equal(c.result.inspection.components.length, 1);
  assert.deepEqual(c.result.inspection.components[0], { name: 'A-1', file: 'A.SLDASM', fixed: true, origin_mm: [-200, 0, 0], unsaved: undefined, nested_components: 60 });
  assert.equal(c.result.inspection.component_count, 61); assert.equal(c.result.inspection.unsaved_count, 3);
  assert.ok(ex311(c.details_file)); assert.equal(JSON.parse(rf311(c.details_file, 'utf8')).result.inspection.components.length, 61);
  assert.equal(compactWorkerResponse({ ok: true, result: { inspection: { components: comps.slice(0, 5) } } }, root, 'x').details_file, undefined);
  rmSync(root, { recursive: true, force: true });
});
test('v3.11: session_recipe records changing calls and exports a recipe without document ids', () => {
  const root = mkdtempSync(j311(tmpdir(), 'sw311r-')), recipes = mkdtempSync(j311(tmpdir(), 'sw311d-'));
  const prev = process.env.SW_MCP_RECIPES_DIR;
  try {
    assert.throws(() => sessionRecipe({ action: 'export' }, { root }), /No hay grabación/);
    assert.equal(sessionRecipe({ action: 'start', name: 'Prueba' }, { root }).recording, true);
    recordCall(root, 'assembly_new', { path: 'C:\\g\\A.SLDASM', template: 't' }, { ok: true, result: { document_id: 'abc', path: 'C:\\g\\A.SLDASM' } }, 1200);
    recordCall(root, 'inspect', { document_id: 'abc' }, { ok: true, result: {} }, 10);
    recordCall(root, 'insert_component', { document_id: 'abc', path: 'C:\\g\\P.SLDPRT', fit_box: { axis: 'x', from_mm: 0, to_mm: 10 } }, { ok: true, result: { component: 'P-1' } }, 900);
    recordCall(root, 'add_mate', { document_id: 'abc', type: 'coincident' }, { ok: false, error: 'boom' }, 50);
    const st = sessionRecipe({ action: 'status' }, { root }); assert.equal(st.steps, 4);
    assert.ok(st.last.every(s => !('document_id' in s.args) || s.args.document_id === '<id del documento>'));
    assert.ok(st.last.some(s => s.args.document === 'A.SLDASM'));
  } finally { if (prev === undefined) delete process.env.SW_MCP_RECIPES_DIR; else process.env.SW_MCP_RECIPES_DIR = prev; rmSync(root, { recursive: true, force: true }); rmSync(recipes, { recursive: true, force: true }); }
});
test('v3.11: plan accepts fit_box, mate expect, find descriptions and rejects bad ones', () => {
  const base = { ir: 'assembly-ir/1', name: 'X', components: [{ id: 'A', file: 'a.SLDPRT', fixed: true }, { id: 'B', file: 'sub/b.SLDASM', fit_box: { axis: 'x', from_mm: -10, to_mm: 5 } }],
    mates: [{ type: 'distance', distance_mm: 5, align: 'aligned', entities: [{ component: 'A', find: { extreme: '+x' } }, { component: 'B', find: { pick: 'largest', kind: 'plane' } }], expect: { component: 'B', origin_mm: [1, 2, 3] } }] };
  assert.deepEqual(checkAssemblyPlan(base).errors, []);
  const bad = structuredClone(base); bad.components[1].fit_box = { axis: 'w', from_mm: 5, to_mm: 1 }; bad.mates[0].expect = { component: 'Z', origin_mm: [1] }; bad.mates[0].entities[0].find = { extreme: 'up' }; bad.components[0].file = '../a.SLDPRT';
  const e = checkAssemblyPlan(bad).errors.join('\n');
  for (const k of ['fit_box', 'expect', 'find.extreme', 'components[0].file']) assert.match(e, new RegExp(k.replace(/[.[\]]/g, '\\$&')));
});
test('v3.11: new tools and options validate', () => {
  const ok = (t, a) => assert.ok(validate.get(t)(a), t + ' ' + JSON.stringify(validate.get(t).errors));
  const no = (t, a) => assert.ok(!validate.get(t)(a), t + ' should fail');
  ok('sw_insert_components', { document_id: 'x', items: [{ path: 'C:\\a.SLDPRT', fit_box: { axis: 'x', from_mm: 0, to_mm: 1 }, fixed: true }] });
  no('sw_insert_components', { document_id: 'x', items: [] });
  ok('sw_insert_component', { document_id: 'x', path: 'C:\\a.SLDPRT', fit_box: { axis: 'z', from_mm: -5, to_mm: 5, tolerance_mm: 0.1 } });
  ok('sw_add_mate', { document_id: 'x', type: 'distance', distance_mm: 2, entities: [{ component: 'a' }, { component: 'b' }], expect: { component: 'b', origin_mm: [0, 0, 1] } });
  ok('sw_move_component', { document_id: 'x', component: 'a', position_mm: [0, 0, 0], allow_fixed: true });
  ok('sw_find_faces', { document_id: 'x', component: 'a', extreme: '+z' }); no('sw_find_faces', { document_id: 'x', pick: 'biggest' });
  ok('sw_drawing_dimension', { document_id: 'x', action: 'auto', sheet: 'Hoja1', view: 'V1', max_circles: 5 });
  ok('sw_wrap', { document_id: 'x', sketch: 'Croquis2', face_point_mm: [0, 10, 5], type: 'deboss', depth_mm: 0.5 }); no('sw_wrap', { document_id: 'x', sketch: 'S', face_point_mm: [0, 0, 0], type: 'carve' });
  ok('sw_boundary', { document_id: 'x', profiles: ['A', 'B'], guides: ['G'], cut: false }); no('sw_boundary', { document_id: 'x', profiles: ['A'] });
  ok('sw_session_recipe', { action: 'export', id: 'mi-receta', notes: 'n' }); no('sw_session_recipe', { action: 'export', id: 'Mal Id' });
  ok('sw_assembly_build', { action: 'check', plan: {}, keep_open: true });
});

// v3.14 (motor lineal): side checks, final posture, appearance in the IR, delivery and clean names
test('v3.14: auto_expect pone expect en distancias/coincidentes de la pieza que se mueve', async () => {
  const { applyAutoExpect, checkAssemblyPlan } = await import('./assembly_build.mjs');
  const plan = { ir: 'assembly-ir/1', name: 'm', auto_expect: { tolerance_mm: 0.5 }, components: [
    { id: 'cig', file: 'c.SLDPRT', fixed: true }, { id: 'biela', file: 'b.SLDPRT', position_mm: [156, 44, 0] }, { id: 'tapa', file: 't.SLDPRT', position_mm: [156, 44, 0] }],
    mates: [{ type: 'coincident', entities: [{ component: 'biela', plane: 'Alzado' }, { assembly_plane: 'Alzado' }] },
      { type: 'distance', distance_mm: 156, entities: [{ component: 'biela', plane: 'Vista lateral' }, { assembly_plane: 'Vista lateral' }] },
      { type: 'coincident', entities: [{ component: 'biela', plane: 'Vista lateral' }, { component: 'tapa', plane: 'Vista lateral' }] },
      { type: 'concentric', entities: [{ component: 'biela', local_point_mm: [0, 0, 27], kind: 'face' }, { component: 'cig', local_point_mm: [156, 44, 27], kind: 'face' }] },
      { type: 'distance', distance_mm: 1, flip: true, expect: { component: 'biela', origin_mm: [0, 0, 0] }, entities: [{ component: 'biela', plane: 'Planta' }, { assembly_plane: 'Planta' }] }] };
  const p = applyAutoExpect(plan);
  assert.deepEqual(p.mates[0].expect, { component: 'biela', origin_mm: [156, 44, 0], tolerance_mm: 0.5 });
  assert.equal(p.mates[1].expect.component, 'biela');
  assert.equal(p.mates[2].expect.component, 'tapa', 'la tapa no tenía relaciones: es la que se mueve');
  assert.equal(p.mates[3].expect, undefined, 'concéntricas no');
  assert.deepEqual(p.mates[4].expect, { component: 'biela', origin_mm: [0, 0, 0] }, 'un expect propio se respeta');
  assert.equal(applyAutoExpect({ ...plan, auto_expect: false }).mates[0].expect, undefined, 'sin auto_expect no toca nada');
  assert.deepEqual(checkAssemblyPlan(p).errors, []);
  assert.ok(checkAssemblyPlan({ ...plan, auto_expect: 'si' }).errors.some(e => /auto_expect/.test(e)));
  assert.ok(checkAssemblyPlan({ ...plan, expect: { posture: { tolerance_mm: -1 } } }).errors.some(e => /posture/.test(e)));
});
test('v3.14: postureDeviations detecta piezas giradas 180 o del otro lado con 0 errores', async () => {
  const { postureDeviations } = await import('./assembly_build.mjs');
  const comps = [{ id: 'a', position_mm: [156, 44, 0] }, { id: 'b', position_mm: [270, -44, 0] }, { id: 'c', position_mm: [10, 0, 0], fit_box: {} }, { id: 'd', transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0.1, 0, 0, 1, 0, 0, 0] }];
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const actual = new Map([['a', [...I, 0.156, 0.044, 0]], ['b', [1, 0, 0, 0, -1, 0, 0, 0, -1, 0.270, -0.044, 0]], ['c', [...I, 9, 9, 9]], ['d', [0, 1, 0, -1, 0, 0, 0, 0, 1, -0.1, 0, 0]]]);
  const dev = postureDeviations(comps, actual);
  assert.deepEqual(dev.map(d => d.component), ['b', 'd']);
  assert.equal(dev[0].rotated_deg, 180); assert.equal(dev[0].offset_mm, 0);
  assert.equal(dev[1].offset_mm, 200); assert.equal(dev[1].rotated_deg, 0);
  assert.deepEqual(postureDeviations(comps, actual, { tolerance_mm: 500, tolerance_deg: 181 }), []);
});
test('v3.14: expect.posture vuelve falla la postura; sin él solo avisa', async () => {
  const f = await assemblyFixture();
  const run = async expect => { const { worker } = assemblyWorker({ inspect: () => ({ ok: true, result: { components: [{ name: 'real-1', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }, { name: 'real-2', transform: [-1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0] }] } }) });
    const plan = assemblyPlan(); plan.name = 'pose' + Math.random().toString(36).slice(2, 7); plan.components[1].position_mm = [0, 0, 0]; if (expect) plan.expect = { ...(plan.expect ?? {}), posture: true };
    return assemblyBuild({ action: 'build', batch: false, plan, parts_dir: f.parts_dir }, { worker, root: f.root }); };
  const warn = await run(false);
  assert.ok(warn.warnings.some(w => /postura: 1 componentes/.test(w)), JSON.stringify(warn.warnings));
  assert.equal(warn.verification.posture.off, 1);
  const fail = await run(true);
  assert.equal(fail.ok, false); assert.ok(fail.differences.some(d => d.quantity === 'posture' && d.components[0].rotated_deg === 180));
});
test('v3.14: IR appearance, sw_appearance y entrega de sw_pack_and_go', async () => {
  const { resolveIR: R } = await import('./part_ir.mjs');
  assert.deepEqual(R({ ...placa, appearance: { rgb: [0.96, 0.78, 0.4], specular: 0.9 } }).appearance, { rgb: [0.96, 0.78, 0.4], specular: 0.9 });
  for (const bad of [{ rgb: [1, 1] }, { rgb: [0, 0, 255] }, { rgb: [0, 0, 0], specular: 2 }, 'rojo']) assert.ok(R({ ...placa, appearance: bad }).errors.some(e => /appearance/.test(e)), JSON.stringify(bad));
  const ap = validate.get('sw_appearance');
  assert.equal(ap({ document_id: 'x', rgb: [0.1, 0.2, 0.3] }), true);
  assert.equal(ap({ document_id: 'x', parts: [{ component: 'Biela', rgb: [0.96, 0.78, 0.4], specular: 0.9 }] }), true);
  assert.equal(ap({ document_id: 'x', rgb: [0.1, 0.2, 3] }), false);
  const pg = validate.get('sw_pack_and_go');
  assert.equal(pg({ document_id: 'x', folder_name: 'motor', deliver_to: 'C:\\Users\\u\\Downloads\\Motor lineal', main_name: 'Motor lineal.SLDASM', rename: { 'Cigueñal_2.SLDPRT': 'Cigueñal.SLDPRT' }, zip: true, open_visible: true }), true);
  assert.equal(pg({ document_id: 'x', folder_name: 'motor', rename: { 'a.SLDPRT': 'sub\\b.SLDPRT' } }), false);
  assert.equal(pg({ document_id: 'x', folder_name: 'motor', main_name: 'a/b' }), false);
});
test('v3.14: worker sin timeout suave cuando timeoutMs es 0', async () => {
  const w = new WorkerClient({ timeoutMs: 20, executable: process.execPath, args: ['-e', "process.stdin.on('data',()=>setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result:1})+'\\n'),80))"] });
  try {
    await assert.rejects(w.call('x', {}), /still running/);
    await new Promise(r => setTimeout(r, 120)); w.takeLate();
    assert.deepEqual(await w.call('x', {}, { timeoutMs: 0 }), { ok: true, result: 1 });
  } finally { w.close(); }
});

// v3.15 supervision of drawing dimensions (real numbers from the CIGUENAL_MOTOR sheet)
const dimH = (id, value, x0, x1, y, extra = {}) => { const cx = extra.cx ?? (x0 + x1) / 2, line = y - 2.8; return { id: 'V1#' + id, view: 'V1', name: 'D' + id, type: 2, hole_callout: false, value, unit: 'mm', text: ' ' + value.toFixed(2) + ' ', pos: [cx, y], start: [cx - 7.2, line], height: 3.5, angle: 0, lines: [[x0, 100, x0, line + 1], [x1, 100, x1, line + 1], [x0, line, x1, line]], arcs: 0 }; };
const sheetOf = (dimensions, extra = {}) => ({ sheet: 'H', active_sheet: 'H', sheets: ['H'], sheet_mm: [280, 216], title_block_mm: [142, 0, 280, 36], views: [{ name: 'V1', scale: 0.1, outline_mm: [50, 100, 120, 125] }], notes: [], dimensions, ...extra });
function fakeDrawing(geo, { worsen = false } = {}) {
  const calls = [];
  return { calls, geo, call: async (op, a) => {
    calls.push([op, a]);
    if (op === 'drawing_dim_geometry') return { ok: true, result: structuredClone(geo) };
    if (op !== 'drawing_dim_apply') return { ok: false, error: 'unexpected ' + op };
    for (const id of a.deletes ?? []) geo.dimensions = geo.dimensions.filter(d => d.id !== id);
    const bad = worsen; worsen = false; // only the first plan goes wrong: the way back must work
    for (const m of a.moves ?? []) { const d = geo.dimensions.find(x => x.id === m.id); if (!d) continue;
      const to = bad ? [60, 112] : m.pos, dx = to[0] - d.pos[0], dy = to[1] - d.pos[1];
      d.pos = to; d.start = [d.start[0] + dx, d.start[1] + dy]; d.lines = d.lines.map(([x1, y1, x2, y2], i) => i < 2 ? [x1, y1, x2, y2 + dy] : [x1 + 0, y1 + dy, x2 + 0, y2 + dy]); }
    return { ok: true, result: { moved: (a.moves ?? []).length, deleted: a.deletes ?? [], missed: [] } };
  } };
}
test('v3.15 dim check: the text box is where the PDF shows it, not at the annotation position', async () => {
  const { textBox } = await import('./dims_layout.mjs');
  // 52.31 vertical of the crankshaft: PDF ink x 26.6..31.3, y 106.4..120.6
  const b = textBox({ pos: [28.1, 113.48], start: [30.878, 106.368], angle: Math.PI / 2 }, 14, 3.5);
  assert.ok(Math.abs(b.x - 28.95) < 0.2, 'across ' + b.x); assert.ok(Math.abs(b.y - 113.48) < 0.01, 'along ' + b.y);
  const r = textBox({ pos: [163.6, 87], start: [156.1, 91.3], angle: 5.76 }, 15, 3.5);
  assert.ok(Math.hypot(r.x - 163.6, r.y - 87) < 3);
});
test('v3.15 dim check: finds overlaps, lines across texts, texts on views, title block, off-sheet and duplicates', async () => {
  const { readSheet, findIssues, errorCount } = await import('./dims_layout.mjs');
  const a = dimH(0, 15, 60, 61.5, 90, { cx: 60 }), b = dimH(1, 38, 55, 58.8, 90, { cx: 62 });
  const crossed = dimH(2, 40, 60, 64, 60, { cx: 62 }), over = dimH(3, 70, 50, 120, 112), tb = dimH(4, 100, 60, 70, 20, { cx: 200 }), off = dimH(5, 20, 60, 62, 214, { cx: 278 });
  const twin1 = dimH(6, 90, 80, 89, 50, { cx: 40 }), twin2 = dimH(7, 90, 80, 89, 44, { cx: 40 });
  const i = findIssues(readSheet(sheetOf([a, b, crossed, over, tb, off, twin1, twin2])));
  assert.ok(i.text_overlap.some(x => x.ids.includes('V1#0') && x.ids.includes('V1#1')));
  assert.ok(i.text_on_line.some(x => x.ids[0] === 'V1#2'), 'a line of 15 or 38 runs through the text at y 60');
  assert.ok(i.text_on_view.some(x => x.ids[0] === 'V1#3'));
  assert.ok(i.over_title_block.some(x => x.ids[0] === 'V1#4'));
  assert.ok(i.out_of_sheet.some(x => x.ids[0] === 'V1#5'));
  assert.deepEqual(i.duplicate.map(x => x.ids), [['V1#7']]);
  assert.ok(errorCount(i) >= 6);
  const clean = findIssues(readSheet(sheetOf([dimH(0, 70, 50, 120, 90)])));
  assert.equal(errorCount(clean), 0); assert.equal(clean.repeated.length, 0);
});
test('v3.15 dim check: same value on another span is only reported; a dimension line through a view is an error', async () => {
  const { readSheet, findIssues } = await import('./dims_layout.mjs');
  const i = findIssues(readSheet(sheetOf([dimH(0, 15, 60, 61.5, 90, { cx: 35 }), dimH(1, 15, 70, 71.5, 80, { cx: 35 })])));
  assert.equal(i.duplicate.length, 0); assert.equal(i.repeated[0].count, 2);
  const j = findIssues(readSheet(sheetOf([dimH(0, 70, 50, 120, 115, { cx: 35 })])));
  assert.equal(j.dim_line_on_view.length, 1);
});
test('v3.15 dim check: the plan clears a stack of crowded dimensions, shortest nearest', async () => {
  const { readSheet, findIssues, planLayout, errorCount } = await import('./dims_layout.mjs');
  const crowd = [10, 20, 30, 40, 50, 60].map((L, k) => dimH(k, L * 10, 55, 55 + L, 112 + k * 0.5));
  const m = readSheet(sheetOf(crowd)), i = findIssues(m), p = planLayout(m, i);
  assert.ok(errorCount(i) > 0); assert.equal(p.unplaced.length, 0); assert.equal(p.moves.length, 6);
  const v = id => Math.abs(p.moves.find(x => x.id === id).pos[1] - 112.5);
  assert.ok(v('V1#0') < v('V1#5'), 'the shortest stays nearest to the view');
  const f = fakeDrawing(sheetOf(crowd));
  await f.call('drawing_dim_apply', { moves: p.moves });
  assert.equal(errorCount(findIssues(readSheet(f.geo))), 0);
});
test('v3.17 check: a dimension over another is seen: lines that cross or lie on each other. A foot landing on a line, or two extension lines, are not', async () => {
  const { segmentsCross, segmentsOnTop, readSheet, findIssues } = await import('./dims_layout.mjs');
  assert.equal(segmentsCross([0, 0, 10, 0], [5, -3, 5, 3]), true);
  assert.equal(segmentsCross([0, 0, 10, 0], [5, 0.1, 5, 3]), false, 'it lands on the line');
  assert.equal(segmentsCross([0, 0, 10, 0], [0.1, -3, 0.1, 3]), false, 'at its very end');
  assert.equal(segmentsCross([0, 0, 10, 0], [11, -3, 11, 3]), false);
  assert.equal(segmentsOnTop([0, 0, 10, 0], [5, 0.1, 20, 0.1]), true);
  assert.equal(segmentsOnTop([0, 0, 10, 0], [10, 0, 20, 0]), false, 'one after the other');
  assert.equal(segmentsOnTop([0, 0, 10, 0], [0, 2, 10, 2]), false);
  const leader = (id, x0, y0, x1, y1) => ({ id: 'V1#' + id, view: 'V1', name: 'R' + id, type: 5, hole_callout: false, value: 3, unit: 'mm', text: 'R3', pos: [x1, y1], height: 3.5, angle: 0, lines: [[x0, y0, x1, y1]], arcs: 0 });
  const across = findIssues(readSheet(sheetOf([dimH(0, 70, 50, 120, 90), leader(1, 85, 100, 85, 40)])));
  assert.deepEqual(across.lines_over.map(x => x.ids), [['V1#0', 'V1#1']], 'the leader goes through the dimension line');
  const bothExt = { ...dimH(1, 70, 60, 100, 70), lines: [[60, 100, 60, 68], [100, 100, 100, 68], [60, 67, 100, 67]] };
  assert.deepEqual(findIssues(readSheet(sheetOf([dimH(0, 70, 50, 120, 90), { ...bothExt }]))).lines_over.map(x => x.ids), [['V1#0', 'V1#1']], 'the lines of the far one go through the dimension line of the near one');
  const nested = [dimH(0, 40, 60, 100, 90), dimH(1, 70, 50, 120, 80)];
  assert.equal(findIssues(readSheet(sheetOf(nested))).lines_over.length, 0, 'the short one inside, the long one outside: nothing crosses');
});
test('v3.17 organize: a long dimension keeps its text by its line, and what would cross goes to the other side of the view', async () => {
  const { readSheet, findIssues, planLayout, errorCount } = await import('./dims_layout.mjs');
  // three on one side: nothing reaches the text of the outermost, it stays in the middle of its span instead of out past its feet
  const nested = [dimH(0, 15, 80, 86, 112), dimH(1, 20, 90, 98, 113), dimH(2, 70, 55, 115, 114)];
  const m = readSheet(sheetOf(nested)), p = planLayout(m, findIssues(m));
  const long = p.moves.find(x => x.id === 'V1#2');
  assert.ok(long.pos[0] > 55 + 8 && long.pos[0] < 115 - 8, 'by its line: ' + long.pos[0]);
  // two that overlap only in part: one foot of each falls inside the other, so on the same side they cross whatever the order
  const staggered = [dimH(0, 30, 60, 90, 112), dimH(1, 30, 75, 105, 113)];
  const s = readSheet(sheetOf(staggered)), q = planLayout(s, findIssues(s));
  assert.equal(q.unplaced.length, 0);
  const ys = staggered.map(d => q.moves.find(x => x.id === d.id).pos[1]);
  assert.ok((ys[0] - 112) * (ys[1] - 112) < 0, 'one above, one below: ' + ys);
  // a radius whose straight way out goes through a dimension takes another way, or it goes further
  const line = dimH(0, 70, 50, 120, 90);
  const radius = { id: 'V1#1', view: 'V1', name: 'R1', type: 5, hole_callout: false, value: 50, unit: 'mm', text: 'R5.00', pos: [85, 112], height: 3.5, angle: 0, lines: [[85, 107, 85, 112]], arcs: 0 };
  const g = readSheet(sheetOf([line, radius])), r = planLayout(g, findIssues(g)), to = r.moves.find(x => x.id === 'V1#1');
  assert.ok(to, 'it has to leave the view');
  const placed = structuredClone(sheetOf([line, radius])), rd = placed.dimensions[1]; rd.pos = to.pos; rd.lines = [[85, 107, ...to.pos]];
  assert.equal(findIssues(readSheet(placed)).lines_over.length, 0);
});
const turned = (x, y, hw, hh, a = 0) => ({ x, y, hw, hh, a });
const dimV = (id, value, y0, y1, xl, from, extra = {}) => { const cy = extra.cy ?? (y0 + y1) / 2; return { id: 'V1#' + id, view: 'V1', name: 'D' + id, type: 2, hole_callout: false, value, unit: 'mm', text: ' ' + value.toFixed(2) + ' ', pos: [xl - 2.78, cy], start: [xl, cy - 7.2], height: 3.5, angle: Math.PI / 2, lines: [[from, y0, xl + 1, y0], [from, y1, xl + 1, y1], [xl, y0, xl, y1]], arcs: 0 }; };
const shapeOf = (view, origin, rects, arcs = []) => { const x0 = Math.min(...rects.map(r => r[0])) - 5, y0 = Math.min(...rects.map(r => r[1])) - 5, y1 = Math.max(...rects.map(r => r[3])) + 5, rows = []; for (let y = y0; y < y1; y += 0.5) { const sp = rects.filter(r => y + 0.25 > r[1] && y + 0.25 < r[3]).map(r => [Math.round((r[0] - x0) / 0.5), Math.round((r[2] - x0) / 0.5)]).sort((a, b) => a[0] - b[0]); rows.push(sp.flat()); } return { view, cell_mm: 0.5, x0, y0, origin_mm: origin, rows, arcs }; };
const IBEAM = [[40, 60, 120, 70], [78, 70, 82, 140], [40, 140, 120, 150]], IVIEW = { name: 'V1', scale: 0.1, outline_mm: [30, 50, 130, 160], origin_mm: [80, 105] };
test('v3.17 check: boxes and lines, near and far, turned or not', async () => {
  const { boxesOverlap, lineHitsBox } = await import('./dims_layout.mjs');
  assert.equal(boxesOverlap(turned(0, 0, 5, 1), turned(9, 0, 5, 1)), true);
  assert.equal(boxesOverlap(turned(0, 0, 5, 1), turned(11, 0, 5, 1)), false);
  assert.equal(boxesOverlap(turned(0, 0, 5, 1), turned(10.5, 0, 5, 1), 1), true, 'with room around');
  assert.equal(boxesOverlap(turned(0, 0, 5, 1), turned(9.9, 0, 5, 1), -0.2), false, 'a touch does not count');
  assert.equal(boxesOverlap(turned(0, 0, 5, 0.5, Math.PI / 4), turned(3, 3, 1, 1)), true);
  assert.equal(boxesOverlap(turned(0, 0, 5, 0.5, Math.PI / 4), turned(3, -3, 1, 1)), false);
  assert.equal(boxesOverlap(turned(0, 0, 5, 1), turned(100, 100, 5, 1), 3), false);
  assert.equal(lineHitsBox([-10, 0, 10, 0], turned(0, 0, 3, 1)), true);
  assert.equal(lineHitsBox([-10, 5, 10, 5], turned(0, 0, 3, 1)), false);
  assert.equal(lineHitsBox([-10, 5, 10, 5], turned(0, 0, 3, 1), 4.5), true);
  assert.equal(lineHitsBox([2, -2, 2, 2], turned(0, 0, 3, 0.2, Math.PI / 2)), false, 'turned, it stands along the line');
  assert.equal(lineHitsBox([100, 100, 110, 100], turned(0, 0, 3, 1)), false);
});
test('v3.17 check: lines read as one, an arrow run through; a stack from one foot is neither', async () => {
  const { segmentsAlong, onArrowTip, readSheet, findIssues } = await import('./dims_layout.mjs');
  assert.equal(segmentsAlong([0, 0, 10, 0], [0, 0.3, 10, 0.5]), true);
  assert.equal(segmentsAlong([0, 0, 10, 0], [0, 2, 10, 2]), false);
  assert.equal(segmentsAlong([0, 0, 2, 0], [0, 0.2, 2, 0.2]), false, 'too short to be read as a line');
  assert.equal(segmentsAlong([0, 0, 10, 0], [5, -3, 5, 3]), false);
  assert.equal(onArrowTip([5, 0, 1, 0], [3, -2, 7, 2]), true);
  assert.equal(onArrowTip([5, 0, 1, 0], [5, -3, 5, 3]), false, 'square to the arrow: stacked from the same place');
  assert.equal(onArrowTip([5, 0, 1, 0], [5, 0, 15, 0]), false, 'in line with the arrow: the next of a chain');
  assert.equal(onArrowTip([5, 0, 1, 0], [20, -2, 24, 2]), false);
  assert.equal(findIssues(readSheet(sheetOf([dimH(0, 300, 60, 90, 90), dimH(1, 600, 60, 120, 80)]))).lines_over.length, 0);
  const leader = { id: 'V1#1', view: 'V1', name: 'R1', type: 5, hole_callout: false, value: 3, unit: 'mm', text: 'R3', pos: [48, 80], height: 3.5, angle: 0, lines: [[66, 90.8, 48, 80]], arcs: 0 };
  assert.equal(findIssues(readSheet(sheetOf([dimH(0, 300, 60, 90, 90), leader]))).lines_over.length, 1, 'through the point of the arrow, without crossing the line');
});
test('v3.17 check: an extension line may go through the tail of an arrow, away from the arrow itself', async () => {
  const { readSheet, findIssues } = await import('./dims_layout.mjs');
  const small = { ...dimH(0, 20, 60, 62, 90, { cx: 70 }), lines: [[60, 100, 60, 88.2], [62, 100, 62, 88.2], [53.65, 87.2, 60, 87.2], [60, 87.2, 62, 87.2], [62, 87.2, 75.14, 87.2]] };
  const read = readSheet(sheetOf([small])).dims[0];
  assert.deepEqual([read.lin.u0, read.lin.u1], [60, 62]);
  assert.deepEqual(read.tails, [[53.65, 87.2, 60, 87.2]], 'the piece with the text is not a tail');
  assert.equal(findIssues(readSheet(sheetOf([small, dimH(1, 300, 55, 85, 70)]))).lines_over.length, 0, '5 mm from the arrow');
  assert.equal(findIssues(readSheet(sheetOf([small, dimH(1, 270, 58, 85, 70)]))).lines_over.length, 1, 'on the arrow');
  // the real 5.00 of the connecting rod: text out on one side, no extension lines
  const five = { ...dimH(0, 50, 120.8, 125.8, 110), text: '5.00', pos: [132.3, 110.1], start: [128.4, 107.3], lines: [[125.8, 107.3, 136.2, 107.3], [125.8, 107.3, 120.8, 107.3], [120.8, 107.3, 114.45, 107.3]] };
  const r5 = readSheet(sheetOf([five])).dims[0];
  assert.deepEqual([r5.lin.u0, r5.lin.u1], [120.8, 125.8]);
  assert.deepEqual(r5.tails, [[120.8, 107.3, 114.45, 107.3]]);
});
test('v3.17 plan: what would be drawn for each place: tails, the text out, the gap of an extension line, the rays of an angle', async () => {
  const { readSheet, candidatesForTest: { linearCandidate, angleCandidate } } = await import('./dims_layout.mjs');
  const rd = d => readSheet(sheetOf([d])).dims[0], near = (a, b) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 0.02), JSON.stringify(a) + ' / ' + JSON.stringify(b));
  const wide = rd(dimH(0, 300, 60, 90, 90));
  let c = linearCandidate(wide, 70, 75);
  assert.equal(c.main.length, 1); assert.deepEqual(c.tails, []);
  c = linearCandidate(wide, 70, 110);
  assert.equal(c.main.length, 2); assert.ok(c.track.hi > 110); assert.deepEqual(c.tails, [], 'the piece out to the text is no tail');
  const narrow = rd(dimH(0, 130, 60, 73, 90));
  c = linearCandidate(narrow, 70, 66.5);
  assert.equal(c.main.length, 3); assert.equal(c.tails.length, 2);
  assert.ok(Math.abs(c.track.lo - 53.65) < 0.01 && Math.abs(c.track.hi - 79.35) < 0.01);
  c = linearCandidate(rd(dimH(0, 20, 60, 62, 90)), 70, 72);
  assert.ok(Math.abs(c.track.lo - 53.65) < 0.01); assert.equal(c.tails.length, 1);
  near(linearCandidate(wide, 70, 75).ext[0], [60, 100, 60, 67.2]);
  near(linearCandidate(wide, 132.8, 75).ext[0], [60, 102, 60, 130]);
  const ang = rd({ id: 'V1#0', view: 'V1', name: 'A0', type: 3, hole_callout: false, value: 60, unit: 'deg', text: '60°', pos: [107.52, 73], start: [105, 71], height: 3.5, angle: 2.09, lines: [[90, 60, 112, 60], [87.5, 64.33, 98.5, 83.38]], arc_list: [[111, 60, 98, 82.52, 85, 60]], arcs: 1 });
  const a = { ...ang, ang: { ...ang.ang, ends: [10, 10] } };
  near(angleCandidate(a, 30, Math.PI / 6).ext[0], [96, 60, 116, 60]);
  near(angleCandidate(a, 8, Math.PI / 6).ext[0], [90, 60, 94, 60]);
  near(angleCandidate(a, 3, Math.PI / 6).ext[0], [90, 60, 87, 60]);
  const inSector = l => [[l[0], l[1]], [l[2], l[3]]].every(([x, y]) => { const t = Math.atan2(y - 60, x - 85); return t > -0.01 && t < Math.PI / 3 + 0.01; });
  assert.ok(angleCandidate(a, 30, Math.PI / 6).main.every(inSector));
  assert.ok(!angleCandidate(a, 12, Math.PI / 6).main.every(inSector), 'no room for the arrows inside: tails');
});
test('v3.17 plan: two dimensions in a chain share a line; with tails they cannot', async () => {
  const { readSheet, findIssues, planLayout } = await import('./dims_layout.mjs');
  const ys = list => { const m = readSheet(sheetOf(list)), p = planLayout(m, findIssues(m)); assert.equal(p.unplaced.length, 0); return p.moves.map(x => x.pos[1]); };
  const [a, b] = ys([dimH(0, 300, 60, 90, 112), dimH(1, 300, 90, 120, 112)]);
  assert.ok(Math.abs(a - b) < 0.01, 'one line: ' + a + ' ' + b);
  const [c, d] = ys([dimH(0, 130, 60, 73, 112), dimH(1, 300, 73, 103, 112)]);
  assert.ok(Math.abs(c - d) > 0.01, 'the tail of the short one would run over the other: ' + c + ' ' + d);
});
test('v3.17 plan: in the air beside a neck goes what is short; a long line would read as one more edge of the part', async () => {
  const { readSheet, findIssues, planLayout } = await import('./dims_layout.mjs');
  const shapes = { views: [shapeOf('V1', IVIEW.origin_mm, IBEAM)] }, lineX = (list, id) => { const m = readSheet(sheetOf(list, { views: [IVIEW] }), { shapes }), mv = planLayout(m, findIssues(m)).moves.find(x => x.id === id); return mv.pos[0] + 2.78; };
  const long = lineX([dimV(0, 600, 72, 132, 80, 78)], 'V1#0');
  assert.ok(long < 40 || long > 120, 'outside the part: ' + long);
  const short = lineX([dimV(1, 100, 100, 110, 80, 78)], 'V1#1');
  assert.ok(short > 40 && short < 120, 'beside the neck: ' + short);
});
test('v3.17 read: the centre of a radius from any of its leaders', async () => {
  const { readSheet } = await import('./dims_layout.mjs');
  const R = (lines, extra = {}) => readSheet(sheetOf([{ id: 'V1#0', view: 'V1', name: 'R0', type: 5, hole_callout: false, value: 50, unit: 'mm', text: 'R5.00', pos: [85, 112], height: 3.5, angle: 0, lines, arcs: 0, ...extra }])).dims[0].rad.center;
  assert.deepEqual(R([[85, 107, 85, 112], [85, 107, 85, 102]]), [85, 102], 'solid');
  assert.deepEqual(R([[85, 107, 85, 112]]), [85, 102], 'open');
  assert.deepEqual(R([[85, 107, 85, 102]], { arrow_side: 0, pos: [85, 104] }), [85, 102], 'its arrow inside');
  assert.deepEqual(R([[85, 107, 85, 112]], { arc_list: [[90, 102, 85, 107, 77, 99]] }), [77, 99], 'it comes with its arc');
  assert.deepEqual(R([[85, 107, 85, 112], [85, 107, 85, 97]], { type: 6, value: 100 }), [85, 102], 'a diameter crosses its circle');
});
test('v3.17 read: the shape of a view: what is part, what runs through it, between two arms', async () => {
  const { viewMask, readSheet, findIssues } = await import('./dims_layout.mjs');
  const s = shapeOf('V1', IVIEW.origin_mm, IBEAM), m = viewMask(s, IVIEW);
  assert.deepEqual(m.extent, [40, 60, 120, 150]);
  assert.equal(m.over(80, 100), true); assert.equal(m.over(60, 100), false); assert.equal(m.over(60, 65), true);
  const moved = viewMask(s, { ...IVIEW, origin_mm: [90, 105] });
  assert.equal(moved.over(90, 100), true, 'it goes with its view'); assert.equal(moved.over(80, 100), false);
  assert.ok(Math.abs(m.lineLen([70, 100, 90, 100]) - 4) < 0.3);
  assert.ok(m.lineThrough([40, 65, 120, 65]) > 70);
  assert.equal(m.lineThrough([40, 60, 120, 60]), 0, 'along an edge it hides nothing');
  assert.equal(m.boxHits(turned(60, 100, 5, 2)), false); assert.equal(m.boxHits(turned(80, 100, 5, 2)), true); assert.equal(m.boxHits(turned(70, 100, 5, 2), 4), true, 'with room around');
  const ring = viewMask(shapeOf('V1', [80, 105], [[60, 90, 100, 95], [60, 95, 65, 115], [95, 95, 100, 115], [60, 115, 100, 120]]), IVIEW);
  assert.equal(ring.over(80, 105), true, 'what a ring closes counts');
  const fork = viewMask(shapeOf('V1', [80, 105], [[40, 60, 50, 70], [70, 60, 80, 70], [40, 70, 80, 90]]), IVIEW);
  assert.equal(fork.over(60, 65), false, 'open between the arms'); assert.equal(fork.inRow(60, 65), true);
  const onNeck = { ...dimH(0, 100, 30, 40, 100, { cx: 80 }), lines: [[30, 90, 30, 97], [40, 90, 40, 97], [30, 97.2, 40, 97.2]] }, inAir = { ...onNeck, pos: [60, 100], start: [52.8, 97.2] };
  const seen = dim => findIssues(readSheet(sheetOf([dim], { views: [IVIEW] }), { shapes: { views: [s] } })).text_on_view.length;
  assert.equal(seen(onNeck), 1); assert.equal(seen(inAir), 0, 'inside the frame, in the air');
});
test('v3.17 read: where a ray of an angle starts past what it measures', async () => {
  const { readSheet } = await import('./dims_layout.mjs');
  // the 7° between the sides of the connecting rod, tangent to the R6.5 of its small end
  const ang = (lines, pos) => ({ id: 'V1#0', view: 'V1', name: 'A', type: 3, hole_callout: false, value: 7, unit: 'deg', text: '7°', pos, height: 3.5, angle: 0, lines, arcs: 1, arc_list: [[70.66 - 133.27 * Math.sin(0.0611), 174.4 - 133.27 * Math.cos(0.0611), 70.66 + 133.27 * Math.sin(0.0611), 174.4 - 133.27 * Math.cos(0.0611), 70.66, 174.4]] });
  const view = { name: 'V1', scale: 1, outline_mm: [50, 57, 92, 136], origin_mm: [70.66, 96.43] };
  const arc = { center: [70.66, 67.93], r: 6.5, start: [64.172, 68.33], end: [77.148, 68.33], mid: [70.66, 61.43] };
  const shapes = { views: [shapeOf('V1', [70.66, 96.43], [[68, 61.5, 73.3, 134]], [arc])] };
  const ends = (lines, pos) => readSheet(sheetOf([ang(lines, pos)], { views: [view] }), { shapes }).dims[0].ang.ends;
  for (const e of ends([], [70.66, 77.54])) assert.ok(Math.abs(e - 106.27) < 0.2, 'where it touches the round: ' + e);
  for (const e of ends([[64.111, 67.329, 62.463, 40.38], [77.209, 67.329, 78.857, 40.38]], [70.66, 41.13])) assert.ok(Math.abs(e - 106.27) < 0.05, 'the sheet says it: ' + e);
  // no round: as far as there is part beside it, also between two arms
  const fork = { views: [shapeOf('V1', [70.66, 96.43], [[50, 60, 60, 70], [80, 60, 90, 70], [50, 70, 90, 90]])] };
  const down = { ...ang([], [70, 40]), arc_list: [[70, 40, 80, 41, 70, 100]] }, r = readSheet(sheetOf([down], { views: [view] }), { shapes: fork }).dims[0].ang;
  assert.ok(Math.abs(r.ends[0] - 40) < 1, 'to the end of the arms: ' + r.ends[0]);
  // the ray of the 30° from the vertex to an arc on its own line says nothing about where it ends
  const onIt = { ...ang([[70, 99, 70, 90]], [75, 90]), arc_list: [[70, 90, 80, 92, 70, 100]] }, t = readSheet(sheetOf([onIt], { views: [view] }), { shapes: fork }).dims[0].ang;
  assert.ok(t.feet[0] < 1.5 && Math.abs(t.ends[0] - 40) < 1, JSON.stringify(t));
});
test('v3.17 last touch: a diameter is not moved to lie on the line of another dimension', async () => {
  const { readSheet, planLeaders, findIssues } = await import('./dims_layout.mjs');
  const view = { name: 'A', outline_mm: [100, 100, 140, 180], scale: 1 }, dia = { id: 'A#0', name: 'D1@C', view: 'A', type: 6, value: 20, unit: 'mm', text: '<MOD-DIAM>20', pos: [120, 195], start: [114, 195], angle: Math.PI / 2, height: 3.5, lines: [[120, 150, 120, 197]] };
  const free = planLeaders(readSheet({ sheet_mm: [280, 216], views: [view], notes: [], dimensions: [dia] }));
  assert.equal(free.length, 1); const slope = Math.abs(Math.sin(Math.atan2(free[0].pos[1] - 140, free[0].pos[0] - 120))); assert.ok(slope > 0.4 && slope < 0.8 && (free[0].pos[0] > 140 || free[0].pos[0] < 100), 'out of the view on a slant when nothing is there: ' + free[0].pos);
  // the extension line of a dimension runs where that level leader would go
  const other = { id: 'A#1', name: 'D2@C', view: 'A', type: 2, value: 40, unit: 'mm', text: ' 40.00 ', pos: [60, 120], start: [60, 112], angle: Math.PI / 2, height: 3.5, lines: [[110, 140, 58, 140], [110, 100, 58, 100], [59, 140, 59, 100]] };
  const moves = planLeaders(readSheet({ sheet_mm: [280, 216], views: [view], notes: [], dimensions: [dia, other] })), m = moves.find(x => x.id === 'A#0');
  if (m) { const g = { sheet_mm: [280, 216], views: [view], notes: [], dimensions: [{ ...dia, pos: m.pos, lines: [[120, 140, ...m.pos]] }, other] }; assert.equal(findIssues(readSheet(g)).lines_over.length, 0, 'at ' + m.pos); }
});
test('v3.17 organize: a sheet left with problems because one view carries almost everything says which view and the scale to go up to', async () => {
  const { crowdedAdvice } = await import('./dims_layout.mjs');
  const views = new Map([['F', { scale: 0.5 }], ['S', { scale: 0.5 }], ['B', { scale: 0.1 }]]);
  const say = crowdedAdvice({ F: 17, S: 3, T: 1, 'A-A': 2 }, views, 3);
  assert.match(say, /^La vista F lleva 17 de las 23 cotas a escala 1:2 y quedan 3 problemas/);
  assert.match(say, /súbele la escala \(1:1\)/);
  assert.match(crowdedAdvice({ B: 9, S: 1 }, views, 1), /a escala 1:10 .*\(1:5\)/, 'one step up, not straight to full size');
  assert.doesNotMatch(crowdedAdvice({ X: 9 }, views, 1), /\(/, 'a view of unknown scale gets no number');
});

test('v3.17 needed: a tapered slot is said by the centres and radii of its ends, as drafted; its sides follow from them', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  // the slot of a connecting rod: R4 below and R2.8 above, 22 apart, its sides open some 6 degrees and touch both
  const a = Math.asin(1.2 / 22), c = Math.cos(a), s = Math.sin(a), arc = (y, r, sweep, box) => ({ axis: [0, 0, 1], point: [0, y, 0], r, sweep, inner: true, blend: false, box });
  const low = arc(-6.5, 4, Math.PI + 2 * a, [-4, -10.5, -2.5, 4, -6.5 + 4 * s, 2.5]), high = arc(15.5, 2.8, Math.PI - 2 * a, [-2.8 * c, 15.5 + 2.8 * s, -2.5, 2.8 * c, 18.3, 2.5]);
  const side = sign => ({ normal: [sign * c, -s, 0], box: [sign > 0 ? -4 * c : 2.8 * c, -6.5 + 4 * s, -2.5, sign > 0 ? -2.8 * c : 4 * c, 15.5 + 2.8 * s, 2.5], area: 110 });
  const rod = { planes: block([-10, 10], [-20, 30], [-2.5, 2.5]), rounds: [low, high], slanted: [side(1), side(-1)] };
  const plan = planNeeded(rod, [LIN('x', 0, -10, 10), LIN('y', 1, -20, 30), LIN('z', 2, -2.5, 2.5), ROUND('r4', 'R', 4), ROUND('r28', 'R', 2.8), LIN('centros', 1, -6.5, 15.5), LIN('arriba', 1, 15.5, 30), LIN('ancho', 0, -4 * c, 4 * c)], VIEWS3);
  assert.ok(namesOf(plan).includes('centros'), namesOf(plan).join());
  assert.ok(!namesOf(plan).includes('ancho'), 'the width is the R4: ' + namesOf(plan).join());
  assert.equal(plan.missing.length, 0, JSON.stringify(plan.missing));
  assert.equal(plan.report.sufficient, true, plan.report.summary);
});
test('v3.17 last touch: stacked sizes a hair apart (14 and 14.5) share their foot, the outer extension line does not cross the arrow of the inner one', async () => {
  const { readSheet, findIssues } = await import('./dims_layout.mjs');
  // as the connecting rod had them: the 14 with its text inside and its arrows out, the 14.5 one track further
  const view = { name: 'A', outline_mm: [90, 50, 127, 90], scale: 1 };
  const vertical = (id, value, x, from, top) => { const mid = (61.43 + top) / 2; return { id, name: 'D' + value + '@C', view: 'A', type: 2, value, unit: 'mm', text: ' ' + value.toFixed(2) + ' ', pos: [x - 2.778, mid], start: [x, mid - 7.112], angle: Math.PI / 2, height: 3.5,
    lines: [[from, 61.43, x + 1, 61.43], [from, top, x + 1, top], [x, 61.43, x, 55.08], [x, 61.43, x, top], [x, top, x, top + 6.35]] }; };
  const issues = findIssues(readSheet({ sheet_mm: [280, 216], views: [view], notes: [], dimensions: [vertical('A#0', 14, 142.008, 117.3, 75.43), vertical('A#1', 14.5, 148.138, 126.9, 75.93)] }));
  assert.equal(issues.lines_over.length, 0, JSON.stringify(issues.lines_over));
});
test('v3.17 last touch: a diameter leaves its circle on a slant, and its text keeps out from between the extension lines of another dimension', async () => {
  const { readSheet, planLeaders } = await import('./dims_layout.mjs');
  const view = { name: 'A', outline_mm: [100, 100, 140, 180], scale: 1 }, dia = { id: 'A#0', name: 'D1@C', view: 'A', type: 6, value: 20, unit: 'mm', text: '<MOD-DIAM>20', pos: [120, 195], start: [114, 195], angle: Math.PI / 2, height: 3.5, lines: [[120, 150, 120, 197]] };
  const at = dims => planLeaders(readSheet({ sheet_mm: [280, 216], views: [view], notes: [], dimensions: dims })).find(x => x.id === 'A#0').pos;
  const first = at([dia]), slope = Math.abs(Math.sin(Math.atan2(first[1] - 140, first[0] - 120)));
  assert.ok(first[0] > 140 && slope > 0.4 && slope < 0.8, 'out on the right on a slant: ' + first);
  // a 12 right there: between its extension lines the text would read as its value
  const y = first[1], side = { id: 'A#1', name: 'D2@C', view: 'A', type: 2, value: 12, unit: 'mm', text: ' 12.00 ', pos: [176, y], start: [176, y - 5], angle: Math.PI / 2, height: 3.5, lines: [[140, y - 6, 177, y - 6], [140, y + 6, 177, y + 6], [176, y - 6, 176, y + 6]] };
  const then = at([dia, side]); assert.ok(then[0] < 140 || Math.abs(then[1] - y) > 6, 'not between its lines: ' + then);
});
test('v3.17 plan: a radius goes to the arc that is drawn; in a hollow its arrow stays inside, and with no room inside it goes back to what the document says', async () => {
  const { readSheet, findIssues, planLayout } = await import('./dims_layout.mjs');
  const radius = (value, text, pos, lines, extra = {}) => ({ id: 'V1#0', view: 'V1', name: 'R1', type: 5, hole_callout: false, value, unit: 'mm', text, pos, start: [pos[0] - 8, pos[1]], height: 3.5, angle: 0, lines, arcs: 0, ...extra });
  const plan = (dim, view, rects, arcs) => { const m = readSheet(sheetOf([dim], { views: [view] }), { shapes: { views: [shapeOf('V1', view.origin_mm, rects, arcs)] } }); return planLayout(m, findIssues(m)); };
  // only a quarter of the circle is drawn: the leader comes from that side, also when the arc is a curve with no centre of its own
  const corner = { name: 'V1', scale: 1, outline_mm: [40, 70, 120, 130], origin_mm: [80, 100] }, wrongSide = [[76.46, 96.46, 70, 90], [76.46, 96.46, 80, 100]];
  for (const arc of [{ center: [80, 100], r: 5, start: [85, 100], end: [80, 105], mid: [83.54, 103.54] }, { start: [85, 100], end: [80, 105], curve: true }]) {
    const p = plan(radius(5, 'R5.00', [70, 90], wrongSide), corner, [[60, 80, 85, 100], [60, 100, 80, 105]], [arc]), mv = p.moves.find(x => x.id === 'V1#0'), to = Math.atan2(mv.pos[1] - 100, mv.pos[0] - 80) * 180 / Math.PI;
    assert.ok(to > 15 && to < 75, 'towards the arc, on a slant: ' + to + ' ' + JSON.stringify(arc));
  }
  // the bottom of a U: inside the circle there is air, around it there is part
  const u = { name: 'V1', scale: 1, outline_mm: [45, 95, 115, 145], origin_mm: [80, 120] }, walls = [[50, 100, 110, 120], [50, 120, 70, 140], [90, 120, 110, 140]], bottom = [{ center: [80, 130], r: 10, start: [70, 130], end: [90, 130], mid: [80, 120] }], crossing = [[80, 120, 80, 100], [80, 120, 80, 130]];
  const inside = plan(radius(10, 'R10.00', [80, 110], crossing, { angle: Math.PI / 2, start: [80, 101.5] }), u, walls, bottom).moves.find(x => x.id === 'V1#0');
  assert.equal(inside.arrows, 'inside', JSON.stringify(inside));
  assert.ok(Math.hypot(inside.pos[0] - 80, inside.pos[1] - 130) < 10, 'the text in the air: ' + inside.pos);
  const long = plan(radius(10, 'R10.00 R10.00 R10.00', [80, 130], [[80, 120, 80, 130]], { angle: Math.PI / 2, start: [80, 112], arrow_side: 0 }), u, walls, bottom).moves.find(x => x.id === 'V1#0');
  assert.equal(long.arrows, 'doc', 'it does not fit: ' + JSON.stringify(long));
});
test('v3.17 organize: each dimension to the view that says it best', async () => {
  const { assignViews, viewMask } = await import('./dims_layout.mjs');
  const square = [0, 0, 40, 40], F = { name: 'F', scale: 1, outline_mm: square, origin_mm: [20, 20], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, T = { name: 'T', scale: 1, outline_mm: square, origin_mm: [20, 20], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] }, S = { name: 'S', scale: 1, outline_mm: square, origin_mm: [20, 20], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }, A = { name: 'A', scale: 1, outline_mm: square, origin_mm: [20, 20], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]], section: true };
  const withMask = (v, arcs = []) => ({ ...v, mask: viewMask(shapeOf(v.name, v.origin_mm, [[5, 5, 35, 35]], arcs), v) });
  const arc = { center: [20, 20], r: 5, start: [25, 20], end: [20, 25], mid: [23.54, 23.54] }, views = new Map([withMask(F, [arc]), withMask(T), withMask(S), withMask(A)].map(v => [v.name, v]));
  const round = view => ({ view, type: 5, unit: 'mm', value: 5, mode: 'free', rad: { center: [20, 20] } }), line = (view, mode = 'h') => ({ view, mode, lin: { u0: 5, u1: 35 } });
  const to = (m, opts) => assignViews([m], views, opts).view_of.get(m.name);
  assert.equal(to({ name: 'R', value: 5, cls: 'R', dims: [round('T'), round('F')] }), 'F', 'where its arc is seen');
  assert.equal(to({ name: 'L', value: 30, cls: 'L', dims: [line('A'), line('T')] }), 'T', 'a section is for what is inside');
  assert.equal(to({ name: 'L@Cut@x', value: 30, cls: 'D', dims: [line('T'), line('A')] }, { hollow_names: new Set(['Cut']) }), 'A', '...and what is inside goes there');
  assert.equal(to({ name: 'L', value: 30, cls: 'L', look: 0, dims: [line('F'), line('S')] }), 'S', 'where its slanted face is seen on edge');
  assert.equal(to({ name: 'L', value: 30, cls: 'L', dims: [line('F'), line('S')] }, { prefer: new Map([['L', 'S']]) }), 'S', 'a pattern says where');
  // and they share: nobody gets them all
  const many = [...Array(6).keys()].map(i => ({ name: 'L' + i, value: 30 + i, cls: 'L', dims: [line('F'), line('T')] })), { load } = assignViews(many, views);
  assert.ok(Math.abs(load.F - load.T) <= 1, JSON.stringify(load));
});
test('v3.17 organize: a dimension with a foot on something a view does not show goes where it is seen', async () => {
  const { assignViews, viewMask } = await import('./dims_layout.mjs');
  const F = { name: 'F', scale: 1, outline_mm: [0, 0, 40, 40], origin_mm: [20, 20], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, A = { ...F, name: 'A', section: true, axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] };
  const withLines = (v, lines, arcs = []) => ({ ...v, mask: viewMask({ ...shapeOf(v.name, v.origin_mm, [[5, 5, 35, 35]], arcs), lines }, v) });
  // the web of a pulley, at 15, is only drawn in the section
  const views = new Map([['F', withLines(F, [[5, 5, 5, 35], [35, 5, 35, 35]])], ['A', withLines(A, [[5, 5, 5, 35], [15, 5, 15, 35], [35, 5, 35, 35]])]]);
  const to = u1 => assignViews([{ name: 'L', value: u1 - 5, cls: 'L', dims: ['F', 'A'].map(view => ({ view, mode: 'h', lin: { u0: 5, u1 } })) }], views).view_of.get('L');
  assert.equal(to(15), 'A', 'it would point at nothing in the other view');
  assert.equal(to(35), 'F', 'seen in both: a section is for what is inside');
  // a view that does not tell its edges says nothing, and it costs nothing
  assert.equal(viewMask(shapeOf('F', [20, 20], [[5, 5, 35, 35]]), F).seenAt(0, 15), undefined);
  // what counts as seen: an edge that stands or ends there, a round centred there or with its side there, the outline, also with the view moved
  const m = viewMask({ ...shapeOf('F', [20, 20], [[5, 5, 35, 35]]), lines: [[10, 10, 10, 20], [12, 30, 18, 33]], arcs: [{ center: [25, 25], r: 3, full: true }, { start: [28, 12], end: [30, 14], curve: true }] }, { ...F, origin_mm: [30, 25] });
  for (const [k, u] of [[0, 20], [0, 22], [0, 28], [1, 35], [0, 35], [0, 32], [0, 38], [0, 40], [0, 15], [1, 10]]) assert.equal(m.seenAt(k, u), true, k + ' ' + u);
  for (const [k, u] of [[0, 21], [0, 26], [1, 20]]) assert.equal(m.seenAt(k, u), false, k + ' ' + u);
});
test('v3.17 organize: a view in line with the front goes back into line when the front moved and it did not', async () => {
  const { planRealign } = await import('./dims_layout.mjs');
  const F = { name: 'F', model_type: 1, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, T = { name: 'T', model_type: 1, axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] }, A = { name: 'A', model_type: 1, section: true, axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] }, at = (v, outline_mm) => ({ ...v, outline_mm });
  const before = { views: [at(F, [60, 50, 90, 130]), at(T, [60, 150, 90, 170]), at(A, [60, 10, 90, 40])] };
  assert.deepEqual(planRealign(before, { views: [at(F, [51, 50, 81, 130]), at(T, [60, 150, 90, 170]), at(A, [60, 10, 90, 40])] }), [{ view: 'T', by: [-9, 0] }], 'a section keeps to its own line');
  assert.deepEqual(planRealign(before, before), []);
  assert.deepEqual(planRealign(before, { views: [at(F, [51, 50, 81, 130]), at(T, [51, 150, 81, 170])] }), [], 'it followed');
  const apart = { views: [at(F, [60, 50, 90, 130]), at(T, [100, 150, 130, 170])] };
  assert.deepEqual(planRealign(apart, { views: [at(F, [51, 50, 81, 130]), at(T, [100, 150, 130, 170])] }), [], 'it was not in line');
});
test('v3.15 dim check: never saves, deletes only exact duplicates, and reverts a plan that made the sheet worse', async () => {
  const { superviseDimensions, dimensionWarning } = await import('./dims_layout.mjs');
  const crowd = () => [dimH(0, 30, 55, 58, 112), dimH(1, 50, 55, 60, 113), dimH(2, 50, 55, 60, 80, { cx: 35 })];
  const ro = fakeDrawing(sheetOf(crowd()));
  const report = await superviseDimensions(ro, { document_id: 'd' });
  assert.ok(ro.calls.every(c => c[0] === 'drawing_dim_geometry' || c[0] === 'drawing_dim_shapes'), 'a check changes nothing');
  assert.equal(report.clean, false); assert.match(dimensionWarning(report), /sw_drawing_dim_check/);
  const fx = fakeDrawing(sheetOf(crowd()));
  const r = await superviseDimensions(fx, { document_id: 'd', fix: true });
  assert.ok(fx.calls.every(c => /^drawing_dim_/.test(c[0])), 'no save, no export');
  assert.deepEqual(fx.calls.flatMap(c => c[1].deletes ?? []), ['V1#2']);
  assert.equal(r.clean, true); assert.equal(dimensionWarning(r), null);
  const bad = fakeDrawing(sheetOf(crowd()), { worsen: true });
  const w = await superviseDimensions(bad, { document_id: 'd', fix: true, delete_duplicates: false });
  assert.ok(w.sheets[0].errors <= w.sheets[0].errors_before, 'never worse than it started');
});
test('v3.15 sw_drawing_dim_check schema', () => {
  const v = validate.get('sw_drawing_dim_check');
  assert.equal(v({ document_id: 'd' }), true); assert.equal(v({ document_id: 'd', fix: true, sheet: 'Hoja1', title_block_mm: [1, 2, 3, 4], margin_mm: 5 }), true);
  assert.equal(v({}), false); assert.equal(v({ document_id: 'd', title_block_mm: [1, 2] }), false); assert.equal(v({ document_id: 'd', nope: 1 }), false);
  assert.equal(validate.get('sw_drawing_annotate')({ document_id: 'd', check_layout: false }), true);
});

// v3.15 fewer dimensions, shared among the views
const dimOf = (name, view, value, x0, x1, extra = {}) => ({ ...dimH(0, value, x0, x1, 90), id: view + '#' + name, name, view, ...extra });
const readDims = async dims => (await import('./dims_layout.mjs')).readSheet(sheetOf(dims, { views: [{ name: 'V1', scale: 0.1, outline_mm: [50, 100, 120, 125] }, { name: 'V2', scale: 0.1, outline_mm: [50, 140, 120, 165] }, { name: 'V3', scale: 0.1, outline_mm: [130, 100, 155, 125] }] })).dims;
test('v3.15 organize: positions that come from adding other dimensions go, chain and overall size stay, an equal size is said once', async () => {
  const { planReduction, measuresOf } = await import('./dims_layout.mjs');
  // the crankshaft: chain 80, 38, 15, positions from the origin 80, 118, 133, the 15 again further on, and the overall size
  const dims = await readDims([dimOf('a', 'V1', 80, 53, 61), dimOf('b', 'V1', 38, 61, 64.8), dimOf('c', 'V1', 15, 64.8, 66.3), dimOf('p1', 'V1', 80, 53, 61), dimOf('p2', 'V1', 118, 53, 64.8), dimOf('p3', 'V1', 133, 53, 66.3), dimOf('c2', 'V1', 15, 70, 71.5), dimOf('t', 'V1', 574, 53, 110.4)]);
  const p = planReduction(measuresOf(dims));
  const kept = p.kept.map(k => k.name).sort();
  assert.deepEqual(kept, ['a', 'b', 'c', 't']);
  assert.equal(p.kept.find(k => k.name === 'c').suffix, ' TYP');
  assert.equal(p.kept.find(k => k.name === 'a').suffix, undefined);
  assert.equal(p.dropped.length, 4);
});
test('v3.15 organize: a count is written only for real holes, with its diameter sign; a reference drawing decides what shows', async () => {
  const { planReduction } = await import('./dims_layout.mjs');
  const D = (name, value) => ({ name, value, cls: 'D', dims: [{ view: 'V3', mode: 'free', rad: { center: [0, 0] } }] }), R = (name, value) => ({ ...D(name, value), cls: 'R' });
  const p = planReduction([D('d1', 10), D('d2', 10), D('d3', 10), D('s1', 54), D('s2', 54), R('r1', 80), R('r2', 80)], { hole_counts: { 10: 10 } });
  assert.deepEqual(p.kept.map(k => [k.name, k.prefix ?? null, k.suffix ?? null]), [['d1', '10 X <MOD-DIAM>', null], ['s1', null, ' TYP'], ['r1', null, ' TYP']]);
  const l = v => ({ name: 'L' + v, value: v, cls: 'L', dims: [] }), q = planReduction([l(30), l(50), l(70)], { reference_values: [30, 70, 90] });
  assert.deepEqual(q.kept.map(k => k.value), [30, 70]); assert.deepEqual(q.reference_not_found, [90]);
});
test('v3.15 organize: a pattern of holes is its pitch and its distance to the contour, not one position per hole', async () => {
  const { planReduction, planHolePattern, patternSketches } = await import('./dims_layout.mjs');
  // the flange of the crankshaft: Ø144, 10 x Ø10 on a circle of Ø110, scale 1:10
  const flange = [{ index: 0, kind: 'circle', diameter_mm: 144, center_sheet_mm: [100, 100] }, { index: 30, kind: 'arc', diameter_mm: 160, center_sheet_mm: [100, 100] }];
  for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5; flange.push({ index: i + 1, kind: 'circle', diameter_mm: 10, center_sheet_mm: [+(100 + 5.5 * Math.cos(a)).toFixed(2), +(100 + 5.5 * Math.sin(a)).toFixed(2)] }); }
  // a through hole shows its far side too
  flange.push({ index: 11, kind: 'circle', diameter_mm: 10, center_sheet_mm: flange[2].center_sheet_mm });
  const r = planHolePattern(flange, 10, 0.1);
  assert.equal(r.dims.length, 2); assert.equal(r.contour_diameter, 144);
  assert.ok(Math.abs(r.dims[0].expected_mm - 33.99) < 0.3); assert.equal(r.dims[0].type, 'horizontal');
  assert.ok(Math.abs(r.dims[1].expected_mm - 17) < 0.1); assert.equal(r.dims[1].type, 'horizontal'); assert.deepEqual(r.dims[1].arc_end, ['center', 'min']); assert.equal(r.dims[1].edges[1], 0);
  // unevenly spaced: every position means something
  const uneven = [...flange.slice(0, 5), { index: 20, kind: 'circle', diameter_mm: 10, center_sheet_mm: [96, 96] }];
  assert.equal(planHolePattern(uneven, 10, 0.1), null);
  // a plate with 3 holes in a row: pitch, edge to hole in both directions; its overall size stays
  const line = (index, x0, y0, x1, y1) => ({ index, kind: 'line', start_sheet_mm: [x0, y0], end_sheet_mm: [x1, y1] }), hole = (index, x) => ({ index, kind: 'circle', diameter_mm: 5, center_sheet_mm: [x, 15] });
  const plate = planHolePattern([line(0, 0, 0, 0, 30), line(1, 90, 0, 90, 30), line(2, 0, 0, 90, 0), line(3, 0, 30, 90, 30), hole(4, 15), hole(5, 45), hole(6, 75)], 5, 1);
  assert.deepEqual(plate.keep, [90, 30]); assert.deepEqual(plate.dims.map(d => [d.type, d.expected_mm]), [['horizontal', 30], ['horizontal', 15], ['vertical', 15]]);
  const L = (name, value) => ({ name, value, cls: 'L', dims: [] }), D = (name, value) => ({ name, value, cls: 'D', dims: [] });
  const ms = [D('D1@Croquis12@P', 10), L('D11@Croquis12@P', 10.5), L('D14@Croquis12@P', 72), D('D1@Croquis11@P', 144), L('D1@Croquis3@P', 43.57)];
  const sk = patternSketches(ms, { 10: 10 }); assert.deepEqual([...sk.keys()], ['Croquis12']);
  const p = planReduction(ms, { hole_counts: { 10: 10 }, pattern_sketches: sk });
  assert.deepEqual(p.kept.map(k => k.name), ['D1@Croquis12@P', 'D1@Croquis11@P', 'D1@Croquis3@P']);
  assert.equal(p.kept[0].prefix, '10 X <MOD-DIAM>');
  // the overall size drawn in the same sketch is not a position
  const q = planReduction([D('D1@S@P', 5), L('D2@S@P', 90), L('D3@S@P', 15)], { hole_counts: { 5: 3 }, pattern_sketches: new Map([['S', [90]]]) });
  assert.deepEqual(q.kept.map(k => k.name), ['D1@S@P', 'D2@S@P']);
});
test('v3.16 advanced modeling: schemas of guides, orientation, variable fillet, multi-thickness shell and the new tools', () => {
  const ok = (n, a) => assert.equal(validate.get(n)(a), true, n + ' ' + JSON.stringify(a)), no = (n, a) => assert.equal(validate.get(n)(a), false, n + ' ' + JSON.stringify(a));
  ok('sw_sweep', { document_id: 'x', profile: 'S1', path: 'S2', guides: ['S3'], orientation: 'keep_normal' }); no('sw_sweep', { document_id: 'x', path: 'S2', orientation: 'sideways' });
  ok('sw_loft', { document_id: 'x', profiles: ['A', 'B'], guides: ['G'], start_constraint: 'normal', closed: false }); no('sw_loft', { document_id: 'x', profiles: ['A', 'B'], end_constraint: 'tangent' });
  ok('sw_fillet', { document_id: 'x', end_radii_mm: [2, 5], edge_points_mm: [[0, 0, 0]] }); no('sw_fillet', { document_id: 'x', end_radii_mm: [2] });
  assert.match(argumentError('fillet', { document_id: 'x', edge_points_mm: [[0, 0, 0]] }), /exactly one/); assert.match(argumentError('fillet', { document_id: 'x', radius_mm: 1, end_radii_mm: [1, 2] }), /exactly one/); assert.equal(argumentError('fillet', { document_id: 'x', radius_mm: 1, edge_points_mm: [[0, 0, 0]] }), null);
  ok('sw_shell', { document_id: 'x', thickness_mm: 2, face_thickness: [{ face_reference: 'a'.repeat(32), thickness_mm: 5 }] }); no('sw_shell', { document_id: 'x', thickness_mm: 2, face_thickness: [{ thickness_mm: 5 }] });
  ok('sw_sketch_3d', { document_id: 'x', points_mm: [[0, 0, 0], [10, 0, 5]], type: 'spline' }); no('sw_sketch_3d', { document_id: 'x', points_mm: [[0, 0, 0]] }); no('sw_sketch_3d', { document_id: 'x', points_mm: [[0, 0], [1, 1]] });
  ok('sw_dome', { document_id: 'x', face_point_mm: [0, 0, 5], height_mm: 3 }); no('sw_dome', { document_id: 'x', face_point_mm: [0, 0, 5] });
  ok('sw_split_line', { document_id: 'x', sketch: 'S', face_points_mm: [[0, 0, 1]] }); no('sw_split_line', { document_id: 'x', sketch: 'S', face_points_mm: [] });
  ok('sw_draft_analysis', { document_id: 'x', direction: [0, 0, 1], min_draft_deg: 2 }); no('sw_draft_analysis', { document_id: 'x' });
});
test('v3.19 surfaces: sw_surface schema and the surfaces-only mode refuses the Features tab', async () => {
  const ok = (n, a) => assert.equal(validate.get(n)(a), true, n + ' ' + JSON.stringify(a)), no = (n, a) => assert.equal(validate.get(n)(a), false, n + ' ' + JSON.stringify(a));
  ok('sw_surface', { document_id: 'x', action: 'extrude', sketch: 'Croquis1', depth_mm: 26, mid_plane: true });
  ok('sw_surface', { document_id: 'x', action: 'trim', tool_points_mm: [[0, 0, 0]], keep_points_mm: [[1, 2, 3]] });
  ok('sw_surface', { document_id: 'x', action: 'knit', form_solid: true });
  ok('sw_surface', { document_id: 'x', action: 'thicken_cut', body_point_mm: [0, 36, 0], thickness_mm: 20, side: 'side2' });
  no('sw_surface', { document_id: 'x', action: 'chamfer' }); no('sw_surface', { document_id: 'x', action: 'trim', keep_points_mm: [[1, 2]] }); no('sw_surface', { document_id: 'x' });
  const { surfacesModeCall } = await import('./surfaces_mode.mjs');
  assert.equal(surfacesModeCall('extrude', { document_id: 'P' }), null);
  assert.equal(surfacesModeCall('surface', { document_id: 'P', action: 'mode' }).isError, true);
  assert.equal(surfacesModeCall('surface', { document_id: 'P', action: 'mode', on: true }).isError, false);
  assert.match(surfacesModeCall('extrude', { document_id: 'P' }).content[0].text, /Features tab/);
  assert.equal(surfacesModeCall('extrude', { document_id: 'Q' }), null);
  for (const allowed of ['surface', 'create_sketch', 'ref_plane', 'fillet', 'set_material', 'save', 'inspect']) assert.equal(surfacesModeCall(allowed, { document_id: 'P', action: 'knit' }), null, allowed);
  surfacesModeCall('surface', { document_id: 'P', action: 'mode', on: false });
  assert.equal(surfacesModeCall('cut', { document_id: 'P' }), null);
});
test('v3.15 organize: dimensions are shared among the views, circles where they are circles', async () => {
  const { assignViews } = await import('./dims_layout.mjs');
  const views = new Map([['V1', { outline_mm: [0, 0, 70, 25] }], ['V2', { outline_mm: [0, 40, 70, 65] }], ['V3', { outline_mm: [90, 0, 115, 25] }]]);
  const lens = Array.from({ length: 12 }, (_, i) => ({ name: 'L' + i, value: i + 1, cls: 'L', dims: ['V1', 'V2'].map(view => ({ view, mode: 'h', lin: { u0: i * 10, u1: i * 10 + 1 } })) }));
  const circle = { name: 'C', value: 144, cls: 'D', dims: [{ view: 'V1', mode: 'h', lin: { u0: 500, u1: 501 } }, { view: 'V3', mode: 'free', rad: { center: [0, 0] } }] };
  const a = assignViews([...lens, circle], views);
  const n = v => [...a.view_of.values()].filter(x => x === v).length;
  assert.ok(n('V1') >= 4 && n('V2') >= 4, 'V1 ' + n('V1') + ' V2 ' + n('V2'));
  assert.equal(a.view_of.get('C'), 'V3');
});
test('v3.15 organize: the section goes along a hole, in the view that sees it lying straight', async () => {
  const { planSection } = await import('./dims_layout.mjs');
  const views = [
    { name: 'F', model_type: 1, outline_mm: [0, 0, 70, 25], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    { name: 'S', model_type: 1, outline_mm: [90, 0, 115, 25], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] },
    { name: 'I', model_type: 1, outline_mm: [130, 0, 200, 70], axes: [[0.7, -0.4, 0.57], [0, 0.8, 0.57], [-0.7, -0.4, 0.57]] }];
  const along = planSection({ views }, { holes: [{ diameter_mm: 10, axis: [-1, 0, 0], point_mm: [581, 52, 17] }] });
  assert.equal(along.view, 'F'); assert.equal(along.direction, 'horizontal'); assert.deepEqual(along.through_mm, [581, 52, 17]);
  const up = planSection({ views }, { holes: [{ diameter_mm: 8, axis: [0, 1, 0], point_mm: [1, 2, 3] }] });
  assert.equal(up.view, 'F'); assert.equal(up.direction, 'vertical');
  assert.equal(planSection({ views }, { holes: [], features: [] }), null);
  assert.equal(planSection({ views }, { holes: [], features: [{ name: 'Vaciado1', center_mm: [1, 1, 1] }] }).view, 'F');
});
test('v3.15 organize: whole flow on a fake sheet, nothing saved, nothing marked for drawing lost, the review speaks up', async () => {
  const { organizeDimensions, superviseDimensions, dimensionWarning } = await import('./dims_layout.mjs');
  const views = [{ name: 'F', scale: 0.1, model_type: 1, model: 'p.SLDPRT', outline_mm: [50, 100, 120, 125], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], section: false }, { name: 'T', scale: 0.1, model_type: 1, model: 'p.SLDPRT', outline_mm: [50, 140, 120, 165], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]], section: false }, { name: 'S', scale: 0.1, model_type: 1, model: 'p.SLDPRT', outline_mm: [130, 100, 155, 125], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], section: false }];
  const offer = { F: ['a', 'b', 'c', 'p'], T: ['a', 'b', 'c', 'p'], S: [] }, spans = { a: [10, 53, 54], b: [20, 54, 56], c: [10, 58, 59], p: [30, 53, 56] };
  let n = 0;
  const make = (name, view) => { const [v, x0, x1] = spans[name]; n++; return { ...dimH(n, v, x0, x1, 90, { cx: 35 + n * 9 }), id: view + '#' + n, name, view, marked: true, value: v }; };
  const geo = sheetOf([make('a', 'F'), make('b', 'F'), make('c', 'F'), make('p', 'F'), { ...make('a', 'F'), name: 'keep', marked: false, type: 5, lines: [[60, 112, 70, 112]], value: 36 }], { views });
  const calls = [];
  const worker = { call: async (op, a) => {
    calls.push(op);
    if (op === 'drawing_dim_geometry') return { ok: true, result: structuredClone(geo) };
    if (op === 'drawing_part_hollows') return { ok: true, result: { holes: [], features: [] } };
    if (op === 'drawing_dim_insert') { for (const v of a.views) for (const m of offer[v]) if (!geo.dimensions.some(d => d.name === m)) geo.dimensions.push(make(m, v)); return { ok: true, result: {} }; }
    if (op === 'drawing_dim_apply') { for (const id of a.deletes ?? []) geo.dimensions = geo.dimensions.filter(d => d.id !== id); for (const m of a.moves ?? []) { const d = geo.dimensions.find(x => x.id === m.id); if (d) d.pos = m.pos; } for (const t of a.texts ?? []) { const d = geo.dimensions.find(x => x.id === t.id); if (d) d.text = (t.prefix ?? '') + d.text + (t.suffix ?? ''); } return { ok: true, result: { moved: (a.moves ?? []).length, deleted: a.deletes ?? [], missed: [] } }; }
    return { ok: false, error: 'unexpected ' + op };
  } };
  const before = await superviseDimensions(worker, { document_id: 'd' });
  assert.equal(before.needs_organize, true); assert.match(dimensionWarning(before), /sw_drawing_dim_organize/);
  const r = await organizeDimensions(worker, { document_id: 'd' });
  assert.ok(calls.every(c => /^drawing_(dim_|part_)/.test(c)), 'no save, no export: ' + [...new Set(calls)]);
  const names = geo.dimensions.map(d => d.name).sort();
  assert.deepEqual(names, ['a', 'b', 'keep', 'p'], 'p is the overall size and stays; c has the size of a and goes; keep is not marked for drawing and survives');
  assert.equal(new Set(geo.dimensions.map(d => d.view)).size >= 2, true, 'shared among views');
  assert.equal(r.dimensions_after, 4);
});
test('v3.17 a section has its hatching drawn again once dimensions left it; a sheet with no section, or nothing moved, is not rebuilt', async () => {
  const { superviseDimensions, organizeDimensions } = await import('./dims_layout.mjs');
  const rebuilds = calls => calls.filter(([op, a]) => op === 'drawing_dim_apply' && a.rebuild).length;
  const crowd = () => [10, 20, 30, 40, 50, 60].map((L, k) => dimH(k, L * 10, 55, 55 + L, 112 + k * 0.5));
  const front = sheetOf([]).views[0], cut = { name: 'A', scale: 0.1, section: true, outline_mm: [50, 40, 120, 60] };
  const plain = fakeDrawing(sheetOf(crowd()));
  await superviseDimensions(plain, { document_id: 'd', fix: true });
  assert.equal(rebuilds(plain.calls), 0, 'no section');
  const moved = fakeDrawing(sheetOf(crowd(), { views: [front, cut] }));
  await superviseDimensions(moved, { document_id: 'd', fix: true });
  assert.equal(rebuilds(moved.calls), 1, 'dimensions moved on a sheet with a section');
  const quiet = fakeDrawing(sheetOf([dimH(0, 70, 50, 120, 90)], { views: [front, cut] }));
  await superviseDimensions(quiet, { document_id: 'd', fix: true });
  assert.equal(rebuilds(quiet.calls), 0, 'nothing moved');
  // organize always leaves the sheet with its section whole, and asks for it after the last touch
  const part = { scale: 0.1, model_type: 1, model: 'p.SLDPRT', section: false };
  const three = [{ ...part, name: 'F', outline_mm: [50, 100, 120, 125], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, { ...part, name: 'T', outline_mm: [50, 140, 120, 165], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] }, { ...part, name: 'S', outline_mm: [130, 100, 155, 125], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }];
  const flow = async views => {
    const geo = sheetOf([{ ...dimH(0, 70, 50, 120, 90), id: 'F#0', view: 'F', name: 'a', marked: true }], { views }), calls = [], worker = { call: async (op, a) => {
      calls.push([op, a]);
      if (op === 'drawing_dim_geometry') return { ok: true, result: structuredClone(geo) };
      if (op === 'drawing_part_hollows') return { ok: true, result: { holes: [], features: [] } };
      if (op === 'drawing_dim_insert') return { ok: true, result: {} };
      if (op === 'drawing_dim_apply') return { ok: true, result: { moved: (a.moves ?? []).length, deleted: [], missed: [] } };
      return { ok: false, error: 'unexpected ' + op };
    } };
    await organizeDimensions(worker, { document_id: 'd', section: false });
    return calls;
  };
  assert.equal(rebuilds(await flow([...three, { ...part, ...cut, axes: three[1].axes }])), 1);
  assert.equal(rebuilds(await flow(three)), 0);
});
test('v3.15 sw_drawing_dim_organize schema', () => {
  const v = validate.get('sw_drawing_dim_organize');
  assert.equal(v({ document_id: 'd' }), true); assert.equal(v({ document_id: 'd', section: false, reference_values: [10, 20.5], sheet: 'Hoja1' }), true);
  assert.equal(v({}), false); assert.equal(v({ document_id: 'd', reference_values: ['x'] }), false);
});

test('v3.15 organize: views over and under the front open room along the projection, within the sheet and past nothing', async () => {
  const { planViewGaps } = await import('./dims_layout.mjs');
  const ax = { model_type: 1, section: false };
  const F = { ...ax, name: 'F', outline_mm: [50, 88, 116, 112], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, T = { ...ax, name: 'T', outline_mm: [50, 125, 116, 148], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] };
  const Sec = { ...ax, name: 'A', section: true, outline_mm: [50, 60, 116, 80] }, Side = { ...ax, name: 'S', outline_mm: [129, 88, 152, 112], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] };
  const m = planViewGaps({ sheet_mm: [280, 216], title_block_mm: [142, 0, 280, 36], views: [F, T, Sec, Side] });
  assert.deepEqual(m, [{ view: 'T', by: [0, 17] }, { view: 'A', by: [0, -22] }, { view: 'S', by: [17, 0] }]);
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 150], views: [F, T] }), [], 'no room: it stays, it never moves towards the front');
});

test('v3.17 organize: beside the front the views open room too, and what is behind goes along; the sheet stops them', async () => {
  const { planViewGaps } = await import('./dims_layout.mjs');
  const ax = { model_type: 1, section: false };
  const F = { ...ax, name: 'F', outline_mm: [44, 76, 94, 105], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, S = { ...ax, name: 'S', outline_mm: [110, 76, 157, 105], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] };
  const A = { ...ax, name: 'A', section: true, outline_mm: [185, 76, 232, 105] };
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], views: [F, S, A] }), [{ view: 'S', by: [14, 0] }, { view: 'A', by: [14, 0] }]);
  assert.deepEqual(planViewGaps({ sheet_mm: [240, 216], views: [F, S, A] }), [], 'no room behind: nobody moves');
});

test('v3.17 check: a line through the name of a section is a problem, and the next place for it leaves the name alone', async () => {
  const { readSheet, findIssues } = await import('./dims_layout.mjs');
  const view = { name: 'A', model_type: 1, section: true, scale: 0.5, outline_mm: [100, 80, 140, 110], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin_mm: [120, 95] };
  const dim = { id: 'A#0', name: 'D1@Croquis1', view: 'A', type: 6, value: 22, unit: 'mm', text: '22', marked: true, pos: [125, 60], start: [120, 60], angle: 0, height: 3, lines: [[115, 85, 115, 62], [125, 85, 125, 62], [115, 62, 125, 62]] };
  const m = readSheet({ sheet: 'H', sheet_mm: [280, 216], views: [view], notes: [], dimensions: [dim] }, { keep_out_mm: [[110, 60, 130, 70]] });
  const f = findIssues(m);
  assert.deepEqual(f.line_on_note.map(x => x.note), ['nombre del corte'], 'the arrows of a cut line are not a name: the lines may pass them');
});

test('v3.17 organize: the name of a section stays on the sheet and off the title block, and the check knows when it does not; only a warning', async () => {
  const { planViewGaps, readSheet, findIssues, errorCount } = await import('./dims_layout.mjs');
  const ax = { model_type: 1, section: false }, title = [140, 0, 280, 36];
  const F = { ...ax, name: 'F', outline_mm: [100, 90, 150, 140], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, A = { ...ax, name: 'A', section: true, outline_mm: [115, 12, 135, 62] };
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], title_block_mm: title, views: [F, A] }), [{ view: 'A', by: [0, 23] }], 'wider than the view, the name would land on the title block');
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], title_block_mm: null, views: [F, { ...A, outline_mm: [115, 12, 135, 62] }] }).map(m => m.view), ['A'], 'off the title block it only needs its own height');
  const nameOf = o => findIssues(readSheet({ sheet_mm: [280, 216], title_block_mm: title, views: [{ ...A, outline_mm: o, scale: 1 }], notes: [], dimensions: [] }));
  const low = nameOf([115, 5, 135, 55]);
  assert.equal(low.name_off_sheet.length, 1);
  assert.equal(errorCount(low), 0, 'not an error of a dimension');
  assert.equal(nameOf([115, 60, 135, 110]).name_off_sheet.length, 0);
  assert.equal(nameOf([40, 12, 60, 55]).name_off_sheet.length, 1, 'inside the edge but past the frame');
  assert.equal(nameOf([40, 16, 60, 55]).name_off_sheet.length, 0);
});

test('v3.17 organize: the name of a section under a side view goes up out of the frame too; beside its view it stays', async () => {
  const { planViewGaps } = await import('./dims_layout.mjs');
  const ax = { model_type: 1, section: false }, title = [142, 0, 280, 36];
  const F = { ...ax, name: 'F', outline_mm: [55, 73, 88, 134], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, T = { ...ax, name: 'T', outline_mm: [55, 164, 88, 178], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] };
  const S = { ...ax, name: 'S', outline_mm: [118, 73, 132, 134], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }, A = { ...ax, name: 'A', section: true, outline_mm: [119, 10, 131, 44] };
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], title_block_mm: title, views: [F, T, S, A] }), [{ view: 'A', by: [0, 7] }]);
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], title_block_mm: title, views: [F, T, S, { ...A, outline_mm: [119, 10, 131, 70] }] }), [], 'nothing between it and the view over it: it stays');
  const W = { ...ax, name: 'W', outline_mm: [100, 5, 140, 50], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }, B = { ...ax, name: 'B', section: true, outline_mm: [150, 5, 170, 50] };
  assert.deepEqual(planViewGaps({ sheet_mm: [280, 216], title_block_mm: title, views: [F, W, B] }), [], 'in line beside the view it comes from it only slides sideways');
});
test('v3.17 organize: two diameters that leave for the same place do not end on top of each other: the second sees where the first went', async () => {
  const { readSheet, planLeaders } = await import('./dims_layout.mjs');
  const dia = (id, y) => ({ id, name: id + '@C', view: 'A', type: 6, value: 34, unit: 'mm', text: '<MOD-DIAM>34', pos: [125, y], start: [125, y], angle: 1.4, height: 3, lines: [[120, 157, 125, y], [120, 157, 120, 123]] });
  const moves = planLeaders(readSheet({ sheet_mm: [280, 216], views: [{ name: 'A', outline_mm: [100, 100, 140, 180], scale: 0.5 }], notes: [], dimensions: [dia('d', 200), dia('e', 206)] }));
  assert.equal(moves.length, 2, JSON.stringify(moves));
  assert.ok(Math.hypot(moves[0].pos[0] - moves[1].pos[0], moves[0].pos[1] - moves[1].pos[1]) > 5, JSON.stringify(moves));
});
test('v3.17 organize: holes around a boss with no rim around them: their separation, and how far they are from its centre only when a place of the circle is empty', async () => {
  const { planHolePattern } = await import('./dims_layout.mjs');
  const c = (index, x, y, d) => ({ index, kind: 'circle', diameter_mm: d, center_sheet_mm: [x, y] });
  const holes = [c(1, 0, 20, 5), c(2, -17.32, -10, 5), c(3, 17.32, -10, 5)];
  const r = planHolePattern([c(0, 0, 0, 10), ...holes], 5, 1);
  assert.equal(r.contour_diameter, null);
  assert.deepEqual(r.dims.map(d => d.what), ['separación entre barrenos'], 'all the way round: the separation and the count say the circle');
  assert.deepEqual(r.dims[0].edges, [2, 3]); assert.equal(r.dims[0].type, 'horizontal'); assert.ok(Math.abs(r.dims[0].expected_mm - 34.64) < 0.01);
  // three of four places: the radius too
  const gap = planHolePattern([c(0, 0, 0, 10), c(1, 0, 20, 5), c(2, -20, 0, 5), c(3, 0, -20, 5)], 5, 1);
  assert.deepEqual(gap.dims.map(d => d.what), ['separación entre barrenos', 'radio del círculo de barrenos']);
  assert.ok(Math.abs(gap.dims[0].expected_mm - 28.28) < 0.01); assert.ok(Math.abs(gap.dims[1].expected_mm - 20) < 0.01);
  // two holes around anything are no pattern to say this way
  assert.equal(planHolePattern([c(0, 0, 0, 10), holes[1], holes[2]], 5, 1), null);
});
test('v3.15 organize: a model that does not offer the dimensions of the sheet stops the work, with the file named', async () => {
  const { organizeDimensions } = await import('./dims_layout.mjs');
  const view = (name, axes) => ({ name, model_type: 1, section: false, model: 'C:/x/otra/Pieza.SLDPRT', scale: 0.5, outline_mm: [50, 50, 100, 100], axes });
  const views = [view('F', [[1, 0, 0], [0, 1, 0], [0, 0, 1]]), view('T', [[1, 0, 0], [0, 0, 1], [0, -1, 0]]), view('S', [[0, 0, 1], [0, 1, 0], [-1, 0, 0]])];
  const dim = (i, v) => ({ id: 'd' + i, name: 'D' + i + '@Croquis1@Pieza.Part', view: v, type: 2, value: 10 + i, unit: 'mm', text: String(10 + i), marked: true, pos: [70, 40], start: [60, 40], angle: 0, height: 3, lines: [] });
  let dims = [0, 1, 2, 3, 4, 5].map(i => dim(i, 'F')); const ops = [];
  const worker = { call: async (op, a) => { ops.push(op);
    if (op === 'drawing_dim_geometry') return { ok: true, result: { active_sheet: 'H1', sheet_mm: [280, 216], views, dimensions: dims, notes: [] } };
    if (op === 'drawing_part_hollows') return { ok: true, result: { holes: [], features: [] } };
    if (op === 'drawing_dim_apply') { dims = dims.filter(d => !(a.deletes ?? []).includes(d.id)); return { ok: true, result: {} }; }
    if (op === 'drawing_dim_insert') return { ok: true, result: {} };
    return { ok: true, result: {} }; } };
  await assert.rejects(organizeDimensions(worker, { document_id: 'x', section: false }), /solo ofrece 0 de las 6 cotas .*otra\/Pieza\.SLDPRT.*SIN guardar/);
});

test('v3.15 organize: a diameter inside a view leaves by the shortest way, not through the whole view', async () => {
  const { readSheet, planLeaders } = await import('./dims_layout.mjs');
  const geo = { sheet_mm: [280, 216], views: [{ name: 'A', outline_mm: [100, 100, 140, 180], scale: 0.5 }], notes: [],
    dimensions: [{ id: 'd', name: 'D1@C', view: 'A', type: 6, value: 34, unit: 'mm', text: '<MOD-DIAM>34', pos: [125, 200], start: [125, 200], angle: 1.4, height: 3, lines: [[120, 157, 125, 200], [120, 157, 120, 123]] }] };
  const [m, ...rest] = planLeaders(readSheet(geo));
  assert.equal(rest.length, 0); assert.equal(m.id, 'd');
  const slope = Math.abs(Math.sin(Math.atan2(m.pos[1] - 140, m.pos[0] - 120)));
  assert.ok((m.pos[0] > 140 || m.pos[0] < 100) && slope > 0.4 && slope < 0.8 && Math.hypot(m.pos[0] - 120, m.pos[1] - 140) < 40, 'out by the side on a slant: ' + m.pos);
  assert.ok(m.pos[0] < 100 || m.pos[0] > 140, 'outside the view');
  // already level and short: it stays
  geo.dimensions[0].pos = [146, 140]; geo.dimensions[0].angle = 0; geo.dimensions[0].start = [146, 140];
  assert.deepEqual(planLeaders(readSheet(geo)), []);
});

// --- v3.17 which dimensions a part needs, from its faces
const FULL = 2 * Math.PI, ZAX = [0, 0, 1];
const VIEWS3 = new Map([['F', { name: 'F', scale: 1, origin_mm: [0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }], ['S', { name: 'S', scale: 1, origin_mm: [0, 0], axes: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }]]);
// in a side view Z runs towards the left of the sheet
const LIN = (name, axis, a, b) => ({ name, value: Math.abs(b - a), cls: 'L', dims: [{ view: axis === 2 ? 'S' : 'F', mode: axis === 1 ? 'v' : 'h', lin: axis === 2 ? { u0: -Math.max(a, b), u1: -Math.min(a, b) } : { u0: Math.min(a, b), u1: Math.max(a, b) } }] });
const ROUND = (name, cls, value) => ({ name, value, cls, dims: [{ view: 'F', mode: 'free', rad: {} }] });
const PLANES = (axis, list, area = 1000) => list.map(pos => ({ axis, pos, area }));
const block = (x, y, z) => [...PLANES(0, x), ...PLANES(1, y), ...PLANES(2, z)];
const hole = (x, y, r, z0 = 0, z1 = 20) => ({ axis: ZAX, point: [x, y, (z0 + z1) / 2], r, sweep: FULL, inner: true, blend: false, box: [x - r, y - r, z0, x + r, y + r, z1] });
const namesOf = plan => plan.kept.map(k => k.name).sort();
const edgeLine = (index, a, b) => ({ index, kind: 'line', length_mm: 10, start_model_mm: a, end_model_mm: b, start_sheet_mm: [a[0], a[1]], end_sheet_mm: [b[0], b[1]] });
const edgeCircle = (index, c, r) => ({ index, kind: 'circle', diameter_mm: r * 2, center_model_mm: c, normal_model: ZAX });

test('v3.17 needed: a plate with two holes takes its three sizes, the diameter once and the separation; the rest goes, and it says why', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const sizes = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(20, 25, 5), hole(80, 25, 5)] };
  const plan = planNeeded(sizes, [LIN('largo', 0, 0, 100), LIN('alto', 1, 0, 50), LIN('grueso', 2, 0, 20), ROUND('d1', 'D', 10), ROUND('d2', 'D', 10), LIN('izq', 0, 0, 20), LIN('der', 0, 80, 100), LIN('sep', 0, 20, 80), LIN('y', 1, 0, 25), LIN('corte', 0, 3, 78)], VIEWS3);
  assert.deepEqual(namesOf(plan), ['alto', 'd1', 'grueso', 'largo', 'sep']);
  assert.equal(plan.kept.find(k => k.name === 'd1').prefix, '2 X <MOD-DIAM>');
  assert.equal(plan.report.sufficient, true); assert.deepEqual(plan.missing, []);
  assert.match(plan.dropped.find(d => d.dimension === 'corte').why, /no mide nada/);
  assert.match(plan.dropped.find(d => d.dimension === 'd2').why, /ya está dicho/);
  assert.match(plan.dropped.find(d => d.dimension === 'izq').why, /ya sale/);
});
test('v3.17 needed: nothing is too many in a chain, what is missing is asked for by name, and the edges of a view can carry it', async () => {
  const { planNeeded, dimensionsFromEdges } = await import('./dims_needed.mjs');
  const chain = { planes: block([0, 10, 30, 100], [0, 50], [0, 20]).map(p => p.axis === 0 ? { ...p, area: 400 + p.pos * 13 } : p) };
  const whole = planNeeded(chain, [LIN('t', 0, 0, 100), LIN('a', 0, 0, 10), LIN('b', 0, 10, 30), LIN('c', 0, 0, 30), LIN('d', 0, 30, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)], VIEWS3);
  assert.deepEqual(namesOf(whole), ['a', 'b', 't', 'y', 'z'], 'four points on X take three dimensions, the total first');
  assert.equal(whole.report.axes.find(a => a.axis === 'X').points, 4);
  assert.equal(whole.report.sufficient, true);
  const plate = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(20, 25, 5), hole(80, 25, 5)] };
  const short = planNeeded(plate, [LIN('largo', 0, 0, 100), LIN('alto', 1, 0, 50)], VIEWS3);
  assert.equal(short.report.sufficient, false);
  assert.deepEqual(short.missing.map(m => m.kind + (m.axis ?? '') + ':' + m.value).sort(), ['D:10', 'L0:60', 'L2:20'], 'the diameter, the separation and the thickness');
  assert.match(short.report.summary, /Faltan cotas/);
  const edges = [edgeCircle(0, [20, 25, 20], 5), edgeCircle(1, [80, 25, 20], 5), edgeLine(2, [0, 0, 20], [0, 50, 20])];
  assert.deepEqual(dimensionsFromEdges(short.missing.find(m => m.kind === 'L' && m.axis === 0), VIEWS3.get('F'), edges)[0], { edges: [0, 1], type: 'horizontal', expected: 60, pair: [20, 80] });
  assert.deepEqual(dimensionsFromEdges(short.missing.find(m => m.kind === 'D'), VIEWS3.get('F'), edges)[0], { edges: [0], type: 'diameter', expected: 10 });
  assert.deepEqual(dimensionsFromEdges(short.missing.find(m => m.kind === 'D'), VIEWS3.get('S'), edges), [], 'the side view sees those holes edge-on');
  assert.deepEqual(dimensionsFromEdges(short.missing.find(m => m.axis === 2), VIEWS3.get('F'), edges), [], 'the front view cannot measure along the line of sight');
});
test('v3.17 needed: a stepped shaft, each diameter and each step; a diameter measured across a section counts, with its sign', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const cyl = (r, z0, z1) => ({ axis: ZAX, point: [0, 0, (z0 + z1) / 2], r, sweep: FULL, inner: false, blend: false, box: [-r, -r, z0, r, r, z1] });
  const sizes = { planes: [{ axis: 2, pos: 0, area: 1256 }, { axis: 2, pos: 50, area: 550 }, { axis: 2, pos: 100, area: 707 }], rounds: [cyl(20, 0, 50), cyl(15, 50, 100)] };
  const plan = planNeeded(sizes, [ROUND('d40', 'D', 40), LIN('d30', 1, -15, 15), LIN('t', 2, 0, 100), LIN('p1', 2, 0, 50), LIN('p2', 2, 50, 100)], VIEWS3);
  assert.deepEqual(namesOf(plan), ['d30', 'd40', 'p1', 't'], 'p2 comes out of the total and the first step');
  assert.equal(plan.kept.find(k => k.name === 'd30').prefix, '<MOD-DIAM>');
  assert.equal(plan.report.sufficient, true);
});
test('v3.17 needed: holes around a circle, by the separation and the distance to the contour; their positions go', async () => {
  const { planNeeded, ringDiameters } = await import('./dims_needed.mjs');
  const ring = [0, 1, 2, 3, 4, 5].map(i => hole(30 * Math.cos(i * Math.PI / 3), 30 * Math.sin(i * Math.PI / 3), 2.5, 0, 10));
  const outer = { ...hole(0, 0, 50, 0, 10), inner: false }, bore = hole(0, 0, 10, 0, 10);
  const sizes = { planes: PLANES(2, [0, 10]), rounds: [outer, bore, ...ring] };
  assert.deepEqual(ringDiameters(sizes), [5]);
  const plan = planNeeded(sizes, [ROUND('d100', 'D', 100), ROUND('d20', 'D', 20), ROUND('d5', 'D', 5), LIN('g', 2, 0, 10), LIN('RD1@sep', 0, -15, 15), LIN('RD2@cont', 0, 30, 50), LIN('pos1', 0, 0, 15), LIN('pos2', 1, 0, 25.98), LIN('pos3', 0, 0, 30)], VIEWS3, { fixed_names: ['RD1@sep', 'RD2@cont'] });
  assert.deepEqual(namesOf(plan), ['RD1@sep', 'RD2@cont', 'd100', 'd20', 'd5', 'g']);
  assert.equal(plan.kept.find(k => k.name === 'd5').prefix, '6 X <MOD-DIAM>');
  assert.equal(plan.report.sufficient, true);
  const none = planNeeded(sizes, [ROUND('d100', 'D', 100), ROUND('d20', 'D', 20), ROUND('d5', 'D', 5), LIN('g', 2, 0, 10)], VIEWS3);
  assert.deepEqual(none.missing.map(m => m.what), ['separación entre barrenos', 'contorno a barreno']);
  // holes of unequal spacing are no ring: each one is placed
  assert.deepEqual(ringDiameters({ rounds: [hole(30, 0, 2), hole(0, 30, 2), hole(-30, 0, 2), hole(21, -21, 2)] }), []);
});
test('v3.17 needed: a fillet is only its radius, said once with how many; a slot its width and where it is', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const fillet = (x, y, sx, sy, blend) => ({ axis: ZAX, point: [x, y, 10], r: 5, sweep: Math.PI / 2, inner: false, blend, box: [Math.min(x, x + sx * 5), Math.min(y, y + sy * 5), 0, Math.max(x, x + sx * 5), Math.max(y, y + sy * 5), 20] });
  for (const blend of [true, false]) {
    const sizes = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [fillet(5, 5, -1, -1, blend), fillet(95, 5, 1, -1, blend), fillet(5, 45, -1, 1, blend), fillet(95, 45, 1, 1, blend)] };
    const plan = planNeeded(sizes, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), ROUND('r1', 'R', 5), ROUND('r2', 'R', 5), LIN('centro', 0, 0, 5)], VIEWS3);
    assert.deepEqual(namesOf(plan), ['r1', 'x', 'y', 'z'], 'blend ' + blend);
    assert.equal(plan.kept.find(k => k.name === 'r1').prefix, '4 X R');
    assert.equal(plan.report.sufficient, true);
  }
  const arcOf = (x, side) => ({ axis: ZAX, point: [x, 20, 5], r: 6, sweep: Math.PI, inner: true, blend: false, box: [side < 0 ? x - 6 : x, 14, 0, side < 0 ? x : x + 6, 26, 10] });
  const slot = { planes: [...block([0, 100], [0, 40], [0, 10]), { axis: 1, pos: 14, area: 400 }, { axis: 1, pos: 26, area: 400 }], rounds: [arcOf(30, -1), arcOf(70, 1)] };
  const plan = planNeeded(slot, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 40), LIN('z', 2, 0, 10), LIN('ancho', 1, 14, 26), LIN('centros', 0, 30, 70), LIN('c1', 0, 0, 30), LIN('m', 1, 0, 14)], VIEWS3);
  assert.deepEqual(namesOf(plan), ['ancho', 'centros', 'x', 'y', 'z'], 'its width says its radius, centred on the height');
  assert.equal(plan.report.sufficient, true);
});
test('v3.17 needed: a 45 degree chamfer is one dimension for all; ribs are said once; the tip of a drill gives a depth', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const s = 0.70711, face = (nx, ny, box) => ({ normal: [nx, ny, 0], box, area: 56 });
  const sizes = { planes: block([0, 100], [0, 50], [0, 20]), slanted: [face(s, s, [98, 48, 0, 100, 50, 20]), face(-s, s, [0, 48, 0, 2, 50, 20]), face(s, -s, [98, 0, 0, 100, 2, 20]), face(-s, -s, [0, 0, 0, 2, 2, 20])] };
  const plan = planNeeded(sizes, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), LIN('ch', 0, 98, 100), LIN('ch2', 1, 48, 50)], VIEWS3);
  assert.deepEqual(namesOf(plan), ['ch', 'x', 'y', 'z']);
  assert.equal(plan.kept.find(k => k.name === 'ch').suffix, ' X 45° TYP');
  assert.equal(plan.report.sufficient, true);
  // three ribs: the middle one sits on the middle, their width says it all. Four: the gap between them has to be said once too
  const ribs = { planes: [...PLANES(0, [0, 5, 25, 30, 50, 55]), ...PLANES(1, [0, 50]), ...PLANES(2, [0, 20])] };
  const r = planNeeded(ribs, [LIN('x', 0, 0, 55), LIN('g', 0, 0, 5), LIN('h', 0, 5, 25), LIN('g2', 0, 25, 30), LIN('h2', 0, 30, 50), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)], VIEWS3);
  assert.deepEqual(r.kept.map(k => k.value).sort((a, b) => a - b), [5, 20, 50, 55]);
  assert.equal(r.kept.find(k => k.value === 5).suffix, ' TYP');
  assert.equal(r.report.sufficient, true);
  const four = { planes: [...PLANES(0, [0, 5, 25, 30, 50, 55, 75, 80]), ...PLANES(1, [0, 50]), ...PLANES(2, [0, 20])] };
  const q = planNeeded(four, [LIN('x', 0, 0, 80), LIN('g', 0, 0, 5), LIN('h', 0, 5, 25), LIN('g2', 0, 25, 30), LIN('h2', 0, 30, 50), LIN('g3', 0, 50, 55), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)], VIEWS3);
  assert.deepEqual(q.kept.map(k => k.value).sort((a, b) => a - b), [5, 20, 20, 50, 80]);
  assert.equal(q.kept.find(k => k.value === 20 && k.name !== 'z').suffix, ' TYP');
  const blind = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(50, 25, 5, 8, 20)], cones: [{ axis: ZAX, half_angle_deg: 59, ends: [{ point: [50, 25, 5], r: 0 }, { point: [50, 25, 8], r: 5 }] }] };
  const b = planNeeded(blind, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), ROUND('d', 'D', 10), LIN('prof', 2, 8, 20)], VIEWS3);
  assert.deepEqual(namesOf(b), ['d', 'prof', 'x', 'y', 'z'], 'centred on both sides, its depth is needed');
  assert.equal(b.report.sufficient, true);
});
test('v3.17 needed: what cannot be followed is said, and the dimensions that may define it stay', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const sizes = { planes: block([0, 100], [0, 50], [0, 20]), free: [{ box: [0, 0, 0, 10, 10, 10], area: 50, blend: false }] };
  const plan = planNeeded(sizes, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), { name: 'ang', value: 30, cls: 'A', dims: [{ view: 'F' }] }, { name: 'dia', value: 12, cls: 'X', dims: [{ view: 'F' }] }, LIN('sobra', 0, 0, 70)], VIEWS3);
  assert.equal(plan.report.sufficient, null);
  assert.match(plan.report.summary, /falta revisar a ojo/);
  assert.deepEqual(namesOf(plan), ['ang', 'dia', 'x', 'y', 'z']);
  const clean = planNeeded({ planes: block([0, 100], [0, 50], [0, 20]) }, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), { name: 'ang', value: 30, cls: 'A', dims: [{ view: 'F' }] }, ROUND('otra', 'D', 33)], VIEWS3);
  assert.deepEqual(namesOf(clean), ['x', 'y', 'z']);
  assert.match(clean.dropped.find(d => d.dimension === 'otra').why, /no aparece en la pieza/);
  // a length and a 45° that are all one feature has, both hanging from those faces, are its chamfer: one dimension
  const L1 = 'D1@Chaflán1@p.Part', A45 = 'D2@Chaflán1@p.Part', A45b = 'D3@Croquis2@p.Part';
  const ch = planNeeded(sizes, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), LIN(L1, 0, 2, 3), { name: A45, value: 45, cls: 'A', dims: [{ view: 'F' }] }], VIEWS3);
  assert.deepEqual(namesOf(ch), [L1, 'x', 'y', 'z']);
  assert.equal(ch.kept.find(k => k.name === L1).suffix, ' X 45°');
  assert.match(ch.dropped.find(d => d.dimension === A45).why, /chaflán/);
  // not a 45° of another feature
  const apart = planNeeded(sizes, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), LIN(L1, 0, 2, 3), { name: A45b, value: 45, cls: 'A', dims: [{ view: 'F' }] }], VIEWS3);
  assert.deepEqual(namesOf(apart), [L1, A45b, 'x', 'y', 'z']);
});
test('v3.17 needed: where a slanted face ends is not asked when a round already says it', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  // a triangular plate: slanted sides leaving a round at the bottom, tangent, and reaching the top corners
  const s = Math.SQRT1_2, r = 10, cx = 50, cy = 20;
  const boss = { ...hole(cx, cy, r, 0, 10), inner: false }, tx = r * s;
  const tangent = { planes: [...PLANES(0, [0, 100]), ...PLANES(1, [60]), ...PLANES(2, [0, 10])], rounds: [boss], slanted: [{ normal: [s, -s, 0], box: [cx + tx, cy - tx, 0, 100, 60, 10], area: 500 }, { normal: [-s, -s, 0], box: [0, cy - tx, 0, cx - tx, 60, 10], area: 500 }] };
  const a = planNeeded(tangent, [LIN('x', 0, 0, 100), LIN('h', 1, 20, 60), LIN('z', 2, 0, 10), ROUND('d', 'D', 20)], VIEWS3);
  assert.equal(a.report.sufficient, true, a.report.summary);
  // the same face ending on the round without being tangent: one coordinate says the other, and it is asked once
  const leaning = { ...tangent, slanted: [{ normal: [0.8, -0.6, 0], box: [cx + 6, cy - 8, 0, 100, 60, 10], area: 500 }] };
  const b = planNeeded(leaning, [LIN('x', 0, 0, 100), LIN('h', 1, 20, 60), LIN('z', 2, 0, 10), ROUND('d', 'D', 20)], VIEWS3);
  assert.equal(b.missing.length, 1, JSON.stringify(b.missing));
  assert.equal(b.missing[0].kind, 'L');
});
test('v3.17 needed: a slanted face is located the way it was drawn: its angle and the corner it had before its rounds', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const ANGLE = (name, value) => ({ name, value, cls: 'A', dims: [{ view: 'F', mode: 'free', ang: {} }] });
  const VIEW = new Map([...VIEWS3, ['T', { name: 'T', scale: 1, origin_mm: [0, 0], axes: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] }]]);
  // in Y and Z, from the corner Y -21, Z 7, down at 30 degrees: rounds took both ends of it, so nothing real is left at that corner
  const blend = (y, z, r) => ({ axis: [1, 0, 0], point: [0, y, z], r, sweep: 0.5, inner: false, blend: true, box: [-5, y - r, z - r, 5, y + r, z + r] });
  const part = { planes: [...PLANES(0, [-5, 5]), ...PLANES(1, [-35, 0]), ...PLANES(2, [-7, 7])], rounds: [blend(-21.8, 4, 3), blend(-10.7, 12.6, 10)], slanted: [{ normal: [0, 0.5, 0.8660254], box: [-5, -20.3, 3.94, 5, -15.7, 6.596], area: 50 }] };
  const base = [LIN('x', 0, -5, 5), LIN('y', 1, -35, 0), LIN('z', 2, -7, 7), ANGLE('a', 30), ROUND('r3', 'R', 3), ROUND('r10', 'R', 10)];
  const atCorner = planNeeded(part, [...base, LIN('c', 1, -35, -21)], VIEW);
  assert.ok(namesOf(atCorner).includes('c') && namesOf(atCorner).includes('a'), namesOf(atCorner).join());
  assert.equal(atCorner.kept.find(k => k.name === 'c').look, 0, 'read where the face is seen on edge');
  assert.equal(atCorner.report.sufficient, true, atCorner.report.summary);
  // a foot on a real plane is there for that plane: with nothing round at that corner it says nothing about the face
  const real = { ...part, planes: [...part.planes, ...PLANES(1, [-21])], rounds: [part.rounds[1]] };
  const onPlane = planNeeded(real, [...base, LIN('c', 1, -35, -21)], VIEW);
  assert.notEqual(onPlane.kept.find(k => k.name === 'c')?.look, 0);
  assert.ok(onPlane.missing.length >= 1, 'where the face is, still to be said: ' + JSON.stringify(onPlane.missing));
  // with its round, the corner it was drawn with is where that plane meets Z 7: the angle is enough
  const meets = planNeeded({ ...real, rounds: part.rounds }, [...base, LIN('c', 1, -35, -21)], VIEW);
  assert.equal(meets.report.sufficient, true, meets.report.summary);
  // the taper under the eye of a connecting rod, both ends rounded: one sharp corner on the web, the other on the edge of the eye and the face of its boss.
  // The angle places it, and a dimension to the corner on the web says nothing new
  const s = Math.SQRT1_2, eye = { axis: [0, 0, 1], point: [0, 28.5, 0], r: 7, sweep: FULL, inner: false, blend: false, box: [-7, 21.5, -5, 7, 35.5, 5] };
  const rod = { planes: [...PLANES(0, [-3, 3]), ...PLANES(1, [0]), ...PLANES(2, [-5, -2.5, 2.5, 5])], rounds: [eye, blend(18.586, 3.5, 1), blend(22.328, 3, 2)], slanted: [{ normal: [0, s, -s], box: [-3, 19.293, 2.793, 3, 20.914, 4.414], area: 20 }] };
  rod.rounds[1].box = [-3, 18.586, 2.5, 3, 19.293, 2.793]; rod.rounds[2].box = [-3, 20.914, 4.414, 3, 22.328, 5];
  const taper = planNeeded(rod, [LIN('x', 0, -3, 3), LIN('largo', 1, 0, 28.5), LIN('t', 2, -5, 5), LIN('alma', 2, -2.5, 2.5), ROUND('d14', 'D', 14), ROUND('r1', 'R', 1), ROUND('r2', 'R', 2), ANGLE('a', 45), LIN('c', 1, 19, 28.5)], VIEW);
  assert.ok(namesOf(taper).includes('a') && !namesOf(taper).includes('c'), namesOf(taper).join());
  assert.equal(taper.dropped.find(d => d.dimension === 'c').why, 'esa esquina de la cara inclinada ya sale de las otras cotas de la cara');
  assert.equal(taper.report.sufficient, true, taper.report.summary);
  // the two sides of a tapered arm: the angle between them says both, and the width is asked at one end only
  const side = (sign, box) => ({ normal: [sign * 0.99813, -0.06105, 0], box, area: 300 });
  const sides = [side(1, [6, 0, -5, 7.835, 30, 5]), side(-1, [-7.835, 0, -5, -6, 30, 5])];
  const arm = { planes: [...PLANES(1, [0, 30]), ...PLANES(2, [-5, 5])], rounds: [], slanted: sides }, armDims = [LIN('w', 0, -6, 6), LIN('big', 0, -7.835, 7.835), LIN('h', 1, 0, 30), LIN('t', 2, -5, 5), ANGLE('between', 7)];
  const both = planNeeded(arm, armDims, VIEW);
  assert.ok(namesOf(both).includes('between'), namesOf(both).join());
  assert.ok(!(namesOf(both).includes('w') && namesOf(both).includes('big')), 'one width: ' + namesOf(both).join());
  assert.equal(both.report.sufficient, true, both.report.summary);
  const single = planNeeded({ ...arm, slanted: [sides[0]] }, armDims, VIEW);
  assert.ok(!namesOf(single).includes('between'), 'with no twin that is not its angle: ' + namesOf(single).join());
});
test('v3.17 needed: half the total from a real centre is the total, one round of a part is the same as many stretches of it, and the first of two equal values is the one with something new', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  // a round in the very middle: from it to an end says the whole width
  const middle = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(50, 25, 5)] };
  const half = planNeeded(middle, [LIN('medio', 0, 0, 50), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), ROUND('d', 'D', 10)], VIEWS3);
  assert.equal(half.report.sufficient, true, half.report.summary);
  assert.deepEqual(namesOf(half), ['d', 'medio', 'y', 'z']);
  // stretches: five journals of one diameter are five; a face split in two, one; two mirrored about the middle (the ears of a clevis), one
  const cyl = (r, spans) => ({ axis: ZAX, point: [0, 0, 0], r, sweep: FULL, inner: false, blend: false, spans, box: [-r, -r, Math.min(...spans.flat()), r, r, Math.max(...spans.flat())] });
  const countOf = rounds => planNeeded({ planes: PLANES(2, [0, 100]), rounds }, [ROUND('d', 'D', 20), LIN('t', 2, 0, 100)], VIEWS3).kept.find(k => k.name === 'd').prefix;
  assert.equal(countOf([cyl(10, [[0, 10], [20, 30], [40, 50], [60, 70], [90, 100]])]), '5 X <MOD-DIAM>');
  assert.equal(countOf([cyl(10, [[0, 50], [50, 100]])]), undefined, 'one face split in two');
  assert.equal(countOf([cyl(10, [[0, 20], [80, 100]])]), undefined, 'mirrored about the middle: one circle on the sheet');
  // on X two gaps of 20 and one of 30, none alike: of the three, the one that repeats a value is the one that comes out of the others
  const plate = { planes: block([0, 20, 40, 70], [0, 50], [0, 25]).map(p => p.axis === 0 ? { ...p, area: 300 + p.pos * 7 } : p) };
  const v = planNeeded(plate, [LIN('t', 0, 0, 70), LIN('y', 1, 0, 50), LIN('z', 2, 0, 25), LIN('a', 0, 0, 20), LIN('b', 0, 20, 40), LIN('c', 0, 40, 70)], VIEWS3);
  assert.deepEqual(namesOf(v), ['a', 'c', 't', 'y', 'z'], 'the 20 again says less than the 30');
  // a radius and a diameter of the same size do not stand for each other when the part has both
  const both = { planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(50, 25, 5), { axis: ZAX, point: [5, 5, 10], r: 5, sweep: Math.PI / 2, inner: false, blend: true, box: [0, 0, 0, 5, 5, 20] }] };
  const noR = planNeeded(both, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), ROUND('d', 'D', 10)], VIEWS3);
  assert.deepEqual(noR.missing.map(m => m.kind + m.value), ['R5']);
});
test('v3.17 needed: what no view can draw stops being asked: the total comes out of the chain, and what has nothing to measure from is said once', async () => {
  const { planNeeded, pairKey } = await import('./dims_needed.mjs');
  const part = { planes: block([0, 30, 70, 100], [0, 50], [0, 20]) };
  const base = [LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)];
  const free = planNeeded(part, base, VIEWS3);
  assert.deepEqual(free.missing.filter(m => m.axis === 0).map(m => m.what + ' ' + m.value), ['total 100', 'posición 30'], 'the mirrored steps come with one of them');
  const noTotal = planNeeded(part, base, VIEWS3, { could_not_make: new Set([pairKey(0, 0, 100)]) });
  assert.deepEqual(noTotal.missing.filter(m => m.axis === 0).map(m => m.value + (m.suffix ?? '')), ['30 TYP', '40'], 'with no total the chain says it: the middle counts too');
  assert.ok(noTotal.missing.filter(m => m.axis === 0).every(m => !m.unreachable));
  const all = ['0|0|30', '0|0|70', '0|0|100', '0|30|70', '0|30|100', '0|70|100'];
  const none = planNeeded(part, base, VIEWS3, { could_not_make: new Set(all) });
  assert.ok(none.missing.filter(m => m.axis === 0).every(m => m.unreachable), JSON.stringify(none.missing));
  assert.equal(none.report.sufficient, false);
  assert.match(none.report.summary, /no se pudo acotar en ninguna vista/);
  const size = planNeeded({ planes: block([0, 100], [0, 50], [0, 20]), rounds: [hole(50, 25, 5)] }, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)], VIEWS3, { could_not_make: new Set(['D|10']) });
  assert.equal(size.missing[0].unreachable, true);
});
test('v3.17 needed: from the middle of the part, where nothing is seen to measure from, only if what it stands for cannot be drawn', async () => {
  const { planNeeded, pairKey } = await import('./dims_needed.mjs');
  const twins = { planes: block([0, 350], [0, 150], [0, 35]), rounds: [hole(70, 75, 45, 0, 35), hole(280, 75, 45, 0, 35)] };
  const dims = [LIN('x', 0, 0, 350), LIN('y', 1, 0, 150), LIN('z', 2, 0, 35), ROUND('d', 'D', 90), LIN('desde_el_medio', 0, 70, 175)];
  const a = planNeeded(twins, dims, VIEWS3);
  assert.ok(!namesOf(a).includes('desde_el_medio'), 'the separation is asked for instead');
  assert.deepEqual(a.missing.map(m => m.value), [210]);
  assert.match(a.dropped.find(d => d.dimension === 'desde_el_medio').why, /no mide nada/);
  const b = planNeeded(twins, dims, VIEWS3, { could_not_make: new Set([pairKey(0, 70, 280)]) });
  assert.ok(namesOf(b).includes('desde_el_medio'), 'the separation cannot be drawn: better that than nothing');
  assert.deepEqual(b.missing, []);
});
test('v3.17 needed: teeth around a centre: one tooth says them all, also when some of their faces lie along an axis of the part', async () => {
  const { planNeeded, findPolar, dimensionsFromEdges } = await import('./dims_needed.mjs');
  // a gear of 24 teeth, its axis along Z. Straight flanks from the root circle R50 to the tip circle R60, one tooth at each 15 degrees, the first at 90
  const rot = (x, y, t) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
  const box2 = (a, b, z0, z1) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0, Math.max(a[0], b[0]), Math.max(a[1], b[1]), z1];
  const flank = (t, side) => { const a = rot(side * 8, Math.sqrt(2500 - 64), t), b = rot(side * 5, Math.sqrt(3600 - 25), t), dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return { normal: [+(dy / L).toFixed(5), +(-dx / L).toFixed(5), 0], box: box2(a, b, 0, 30), area: +(L * 30).toFixed(2), chamfer: false }; };
  const slanted = [], planesOf = [];
  for (let i = 0; i < 24; i++) for (const side of [-1, 1]) { const f = flank(i * Math.PI / 12, side); if (Math.max(Math.abs(f.normal[0]), Math.abs(f.normal[1])) > 0.9999) throw new Error('prueba: una cara a lo largo de un eje'); slanted.push(f); }
  const arc = (r, sweep) => ({ axis: ZAX, point: [0, 0, 15], r, sweep, inner: false, blend: false, spans: [[0, 30]], box: [-r, -r, 0, r, r, 30] });
  const sizes = { planes: PLANES(2, [0, 30], 9000), rounds: [arc(60, 1), arc(50, 2), hole(0, 0, 10, 0, 30)], slanted };
  const polar = findPolar(sizes);
  assert.equal(polar.repeats[0].count, 24); assert.equal(polar.repeats[0].axis, 2);
  assert.equal(polar.slanted.length, 2, 'the two flanks of one tooth');
  assert.ok(polar.slanted.every(f => f.repeats === 24));
  assert.ok(polar.slanted.every(f => f.box[1] > 40 && Math.abs(f.box[0]) < 10), 'the tooth standing straight up: its widths run along the sheet');
  const plan = planNeeded(sizes, [ROUND('d120', 'D', 120), ROUND('d100', 'D', 100), ROUND('d20', 'D', 20), LIN('ancho', 2, 0, 30)], VIEWS3);
  assert.deepEqual(plan.missing.filter(m => m.kind === 'L').map(m => m.axis + ':' + m.value).sort(), ['0:10', '0:16'], 'its width at the tip and at the root');
  assert.match(plan.report.repeated_around[0], /24 veces alrededor de Z/);
  // a slanted edge has no line of that plane: its corner carries the dimension
  const need = plan.missing.find(m => m.value === 16), left = sizes.slanted[0], corner = { index: 7, kind: 'line', length_mm: 11, start_model_mm: [-8, 49.4, 30], end_model_mm: [-5, 59.8, 30], start_sheet_mm: [-8, 49.4], end_sheet_mm: [-5, 59.8] }, other = { ...corner, index: 8, start_model_mm: [8, 49.4, 30], end_model_mm: [5, 59.8, 30], start_sheet_mm: [8, 49.4], end_sheet_mm: [5, 59.8] };
  assert.ok(left);
  assert.deepEqual(dimensionsFromEdges(need, VIEWS3.get('F'), [corner, other])[0], { edges: [7, 8], ends: ['start', 'start'], type: 'horizontal', expected: 16, pair: need.pairs[0] });
  // eight teeth at 45 degrees: four of each eight flat faces come as planes of the part, and the part has nothing else there
  const flatTop = t => { const m = rot(0, 60, t), a = rot(-10, 60, t), b = rot(10, 60, t), n = rot(0, 1, t); return { normal: n.map(v => +v.toFixed(5)).concat(0), box: box2(a, b, 0, 30), area: 600 }; };
  const octo = { planes: [...PLANES(2, [0, 30], 9000), ...[-60, 60].flatMap(pos => [{ axis: 0, pos, area: 600 }, { axis: 1, pos, area: 600 }])], rounds: [hole(0, 0, 10, 0, 30)], slanted: [1, 3, 5, 7].map(i => flatTop(i * Math.PI / 4)) };
  const o = findPolar(octo);
  assert.equal(o.repeats[0].count, 4);
  assert.equal(o.slanted.length, 1);
  assert.deepEqual(o.planes.map(p => p.axis + ':' + p.pos), ['2:0', '2:30', '0:-60', '1:-60', '0:60', '1:60'], 'the steps of 90 do not reach those at 0: they are planes of their own');
  // the corners of a square cut at 45 with no chamfer feature: said once, and it says there are more
  const s = Math.SQRT1_2, cut = (nx, ny, b) => ({ normal: [nx, ny, 0], box: b, area: 56, chamfer: false });
  const square = { planes: block([0, 100], [0, 100], [0, 20]), slanted: [cut(s, s, [98, 98, 0, 100, 100, 20]), cut(-s, s, [0, 98, 0, 2, 100, 20]), cut(s, -s, [98, 0, 0, 100, 2, 20]), cut(-s, -s, [0, 0, 0, 2, 2, 20])] };
  const sq = planNeeded(square, [LIN('x', 0, 0, 100), LIN('z', 2, 0, 20), LIN('ch', 0, 98, 100)], VIEWS3);
  assert.deepEqual(namesOf(sq), ['ch', 'x', 'z']);
  assert.equal(sq.kept.find(k => k.name === 'ch').suffix, ' X 45° TYP');
});
test('v3.17 needed: faces that only look alike, or holes of a ring, are not a pattern; arms of arcs are', async () => {
  const { planNeeded, findPolar } = await import('./dims_needed.mjs');
  // three slanted faces, the same size at the same distance, but at unequal angles
  const f = t => ({ normal: [+Math.cos(t).toFixed(5), +Math.sin(t).toFixed(5), 0], box: [30 * Math.cos(t) - 1e-6, 30 * Math.sin(t) - 1e-6, 0, 30 * Math.cos(t) + 1e-6, 30 * Math.sin(t) + 1e-6, 10], area: 100 });
  assert.equal(findPolar({ planes: [], rounds: [hole(0, 0, 5, 0, 10)], slanted: [f(0.3), f(1.1), f(3.9)] }).repeats.length, 0);
  // eight arms ending in an arc of R4 whose centre goes around: it asks for the place of one, and the size counts them all
  const arm = i => { const t = i * Math.PI / 4, x = 40 * Math.cos(t), y = 40 * Math.sin(t); return { axis: ZAX, point: [x, y, 5], r: 4, sweep: 2.5, inner: false, blend: false, spans: [[0, 10]], box: [x - 4, y - 4, 0, x + 4, y + 4, 10] }; };
  const star = { planes: PLANES(2, [0, 10], 900), rounds: [hole(0, 0, 10, 0, 10), ...[0, 1, 2, 3, 4, 5, 6, 7].map(arm)], slanted: [] };
  const plan = planNeeded(star, [ROUND('d', 'D', 20), ROUND('r', 'R', 4), LIN('g', 2, 0, 10)], VIEWS3);
  assert.equal(plan.report.repeated_around.length, 1);
  assert.equal(plan.kept.find(k => k.name === 'r').suffix, ' TYP', 'eight of them');
  assert.ok(plan.missing.filter(m => m.kind === 'L').length <= 2, JSON.stringify(plan.missing));
});
test('v3.17 needed: the two flanks of a tooth are turned copies of themselves, not of each other', async () => {
  const { findPolar } = await import('./dims_needed.mjs');
  // ten teeth at 36 degrees, each with two arcs of one size, at 5 degrees to each side of the tooth: all together their steps alternate, 10 and 26
  const arc = t => { const x = 50 * Math.cos(t), y = 50 * Math.sin(t), r = 4; return { axis: ZAX, point: [x, y, 5], r, sweep: 1, inner: false, blend: false, spans: [[0, 10]], box: [x - r, y - r, 0, x + r, y + r, 10] }; };
  const flanks = [];
  for (let i = 0; i < 10; i++) for (const side of [-1, 1]) flanks.push(arc(i * Math.PI / 5 + side * 5 * Math.PI / 180));
  const p = findPolar({ planes: PLANES(2, [0, 10], 900), rounds: [hole(0, 0, 10, 0, 10), ...flanks], slanted: [] });
  assert.equal(p.repeats[0].count, 10, 'ten teeth, not twenty and not three');
  assert.equal(p.repeats[0].kinds, 2);
  assert.equal(p.echo.size, 18, 'what is left is one flank of each kind');
});
test('v3.17 needed: an arc that touches two things needs only its radius, one that touches one takes one coordinate; a fillet says nothing about what it joins', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const arc = (x, y, r, b, blend = false) => ({ axis: ZAX, point: [x, y, 10], r, sweep: 1.5, inner: false, blend, spans: [[0, 20]], box: [b[0], b[1], 0, b[2], b[3], 20] });
  const planes = block([0, 100], [0, 50], [0, 20]), dims = [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20), ROUND('r', 'R', 10)];
  // a corner drawn as an arc, no fillet feature: the two faces put its centre
  const two = planNeeded({ planes, rounds: [arc(90, 40, 10, [90, 40, 100, 50])] }, dims, VIEWS3);
  assert.equal(two.report.sufficient, true, two.report.summary);
  assert.deepEqual(namesOf(two), ['r', 'x', 'y', 'z']);
  const asked = plan => plan.missing.filter(m => m.kind === 'L').map(m => m.axis + ':' + m.value).sort();
  // touching only the top: its height comes from there, along the top it has to be placed
  const one = arc(40, 40, 10, [30, 40, 50, 50]);
  assert.deepEqual(asked(planNeeded({ planes, rounds: [one] }, dims, VIEWS3)), ['0:40']);
  // a fillet beside it says nothing: still one contact
  assert.deepEqual(asked(planNeeded({ planes, rounds: [one, arc(55, 40, 5, [50, 35, 60, 45], true)] }, [...dims, ROUND('r5', 'R', 5)], VIEWS3)), ['0:40']);
  // a boss with its own place does: top and boss put the arc, and only the boss is asked for
  const boss = { ...hole(65, 40, 15, 0, 20), inner: false };
  assert.deepEqual(asked(planNeeded({ planes, rounds: [one, boss] }, [...dims, ROUND('d', 'D', 30)], VIEWS3)), ['0:35', '1:10']);
});
test('v3.17 needed: a ring with an empty place is still a ring, three holes of a grid are not; its step may be an angle, two level neighbours take a straight dimension, and with no contour the separation says a full ring but not one with an empty place', async () => {
  const { planNeeded, ringDiameters } = await import('./dims_needed.mjs');
  const around = (i, from = 0) => { const t = from + i * 2 * Math.PI / 7; return hole(18 * Math.cos(t), 18 * Math.sin(t), 4, 0, 10); };
  const six = [0, 1, 2, 3, 4, 5].map(i => around(i)), centre = { ...hole(0, 0, 25, 0, 10), inner: false };
  assert.deepEqual(ringDiameters({ rounds: [centre, ...six] }), [8]);
  assert.deepEqual(ringDiameters({ rounds: six }), [], 'with nothing in the middle an empty place says no ring');
  assert.deepEqual(ringDiameters({ rounds: [hole(0, 0, 3), hole(30, 0, 3), hole(0, 30, 3)] }), [], 'three corners of a grid');
  const common = [ROUND('d50', 'D', 50), ROUND('d8', 'D', 8), LIN('g', 2, 0, 10), LIN('RD1@cont', 0, 18, 25)], fixed = { fixed_names: ['RD1@cont'] }, planes = PLANES(2, [0, 10]);
  const byAngle = planNeeded({ planes, rounds: [centre, ...six] }, [...common, { name: 'paso', value: 51.43, cls: 'A', dims: [{ view: 'F', mode: 'free', ang: {} }] }], VIEWS3, fixed);
  assert.ok(namesOf(byAngle).includes('paso'), namesOf(byAngle).join());
  assert.equal(byAngle.report.sufficient, true, byAngle.report.summary);
  assert.equal(byAngle.kept.find(k => k.name === 'd8').prefix, '6 X <MOD-DIAM>');
  // the empty place on top: the two at the bottom are level, a straight dimension says the step
  const level = [1, 2, 3, 4, 5, 6].map(i => around(i, Math.PI / 2));
  const asked = planNeeded({ planes, rounds: [centre, ...level] }, common, VIEWS3, fixed).missing.find(m => m.what === 'separación entre barrenos');
  assert.equal(asked.kind, 'L'); assert.equal(asked.axis, 0); assert.equal(asked.value, 15.62); assert.ok(!asked.unreachable);
  // none level: it cannot be drawn straight, and it says so
  const none = planNeeded({ planes, rounds: [centre, ...[0, 1, 2, 3, 4, 5].map(i => around(i, 0.2))] }, common, VIEWS3, fixed).missing.find(m => m.what === 'separación entre barrenos');
  assert.equal(none.kind, 'ring'); assert.equal(none.unreachable, true);
  // only a bore in the middle, no contour: six of six are said by their separation and their count, six of seven need the radius too
  const bore = hole(0, 0, 5, 0, 10), paso = v => [ROUND('d10', 'D', 10), ROUND('d8', 'D', 8), LIN('g', 2, 0, 10), LIN('RD1@paso', 0, -v / 2, v / 2)];
  const full = planNeeded({ planes, rounds: [bore, ...[0, 1, 2, 3, 4, 5].map(i => hole(18 * Math.cos(i * Math.PI / 3), 18 * Math.sin(i * Math.PI / 3), 4, 0, 10))] }, paso(18), VIEWS3, { fixed_names: ['RD1@paso'] });
  assert.deepEqual(full.missing, [], JSON.stringify(full.missing));
  const gap = planNeeded({ planes, rounds: [bore, ...level] }, paso(15.62), VIEWS3, { fixed_names: ['RD1@paso'] });
  assert.deepEqual(gap.missing.map(m => m.what + ' ' + m.value), ['radio del círculo de barrenos 18']);
});
test('v3.17 needed: a part inside one round is said from its centre: its size is the diameter, no total, and what is beyond a keyway goes to the centre too', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const round = (r, inner) => ({ axis: [1, 0, 0], point: [15, 0, 0], r, sweep: FULL, inner, blend: false, spans: [[0, 30]], box: [0, -r, -r, 30, r, r] });
  const wheel = { planes: [...PLANES(0, [0, 30]), ...PLANES(1, [-3, 3, 30], 60), ...PLANES(2, [22], 60)], rounds: [round(66, false), round(19, true)] };
  const plan = planNeeded(wheel, [ROUND('d132', 'D', 132), ROUND('d38', 'D', 38), LIN('ancho', 0, 0, 30)], VIEWS3);
  assert.deepEqual(plan.missing.map(m => m.axis + ':' + m.value + ' ' + m.what), ['1:6 separación', '1:30 posición', '2:22 posición']);
});
test('v3.17 needed: the end of a ring is one of its holes: the total goes to its centre, or is taken from a dimension there; and it never comes out as nothing', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const ring = (cx, r = 30, d = 2.5) => [0, 1, 2, 3, 4, 5].map(i => hole(cx + r * Math.cos(i * Math.PI / 3), r * Math.sin(i * Math.PI / 3), d, 0, 10));
  const nose = { axis: ZAX, point: [0, 0, 5], r: 60, sweep: Math.PI, inner: false, blend: false, spans: [[0, 10]], box: [-60, -60, 0, 60, 0, 10] };
  const part = { planes: [...PLANES(0, [-60, 60]), ...PLANES(1, [100]), ...PLANES(2, [0, 10])], rounds: [nose, ...ring(0)] };
  const common = [LIN('x', 0, -60, 60), LIN('g', 2, 0, 10), ROUND('r60', 'R', 60), ROUND('d5', 'D', 5), LIN('RD1@paso', 0, -15, 15), LIN('RD2@rad', 0, 0, 30)], fixed = { fixed_names: ['RD1@paso', 'RD2@rad'] };
  const without = planNeeded(part, common, VIEWS3, fixed).missing.find(m => m.axis === 1 && m.what === 'total');
  assert.deepEqual(without.pairs, [[0, 100]], 'from the centre of the ring: 100, not from a hole of it');
  assert.equal(without.value, 100);
  // and when no view could draw it, it is not asked for again (it was, endlessly): the chain says it
  const { pairKey } = await import('./dims_needed.mjs');
  const refused = planNeeded(part, common, VIEWS3, { ...fixed, could_not_make: new Set([pairKey(1, 0, 100)]) });
  assert.ok(!refused.missing.some(m => m.axis === 1 && m.what === 'total'), JSON.stringify(refused.missing));
  const withIt = planNeeded(part, [...common, LIN('alto', 1, 0, 100)], VIEWS3, fixed);
  assert.equal(withIt.report.sufficient, true, withIt.report.summary);
  assert.ok(namesOf(withIt).includes('alto'));
  // the two ends are always twins of each other: that does not put the far end in the ring. From its centre to the other end, not from the centre to itself
  const off = { planes: [...PLANES(0, [70]), ...PLANES(1, [-40, 40]), ...PLANES(2, [0, 10])], rounds: ring(-50, 20) };
  const total = planNeeded(off, [], VIEWS3).missing.find(m => m.axis === 0 && m.what === 'total');
  assert.equal(total.value, 120);
  // a dimension between two holes that were joined anyway is no total
  const between = planNeeded(part, [...common, LIN('huecos', 1, -25.98, 25.98)], VIEWS3, fixed);
  assert.ok(between.missing.some(m => m.axis === 1 && m.what === 'total'), JSON.stringify(between.missing));
});
test('v3.17 needed: the two twin sides of an arm ask for the same thing, so one dimension says both', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const side = sign => ({ normal: [sign * 0.99863, 0.05234, 0], box: sign > 0 ? [4.514, -11.948, 0, 6.774, 31.182, 10] : [-6.774, -11.948, 0, -4.514, 31.182, 10], area: 400 });
  const arm = { planes: [...PLANES(0, [-20, 20]), ...PLANES(1, [-30, 40]), ...PLANES(2, [0, 10])], slanted: [side(1), side(-1)] };
  const plan = planNeeded(arm, [LIN('x', 0, -20, 20), LIN('y', 1, -30, 40), LIN('z', 2, 0, 10), { name: 'a', value: 3, cls: 'A', dims: [{ view: 'F', mode: 'free', ang: {} }] }], VIEWS3);
  assert.deepEqual(plan.missing.map(m => m.axis + ':' + m.value), ['0:9.03']);
});
test('v3.17 needed: how far free faces reach is asked, their shape is left to the eye, and a loose dimension stays only if it falls on them; not where a round already reaches, nor a diameter said again across its edge', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const wing = { planes: [], free: [{ box: [0, 0, 0, 82.33, 29.6, 249.4], area: 9000, blend: false }] };
  const none = planNeeded(wing, [], VIEWS3);
  assert.deepEqual(none.missing.map(m => m.axis + ':' + m.value + ' ' + m.what), ['0:82.33 total', '1:29.6 total', '2:249.4 total']);
  const plan = planNeeded(wing, [LIN('x', 0, 0, 82.33), LIN('y', 1, 0, 29.6), LIN('z', 2, 0, 249.4), LIN('dentro', 2, 25, 100), LIN('fuera', 0, 100, 150)], VIEWS3);
  assert.equal(plan.report.sufficient, null);
  assert.deepEqual(namesOf(plan), ['dentro', 'x', 'y', 'z']);
  // what a plane already reaches is not asked twice
  const inside = planNeeded({ planes: block([0, 100], [0, 50], [0, 20]), free: [{ box: [10, 10, 5, 20, 20, 15], area: 50, blend: false }] }, [LIN('x', 0, 0, 100), LIN('y', 1, 0, 50), LIN('z', 2, 0, 20)], VIEWS3);
  assert.deepEqual(inside.missing, []);
  // a wheel: the free faces reach the edge of its Ø60, which its centre and diameter already say; a length across its Ø40 rim is that diameter again
  const disc = { axis: ZAX, point: [0, 0, 0], r: 30, sweep: FULL, inner: false, blend: false, box: [-30, -30, -5, 30, 30, 5] };
  const wheel = { planes: [...PLANES(0, [-45, 45]), ...PLANES(2, [-5, 5])], rounds: [disc], tori: [{ axis: ZAX, center: [0, 0, 0], major: 20, minor: 2, blend: false }], free: [{ box: [-30, -30, -5, 30, 30, 5], area: 500, blend: false }] };
  const again = planNeeded(wheel, [LIN('x', 0, -45, 45), LIN('z', 2, -5, 5), ROUND('d60', 'D', 60), ROUND('d40', 'D', 40), ROUND('r2', 'R', 2), LIN('otra', 0, -20, 20)], VIEWS3);
  assert.deepEqual(again.missing, [], JSON.stringify(again.missing));
  assert.ok(!namesOf(again).includes('otra'), namesOf(again).join());
  assert.equal(again.dropped.find(d => d.dimension === 'otra').why, 'ese diámetro ya está dicho');
});
test('v3.17 needed: equal grooves take one width, also the one with a face of the inside across it', async () => {
  const { planNeeded } = await import('./dims_needed.mjs');
  const ring = (r, y0, y1) => ({ axis: [0, 1, 0], point: [0, (y0 + y1) / 2, 0], r, sweep: FULL, inner: false, blend: false, spans: [[y0, y1]], box: [-r, y0, -r, r, y1, r] });
  const lands = [[0, 19.5], [21, 23], [24.5, 26.5], [28, 30]].map(([a, b]) => ring(15, a, b)), grooves = [[19.5, 21], [23, 24.5], [26.5, 28]].map(([a, b]) => ring(13.75, a, b));
  const piston = { planes: [...PLANES(1, [0], 487), ...PLANES(1, [19.5, 21, 23, 24.5, 26.5, 28], 113), ...PLANES(1, [20], 220), ...PLANES(1, [30], 707)], rounds: [...lands, ...grooves] };
  const plan = planNeeded(piston, [LIN('alto', 1, 0, 30), LIN('hueco', 1, 0, 20), LIN('ranura', 1, 26.5, 28), LIN('tierra', 1, 28, 30), LIN('otra', 1, 19.5, 21), ROUND('d30', 'D', 30), ROUND('d27', 'D', 27.5)], VIEWS3);
  assert.ok(!namesOf(plan).includes('otra'), namesOf(plan).join());
  assert.equal(plan.kept.find(k => k.name === 'ranura').suffix, ' TYP');
  assert.equal(plan.report.sufficient, true, plan.report.summary);
});
test('v3.17 needed: of edges equally good, the two nearest on the sheet: both on one tooth, not across the wheel', async () => {
  const { dimensionsFromEdges } = await import('./dims_needed.mjs');
  const l = (index, x, y) => ({ index, kind: 'line', length_mm: 5, start_model_mm: [x, y, 0], end_model_mm: [x, y + 5, 0], start_sheet_mm: [x, y], end_sheet_mm: [x, y + 5] });
  assert.deepEqual(dimensionsFromEdges({ kind: 'L', axis: 0, pairs: [[0, 10]], value: 10 }, VIEWS3.get('F'), [l(1, 0, 0), l(2, 0, 100), l(3, 10, 100), l(4, 10, 200)])[0].edges, [2, 3]);
});
test('v3.17 needed: a circle seen edge-on is the line of its plane: it carries a dimension when nothing else does', async () => {
  const { planNeeded, dimensionsFromEdges } = await import('./dims_needed.mjs');
  const short = planNeeded({ planes: PLANES(2, [0, 100]) }, [], VIEWS3);
  const side = (index, z, r) => ({ index, kind: 'circle', diameter_mm: r * 2, center_model_mm: [0, 0, z], normal_model: ZAX });
  const offers = dimensionsFromEdges(short.missing[0], VIEWS3.get('S'), [side(4, 0, 30), side(5, 100, 30)]);
  assert.deepEqual(offers, [{ edges: [4, 5], type: 'horizontal', expected: 100, pair: [0, 100] }]);
  // a straight edge on that plane goes first: it needs no choosing of a point
  const line = { ...edgeLine(6, [0, 0, 0], [0, 50, 0]), start_sheet_mm: [0, 0], end_sheet_mm: [0, 50] };
  assert.deepEqual(dimensionsFromEdges(short.missing[0], VIEWS3.get('S'), [side(4, 0, 30), line, side(5, 100, 30)])[0].edges, [6, 5]);
});
test('v3.17 check: a dimension line between its own edges has no extension lines, and it is still read by its value', async () => {
  const { readSheet } = await import('./dims_layout.mjs');
  const view = { name: 'F', model_type: 1, section: false, scale: 0.5, outline_mm: [0, 0, 100, 50], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin_mm: [0, 0] };
  const base = { id: 'F#0', name: 'RD1@F', view: 'F', type: 2, unit: 'mm', marked: true, pos: [30, 25], start: [25, 25], angle: 0, height: 3, attached: ['swSelEDGES', 'swSelEDGES'] };
  const m = readSheet({ sheet: 'H', sheet_mm: [280, 216], views: [view], notes: [], dimensions: [{ ...base, value: 40, text: '40', lines: [[10, 25, 30, 25]] }, { ...base, id: 'F#1', value: 99, text: '99', lines: [[10, 25, 30, 25]] }] });
  assert.equal(m.dims[0].mode, 'h');
  assert.deepEqual([m.dims[0].lin.u0, m.dims[0].lin.u1], [10, 30], 'the line is 20 on the sheet at 1:2, that is 40');
  assert.equal(m.dims[1].mode, 'fixed', 'a line that does not measure what the dimension says tells nothing');
});
test('v3.17 organize: a section with no room goes along its line, past what is in the way, and the isometric makes way', async () => {
  const { planSectionPlace } = await import('./dims_layout.mjs');
  const FRONT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], SIDE = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], ISO = [[0.7, 0.4, 0.6], [0, 0.8, -0.6], [-0.7, 0.4, 0.6]];
  const v = (name, outline, axes, extra = {}) => ({ name, model_type: 1, section: false, outline_mm: outline, axes, ...extra });
  const F = v('F', [44, 76, 94, 105], FRONT), S = v('S', [110, 76, 157, 105], SIDE), A = v('A', [125, 76, 172, 105], FRONT, { section: true });
  // past the side view, in its row, with the room a row of dimensions takes
  const row = { sheet_mm: [280, 216], title_block_mm: [145, 8, 272, 35], views: [F, S, A] };
  assert.deepEqual(planSectionPlace(row, 'A', 'F', 'vertical'), [{ view: 'A', center_mm: [208.5, 90.5] }]);
  // the isometric in the way goes somewhere else; a view with a projection never does
  const iso = v('I', [190, 70, 250, 120], ISO);
  const moves = planSectionPlace({ ...row, views: [F, S, A, iso] }, 'A', 'F', 'vertical');
  assert.deepEqual(moves[0], { view: 'A', center_mm: [208.5, 90.5] });
  assert.equal(moves[1].view, 'I');
  const [cx, cy] = moves[1].center_mm; assert.ok(cy - 25 > 105 + 8 || cx + 30 < 185 - 8, 'it no longer touches the section: ' + moves[1].center_mm);
  // a horizontal cut goes up and down instead
  const down = v('A', [44, 76, 94, 105], FRONT, { section: true });
  assert.deepEqual(planSectionPlace({ sheet_mm: [280, 216], title_block_mm: null, views: [v('F', [44, 120, 94, 149], FRONT), down] }, 'A', 'F', 'horizontal'), [{ view: 'A', center_mm: [69, 80.5] }]);
  // no room in the row: it leaves the line, and says so
  const off = planSectionPlace({ sheet_mm: [200, 216], title_block_mm: null, views: [F, S, A] }, 'A', 'F', 'vertical');
  assert.equal(off[0].break_alignment, true);
  // off its line it does not take the first gap, it takes one with room for its dimensions: not a corner of the sheet
  const G = v('F', [60, 30, 80, 110], FRONT), T = v('T', [60, 130, 80, 200], FRONT), gear = v('S', [100, 30, 170, 100], SIDE), cut = v('A', [60, 30, 80, 110], FRONT, { section: true });
  const [went] = planSectionPlace({ sheet_mm: [280, 216], title_block_mm: [145, 8, 272, 28], views: [G, T, gear, cut] }, 'A', 'F', 'horizontal');
  assert.equal(went.break_alignment, true);
  assert.ok(went.center_mm[0] - 10 >= 38 + 30 + 8 || went.center_mm[0] > 100, 'not squeezed against the edge of the sheet: ' + went.center_mm);
  // the sheet is full: nothing to do, the caller warns
  const tall = (name, x0, x1, extra) => v(name, [x0, 20, x1, 95], FRONT, extra);
  assert.equal(planSectionPlace({ sheet_mm: [180, 110], title_block_mm: null, views: [tall('F', 44, 94), tall('S', 110, 157), tall('A', 125, 172, { section: true })] }, 'A', 'F', 'vertical'), null);
});
test('v3.17 organize: it asks the part what it needs, takes off what hangs from the line of a section, makes what is missing and says the sheet is enough', async () => {
  const { organizeDimensions } = await import('./dims_layout.mjs');
  const view = (name, axes, outline, origin = [0, 0]) => ({ name, scale: 1, model_type: 1, section: false, model: 'p.SLDPRT', outline_mm: outline, origin_mm: origin, axes });
  const F = view('F', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 100, 50]), S = view('S', [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [0, 0, 20, 50], [20, 0]), T = view('T', [[1, 0, 0], [0, 0, 1], [0, -1, 0]], [0, 0, 100, 20]);
  const sizes = { planes: block([0, 30, 100], [0, 50], [0, 20]).map(p => p.axis === 0 ? { ...p, area: 300 + p.pos * 11 } : p), rounds: [], slanted: [], cones: [], spheres: [], tori: [], free: [] };
  let n = 0;
  const dim = (name, v, mode, u0, u1, extra = {}) => { n++; const line = 70 + n * 8, lines = mode === 'h' ? [[u0, 0, u0, line], [u1, 0, u1, line], [u0, line, u1, line]] : [[0, u0, line, u0], [0, u1, line, u1], [line, u0, line, u1]], pos = mode === 'h' ? [(u0 + u1) / 2, line + 3] : [line + 3, (u0 + u1) / 2]; return { id: v + '#' + n, name, view: v, type: 2, hole_callout: false, marked: true, value: Math.abs(u1 - u0), unit: 'mm', text: String(Math.abs(u1 - u0)), pos, start: [pos[0] - 4, pos[1]], height: 3, angle: mode === 'h' ? 0 : Math.PI / 2, lines, arcs: 0, attached: ['swSelEDGES', 'swSelEDGES'], ...extra }; };
  const geo = { sheet: 'H', active_sheet: 'H', sheets: ['H'], sheet_mm: [420, 297], title_block_mm: null, notes: [], views: [F, T, S], dimensions: [dim('RD9@F@p.Drawing', 'F', 'h', 12, 87, { attached: ['swSelSKETCHSEGS', 'swSelEDGES'] }), dim('total', 'F', 'h', 0, 100), dim('paso', 'F', 'h', 0, 30), dim('resto', 'F', 'h', 30, 100)] };
  const offer = { total: () => dim('total', 'F', 'h', 0, 100), paso: () => dim('paso', 'F', 'h', 0, 30), resto: () => dim('resto', 'F', 'h', 30, 100) };
  const added = [], worker = { call: async (op, a) => {
    if (op === 'drawing_dim_geometry') return { ok: true, result: structuredClone(geo) };
    if (op === 'drawing_part_hollows') return { ok: true, result: { holes: [], features: [] } };
    if (op === 'drawing_part_sizes') return { ok: true, result: sizes };
    if (op === 'drawing_dim_insert') { if (a.views[0] === 'F') for (const [k, mk] of Object.entries(offer)) if (!geo.dimensions.some(d => d.name === k)) geo.dimensions.push(mk()); return { ok: true, result: {} }; }
    if (op === 'drawing_dim_apply') { geo.dimensions = geo.dimensions.filter(d => !(a.deletes ?? []).includes(d.id)); for (const m of a.moves ?? []) { const d = geo.dimensions.find(x => x.id === m.id); if (d) d.pos = m.pos; } return { ok: true, result: { moved: 0, deleted: a.deletes ?? [], missed: [] } }; }
    if (op === 'drawing_dimension' && a.action === 'probe') return { ok: true, result: { scale: 1, edges: a.view === 'F' ? [edgeLine(0, [0, 0, 20], [100, 0, 20]), edgeLine(1, [0, 50, 20], [100, 50, 20])] : a.view === 'S' ? [{ ...edgeLine(0, [0, 0, 0], [0, 50, 0]), start_sheet_mm: [0, 0], end_sheet_mm: [0, 50] }, { ...edgeLine(1, [0, 0, 20], [0, 50, 20]), start_sheet_mm: [20, 0], end_sheet_mm: [20, 50] }] : [] } };
    if (op === 'drawing_dimension' && a.action === 'add') { const isZ = a.view === 'S', name = 'RD' + (added.length + 1) + '@' + a.view + '@p.Drawing'; added.push(name); geo.dimensions.push(isZ ? dim(name, 'S', 'h', 0, 20) : dim(name, 'F', 'v', 0, 50)); return { ok: true, result: { name, value: isZ ? 20 : 50 } }; }
    return { ok: false, error: 'unexpected ' + op };
  } };
  const r = await organizeDimensions(worker, { document_id: 'd', section: false });
  const names = geo.dimensions.map(d => d.name);
  assert.ok(!names.includes('RD9@F@p.Drawing'), 'the one on the line of the section is gone');
  assert.equal(r.dimensions_not_on_the_part, 1);
  assert.ok(names.includes('total') && names.includes('paso') && !names.includes('resto'), names.join());
  assert.equal(added.length, 2, 'height and thickness made from the edges');
  assert.equal(r.sufficiency.sufficient, true, JSON.stringify(r.sufficiency));
  assert.equal(r.sufficiency.too_many, 0);
  assert.match(r.sufficiency.summary, /se puede hacer la pieza/);
  // a dimension that comes out and cannot be read back is taken off, it is not made again and again, and the sheet says what is left
  const { addNeededForTest } = await import('./dims_layout.mjs');
  const unread = { missing: [{ kind: 'L', axis: 2, pairs: [[0, 20]], value: 20, what: 'total' }] };
  const log = [], sheet = { dimensions: [] }, w2 = { call: async (op, a) => {
    if (op === 'drawing_dim_geometry') return { ok: true, result: { sheet: 'H', sheet_mm: [280, 216], views: [], notes: [], dimensions: structuredClone(sheet.dimensions) } };
    if (op === 'drawing_dim_apply') { sheet.dimensions = sheet.dimensions.filter(d => !(a.deletes ?? []).includes(d.id)); log.push('quitada'); return { ok: true, result: {} }; }
    if (op === 'drawing_dimension' && a.action === 'probe') return { ok: true, result: { edges: [{ ...edgeLine(0, [0, 0, 0], [0, 50, 0]), start_sheet_mm: [0, 0], end_sheet_mm: [0, 50] }, { ...edgeLine(1, [0, 0, 20], [0, 50, 20]), start_sheet_mm: [20, 0], end_sheet_mm: [20, 50] }] } };
    if (op === 'drawing_dimension' && a.action === 'add') { log.push('hecha'); sheet.dimensions.push({ id: 'n', name: 'RD1@S', view: 'S', type: 2, value: 20, unit: 'mm', lines: [] }); return { ok: true, result: { name: 'RD1@S', value: 20 } }; }
    return { ok: false, error: 'unexpected ' + op };
  } };
  const read2 = async () => ({ views: new Map([['S', { name: 'S', axes: VIEWS3.get('S').axes }]]), dims: [] });
  const plans = [];
  const done = await addNeededForTest(w2, {}, unread, async (names, cannot) => { plans.push(cannot.size); return cannot.size ? { missing: [{ ...unread.missing[0], pairs: [], unreachable: true }] } : unread; }, ['S'], read2);
  assert.deepEqual(log, ['hecha', 'quitada'], 'once');
  assert.deepEqual(done.names, []);
  assert.ok(done.cannot.has('2|0|20'));
  assert.match(done.lines[0], /no se puede leer/);
});
test('v3.17 needed: two long dimensions a hair apart say their small step, and the corner a round took away goes on a line from the end of its edge', async () => {
  const { planNeeded, dimensionsFromEdges, pairKey } = await import('./dims_needed.mjs');
  const { addNeededForTest } = await import('./dims_layout.mjs');
  const blend = (y, z, r) => ({ axis: [1, 0, 0], point: [0, y, z], r, sweep: 0.5, inner: false, blend: true, box: [-5, y - r, z - r, 5, y + r, z + r] });
  const part = { planes: [...PLANES(0, [-5, 5]), ...PLANES(1, [-35, -20.5, 0]), ...PLANES(2, [-7, 7])], rounds: [blend(-21.8, 4, 3), blend(-10.7, 12.6, 10)], slanted: [{ normal: [0, 0.5, 0.8660254], box: [-5, -20.3, 3.94, 5, -15.7, 6.596], area: 50 }] };
  const dims = [LIN('x', 0, -5, 5), LIN('y', 1, -35, 0), LIN('z', 2, -7, 7), { name: 'a', value: 30, cls: 'A', dims: [{ view: 'F', mode: 'free', ang: {} }] }, ROUND('r3', 'R', 3), ROUND('r10', 'R', 10), LIN('techo', 1, -35, -20.5), LIN('esquina', 1, -35, -21)];
  const plan = planNeeded(part, dims, VIEWS3), step = plan.missing.find(n => n.what === 'escalón');
  assert.ok(namesOf(plan).includes('techo') && !namesOf(plan).includes('esquina'), namesOf(plan).join());
  assert.equal(step?.value, 0.5, JSON.stringify(plan.missing));
  // in the side view the face is a line: it goes on from the end of its edge to the corner, 0.81 mm
  const S = VIEWS3.get('S'), line = (index, a, b) => ({ ...edgeLine(index, a, b), start_sheet_mm: [-a[2], a[1]], end_sheet_mm: [-b[2], b[1]] });
  const edges = [line(0, [5, -20.3, 6.596], [5, -15.7, 3.94]), line(1, [5, -20.5, -7], [5, -20.5, -3])];
  const [offer] = dimensionsFromEdges(step, S, edges);
  assert.equal(offer.action, 'guided'); assert.equal(offer.type, 'vertical'); assert.equal(offer.expect, 0.5);
  assert.deepEqual(offer.guides.map(g => [g.edge, g.at, g.turn_deg]), [[0, 'start', 180]]);
  assert.ok(Math.abs(offer.guides[0].length_mm - 0.808) < 0.01, String(offer.guides[0].length_mm));
  assert.ok(offer.feet.some(f => f.guide === 0 && f.end === 'end') && offer.feet.some(f => f.edge === 1), JSON.stringify(offer.feet));
  assert.deepEqual(dimensionsFromEdges(step, VIEWS3.get('F'), edges), [], 'only where the face is seen as a line');
  const sent = [], w = { call: async (op, a) => {
    if (op === 'drawing_dimension' && a.action === 'probe') return { ok: true, result: { edges } };
    if (op === 'drawing_dimension' && a.action === 'guided') { sent.push(a); return { ok: true, result: { name: 'RD1@S', value: 0.5 } }; }
    return { ok: false, error: 'unexpected ' + op };
  } };
  const done = await addNeededForTest(w, {}, { missing: [step] }, async () => ({ missing: [] }), ['S'], async () => ({ views: new Map([['S', S]]), dims: [] }));
  assert.deepEqual(done.names, ['RD1@S']); assert.equal(sent.length, 1);
  // ...and what cannot be drawn does not leave the part without it: the long one comes back
  assert.ok(namesOf(planNeeded(part, dims, VIEWS3, { could_not_make: new Set([pairKey(1, -21, -20.5)]) })).includes('esquina'));
});
test('v3.17 angles: with a ray in the air it goes to the end of the edge it follows, on a line parallel to that ray and off the part', async () => {
  const { planAngleGuide, viewMask } = await import('./dims_layout.mjs');
  const deg = Math.PI / 180, V = { name: 'V1', scale: 1, outline_mm: [50, 35, 110, 125], origin_mm: [80, 80] }, shaped = rects => ({ ...V, mask: viewMask(shapeOf('V1', V.origin_mm, rects), V) });
  const edge = (index, s, e) => ({ index, kind: 'line', start_sheet_mm: s, end_sheet_mm: e });
  const fork = shaped([[60, 40, 100, 76], [70, 76, 90, 120]]), Q = [60, 76], P = [62.76, 80.78];
  const d = { unit: 'deg', value: 30, ang: { c: [80, 110.64], from: -120 * deg, sweep: 30 * deg } };
  const p = planAngleGuide(d, fork, [edge(7, Q, P)]);
  assert.deepEqual(p.guides, [{ edge: 7, at: 'start', turn_deg: 30, length_mm: 11 }], 'from the lower end, straight up');
  assert.deepEqual(p.feet, [{ edge: 7 }, { guide: 0 }]);
  assert.equal(p.type, 'angle'); assert.equal(p.expect, 30);
  assert.ok(Math.hypot(p.position_mm[0] - 62.07, p.position_mm[1] - 83.73) < 0.01, p.position_mm.join());
  // an edge on each ray, or on none: it stays
  assert.equal(planAngleGuide(d, fork, [edge(7, Q, P), edge(8, [80, 100], [80, 90])]), null);
  assert.equal(planAngleGuide(d, fork, [edge(8, [10, 10], [20, 10])]), null);
  assert.equal(planAngleGuide(d, shaped([[0, 0, 200, 200]]), [edge(7, Q, P)]), null, 'nowhere off the part');
  // a 45° under a wider head: up the line would run inside the part, the one square to it reads the same
  const ends = [[69.7, 100.3], [68, 102]], q = planAngleGuide({ unit: 'deg', value: 45, ang: { c: [70, 100], from: 90 * deg, sweep: 45 * deg } }, shaped([[70, 40, 90, 100], [68, 100, 92, 130]]), [edge(3, ...ends)]);
  const [X, Y] = q.guides[0].at === 'start' ? ends : [ends[1], ends[0]], way = Math.atan2(Y[1] - X[1], Y[0] - X[0]) + q.guides[0].turn_deg * deg;
  assert.ok(Math.abs(Math.cos(way) + 1) < 1e-6, 'to the left: ' + JSON.stringify(q.guides));
});
test('v3.17 organize: an angle with a ray in the air is made on its line; the old one goes only after the sheet confirmed the new one', async () => {
  const { organizeDimensions } = await import('./dims_layout.mjs');
  const deg = Math.PI / 180, view = (name, axes, outline, origin) => ({ name, scale: 1, model_type: 1, section: false, model: 'p.SLDPRT', outline_mm: outline, origin_mm: origin, axes });
  const F = view('F', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [55, 35, 105, 125], [80, 80]), T = view('T', [[1, 0, 0], [0, 0, 1], [0, -1, 0]], [55, 140, 105, 160], [80, 150]), S = view('S', [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [130, 35, 150, 125], [140, 80]);
  const arcAt = (c, r) => [c[0] + r * Math.cos(-120 * deg), c[1] + r * Math.sin(-120 * deg), c[0] + r * Math.cos(-90 * deg), c[1] + r * Math.sin(-90 * deg), c[0], c[1]];
  const angle = (id, name, c, r, attached) => ({ id, name, view: 'F', type: 3, hole_callout: false, marked: true, value: 30, unit: 'deg', text: '30°', pos: [c[0] - 0.3 * r, c[1] - 1.05 * r], start: [c[0] - 0.3 * r - 3, c[1] - 1.05 * r], height: 3, angle: 0, lines: [], arcs: 1, arc_list: [arcAt(c, r)], attached });
  const run = async guided => {
    const geo = { sheet: 'H', active_sheet: 'H', sheets: ['H'], sheet_mm: [420, 297], title_block_mm: null, notes: [], views: [F, T, S], dimensions: [] }, log = [];
    const worker = { call: async (op, a) => {
      if (op === 'drawing_dim_geometry') return { ok: true, result: structuredClone(geo) };
      if (op === 'drawing_part_hollows') return { ok: true, result: { holes: [], features: [] } };
      if (op === 'drawing_dim_shapes') return { ok: true, result: { views: [shapeOf('F', F.origin_mm, [[60, 40, 100, 76], [70, 76, 90, 120]])] } };
      if (op === 'drawing_dim_insert') { if (a.views[0] === 'F' && !geo.dimensions.some(d => d.name === 'ang')) geo.dimensions.push(angle('F#0', 'ang', [80, 110.64], 33, ['swSelSKETCHSEGS', 'swSelSKETCHSEGS'])); return { ok: true, result: {} }; }
      if (op === 'drawing_dim_apply') { if (a.view_moves?.length) log.push('reparte'); for (const t of a.texts ?? []) if (t.black) log.push('tinta ' + t.id); if (a.deletes?.length) log.push('quita ' + a.deletes); geo.dimensions = geo.dimensions.filter(d => !(a.deletes ?? []).includes(d.id)); for (const m of a.moves ?? []) { const d = geo.dimensions.find(x => x.id === m.id); if (d) d.pos = m.pos; } return { ok: true, result: { moved: 0, deleted: a.deletes ?? [], missed: [] } }; }
      if (op === 'drawing_dimension' && a.action === 'probe') return { ok: true, result: { scale: 1, edges: a.view === 'F' ? [{ index: 7, kind: 'line', start_sheet_mm: [60, 76], end_sheet_mm: [62.76, 80.78] }] : [] } };
      if (op === 'drawing_dimension' && a.action === 'guided') { log.push('hace ' + a.feet.length + ' pies'); if (!guided) return { ok: false, error: 'It measured 150 and should be 30: line and dimension removed' }; geo.dimensions.push(angle('F#1', 'RD1@F@p.Drawing', [60, 76], 8, ['swSelEDGES', 'swSelSKETCHSEGS'])); return { ok: true, result: { name: 'RD1@F@p.Drawing', value: 30 } }; }
      return { ok: false, error: 'unexpected ' + op };
    } };
    return { r: await organizeDimensions(worker, { document_id: 'd', section: false }), names: geo.dimensions.map(d => d.name), log };
  };
  const yes = await run(true);
  assert.deepEqual(yes.names, ['RD1@F@p.Drawing'], JSON.stringify(yes));
  assert.equal(yes.r.angles_on_a_line, 1);
  assert.ok(yes.log.indexOf('hace 2 pies') < yes.log.lastIndexOf('quita F#0'), yes.log.join());
  // the views go to their places first: the line widens the frame of its view, and it would push the view too far
  assert.ok(yes.log.includes('reparte') && yes.log.indexOf('reparte') < yes.log.indexOf('hace 2 pies'), yes.log.join());
  // what the line measures is a reference dimension, grey on paper unless it is told otherwise
  assert.ok(yes.log.includes('tinta F#1') && yes.log.indexOf('tinta F#1') < yes.log.lastIndexOf('quita F#0'), yes.log.join());
  const no = await run(false);
  assert.deepEqual(no.names, ['ang'], JSON.stringify(no));
  assert.match(no.r.warnings.join(), /Ángulo ang: .*150/);
});
test('v3.17 angles: on its line it stays by its vertex: what keeps the others off that line does not keep it off, and its text does not sit on its own extension line', async () => {
  const { readSheet, findIssues, planLayout } = await import('./dims_layout.mjs');
  const deg = Math.PI / 180, V = { name: 'V1', scale: 1, model_type: 1, section: false, model: 'p.SLDPRT', outline_mm: [55, 35, 105, 125], origin_mm: [80, 80], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, c = [60, 76];
  const at = (r, a) => [c[0] + r * Math.cos(a * deg), c[1] + r * Math.sin(a * deg)];
  const angle = (r, attached, lines = []) => ({ id: 'V1#0', name: 'ang', view: 'V1', type: 3, hole_callout: false, marked: true, value: 30, unit: 'deg', text: '30°', pos: at(r, -105), start: [at(r, -105)[0] - 3, at(r, -105)[1]], height: 3, angle: 0, lines, arcs: 1, arc_list: [[...at(r, -120), ...at(r, -90), ...c]], attached });
  const mark = [50, 62, 62, 77], onLine = ['swSelEDGES', 'swSelSKETCHSEGS'], onSketch = ['swSelSKETCHSEGS', 'swSelSKETCHSEGS'], shapes = { views: [shapeOf('V1', V.origin_mm, [[60, 40, 100, 76], [70, 76, 90, 120]])] };
  const read = dim => readSheet({ sheet: 'H', active_sheet: 'H', sheets: ['H'], sheet_mm: [420, 297], title_block_mm: null, notes: [], views: [V], dimensions: [dim] }, { shapes, keep_out_mm: [mark] });
  assert.equal(findIssues(read(angle(8, onLine))).over_note.length, 0, 'its own line');
  assert.equal(findIssues(read(angle(8, onSketch))).over_note.length, 1, 'the line of another');
  const far = read({ ...angle(33, onLine), pos: [80, 60], start: [77, 60] }), to = planLayout(far, findIssues(far)).moves.find(m => m.id === 'V1#0');
  assert.ok(to && Math.hypot(to.pos[0] - c[0], to.pos[1] - c[1]) < 12, JSON.stringify(to));
  const crossed = findIssues(read(angle(8, onLine, [[at(8, -105)[0] - 5, at(8, -105)[1], at(8, -105)[0] + 5, at(8, -105)[1]]])));
  assert.deepEqual(crossed.text_on_line.map(t => t.ids), [['V1#0']], JSON.stringify(crossed.text_on_line));
});
test('v3.17 needed: a corner a round took away has its twin on the other side of the part: the dimension starts from the one with room beside it, so its extension line does not cross the part', async () => {
  const { planNeeded, dimensionsFromEdges } = await import('./dims_needed.mjs');
  const blend = (y, z, r) => ({ axis: [1, 0, 0], point: [0, y, z], r, sweep: 0.5, inner: false, blend: true, box: [-5, y - r, z - r, 5, y + r, z + r] });
  const part = { planes: [...PLANES(0, [-5, 5]), ...PLANES(1, [-35, -20.5, 0]), ...PLANES(2, [-7, 7])], rounds: [blend(-21.8, 4, 3), blend(-10.7, 12.6, 10)], slanted: [{ normal: [0, 0.5, 0.8660254], box: [-5, -20.3, 3.94, 5, -15.7, 6.596], area: 50 }] };
  const dims = [LIN('x', 0, -5, 5), LIN('y', 1, -35, 0), LIN('z', 2, -7, 7), { name: 'a', value: 30, cls: 'A', dims: [{ view: 'F', mode: 'free', ang: {} }] }, ROUND('r3', 'R', 3), ROUND('r10', 'R', 10), LIN('techo', 1, -35, -20.5), LIN('esquina', 1, -35, -21)];
  const step = planNeeded(part, dims, VIEWS3).missing.find(n => n.what === 'escalón');
  const line = (index, a, b) => ({ ...edgeLine(index, a, b), start_sheet_mm: [-a[2], a[1]], end_sheet_mm: [-b[2], b[1]] });
  const edges = [line(0, [5, -20.3, 6.596], [5, -15.7, 3.94]), line(1, [5, -20.5, -7], [5, -20.5, 7]), line(2, [5, -20.3, -6.596], [5, -15.7, -3.94])];
  const S = { ...VIEWS3.get('S'), outline_mm: [-10, -40, 10, 5] }, leftWall = [-30, -40, -12, 5], rightWall = [12, -40, 30, 5];
  const guideOf = (...around) => dimensionsFromEdges(step, S, edges, around)[0].guides[0];
  assert.deepEqual([guideOf(leftWall, [40, -40, 60, 5]).edge, guideOf([-60, -40, -40, 5], rightWall).edge], [2, 0], 'towards the free side');
  const twin = guideOf(leftWall, [40, -40, 60, 5]);
  assert.equal(twin.at, 'start'); assert.equal(twin.turn_deg, 180); assert.ok(Math.abs(twin.length_mm - 0.808) < 0.01, String(twin.length_mm));
  assert.equal(dimensionsFromEdges(step, S, edges.slice(0, 2), [leftWall])[0].guides[0].edge, 0, 'with no twin it is the only one');
});
test('v3.17 plan: a leader runs under its whole text, also under the blanks that hold no ink, so it stays off what is just past the ink', async () => {
  const { readSheet, findIssues, planLayout } = await import('./dims_layout.mjs');
  const corner = { name: 'V1', scale: 1, outline_mm: [40, 70, 120, 130], origin_mm: [80, 100] }, arc = { center: [80, 100], r: 5, start: [85, 100], end: [80, 105], mid: [83.54, 103.54] }, wrongSide = [[76.46, 96.46, 70, 90], [76.46, 96.46, 80, 100]];
  const to = (text, half, notes = []) => { const dim = { id: 'V1#0', view: 'V1', name: 'R1', type: 5, hole_callout: false, value: 5, unit: 'mm', text, pos: [70, 90], start: [70 - half * Math.SQRT1_2, 90 - half * Math.SQRT1_2], height: 3.5, angle: Math.PI / 4, lines: wrongSide, arcs: 0 }, m = readSheet(sheetOf([dim], { views: [corner], notes }), { shapes: { views: [shapeOf('V1', corner.origin_mm, [[60, 80, 85, 100], [60, 100, 80, 105]], [arc])] } }); return planLayout(m, findIssues(m)).moves.find(x => x.id === 'V1#0').pos; };
  // the same ink, 6 mm wide: one fills its text, the other is padded and its leader goes 2.4 mm further
  const free = to('R5.00', 3), t = Math.atan2(free[1] - 100, free[0] - 80), past = 4.6, x = free[0] + past * Math.cos(t), y = free[1] + past * Math.sin(t), note = [{ text: 'NOTA', box: [x - 0.5, y - 0.5, x + 0.5, y + 0.5] }];
  assert.deepEqual(to('R5.00', 3, note), free, 'its line ends before the note');
  assert.notDeepEqual(to('  R5.00  ', 5.4, note), free, 'this line would reach the note');
});

import { answerInTime } from './answer_in_time.mjs';
import { backgroundJobs, waitBackground, trackJob } from './assembly_build.mjs';
const later = (ms, text = '{"ok":true,"result":"hecho"}') => new Promise(r => setTimeout(() => r({ content: [{ type: 'text', text }] }), ms));
test('v3.18 a call answers before the client limit: running, tracked, and its result arrives late', async () => {
  let late = [];
  const quick = await answerInTime(later(5), { tool: 'sw_rapida', late: () => late, withinMs: 500 });
  assert.equal(JSON.parse(quick.content[0].text).result, 'hecho'); assert.equal(late.length, 0, 'what answers in time is not repeated');
  const first = await answerInTime(later(80), { tool: 'sw_larga', late: () => late, withinMs: 10 }), said = JSON.parse(first.content[0].text);
  assert.equal(said.running, true); assert.equal(said.ok, true); assert.equal(late.length, 0);
  assert.ok(backgroundJobs().some(j => j.label.startsWith('sw_larga:')), 'other calls see it and wait for it');
  late = [];   // as takeLate does on every response: the result must land in the list of that moment
  await waitBackground();
  assert.equal(late.length, 1); assert.equal(late[0].operation, 'sw_larga'); assert.equal(late[0].response.result, 'hecho');
  assert.ok(!backgroundJobs().some(j => j.label.startsWith('sw_larga:')), 'its result went to late: it is not kept');
});
test('v3.18 a call waiting behind a long one says so, and a call the client cancelled does not answer running', async () => {
  const late = [], first = later(80);
  trackJob('organize:prueba', first, { forget: true });
  const behind = await answerInTime(later(90), { tool: 'sw_status', late: () => late, withinMs: 10 });
  assert.deepEqual(JSON.parse(behind.content[0].text).waiting_for, ['organize:prueba']);
  await waitBackground();
  const stop = new AbortController(); stop.abort();
  const cancelled = await answerInTime(later(40), { tool: 'sw_cancelada', late: () => [], withinMs: 5, signal: stop.signal });
  assert.equal(JSON.parse(cancelled.content[0].text).result, 'hecho');
});
