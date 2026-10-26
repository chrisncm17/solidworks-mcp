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
      document_units: () => ({ set: true }), save: () => ({ saved: true }),
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
  assert.deepEqual(calls.map(c => c.op), ['environment','assembly_new','insert_component','insert_component','add_mate','add_mate','mates','coordinate_system','coordinate_system','document_units','save','mates','assembly_doctor','mass_check','mass_check','session_health','interference']);
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
