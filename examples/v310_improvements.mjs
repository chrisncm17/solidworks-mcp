// v3.10 prueba: vista previa con caras numeradas, combinar cuerpos, vista de detalle y cotas manuales en un plano.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyDrawing } from '../server/assembly_drawing.mjs';
import { examReady } from '../server/exam_ready.mjs';
import { drawingRead } from '../server/drawing_read.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const placa = { ir: 'part-ir/1', part: 'PlacaV310_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 60, h: 40 } }] }, depth: 10, direction: '+Z' },
  { id: 'barreno', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [15, 0], d: 10 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1 } };
const step = async (label, op, args) => { const t = performance.now(); const r = await w.call(op, args);
  console.log(label, ((performance.now() - t) / 1000).toFixed(1) + 's', r.ok ? 'OK' : 'ERROR', JSON.stringify(r.ok ? r.result : r.error).slice(0, 900)); return r; };
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const p = await partBuild({ action: 'build', ir: placa }, { worker: w, root }); if (p.document_id) docs.push(p.document_id);
  console.log('pieza', p.ok, p.path);
  const id = p.document_id;
  // 1) vista previa con caras numeradas
  await step('PREVIEW', 'preview', { document_id: id, views: ['iso', 'front', 'top'], label_faces: true });
  // 2) combinar: un segundo cuerpo (cilindro Ø20 que atraviesa la placa) y luego restar / sumar
  const cs = await step('CROQUIS cilindro', 'create_sketch', { document_id: id, plane_index: 0, entities: [{ kind: 'circle', center_mm: [-15, 0], radius_mm: 10 }] });
  const sk = cs.result?.sketch ?? cs.result?.name ?? cs.result?.feature;
  await step('EXTRUIR sin fusionar', 'extrude', { document_id: id, sketch: sk, depth_mm: 30, direction: '+Z', merge: false });
  await step('COMBINAR restar', 'combine', { document_id: id, operation: 'subtract', main_point_mm: [0, 20, 5] });
  await w.call('save', { document_id: id });
  // 3) plano, vista de detalle del barreno y cotas manuales
  const dp = await assemblyDrawing({ document_id: id, name: 'PlanoV310_' + ts, close: false, pdf: false, answers: false }, { worker: w, root });
  console.log('plano', dp.ok, dp.error ?? '');
  if (dp.ok) {
    const dId = dp.drawing_document_id; docs.push(dId);
    const list = await w.call('drawing_views', { document_id: dId, action: 'list' });
    const sheet = list.result.active_sheet, front = dp.views.front;
    await step('DETALLE', 'drawing_views', { document_id: dId, action: 'detail', sheet, view: front, through_mm: [15, 0, 10], radius_mm: 9 });
    const pr = await step('PROBE', 'drawing_dimension', { document_id: dId, action: 'probe', sheet, view: front });
    const edges = pr.result?.edges ?? [];
    const circle = edges.find(e => e.kind === 'circle'), lines = edges.filter(e => e.kind === 'line');
    if (circle) await step('COTA diametro', 'drawing_dimension', { document_id: dId, action: 'add', sheet, view: front, edges: [circle.index], type: 'diameter' });
    const longest = [...lines].sort((a, b) => b.length_mm - a.length_mm)[0];
    if (longest) await step('COTA linea', 'drawing_dimension', { document_id: dId, action: 'add', sheet, view: front, edges: [longest.index] });
    await w.call('save', { document_id: dId });
    const pdf = await w.call('export', { document_id: dId, name: `PlanoV310_${ts}.pdf` });
    const png = await drawingRead({ path: pdf.result.path, action: 'render', width_px: 1600 });
    console.log('PNG plano', png.path);
  }
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally { for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
