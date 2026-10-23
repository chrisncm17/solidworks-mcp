// Prueba cronometrada con ensamble nunca visto: "Rondana pivotante para muebles" (placa superior, rueda, 2 soportes, eje, 2 bujes).
// Supuestos (plano isométrico de libro): placa 136x82x4 con R12 y 4xØ11 (112x58), sin el relieve central; soporte = ala 82x38x10
// con 2xØ11 a 26 + placa vertical 12 en trapecio a R19 con Ø22 a 48 BAJO EL ALA (58 de arriba: con 48 la rueda Ø100 toca la placa); eje Ø16x20 | Ø22x40 | Ø16x20 chaflán 2x45; buje Ø34x7 +
// Ø22x12, Ø16 pasante; rueda Ø100 ancho 38, llanta 5, alma 10, cubo Ø38x38, Ø22. Tornillos M10 en líneas fantasma: no se modelan.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyBuild } from '../server/assembly_build.mjs';
const MODE = process.argv[2] ?? 'build';
const w = MODE === 'check' ? null : new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), T = {}, FM = { name: 'Malleable Cast Iron' };
const lap = async (k, f) => { const t = performance.now(); const r = await f(); T[k] = +((performance.now() - t) / 1000).toFixed(1); return r; };
const placa = { ir: 'part-ir/1', part: 'RP_Placa_' + ts, units: 'mm', material: FM, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'top', entities: [{ rect: { center: [0, 0], w: 136, h: 82 } }] }, depth: 4, direction: '+Y' },
  { id: 'R12', op: 'fillet', edges: [[68, 2, 41], [-68, 2, 41], [68, 2, -41], [-68, 2, -41]].map(n => ({ near: n })), radius: 12 },
  { id: 'barrenos', op: 'cut', sketch: { plane: 'top', entities: [{ grid: { from: [-56, -29], count: [2, 2], step: [112, 58], d: 11 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1, box_mm: [136, 4, 82] } };
const soporte = { ir: 'part-ir/1', part: 'RP_Soporte_' + ts, units: 'mm', material: FM, features: [
  { id: 'ala', op: 'extrude', sketch: { plane: 'top', entities: [{ rect: { from: [-41, 0], to: [41, -38] } }] }, depth: 10, direction: '-Y' },
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: [[-41, 0], [41, 0], [19, -58], [-19, -58]] } }] }, depth: 12, direction: '+Z' },
  { id: 'boss', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, -58], r: 19 } }] }, depth: 12, direction: '+Z' },
  { id: 'eje22', op: 'cut', sketch: { plane: 'front', entities: [{ circle: { center: [0, -58], d: 22 } }] }, end: 'through_all_both' },
  { id: 'barrenos11', op: 'cut', sketch: { plane: 'top', entities: [{ circle: { center: [29, -26], d: 11 } }, { circle: { center: [-29, -26], d: 11 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1, box_mm: [82, 77, 38] } };
const eje = { ir: 'part-ir/1', part: 'RP_Eje_' + ts, units: 'mm', material: { name: 'AISI 1020' }, features: [
  { id: 'eje', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { x0: -40, segments: [[16, 20], [22, 40], [16, 20]] } }] } },
  { id: 'chaflanes', op: 'chamfer', edges: [{ near: [-40, 8, 0] }, { near: [40, 8, 0] }], distance: 2 }],
  expect: { bodies: 1, box_mm: [80, 22, 22] } };
const buje = { ir: 'part-ir/1', part: 'RP_Buje_' + ts, units: 'mm', material: { name: 'Tin Bearing Bronze' }, features: [
  { id: 'buje', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { segments: [[34, 7], [22, 12]] } }] } },
  { id: 'barreno16', op: 'cut', sketch: { plane: 'right', entities: [{ circle: { center: [0, 0], d: 16 } }] }, end: 'through_all_both' }],
  expect: { bodies: 1, box_mm: [19, 34, 34] } };
