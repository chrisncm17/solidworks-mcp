// Prueba cronometrada: transportador de 5 rodillos (placa superior, 2 rieles, 2 placas laterales, 5 rodillos, 10 tornillos M10 con rondana).
// argv[2] = "check" solo valida sin SolidWorks. Todo nuevo en generated; nada del usuario.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { partBuild } from '../server/part_ir.mjs';
import { assemblyBuild } from '../server/assembly_build.mjs';
const MODE = process.argv[2] ?? 'build';
const w = MODE === 'check' ? null : new WorkerClient({ timeoutMs: 900000 });
const ts = process.env.TS ?? Date.now().toString(36), T = {}, OPS = {};
const lap = async (k, f) => { const t = performance.now(); const r = await f(); T[k] = +((performance.now() - t) / 1000).toFixed(1); return r; };
const MAT = { name: 'AISI 1020' };
const X5 = [0, 1, 2, 3, 4].map(k => -265 + 132.5 * k);          // barrenos a 25 y 132.5 (4x) sobre 580
// Placa superior: 580 x 248 x 30, saliente central de 138 x 10 abajo (40 en total); 10 barrenos Ø11 con avellanado 6x45
const placa = { ir: 'part-ir/1', part: 'PlacaSup_' + ts, units: 'mm', material: MAT,
  features: [
    { id: 'bloque', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { from: [-290, -124], to: [290, 124] } }] }, depth: 40, direction: '+Z' },
    { id: 'escalones', op: 'cut', sketch: { plane: 'front', entities: [{ rect: { from: [-300, 69], to: [300, 130] } }, { rect: { from: [-300, -130], to: [300, -69] } }] }, depth: 10, direction: '+Z' },
    { id: 'barrenos11', op: 'cut', sketch: { plane: 'front', entities: X5.flatMap(x => [[x, 92], [x, -92]]).map(c => ({ circle: { center: c, d: 11 } })) }, end: 'through_all_both' },
    { id: 'avellanado', op: 'chamfer', edges: X5.flatMap(x => [{ near: [x + 5.5, 92, 40] }, { near: [x + 5.5, -92, 40] }]), distance: 6 }],
  expect: { bodies: 1, box_mm: [580, 248, 40] } };
// Riel 580: perfil 60 x 28 (x = ancho desde el borde interior, y = alto), ranura 16 x 8 a 15 del borde interior, chaflán 10x45, R5
const riel = { ir: 'part-ir/1', part: 'Riel_' + ts, units: 'mm', material: MAT,
  features: [
    { id: 'perfil', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: [[0, 0], [15, 0], [15, 8], [31, 8], [31, 0], [50, 0], [60, 10], [60, 28], [0, 28]] } }] }, depth: 580, direction: '+Z' },
    { id: 'R5', op: 'fillet', edges: [{ near: [60, 28, 290] }], radius: 5 },
    { id: 'M10x1_25', op: 'cut', sketch: { plane: 'top', entities: [0, 1, 2, 3, 4].map(k => ({ circle: { center: [23, -(25 + 132.5 * k)], d: 10 } })) }, end: 'through_all_both' }],
  expect: { bodies: 1, box_mm: [60, 28, 580] } };
// Placa lateral 580 x 80 x 16 con 5 barrenos Ø25.2 a 20 de abajo, 50 y 120 (4x)
const lateral = { ir: 'part-ir/1', part: 'Lateral_' + ts, units: 'mm', material: MAT,
  features: [
    { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { from: [-290, 0], to: [290, 80] } }] }, depth: 16, direction: '+Z' },
    { id: 'barrenos25_2', op: 'cut', sketch: { plane: 'front', entities: [0, 1, 2, 3, 4].map(k => ({ circle: { center: [-240 + 120 * k, 20], d: 25.2 } })) }, end: 'through_all_both' }],
  expect: { bodies: 1, box_mm: [580, 80, 16], volume_mm3: '580*80*16 - 5*pi*12.6^2*16' } };
