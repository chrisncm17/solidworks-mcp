// v3.9: genera planos de prueba en DXF y PDF (el mismo plano) para comparar la lectura de cotas DXF contra la de PDF.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyDrawing } from '../server/assembly_drawing.mjs';
import { examReady } from '../server/exam_ready.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const soporte = { ir: 'part-ir/1', part: 'SoporteDxf_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 300, h: 180 } }] }, depth: 20, direction: '+Z' },
  { id: 'barrenos', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [-110, 60], d: 22 } }, { circle: { center: [110, 60], d: 22 } }, { circle: { center: [-110, -60], d: 22 } }, { circle: { center: [110, -60], d: 22 } }] }, end: 'through_all_both' },
  { id: 'centro', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 70 } }] }, end: 'through_all_both' },
  { id: 'esquinas', op: 'fillet', edges: [{ near: [150, 90, 10] }, { near: [-150, 90, 10] }, { near: [150, -90, 10] }, { near: [-150, -90, 10] }], radius: 15 }],
  expect: { bodies: 1 } };
const c = async (op, a) => { const r = await w.call(op, a); if (!r.ok) throw new Error(op + ': ' + r.error); return r.result; };
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const p = await partBuild({ action: 'build', ir: soporte }, { worker: w, root }); if (p.document_id) docs.push(p.document_id);
  if (!p.ok) throw new Error('pieza: ' + JSON.stringify(p.failed ?? p.error).slice(0, 500));
  await c('save', { document_id: p.document_id });
  const d = await assemblyDrawing({ document_id: p.document_id, name: 'SoporteDxf_' + ts, close: false }, { worker: w, root });
  if (!d.ok) throw new Error('plano: ' + d.error);
  docs.push(d.drawing_document_id);
  const id = d.drawing_document_id, list = await c('drawing_views', { document_id: id, action: 'list' });
  await c('drawing_views', { document_id: id, action: 'section', sheet: list.active_sheet, view: d.views.front, direction: 'horizontal', through_mm: [110, 60, 10] });
  await c('save', { document_id: id });
  const pdf = await c('export', { document_id: id, name: `SoporteDxf_${ts}.pdf` });
  const dxf = await c('export', { document_id: id, name: `SoporteDxf_${ts}.dxf` });
  console.log('ESCALA', d.scale, '| COTAS', JSON.stringify(d.dimensions?.inserted), '\nPDF', pdf.path, '\nDXF', dxf.path);
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally { for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
