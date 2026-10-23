// v3.9 prueba: exportar en lote (STEP, IGES, x_t, PDF, DXF) y volver a importar STEP/IGES/x_t de una pieza y STEP de un ensamble;
// la pieza importada debe tener el mismo volumen y, con el mismo material, la misma masa y centro de masa.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyBuild } from '../server/assembly_build.mjs';
import { examReady } from '../server/exam_ready.mjs';
import { exportBatch } from '../server/export_batch.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [];
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const placa = { ir: 'part-ir/1', part: 'PlacaImp_' + ts, units: 'mm', material: MAT, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 80, h: 50 } }] }, depth: 12, direction: '+Z' },
  { id: 'barreno', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [20, 5], d: 14 } }] }, end: 'through_all_both' },
  { id: 'redondeo', op: 'fillet', edges: [{ near: [40, 25, 6] }], radius: 6 }], expect: { bodies: 1 } };
const perno = { ir: 'part-ir/1', part: 'PernoImp_' + ts, units: 'mm', material: MAT, features: [
  { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 14 } }] }, depth: 30, direction: '+Z' }], expect: { bodies: 1 } };
const c = async (op, a) => { const r = await w.call(op, a); if (!r.ok) throw new Error(op + ': ' + r.error); return r.result; };
const mass = async id => { const m = await c('mass_check', { document_id: id, mass_units: 'g', length_units: 'mm' }); return [m.mass ?? m.mass_g, m.center_of_mass ?? m.center_of_mass_mm]; };
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  const p = await partBuild({ action: 'build', ir: placa }, { worker: w, root }); if (p.document_id) docs.push(p.document_id);
  await c('save', { document_id: p.document_id });
  const ref = await mass(p.document_id); console.log('ORIGINAL', JSON.stringify(ref));
  const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
  const a = await assemblyBuild({ action: 'build', plan: { ir: 'assembly-ir/1', name: 'EnsImp_' + ts, parts: [placa, perno],
    components: [{ id: 'A', file: placa.part + '.SLDPRT', fixed: true }, { id: 'P', file: perno.part + '.SLDPRT' }],
    mates: [{ name: 'perno', type: 'concentric', align: 'aligned', entities: [{ component: 'P', find: { kind: 'cylinder', diameter_mm: 14 } }, { component: 'A', find: { kind: 'cylinder', diameter_mm: 14 } }] },
      { name: 'al ras', type: 'coincident', align: 'aligned', entities: [pl('P', [0, 0, -1], 0), pl('A', [0, 0, -1], 0)] }],
    expect: { interferences_mm3: [] } }, parts_dir: root, reuse_parts: true }, { worker: w, root });
  if (a.document_id) docs.push(a.document_id);
  console.log('ENSAMBLE', a.verdict, JSON.stringify(a.answers?.lines ?? null));
  const t = performance.now();
  const b = await exportBatch({ document_ids: [p.document_id, a.document_id], formats: ['step', 'igs', 'x_t', 'pdf'], suffix: ts }, { worker: w });
  console.log('LOTE', ((performance.now() - t) / 1000).toFixed(1), 's ok', b.ok, JSON.stringify(b.files.map(f => f.title + '.' + f.format + ' ' + f.bytes)), 'omitidos', b.skipped.length, 'fallas', JSON.stringify(b.failed));
  for (const f of b.files.filter(f => f.document_id === p.document_id)) {
    const t1 = performance.now();
    const r = await w.call('import_model', { source: f.path, name: `Imp_${f.format}_${ts}.SLDPRT` });
    if (!r.ok) { console.log('IMPORT', f.format, 'ERROR', r.error); continue; }
    docs.push(r.result.document_id);
    await c('set_material', { document_id: r.result.document_id, material: 'AISI 1020' }).catch(e => console.log('material', e.message));
    const m = await mass(r.result.document_id);
    console.log('IMPORT', f.format, ((performance.now() - t1) / 1000).toFixed(1), 's | sólidos', r.result.solid_bodies, 'superficies', r.result.surface_bodies, '| masa/CM', JSON.stringify(m), '| igual', Math.abs(m[0] - ref[0]) / ref[0] < 1e-4, JSON.stringify(r.result.warnings));
  }
  const step = b.files.find(f => f.document_id === a.document_id && f.format === 'step');
  if (step) {
    const r = await w.call('import_model', { source: step.path, name: `ImpEns_${ts}.SLDASM` });
    if (!r.ok) console.log('IMPORT ENSAMBLE ERROR', r.error); else { docs.push(r.result.document_id); const v0 = await c('mass_check', { document_id: a.document_id }), v1 = await c('mass_check', { document_id: r.result.document_id }); console.log('IMPORT ENSAMBLE', r.result.kind, JSON.stringify(r.result.components), '| volumen original', v0.volume_mm3 ?? v0.volume, 'importado', v1.volume_mm3 ?? v1.volume, '| CM', JSON.stringify(v0.center_of_mass), JSON.stringify(v1.center_of_mass));
      await c('close_document', { document_id: r.result.document_id, discard_changes: true }); docs.pop();
      const re = await c('resume_document', { name: `ImpEns_${ts}.SLDASM` }); docs.push(re.document_id); const v2 = await c('mass_check', { document_id: re.document_id }); console.log('REABIERTO', v2.volume_mm3 ?? v2.volume, JSON.stringify(v2.center_of_mass), JSON.stringify(v2.warnings ?? [])); }
    const wrong = await w.call('import_model', { source: step.path, name: `ImpMal_${ts}.SLDPRT` }); console.log('NOMBRE EQUIVOCADO', wrong.ok, wrong.error);
  }
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally { for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
