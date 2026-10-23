// Ejemplo para mostrar (22-oct): Tablero con pivotes DESDE CERO en una sola llamada de sw_assembly_build
// (4 piezas por IR, 6 pernos, 4 pivotes semilla + patrón circular x6 = 24, plano A3 y respuestas). Cronometrado.
import { WorkerClient } from '../server/worker-client.mjs';
import { fileURLToPath } from 'node:url';
import { assemblyBuild, waitBackground } from '../server/assembly_build.mjs';
import { examReady } from '../server/exam_ready.mjs';
import { drawingDimensions } from '../server/dims_geometry.mjs';
const w = new WorkerClient({ timeoutMs: 900000 });
const ts = Date.now().toString(36), docs = [], T = {};
const lap = async (k, f) => { const t = performance.now(); const r = await f(); T[k] = +((performance.now() - t) / 1000).toFixed(1); return r; };
const R = 86.60254037844386, H = 43.30127018922193, MAT = { name: 'AISI 1020' };
const pol = (r, a) => [+(r * Math.cos(a * Math.PI / 180)).toFixed(4), +(r * Math.sin(a * Math.PI / 180)).toFixed(4)];
const ring = (r, a0) => [0, 1, 2, 3, 4, 5].map(k => pol(r, a0 + 60 * k));
const hexPts = [[75, -H], [75, H], [0, R], [-75, H], [-75, -H], [0, -R]];
const sideMid = z => [[75, 0, z], [-75, 0, z], [37.5, 64.9519, z], [-37.5, 64.9519, z], [37.5, -64.9519, z], [-37.5, -64.9519, z]].map(n => ({ near: n }));
const H7 = ring(65, 0), M6 = ring(75, 30);
const P9 = [[0, 0], ...[20, 35, 50].flatMap(r => ring(r, 0)), ...[23, 40, 58].flatMap(r => ring(r, 30))];
const CH = '0.5*c*c*(6*86.60254037844386 - 2*(c/3)*6*0.5773502691896258)';
const circles = (pts, d) => ({ plane: 'front', entities: pts.map(c => ({ circle: { center: c, d } })) });
const base = { ir: 'part-ir/1', part: 'Base_' + ts, units: 'mm', material: MAT, params: { t: 12, c: 3 },
  features: [
    { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: hexPts } }] }, depth: 't', direction: '+Z' },
    { id: 'h7', op: 'cut', sketch: circles(H7, 8), end: 'through_all_both' },
    { id: 'm6', op: 'cut', sketch: circles(M6, 6), end: 'through_all_both' },
    { id: 'chaflan', op: 'chamfer', edges: sideMid(0), distance: 'c' }],
  expect: { bodies: 1, volume_mm3: `1.5*sqrt(3)*86.60254037844386^2*t - 6*pi*16*t - 6*pi*9*t - ${CH}` } };
const tapa = { ir: 'part-ir/1', part: 'Tapa_' + ts, units: 'mm', material: MAT, params: { t: 12, c: 3 },
  features: [
    { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: hexPts } }] }, depth: 't', direction: '+Z' },
    { id: 'pivotes37', op: 'cut', sketch: circles(P9, 9), end: 'through_all_both' },
    { id: 'h7', op: 'cut', sketch: circles(H7, 8), end: 'through_all_both' },
    { id: 'd6_5', op: 'cut', sketch: circles(M6, 6.5), end: 'through_all_both' },
    { id: 'chaflan', op: 'chamfer', edges: sideMid(12), distance: 'c' }],
  expect: { bodies: 1, volume_mm3: `1.5*sqrt(3)*86.60254037844386^2*t - 37*pi*4.5^2*t - 6*pi*16*t - 6*pi*3.25^2*t - ${CH}` } };
const perno = { ir: 'part-ir/1', part: 'Perno_' + ts, units: 'mm', material: MAT, params: { d: 8, L: 24, c: 1 },
  features: [
    { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 'd' } }] }, depth: 'L', direction: '+Z' },
    { id: 'chaflanes', op: 'chamfer', edges: [{ near: [4, 0, 0] }, { near: [4, 0, 24] }], distance: 'c' }],
  expect: { bodies: 1, volume_mm3: 'pi*(d/2)^2*L - 2*2*pi*(d/2 - c/3)*0.5*c*c' } };