const rueda = { ir: 'part-ir/1', part: 'RP_Rueda_' + ts, units: 'mm', material: FM, features: [
  { id: 'rueda', op: 'revolve', sketch: { plane: 'front', entities: [{ poly: { points: [[-19, 11], [-19, 19], [-5, 19], [-5, 45], [-19, 45], [-19, 50], [19, 50], [19, 45], [5, 45], [5, 19], [19, 19], [19, 11]] } }, { line: { from: [-19, 0], to: [19, 0], construction: true } }] } }],
  expect: { bodies: 1, box_mm: [38, 100, 100] } };
const P = (component, normal, near) => ({ component, find: { kind: 'plane', normal, near_mm: near } });
const C = (component, d, near) => ({ component, find: { kind: 'cylinder', diameter_mm: d, ...(near ? { near_mm: near } : {}) } });
const mates = [];
for (const [b, k, sx] of [['SL', 'BL', -1], ['SR', 'BR', 1]]) mates.push(
  { name: `${b} ala bajo placa`, type: 'coincident', align: 'anti_aligned', entities: [P(b, [0, 1, 0], [0, 0, 20]), P('T', [0, -1, 0], [0, 0, 0])] },
  // which way each bracket faces must be explicit (its inner face looks at the wheel), or the solver may mirror it
  { name: `${b} mira al centro`, type: 'parallel', align: sx > 0 ? 'aligned' : 'anti_aligned', entities: [{ component: b, plane: 'Alzado' }, { component: 'T', plane: 'Vista lateral' }] },
  { name: `${b} centrado`, type: 'coincident', align: sx > 0 ? 'anti_aligned' : 'aligned', entities: [{ component: b, plane: 'Vista lateral' }, { component: 'T', plane: 'Alzado' }] },
  { name: `${k} en ${b}`, type: 'concentric', entities: [C(k, 22, [13, 11, 0]), C(b, 22, [11, -58, 6])] },
  { name: `${k} contra ${b}`, type: 'coincident', align: 'anti_aligned', entities: [P(k, [1, 0, 0], [7, 14, 0]), P(b, [0, 0, -1], [0, -30, 0])] },
  { name: `${k} contra hombro del eje`, type: 'coincident', align: 'anti_aligned', entities: [P(k, [-1, 0, 0], [0, 12, 0]), P('E', [sx, 0, 0], [sx * 20, 10, 0])] });
mates.push(
  { name: 'eje en BL', type: 'concentric', entities: [C('E', 16, [-30, 8, 0]), C('BL', 16, [10, 8, 0])] },
  { name: 'eje centrado', type: 'coincident', entities: [{ component: 'E', plane: 'Vista lateral' }, { component: 'T', plane: 'Vista lateral' }] },
  { name: 'rueda en eje', type: 'concentric', entities: [C('W', 22, [5, 11, 0]), C('E', 22, [0, 11, 0])] },
  { name: 'rueda centrada', type: 'coincident', entities: [{ component: 'W', plane: 'Vista lateral' }, { component: 'E', plane: 'Vista lateral' }] });
const plan = { ir: 'assembly-ir/1', name: 'RondanaPivotante_' + ts,
  components: [{ id: 'T', file: placa.part + '.SLDPRT', fixed: true }, { id: 'SL', file: soporte.part + '.SLDPRT' }, { id: 'SR', file: soporte.part + '.SLDPRT' },
    { id: 'BL', file: buje.part + '.SLDPRT' }, { id: 'BR', file: buje.part + '.SLDPRT' }, { id: 'E', file: eje.part + '.SLDPRT' }, { id: 'W', file: rueda.part + '.SLDPRT' }],
  mates, expect: { interferences_mm3: [], symmetric: ['x', 'z'] } };
