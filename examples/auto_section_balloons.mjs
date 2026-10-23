// v3.9 prueba: sw_assembly_drawing agrega solo un corte cuando una pieza interna no se ve en ninguna vista y le pone su globo ahÃ­.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { assemblyBuild } from '../server/assembly_build.mjs';
import { assemblyDrawing } from '../server/assembly_drawing.mjs';
import { examReady } from '../server/exam_ready.mjs';
import { drawingRead } from '../server/drawing_read.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const box = (name, h, hole) => ({ ir: 'part-ir/1', part: name + '_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 60, h: 40 } }] }, depth: h, direction: '+Z' },
  ...(hole ? [{ id: 'barreno', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 10 } }] }, depth: 8, direction: '+Z' }] : [])],
  expect: { bodies: 1 } });
const base = box('BaseOculta', 10, true), tapa = box('TapaOculta', 5, false);
const perno = { ir: 'part-ir/1', part: 'PernoOculto_' + ts, units: 'mm', material: MAT, features: [
  { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 10 } }] }, depth: 8, direction: '+Z' }],
  expect: { bodies: 1 } };
const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
const cyl = (component, d) => ({ component, find: { kind: 'cylinder', diameter_mm: d } });
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const a = await assemblyBuild({ action: 'build', plan: { ir: 'assembly-ir/1', name: 'Oculto_' + ts, parts: [base, tapa, perno],
    components: [{ id: 'B', file: base.part + '.SLDPRT', fixed: true }, { id: 'T', file: tapa.part + '.SLDPRT' }, { id: 'P', file: perno.part + '.SLDPRT' }],
    mates: [
      { name: 'tapa encima', type: 'coincident', align: 'anti_aligned', entities: [pl('T', [0, 0, -1], 0), pl('B', [0, 0, 1], 10)] },
      { name: 'tapa x', type: 'coincident', align: 'aligned', entities: [pl('T', [1, 0, 0], 30), pl('B', [1, 0, 0], 30)] },
      { name: 'tapa y', type: 'coincident', align: 'aligned', entities: [pl('T', [0, 1, 0], 20), pl('B', [0, 1, 0], 20)] },
      { name: 'perno', type: 'concentric', align: 'aligned', entities: [cyl('P', 10), cyl('B', 10)] },
      { name: 'perno fondo', type: 'coincident', align: 'anti_aligned', entities: [pl('P', [0, 0, 1], 8), pl('B', [0, 0, -1], -8)] }],
    expect: { interferences_mm3: [] } }, parts_dir: root }, { worker: w, root });
  if (a.document_id) docs.push(a.document_id);
  console.log('ensamble', a.verdict, JSON.stringify(a.failures ?? []).slice(0, 400), JSON.stringify(a.differences ?? []).slice(0, 300));
  if (a.verdict !== 'pass') throw new Error('ensamble no pasó');
  const t = performance.now();
  const d = await assemblyDrawing({ document_id: a.document_id, name: 'Oculto_' + ts }, { worker: w, root });
  console.log('plano', d.ok, d.error ?? '', ((performance.now() - t) / 1000).toFixed(1), 's | corte', JSON.stringify(d.section), '| globos', JSON.stringify(d.balloons).slice(0, 500), '| avisos', JSON.stringify(d.warnings));
  if (d.pdf) console.log('PNG', (await drawingRead({ path: d.pdf, action: 'render', width_px: 1600 })).path);
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally { for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