const hm = z => [[6, 0, z], [-6, 0, z], [3, 5.1962, z], [-3, 5.1962, z], [3, -5.1962, z], [-3, -5.1962, z]].map(n => ({ near: n }));
const pivote = { ir: 'part-ir/1', part: 'Pivote_' + ts, units: 'mm', material: MAT, params: { s: 12, h: 10, d: 9, L: 30 },
  features: [
    { id: 'cabeza', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: [[6, -3.4641], [6, 3.4641], [0, 6.9282], [-6, 3.4641], [-6, -3.4641], [0, -6.9282]] } }] }, depth: 'h', direction: '+Z' },
    { id: 'vastago', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 'd' } }] }, depth: 'L', direction: '+Z' },
    { id: 'redondeo_R2', op: 'fillet', edges: hm(0), radius: 2 },
    { id: 'chaflan_cabeza', op: 'chamfer', edges: hm(10), distance: 1 },
    { id: 'chaflan_punta', op: 'chamfer', edges: [{ near: [4.5, 0, 30] }], distance: 1 }],
  expect: { bodies: 1 } };
const SEEDS = [pol(23, 30), pol(40, 30), pol(58, 30), pol(50, 0)];
const cyl = (component, d, near) => ({ component, find: { kind: 'cylinder', diameter_mm: d, ...(near ? { near_mm: near } : {}) } });
const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
const plan = { ir: 'assembly-ir/1', name: 'TableroPivotes_' + ts, parts: [base, tapa, perno, pivote],
  components: [{ id: 'B', file: base.part + '.SLDPRT', fixed: true }, { id: 'T', file: tapa.part + '.SLDPRT' },
    { id: 'P', file: perno.part + '.SLDPRT', count: 6 }, { id: 'G', file: pivote.part + '.SLDPRT', count: 4 }],
  mates: [
    { name: 'tapa sobre base', type: 'coincident', align: 'anti_aligned', entities: [pl('T', [0, 0, -1], 0), pl('B', [0, 0, 1], 12)] },
    { name: 'tapa barreno 1', type: 'concentric', entities: [cyl('T', 8, [65, 0, 6]), cyl('B', 8, [65, 0, 6])] },
    { name: 'tapa barreno 2', type: 'concentric', entities: [cyl('T', 8, [-65, 0, 6]), cyl('B', 8, [-65, 0, 6])] },
    ...H7.flatMap(([x, y], k) => [
      { name: `perno ${k + 1}`, type: 'concentric', entities: [cyl('P' + (k + 1), 8), cyl('B', 8, [x, y, 6])] },
      { name: `perno ${k + 1} al ras`, type: 'coincident', align: 'aligned', entities: [pl('P' + (k + 1), [0, 0, -1], 0), pl('B', [0, 0, -1], 0)] }]),
    ...SEEDS.flatMap(([x, y], k) => [
      { name: `pivote ${k + 1}`, type: 'concentric', entities: [cyl('G' + (k + 1), 9), cyl('T', 9, [x, y, 6])] },
      { name: `pivote ${k + 1} apoyo`, type: 'coincident', align: 'anti_aligned', entities: [pl('G' + (k + 1), [0, 0, 1], 30), pl('B', [0, 0, 1], 12)] }])],
  patterns: [{ kind: 'circular', seeds: ['G1', 'G2', 'G3', 'G4'], count: 6, axis: { component: 'T', local_point_mm: [4.5, 0, 6], kind: 'face' } }],
  expect: { interferences_mm3: [], symmetric: ['x', 'y'] } };
