// v3.11 prueba en SolidWorks real: insert_components + fit_box, enganche de rosca, mover fijo, relación con expect,
// caras por descripción, reemplazar componente, guardar referencias + Pack and Go, envolver, límite, cotas automáticas,
// respuesta compacta y mostrar la ventana. Usa el SolidWorks que ya esté en uso (no lo detiene al final).
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyDrawing } from '../server/assembly_drawing.mjs';
import { compactWorkerResponse } from '../server/compact.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [], results = {};
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const MAT = { name: 'AISI 1020' };
const block = (part, h, hole) => ({ ir: 'part-ir/1', part, units: 'mm', material: MAT, features: [
  { id: 'b', op: 'extrude', sketch: { plane: 'top', entities: [{ rect: { center: [0, 0], w: 40, h: 40 } }] }, depth: h, direction: '+Y' },
  ...(hole ? [{ id: 'h', op: 'cut', sketch: { plane: 'top', entities: [{ circle: { center: [0, 0], d: 4.2 } }] }, end: 'through_all_both' }] : [])], expect: { bodies: 1 } });
const step = async (label, op, args, check) => {
  const t = performance.now(); const r = await w.call(op, args); const s = ((performance.now() - t) / 1000).toFixed(1) + 's';
  let verdict = r.ok ? 'OK' : 'ERROR'; try { if (r.ok && check) { const c = check(r.result); verdict = c === true ? 'PASA' : 'FALLA ' + c; } } catch (e) { verdict = 'FALLA ' + e.message; }
  results[label] = verdict; console.log(`${label.padEnd(26)} ${s.padStart(6)} ${verdict}  ${JSON.stringify(r.ok ? r.result : r.error).slice(0, 700)}`); return r;
};
const sk = r => r.result?.sketch ?? r.result?.name ?? r.result?.feature;
import { examReady } from '../server/exam_ready.mjs';
try {
  await examReady({ start: true, wait: true }, { worker: w, root });
  await step('1 mostrar ventana', 'instance', { action: 'show' }, r => r.window_found && r.foreground === true || 'ventana ' + r.window_found + ' frente ' + r.foreground);
  const base = await partBuild({ action: 'build', ir: block('BaseV311_' + ts, 10, true) }, { worker: w, root }); docs.push(base.document_id);
  const tapa = await partBuild({ action: 'build', ir: block('TapaV311_' + ts, 10, false) }, { worker: w, root }); docs.push(tapa.document_id);
  const tapa2 = await partBuild({ action: 'build', ir: block('Tapa2V311_' + ts, 12, false) }, { worker: w, root }); docs.push(tapa2.document_id);
  for (const p of [base, tapa, tapa2]) { const sv = await w.call('save', { document_id: p.document_id }); if (!sv.ok) throw new Error('save: ' + sv.error); p.path = sv.result.path; if (p === base) continue; if (p.document_id) await w.call('close_document', { document_id: p.document_id, discard_changes: true }); }
  docs.length = 0; docs.push(base.document_id);
  const bolt = join(root, 'ISO4017_M5x16_AISI_304.SLDPRT');
  const env = await w.call('environment', {});
  const asm = await w.call('assembly_new', { path: join(root, 'assemblies', `PruebaV311_${ts}.SLDASM`), template: env.result.default_assembly_template });
  const A = asm.result.document_id; docs.push(A);
  await step('2 insert_components+fit_box', 'insert_components', { document_id: A, items: [
    { path: base.path, fixed: true, fit_box: { axis: 'y', from_mm: 5, to_mm: 15 } },
    { path: bolt, fixed: true, transform: [1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0.015, 0, 1, 0, 0, 0] },
    { path: tapa.path, position_mm: [0, 40, 0] }] },
    r => r.count === 3 && r.inserted[0].fit_box?.origin_mm === 5 || 'fit_box ' + JSON.stringify(r.inserted[0].fit_box));
  const names = (await w.call('inspect', { document_id: A })).result.components.map(c => c.name);
  const nBase = names.find(n => n.startsWith('BaseV311')), nTapa = names.find(n => n.startsWith('TapaV311'));
  await step('3 mover fijo (allow_fixed)', 'move_component', { document_id: A, component: nBase, position_mm: [0, 6, 0], allow_fixed: true }, r => r.refixed && r.origin_mm[1] === 6 || JSON.stringify(r));
  { const r3 = await step('3b sin allow_fixed falla', 'move_component', { document_id: A, component: nBase, position_mm: [0, 5, 0] }, () => 'debió fallar'); if (!r3.ok && /allow_fixed/.test(JSON.stringify(r3.error))) results['3b sin allow_fixed falla'] = 'PASA (lo rechazó como debía)'; }
  await w.call('move_component', { document_id: A, component: nBase, position_mm: [0, 5, 0], allow_fixed: true });
  await step('4 caras por descripción', 'find_faces', { document_id: A, component: nTapa, extreme: '+y' }, r => r.count >= 1 && Math.abs(r.candidates[0].offset_mm - 10) < 1e-6 || JSON.stringify(r.candidates?.[0]));
  await step('4b pick largest', 'find_faces', { document_id: A, component: nBase, kind: 'plane', pick: 'largest' }, r => r.candidates[0].area_mm2 >= r.candidates.at(-1).area_mm2 || 'orden');
  await step('5 relación con expect', 'add_mate', { document_id: A, type: 'distance', distance_mm: 5, align: 'anti_aligned', flip: true,
    entities: [{ component: nBase, local_point_mm: [10, 10, 10], kind: 'face' }, { component: nTapa, local_point_mm: [10, 0, 10], kind: 'face' }],
    expect: { component: nTapa, origin_mm: [0, 20, 0], tolerance_mm: 0.05 } },
    r => { const o = (r.mate_result ?? r).moved_components?.find(m => m.component === nTapa)?.origin_mm; return o && Math.abs(o[1] - 20) < 0.05 || 'origen ' + JSON.stringify(o) + ' flipped ' + r.flipped_for_expect; });
  const big = await w.call('inspect', { document_id: A });
  results['6 respuesta compacta (lógica)'] = compactWorkerResponse(big, root, 'inspect') === big ? 'PASA (pequeño, sin cambio)' : 'compactado';
  await step('7 guardar con referencias', 'save', { document_id: A, include_references: true }, () => true);
  await step('8 reemplazar componente', 'replace_component', { document_id: A, component: nTapa, new_path: tapa2.path }, r => r.replaced?.length === 1 && r.mates_with_new_errors.length === 0 && r.remated?.every(m => m.ok) || JSON.stringify({ e: r.mates_with_new_errors, m: r.remated }).slice(0, 400));
  await step('8b guardar', 'save', { document_id: A, include_references: true }, () => true);
  await w.call('close_document', { document_id: A }); docs.length = 0; docs.push(base.document_id);
  const re = await w.call('resume_document', { name: `PruebaV311_${ts}.SLDASM` }); const A2 = re.result.document_id; docs.push(A2);
  await step('9 Pack and Go', 'pack_and_go', { document_id: A2, folder_name: 'PackV311_' + ts }, r => r.ok === true || JSON.stringify(r).slice(0, 300));
  await step('10 rosca en interferencia', 'interference', { document_id: A2 }, r => r.pairs.some(p => p.kind === 'thread_engagement') && r.pairs.filter(p => p.kind === 'overlap').length === 0 || JSON.stringify(r.pairs.map(p => [p.components, p.kind, p.volume_mm3])));
  await w.call('close_document', { document_id: A2, discard_changes: true }); docs.length = 0; docs.push(base.document_id);
  // envolver y límite en una pieza cilíndrica
  const cil = await partBuild({ action: 'build', ir: { ir: 'part-ir/1', part: 'CilV311_' + ts, units: 'mm', material: MAT, features: [
    { id: 'c', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 40 } }] }, depth: 40, direction: '+Z' }], expect: { bodies: 1 } } }, { worker: w, root });
  const C = cil.document_id; docs.push(C);
  const pl = await w.call('ref_plane', { document_id: C, plane_index: 1, offset_mm: 20 });
  const pIdx = pl.result.plane_index;
  const ws = await w.call('create_sketch', { document_id: C, plane_index: pIdx, entities: [
    { kind: 'line', start_mm: [-5, -25], end_mm: [5, -25] }, { kind: 'line', start_mm: [5, -25], end_mm: [5, -15] }, { kind: 'line', start_mm: [5, -15], end_mm: [-5, -15] }, { kind: 'line', start_mm: [-5, -15], end_mm: [-5, -25] }] });
  await step('11 envolver (relieve)', 'wrap', { document_id: C, sketch: sk(ws), face_point_mm: [0, 20, 20], type: 'emboss', depth_mm: 1 }, r => r.volume_change_mm3 > 50 || 'volumen ' + r.volume_change_mm3);
  const s1 = await w.call('create_sketch', { document_id: C, plane_index: 0, entities: [{ kind: 'circle', center_mm: [100, 0], radius_mm: 10 }] });
  const pl2 = await w.call('ref_plane', { document_id: C, plane_index: 0, offset_mm: 30 });
  const s2 = await w.call('create_sketch', { document_id: C, plane_index: pl2.result.plane_index, entities: [
    { kind: 'line', start_mm: [90, -10], end_mm: [110, -10] }, { kind: 'line', start_mm: [110, -10], end_mm: [110, 10] }, { kind: 'line', start_mm: [110, 10], end_mm: [90, 10] }, { kind: 'line', start_mm: [90, 10], end_mm: [90, -10] }] });
  await step('12 límite (boundary)', 'boundary', { document_id: C, profiles: [sk(s1), sk(s2)] }, r => r.volume_change_mm3 > 5000 || 'volumen ' + r.volume_change_mm3);
  await step('12b loft mismos perfiles', 'loft', { document_id: C, profiles: [sk(s1), sk(s2)] }, r => true);
  await w.call('save', { document_id: C });
  // cotas automáticas en el plano de la base
  const bd = base.document_id ? { result: { document_id: base.document_id } } : await w.call('resume_document', { name: base.path.split(/[\\/]/).pop() }); if (!bd.result) throw new Error('base: ' + base.path + ' ' + JSON.stringify(bd.error)); docs.push(bd.result.document_id); 
  const dp = await assemblyDrawing({ document_id: bd.result.document_id, name: 'PlanoV311_' + ts, close: false, pdf: false, answers: false, dimensions: false }, { worker: w, root });
  if (dp.ok) { docs.push(dp.drawing_document_id); const list = await w.call('drawing_views', { document_id: dp.drawing_document_id, action: 'list' });
    await step('13 cotas automáticas', 'drawing_dimension', { document_id: dp.drawing_document_id, action: 'auto', sheet: list.result.active_sheet, view: dp.views.top ?? dp.views.front },
      r => r.dimensions.length >= 2 && r.dimensions.some(x => /Ø4\.2/.test(x.what)) || JSON.stringify(r).slice(0, 400)); }
  else results['13 cotas automáticas'] = 'plano falló: ' + (dp.error ?? JSON.stringify(dp.errors));
} catch (e) { console.log('ERR', e.message.slice(0, 1500)); process.exitCode = 1; }
finally {
  for (const id of docs.reverse()) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { }
  console.log('\nRESUMEN'); for (const [k, v] of Object.entries(results)) console.log(k.padEnd(28), v);
  w.close();
}
