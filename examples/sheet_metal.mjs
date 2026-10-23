// v3.9 prueba CAD: chapa con pliegue croquizado y dobladillo, vista desplegada en el plano, y guardar un cuerpo como pieza.
import { session, poly, L } from './session.mjs';
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { examReady } from '../server/exam_ready.mjs';
import { partBuild } from '../server/part_ir.mjs';
import { drawingRead } from '../server/drawing_read.mjs';
const ts = Date.now().toString(36), root = fileURLToPath(new URL('../server/generated', import.meta.url));
const check = (ok, msg) => { if (!ok) throw new Error('FALLA: ' + msg); console.log('  ✓ ' + msg); };
const w0 = new WorkerClient({ timeoutMs: 600000 });
await examReady({ start: true, wait: true }, { worker: w0, root });
const s = await session(`ChapaV39_${ts}.SLDPRT`); const { call, id } = s;
let did, other = [];
try {
  const sk = await s.sketch(1, poly([[0, 0], [100, 0], [100, 60], [0, 60]]));
  const bf = await call('sheet_metal', { document_id: id, action: 'base_flange', sketch: sk, thickness_mm: 2, bend_radius_mm: 2, k_factor: 0.5 });
  const b = bf.inspection.bodies[0].box_exact_mm, [x0, y0, z0, x1, y1, z1] = b;
  console.log('base', bf.inspection.volume_mm3.toFixed(2), 'caja', JSON.stringify(b));
  // bend line across the top face at x = 60 (sketch on that face)
  // the sheet lies on the Planta plane (XZ), 2 mm thick toward -Y: top face y = 0, sketch y maps to -z
  const bl = await call('create_sketch', { document_id: id, face_point_mm: [20, y1, -30], entities: [L([60, -5], [60, 65])] });
  let r = null, err = null;
  try { r = await call('sheet_metal', { document_id: id, action: 'sketched_bend', sketch: bl.sketch, fixed_point_mm: [20, y1, -30], angle_deg: 90 }); } catch (e) { err = e.message; }
  if (err) console.log('pliegue croquizado ERROR', err.slice(0, 400));
  else { console.log('pliegue', r.feature, 'volumen', r.report.inspection.volume_mm3.toFixed(2), 'caja', JSON.stringify(r.report.inspection.bodies[0].box_exact_mm));
    check(Math.abs(r.report.inspection.volume_mm3 - 12000) / 12000 < 0.02, 'el pliegue conserva el volumen (±2 % por el factor K)');
    const nb = r.report.inspection.bodies[0].box_exact_mm; check(Math.abs(nb[4] - nb[1]) > 20, 'la caja ganó altura en Y: la chapa se dobló'); }
  // hem on the short edge at x = 0 (top face)
  const n0 = (await s.inspect()).features.length;
  if (process.env.DIAG) { const z = await s.w.call('sheet_metal', { document_id: id, action: 'hem', edge_point_mm: [x1, y1, -30], length_mm: 8 }); console.log('DIAG', JSON.stringify(z.safe_edit)); throw new Error('fin diag'); }
  let h = null; try { h = await call('sheet_metal', { document_id: id, action: 'hem', edge_point_mm: [x0, y1, -30], hem_type: 'closed', length_mm: 8 }); } catch (e) { console.log('dobladillo ERROR', e.message.slice(0, 400)); }
  if (h) { console.log('dobladillo', h.feature, 'volumen', h.report.inspection.volume_mm3.toFixed(2)); check(h.report.inspection.volume_mm3 > (r?.report.inspection.volume_mm3 ?? 12000), 'el dobladillo agregó material'); }
  else check((await s.inspect()).features.length === n0, 'el dobladillo fallido no dejó nada en el árbol');
  let bad = null; try { await call('sheet_metal', { document_id: id, action: 'hem', edge_point_mm: [x0, (y0 + y1) / 2, z1], length_mm: 8 }); } catch (e) { bad = e.message; }
  check(bad !== null, 'dobladillo en una esquina se rechaza: ' + String(bad).slice(0, 80));
  await call('save', { document_id: id });
  // drawing with the flat pattern
  const env = await call('environment', {});
  did = (await call('drawing_new', { path: `${root}\\drawings\\ChapaV39_${ts}.SLDDRW`, template: env.default_drawing_template, width_mm: 420, height_mm: 297 })).document_id;
  const part = `${root}\\ChapaV39_${ts}.SLDPRT`;
  await call('drawing_sheets', { document_id: did, action: 'add_view', model_path: part, view_orientation: 'isometric', position_mm: [120, 180], scale: 1 });
  const fv = await call('drawing_sheets', { document_id: did, action: 'add_view', model_path: part, flat_pattern: true, position_mm: [300, 120], scale: 1 });
  console.log('vista desplegada', JSON.stringify(fv)); check(fv.orientation === 'flat_pattern', 'vista de chapa desplegada creada');
  await call('save', { document_id: did });
  const pdf = await call('export', { document_id: did, name: `ChapaV39_${ts}.pdf` });
  console.log('PNG', (await drawingRead({ path: pdf.path, action: 'render', width_px: 1400 })).path);
  // save one body of a two-body part
  const two = await partBuild({ action: 'build', ir: { ir: 'part-ir/1', part: 'DosCuerpos_' + ts, units: 'mm', material: { name: 'AISI 1020' }, features: [
    { id: 'a', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 0], w: 20, h: 20 } }] }, depth: 10, direction: '+Z' },
    { id: 'b', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [50, 0], w: 30, h: 10 } }] }, depth: 5, direction: '+Z' }], expect: { bodies: 2 } } }, { worker: s.w, root });
  if (two.document_id) other.push(two.document_id);
  const sb = await call('save_body', { document_id: two.document_id, name: `Cuerpo_${ts}.SLDPRT`, point_mm: [50, 0, 5] });   // a point ON a face of the second body
  other.push(sb.document_id);
  console.log('guardar cuerpo', JSON.stringify(sb)); check(Math.abs(sb.volume_mm3 - 1500) < 0.01, 'el cuerpo guardado mide 30x10x5 = 1500 mm3');
} catch (e) { console.log('ERR', e.message.slice(0, 1200)); process.exitCode = 1; }
finally {
  for (const x of [did, ...other.reverse()]) if (x) try { await call('close_document', { document_id: x, discard_changes: true }); } catch { }
  try { await call('close_document', { document_id: id, discard_changes: true }); } catch { }
  await s.w.call('instance', { action: 'stop' }); s.w.close(); w0.close();
}