try {
  // flujo del examen: SolidWorks arranca en segundo plano mientras se lee el plano
  const t0 = performance.now(), at = () => +((performance.now() - t0) / 1000).toFixed(1);
  const root = fileURLToPath(new URL('../server/generated', import.meta.url));
  const er = await lap('exam_ready (regresa sin esperar)', () => examReady({ start: true, wait: false }, { worker: w, root }));
  console.log('exam_ready', JSON.stringify(er.started));
  const dd = await lap('leer un plano mientras arranca', () => drawingDimensions({ path: fileURLToPath(new URL('./drawings/support_plate.pdf', import.meta.url)), page: 1 }));
  console.log('cotas leídas', dd.dimensions.filter(d => d.from_mm).length, 'a los', at(), 's');
  const a = await lap('una llamada', () => assemblyBuild({ action: 'build', plan, parts_dir: root, reuse_parts: process.env.REUSE === '1',
    drawing: { size: 'A3', mass_units: 'g', length_units: 'mm', decimals: 2 }, answers: { mass_units: 'g', length_units: 'mm', decimals: 4 } }, { worker: w, root }));
  if (a.document_id) docs.push(a.document_id);
  T['respuestas listas desde el inicio'] = at();
  console.log('TIEMPOS POR FASE', JSON.stringify(a.times), '| piezas', JSON.stringify((a.parts ?? []).map(p => p.part.split('_')[0] + ' ' + p.s + 's')));
  const jobs = await waitBackground(); T['plano listo desde el inicio'] = at();
  console.log('SEGUNDO PLANO', JSON.stringify(jobs.map(j => ({ label: j.label, ok: j.result?.ok, s: j.result?.s, path: j.result?.path ?? j.result?.drawing, err: j.result?.error }))));
  console.log('VEREDICTO', a.verdict, '| total', a.total_s, 's | fase', a.phase ?? '-', '|', a.deliverables ?? '');
  for (const p of a.parts ?? []) console.log('pieza', p.part, p.ok ? '✓' : '✗', p.reused ? '(reusada)' : '', JSON.stringify(p.failed ?? []).slice(0, 200));
  console.log('fases ensamble (s):', JSON.stringify(Object.fromEntries(Object.entries(a.timings_ms ?? {}).map(([k, v]) => [k, +(v / 1000).toFixed(1)]))));
  console.log('reparto [antes, seleccion+AddMate5, recorrer, rebuild, posiciones]', JSON.stringify((a.verification?.mate_split_ms ?? []).filter((x, i) => i % 5 === 0)));
  console.log('mass split [total, sin ocultos, por pieza, fin]', JSON.stringify((a.verification?.mass_checks ?? []).map(m => [m.split_ms, m.call_ms])), 'simetria', a.verification?.symmetric_ms, JSON.stringify(a.verification?.symmetric_split));
  console.log('ms por relación', JSON.stringify(a.verification?.mate_ms), '| preflight', a.timings_ms?.mates_preflight);
  console.log('relaciones', a.verification?.mates?.mate_count, '| fallas', JSON.stringify(a.failures ?? []).slice(0, 400), '| diferencias', JSON.stringify(a.differences ?? []).slice(0, 400));
  console.log('RESPUESTAS', String(JSON.stringify(a.answers?.lines ?? a.answers ?? null)).slice(0, 900));
  console.log('PLANO', a.drawing?.ok, a.drawing?.path ?? a.drawing?.drawing ?? '', a.drawing?.pdf ?? '', a.drawing?.error ?? '');
  console.log('FIND [comp, cands, pick, punto]', JSON.stringify(a.verification?.find_ms));
  console.log('TAMANO resultado', JSON.stringify(a).length, 'bytes | por clave', JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, JSON.stringify(v ?? null).length]).sort((x, y) => y[1] - x[1]).slice(0, 10))), '| verificación', JSON.stringify(Object.fromEntries(Object.entries(a.verification ?? {}).map(([k, v]) => [k, JSON.stringify(v ?? null).length]).sort((x, y) => y[1] - x[1]).slice(0, 8))));
  console.log('ENSAMBLE', a.path);
  // picture for the README: isometric preview of the finished assembly and the drawing PDF
  if (a.document_id) { const pv = await w.call('preview', { document_id: a.document_id }); console.log('PREVIEW', pv.ok ? pv.result.path : pv.error); }
  console.log('PDF', JSON.stringify(jobs.map(j => j.result?.pdf).filter(Boolean)));
  console.log('PERFIL (op, ms, worker, pre) > 1 s', JSON.stringify((w.profile ?? []).filter(p => p[1] > 1000)));
  console.log('TIEMPOS (s):', JSON.stringify(T));
} catch (e) { console.log('ERR', e.message, '| TIEMPOS', JSON.stringify(T)); process.exitCode = 1; }
finally { for (const id of docs) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } await w.call('instance', { action: 'stop' }); w.close(); }
