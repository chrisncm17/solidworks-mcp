// v3.8 prueba: un local_point_mm que falla por décimas (como el centro real de un barreno de Asistente) se ajusta solo
// a la única cara cercana y queda como aviso; uno que falla por milímetros da error con las caras más cercanas y su punto exacto.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { assemblyBuild } from '../server/assembly_build.mjs';
import { examReady } from '../server/exam_ready.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const placa = { ir: 'part-ir/1', part: 'PlacaAj_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 40, h: 40 } }] }, depth: 10, direction: '+Z' },
  { id: 'barreno', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 10 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1 } };
const perno = { ir: 'part-ir/1', part: 'PernoAj_' + ts, units: 'mm', material: MAT, features: [
  { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 10 } }] }, depth: 30, direction: '+Z' }],
  expect: { bodies: 1 } };
const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
const plan = (pinPoint, name) => ({ ir: 'assembly-ir/1', name: name + '_' + ts, parts: [placa, perno],
  components: [{ id: 'A', file: placa.part + '.SLDPRT', fixed: true }, { id: 'P', file: perno.part + '.SLDPRT' }],
  mates: [
    { name: 'perno en barreno', type: 'concentric', align: 'aligned', entities: [{ component: 'P', local_point_mm: pinPoint, kind: 'face' }, { component: 'A', local_point_mm: [-5.3, 0, 5], kind: 'face' }] },
    { name: 'perno al ras', type: 'coincident', align: 'aligned', entities: [pl('P', [0, 0, -1], 0), pl('A', [0, 0, -1], 0)] }],
  expect: { interferences_mm3: [] } });
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const a = await assemblyBuild({ action: 'build', plan: plan([5.2, 0, 15], 'AjusteFino'), parts_dir: root, answers: { mass_units: 'g', length_units: 'mm', decimals: 4 } }, { worker: w, root });
  if (a.document_id) docs.push(a.document_id);
  console.log('AJUSTE FINO', a.verdict, '| avisos de ajuste', JSON.stringify((a.warnings ?? []).filter(x => /ajust/.test(x))), '| fallas', JSON.stringify(a.failures ?? []).slice(0, 300), '| respuestas', JSON.stringify(a.answers?.lines ?? null));
  const b = await assemblyBuild({ action: 'build', plan: plan([7, 0, 15], 'AjusteLejos'), parts_dir: root, reuse_parts: true }, { worker: w, root });
  if (b.document_id) docs.push(b.document_id);
  console.log('LEJOS', b.verdict, '| fallas', JSON.stringify(b.failures ?? b.error ?? null).slice(0, 900));
} catch (e) { console.log('ERR', e.message.slice(0, 1200)); process.exitCode = 1; }
finally { for (const id of docs) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