// Rodillo: Ø100, 200 total con muñones Ø25 de 16.5 (desde el borde del cuerpo), caras a 85° hundidas (cono de 5° hacia el muñón), chaflán 3x45 y 0.5x45, M10 x 50 (broca 59) en cada punta
const c5 = 37.5 * Math.tan(5 * Math.PI / 180);
const rodillo = { ir: 'part-ir/1', part: 'Rodillo_' + ts, units: 'mm', material: MAT,
  features: [
    { id: 'cuerpo', op: 'revolve', sketch: { plane: 'front', entities: [{ poly: { points: [[0, 0], [0, 12.5], [16.5 + c5, 12.5], [16.5, 50], [183.5, 50], [183.5 - c5, 12.5], [200, 12.5], [200, 0]] } }, { line: { from: [0, 0], to: [200, 0], construction: true } }] } },
    { id: 'chaflan3', op: 'chamfer', edges: [{ near: [16.5, 50, 0] }, { near: [183.5, 50, 0] }], distance: 3 },
    { id: 'chaflan0_5', op: 'chamfer', edges: [{ near: [0, 12.5, 0] }, { near: [200, 12.5, 0] }], distance: 0.5 },
    { id: 'M10_izq', op: 'hole', type: 'tap', size: 'M10', at: [0, 0, 0], depth: 59, thread_depth: 50 },
    { id: 'M10_der', op: 'hole', type: 'tap', size: 'M10', at: [200, 0, 0], depth: 59, thread_depth: 50 }],
  expect: { bodies: 1, box_mm: [200, 100, 100] } };
const P = (component, normal, near) => ({ component, find: { kind: 'plane', normal, near_mm: near } });
const C = (component, d, near) => ({ component, find: { kind: 'cylinder', diameter_mm: d, ...(near ? { near_mm: near } : {}) } });
const mates = [];
for (const [s, sg] of [[1, 1], [2, -1]]) {
  const R = 'R' + s, L = 'L' + s;
  mates.push(
    { name: `riel ${s} bajo la placa`, type: 'coincident', align: 'anti_aligned', entities: [P(R, [0, 1, 0], [40, 28, 290]), P('T', [0, 0, -1], [0, sg * 100, 10])] },
    { name: `riel ${s} contra el saliente`, type: 'coincident', align: 'anti_aligned', entities: [P(R, [-1, 0, 0], [0, 20, 290]), P('T', [0, sg, 0], [0, sg * 69, 5])] },
    { name: `riel ${s} al ras`, type: 'coincident', align: 'aligned', entities: [P(R, [0, 0, -1], [40, 20, 0]), P('T', [-sg, 0, 0], [-sg * 290, 0, 20])] },
    { name: `lateral ${s} en la ranura`, type: 'coincident', align: 'anti_aligned', entities: [P(L, [0, 1, 0], [0, 80, 8]), P(R, [0, -1, 0], [23, 8, 290])] },
    { name: `lateral ${s} contra la ranura`, type: 'coincident', align: 'anti_aligned', entities: [P(L, [0, 0, -1], [0, 60, 0]), P(R, [1, 0, 0], [15, 4, 290])] },
    { name: `lateral ${s} al ras`, type: 'coincident', align: 'aligned', entities: [P(L, [-1, 0, 0], [-290, 40, 8]), P('T', [sg, 0, 0], [sg * 290, 0, 20])] });
}
const PATRON = !!process.env.PATRON;   // 1 rodillo + 2 tornillos como semillas y patrón lineal x5
for (let k = 1; k <= (PATRON ? 1 : 5); k++) {
  const x = -240 + 120 * (k - 1);
  mates.push({ name: `rodillo ${k}`, type: 'concentric', entities: [C('G' + k, 25, [8, 12.5, 0]), C('L1', 25.2, [x, 20, 8])] },
    { name: `rodillo ${k} al ras`, type: 'coincident', align: 'aligned', entities: [P('G' + k, [-1, 0, 0], [0, 6, 0]), P('L1', [0, 0, 1], [x + 20, 35, 16])] });
  for (const [s, end] of [[1, 0], [2, 200]]) {
    const n = (k - 1) * 2 + s;
    mates.push({ name: `tornillo ${n}`, intent: 'fastener', bolt: 'B' + n, washer: 'W' + n,
      hole: C('G' + k, 10, [end ? 190 : 10, 5, 0]), head_side: P('L' + s, [0, 0, 1], [x + 20, 35, 16]) });
  }
}
// avellanados ISO 10642 M10x45 de la placa superior (2 semillas, una por fila; el patrón hace las demás)
if (PATRON) for (const [i, y] of [[1, 92], [2, -92]]) mates.push({ name: `avellanado ${i}`, intent: 'fastener', bolt: 'S' + i, hole: C('T', 11, [-265, y, 20]), head_side: P('T', [0, 0, 1], [-200, 0, 40]) });
const plan = { ir: 'assembly-ir/1', name: (process.env.PATRON ? 'RodillosPatron_' + Date.now().toString(36) + '_' : 'Rodillos_') + ts,
  components: [{ id: 'T', file: placa.part + '.SLDPRT', fixed: true, ...(process.env.UP ? { up: process.env.UP } : {}) }, { id: 'R', file: riel.part + '.SLDPRT', count: 2 }, { id: 'L', file: lateral.part + '.SLDPRT', count: 2 },
    (PATRON ? { id: 'G1', file: rodillo.part + '.SLDPRT' } : { id: 'G', file: rodillo.part + '.SLDPRT', count: 5 }), { id: 'B', make: { type: 'bolt', size: 'M10', length_mm: 25, material: 'AISI 1020' }, count: PATRON ? 2 : 10 }, { id: 'W', make: { type: 'washer', size: 'M10', material: 'AISI 1020' }, count: PATRON ? 2 : 10 }, ...(PATRON ? [{ id: 'S', make: { type: 'countersunk', size: 'M10', length_mm: 45, material: 'AISI 1020' }, count: 2 }] : [])],
  mates, ...(PATRON ? { patterns: [{ kind: 'linear', seeds: ['G1', 'B1', 'W1', 'B2', 'W2'], count: 5, spacing_mm: 120, direction: { component: 'L1', local_point_mm: [0, 80, 0], kind: 'edge' }, ...(process.env.REV ? { reverse: true } : {}) }, { kind: 'linear', seeds: ['S1', 'S2'], count: 5, spacing_mm: 132.5, direction: { component: 'T', local_point_mm: [0, 124, 40], kind: 'edge' }, ...(process.env.REV2 ? { reverse: true } : {}) }] } : {}), expect: { interferences_mm3: [], symmetric: process.env.UP ? ['x', 'z'] : ['x', 'y'] } };