const root = fileURLToPath(new URL('../server/generated', import.meta.url)), docs = [];
const parts = [['placa', placa], ['soporte', soporte], ['eje', eje], ['buje', buje], ['rueda', rueda]];
try {
  if (MODE === 'una') {
    // v3.8: TODO en una llamada: piezas (con reuso), ensamble, plano con PDF y respuestas
    await lap('arrancar', () => w.call('instance', { action: 'start' }));
    const r = await lap('una llamada', () => assemblyBuild({ action: 'build', plan: { ...plan, parts: parts.map(([, ir]) => ir) }, parts_dir: root, drawing: { size: 'A3', mass_units: 'g', length_units: 'mm', decimals: 2 }, answers: { mass_units: 'g', length_units: 'mm', decimals: 2, save_file: false } }, { worker: w, root }));
    console.log('veredicto', r.verdict, '| total', r.total_s, 's | piezas', JSON.stringify((r.parts ?? []).map(p => p.part.split('_')[1] + (p.reused ? ' ♻' : ' ✓'))), '| fases', JSON.stringify(Object.fromEntries(Object.entries(r.timings_ms ?? {}).map(([k, v]) => [k, +(v / 1000).toFixed(1)]))));
    console.log('plano', r.drawing?.pdf ?? JSON.stringify(r.drawing).slice(0, 200), r.drawing?.timings_s?.total, 's');
    console.log('respuestas', JSON.stringify(r.answers?.lines ?? r.answers));
    if (r.document_id) docs.push(r.document_id);
    console.log('TIEMPOS (s):', JSON.stringify(T));
  } else if (MODE === 'check') {
    for (const [k, ir] of parts) { const r = await partBuild({ action: 'check', ir }, {}); console.log(k, r.ok ? 'ok' : JSON.stringify(r.errors)); }
    const a = await assemblyBuild({ action: 'check', plan, parts_dir: root }, { root }); console.log('ensamble', a.ok ?? a.verdict, JSON.stringify(a.errors ?? '').slice(0, 600));
  } else {
    await lap('arrancar', () => w.call('instance', { action: 'start' }));
    for (const [k, ir] of parts) {
      const b = await lap(k, () => partBuild({ action: 'build', ir, link_parameters: false, reuse: true }, { worker: w }));
      const nw = b.part; for (const c of plan.components) if (c.file === ir.part + '.SLDPRT') c.file = nw; ir.part = nw.replace(/\.SLDPRT$/i, '');
      console.log(k, b.reused ? '♻' : b.ok ? '✓' : '✗', JSON.stringify((b.checks ?? []).filter(r => !r.ok)), b.ok ? '' : (b.failed_at ?? '') + ' ' + (b.error ?? JSON.stringify(b.errors)));
      if (b.document_id) docs.push(b.document_id);
      if (!b.ok) throw new Error(k + ' falló');
    }
    for (const id of docs.splice(0)) await w.call('close_document', { document_id: id, discard_changes: true });
    const a = await lap('ensamble', () => assemblyBuild({ action: 'build', plan, parts_dir: root }, { worker: w, root }));
    console.log('PARES', JSON.stringify((a.verification?.interference?.pairs ?? []).map(p => p.components.join('–') + ' ' + p.volume_mm3.toFixed(1) + ' ' + p.kind + ' c' + (p.center_mm ?? []).map(v => v.toFixed(0)).join(','))));
    console.log('ensamble', a.verdict, '| relaciones', a.verification?.mates?.mate_count, '| fallas', JSON.stringify(a.failures ?? a.errors).slice(0, 1200), '| dif', JSON.stringify(a.differences).slice(0, 700));
    if (a.document_id) { docs.push(a.document_id);
      const m = await w.call('mass_check', { document_id: a.document_id, mass_units: 'g', length_units: 'mm' });
      console.log('masa', m.result?.mass, 'g | CM', m.result?.center_of_mass?.map(v => v.toFixed(4)).join(', '), '| archivo', a.path); }
    console.log('TIEMPOS (s):', JSON.stringify(T), '| total', Object.values(T).reduce((x, v) => x + v, 0).toFixed(1));
  }
} catch (e) { console.log('ERR', e.message); console.log('TIEMPOS (s):', JSON.stringify(T)); process.exitCode = 1; }
finally { if (w) { for (const id of docs) await w.call('close_document', { document_id: id, discard_changes: true }); await w.call('instance', { action: 'stop' }); w.close(); } }
