// v3.9 prueba: vista de corte (sw_drawing_views action section) por el centro de un barreno, en una pieza y en un ensamble.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyBuild } from '../server/assembly_build.mjs';
import { assemblyDrawing } from '../server/assembly_drawing.mjs';
import { examReady } from '../server/exam_ready.mjs';
import { drawingRead } from '../server/drawing_read.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const placa = { ir: 'part-ir/1', part: 'PlacaCorte_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 60, h: 40 } }] }, depth: 10, direction: '+Z' },
  { id: 'barreno', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [15, 0], d: 10 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1 } };
const perno = { ir: 'part-ir/1', part: 'PernoCorte_' + ts, units: 'mm', material: MAT, features: [
  { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 10 } }] }, depth: 10, direction: '+Z' }],
  expect: { bodies: 1 } };
const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
const cyl = (component, d) => ({ component, find: { kind: 'cylinder', diameter_mm: d } });
async function corte(label, drawingRes, through, direction) {
  const id = drawingRes.drawing_document_id; docs.push(id);
  const list = await w.call('drawing_views', { document_id: id, action: 'list' });
  
  const sheet = list.result.active_sheet, front = drawingRes.views.front;
  
  const t = performance.now();
  const s = await w.call('drawing_views', { document_id: id, action: 'section', sheet, view: front, through_mm: through, direction });
  console.log(label, 'CORTE', ((performance.now() - t) / 1000).toFixed(1), 's', JSON.stringify(s).slice(0, 700));
  await w.call('save', { document_id: id });
  const pdf = await w.call('export', { document_id: id, name: `${label}_${ts}.pdf` });
  const png = await drawingRead({ path: pdf.result.path, action: 'render', width_px: 1600 });
  console.log(label, 'PNG', png.path);
}
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const p = await partBuild({ action: 'build', ir: placa }, { worker: w, root }); if (p.document_id) docs.push(p.document_id);
  console.log('pieza', p.ok, p.path);
  await w.call('save', { document_id: p.document_id });
  const dp = await assemblyDrawing({ document_id: p.document_id, name: 'CortePieza_' + ts, close: false, pdf: false }, { worker: w, root });
  console.log('plano pieza', dp.ok, dp.error ?? '', dp.drawing);
  if (dp.ok) await corte('pieza', dp, [15, 0, 5], 'horizontal');
  const a = await assemblyBuild({ action: 'build', plan: { ir: 'assembly-ir/1', name: 'CorteEns_' + ts, parts: [placa, perno],
    components: [{ id: 'A', file: placa.part + '.SLDPRT', fixed: true }, { id: 'P', file: perno.part + '.SLDPRT' }],
    mates: [{ name: 'perno', type: 'concentric', align: 'aligned', entities: [cyl('P', 10), cyl('A', 10)] },
      { name: 'al ras', type: 'coincident', align: 'aligned', entities: [pl('P', [0, 0, -1], 0), pl('A', [0, 0, -1], 0)] }],
    expect: { interferences_mm3: [] } }, parts_dir: root, reuse_parts: true }, { worker: w, root });
  if (a.document_id) docs.push(a.document_id);
  console.log('ensamble', a.verdict, a.path, JSON.stringify(a.failures ?? []).slice(0, 300));
  const da = await assemblyDrawing({ document_id: a.document_id, name: 'CorteEns_' + ts, close: false, pdf: false, answers: false }, { worker: w, root });
  console.log('plano ensamble', da.ok, da.error ?? '', JSON.stringify(da.warnings ?? []).slice(0, 300));
  if (da.ok) await corte('ensamble', da, [15, 0, 5], 'vertical');
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally { for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