const root = fileURLToPath(new URL('../server/generated', import.meta.url));
const parts = [['placa superior', placa], ['riel', riel], ['placa lateral', lateral], ['rodillo', rodillo]];
const docs = [];
try {
  if (MODE === 'debug') {
    await w.call('instance', { action: 'start' });
    plan.mates = plan.mates.filter(m => !/^tornillo ([3-9]|10)$/.test(m.name ?? ''));
    const a = await assemblyBuild({ action: 'build', plan: { ...plan, name: 'Dbg_' + Date.now().toString(36) }, parts_dir: root }, { worker: w, root });
    console.log('debug', a.verdict, JSON.stringify(a.failures).slice(0, 300));
    if (a.document_id) { docs.push(a.document_id);
      const ins = await w.call('inspect', { document_id: a.document_id });
      for (const c of ins.result?.components ?? []) { const t = c.transform; if (!t || !/Lateral|Riel|Rodillo_.*-1$|ISO/.test(c.name)) continue;
        console.log(c.name, 'X', t.slice(0, 3).map(v => v.toFixed(2)).join(','), 'Y', t.slice(3, 6).map(v => v.toFixed(2)).join(','), 'Z', t.slice(6, 9).map(v => v.toFixed(2)).join(','), 'O', t.slice(9, 12).map(v => (v * 1000).toFixed(2)).join(',')); }
      if (!ins.ok) console.log('inspect', ins.error); else if (!ins.result?.components?.[0]?.transform) console.log(JSON.stringify(ins.result.components?.[0]).slice(0, 300)); }
  } else if (MODE === 'check') {
    for (const [k, ir] of parts) { const r = await partBuild({ action: 'check', ir }, {}); console.log(k, r.ok ? 'ok' : JSON.stringify(r.errors), r.warnings?.length ? JSON.stringify(r.warnings).slice(0, 300) : ''); }
    const a = await assemblyBuild({ action: 'check', plan, parts_dir: root }, { root });
    console.log('ensamble', a.ok ?? a.verdict, JSON.stringify(a.errors ?? a.problems ?? '').slice(0, 800), '| relaciones', a.expanded?.mates?.length ?? a.mates?.length);
  } else {
    const s = await lap('arrancar SolidWorks del MCP', () => w.call('instance', { action: 'start' }));
    if (!s.ok) throw new Error(s.error);
    for (const [k, ir] of (MODE === 'asm' ? [] : parts)) {
      const b = await lap(k, () => partBuild({ action: 'build', ir, link_parameters: false, reuse: !!process.env.REUSE }, { worker: w }));
      const ren = old => { const nw = b.part; for (const c of plan.components) if (c.file === old) c.file = nw; ir.part = nw.replace(/\.SLDPRT$/i, ''); };
      if (b.reused) { ren(ir.part + '.SLDPRT'); console.log(k, '♻ reusada', b.part); continue; }
      if (b.saved) ren(ir.part + '.SLDPRT');
      OPS[k] = (b.features ?? []).map(f => `${f.id} ${f.s}s`).join(' | ') + ` | material+revisión ${b.finish_s}s`;
      const ins = b.document_id ? await w.call('inspect', { document_id: b.document_id }) : null;
      console.log(k, b.ok ? '✓' : '✗', 'volumen', ins?.result?.volume_mm3?.toFixed(2), JSON.stringify((b.checks ?? []).filter(r => !r.ok)), b.ok ? '' : (b.failed_at ?? '') + ' ' + JSON.stringify(b.error ?? b.errors ?? '').slice(0, 400), JSON.stringify(b.warnings ?? []).slice(0, 300));
      if (!b.document_id) throw new Error(k + ' sin documento');
      docs.push(b.document_id);
      if (!b.ok) throw new Error(k + ' falló');
      if (!b.saved) await lap(k + ' (guardar)', () => w.call('save', { document_id: b.document_id }));
    }
    for (const id of docs.splice(0)) await w.call('close_document', { document_id: id, discard_changes: true });
    const a = await lap('ensamble', () => assemblyBuild({ action: 'build', plan, parts_dir: root }, { worker: w, root }));
    if (!a.failures) console.log('RESPUESTA', JSON.stringify(a).slice(0, 1200));
    console.log('ensamble', a.verdict, '| relaciones', a.verification?.mates?.mate_count ?? '?', '| fallas', JSON.stringify(a.failures).slice(0, 900), '| diferencias', JSON.stringify(a.differences).slice(0, 600), '| avisos', JSON.stringify(a.warnings ?? []).slice(0, 300));
    console.log('fases ensamble (s):', JSON.stringify(Object.fromEntries(Object.entries(a.timings_ms ?? {}).map(([k, v]) => [k, +(v / 1000).toFixed(1)]))), '| tornillería', JSON.stringify((a.fasteners ?? []).map(f => f.file + ' ' + (f.s ?? ''))));
    if (a.document_id) {
      docs.push(a.document_id);
      const m = await lap('masa y CM', () => w.call('mass_check', { document_id: a.document_id, mass_units: 'g', length_units: 'mm' }));
      console.log('masa', m.result?.mass, 'g | CM', m.result?.center_of_mass?.map(v => v.toFixed(4)).join(', '), 'mm');
      if (!a.failures?.length) await lap('guardar ensamble', () => w.call('save', { document_id: a.document_id }));
      const i = await lap('interferencias', () => w.call('interference', { document_id: a.document_id }));
      console.log('interferencias', i.result?.interference_count, JSON.stringify((i.result?.pairs ?? []).map(p => `${p.components.join('–')} ${p.volume_mm3.toFixed(2)} ${p.kind}`)));
      console.log('archivo', a.path);
    }
    for (const [k, v] of Object.entries(OPS)) console.log('OPERACIONES', k, ':', v);
    console.log('TIEMPOS (s):', JSON.stringify(T), '| total', Object.values(T).reduce((x, v) => x + v, 0).toFixed(1));
  }
} catch (e) { console.log('ERR', e.stack); for (const [k, v] of Object.entries(OPS)) console.log('OPERACIONES', k, ':', v); console.log('TIEMPOS (s):', JSON.stringify(T)); process.exitCode = 1; }
finally { if (w) { for (const id of docs) await w.call('close_document', { document_id: id, discard_changes: true }); await w.call('instance', { action: 'stop' }); w.close(); } }
