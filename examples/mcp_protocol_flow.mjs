// Flujo del examen POR EL PROTOCOLO MCP, como lo hace el chat: sw_exam_ready (arranca sin esperar) -> sw_drawing_read dimensions
// (mientras arranca) -> sw_assembly_build del tablero en una llamada (piezas IR, patrón, respuestas y plano en segundo plano)
// -> sw_exam_ready (el plano terminado). Al final cierra el documento y detiene el SolidWorks del MCP.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', id = 0; const waiting = new Map();
server.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const rpc = (method, params) => new Promise(res => { const k = ++id; waiting.set(k, res); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const txt = r.result?.content?.find(c => c.type === 'text')?.text ?? ''; let j = null; try { j = JSON.parse(txt); } catch { } return { err: !!r.result?.isError, txt, j }; };
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
// --- the tablero, exactly as in v38_tablero_una_llamada.mjs
const ts = Date.now().toString(36), R = 86.60254037844386, H = 43.30127018922193, MAT = { name: 'AISI 1020' };
const pol = (r, a) => [+(r * Math.cos(a * Math.PI / 180)).toFixed(4), +(r * Math.sin(a * Math.PI / 180)).toFixed(4)];
const ring = (r, a0) => [0, 1, 2, 3, 4, 5].map(k => pol(r, a0 + 60 * k));
const hexPts = [[75, -H], [75, H], [0, R], [-75, H], [-75, -H], [0, -R]];
const sideMid = z => [[75, 0, z], [-75, 0, z], [37.5, 64.9519, z], [-37.5, 64.9519, z], [37.5, -64.9519, z], [-37.5, -64.9519, z]].map(n => ({ near: n }));
const H7 = ring(65, 0), M6 = ring(75, 30), P9 = [[0, 0], ...[20, 35, 50].flatMap(r => ring(r, 0)), ...[23, 40, 58].flatMap(r => ring(r, 30))];
const CH = '0.5*c*c*(6*86.60254037844386 - 2*(c/3)*6*0.5773502691896258)';
const circles = (pts, d) => ({ plane: 'front', entities: pts.map(c => ({ circle: { center: c, d } })) });
const base = { ir: 'part-ir/1', part: 'BaseF_' + ts, units: 'mm', material: MAT, params: { t: 12, c: 3 }, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: hexPts } }] }, depth: 't', direction: '+Z' },
  { id: 'h7', op: 'cut', sketch: circles(H7, 8), end: 'through_all_both' }, { id: 'm6', op: 'cut', sketch: circles(M6, 6), end: 'through_all_both' },
  { id: 'chaflan', op: 'chamfer', edges: sideMid(0), distance: 'c' }], expect: { bodies: 1, volume_mm3: `1.5*sqrt(3)*86.60254037844386^2*t - 6*pi*16*t - 6*pi*9*t - ${CH}` } };
const tapa = { ir: 'part-ir/1', part: 'TapaF_' + ts, units: 'mm', material: MAT, params: { t: 12, c: 3 }, features: [
  { id: 'placa', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: hexPts } }] }, depth: 't', direction: '+Z' },
  { id: 'pivotes37', op: 'cut', sketch: circles(P9, 9), end: 'through_all_both' }, { id: 'h7', op: 'cut', sketch: circles(H7, 8), end: 'through_all_both' },
  { id: 'd6_5', op: 'cut', sketch: circles(M6, 6.5), end: 'through_all_both' }, { id: 'chaflan', op: 'chamfer', edges: sideMid(12), distance: 'c' }],
  expect: { bodies: 1, volume_mm3: `1.5*sqrt(3)*86.60254037844386^2*t - 37*pi*4.5^2*t - 6*pi*16*t - 6*pi*3.25^2*t - ${CH}` } };
const perno = { ir: 'part-ir/1', part: 'PernoF_' + ts, units: 'mm', material: MAT, params: { d: 8, L: 24, c: 1 }, features: [
  { id: 'perno', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 'd' } }] }, depth: 'L', direction: '+Z' },
  { id: 'chaflanes', op: 'chamfer', edges: [{ near: [4, 0, 0] }, { near: [4, 0, 24] }], distance: 'c' }], expect: { bodies: 1, volume_mm3: 'pi*(d/2)^2*L - 2*2*pi*(d/2 - c/3)*0.5*c*c' } };
const hm = z => [[6, 0, z], [-6, 0, z], [3, 5.1962, z], [-3, 5.1962, z], [3, -5.1962, z], [-3, -5.1962, z]].map(n => ({ near: n }));
const pivote = { ir: 'part-ir/1', part: 'PivoteF_' + ts, units: 'mm', material: MAT, params: { s: 12, h: 10, d: 9, L: 30 }, features: [
  { id: 'cabeza', op: 'extrude', sketch: { plane: 'front', entities: [{ poly: { points: [[6, -3.4641], [6, 3.4641], [0, 6.9282], [-6, 3.4641], [-6, -3.4641], [0, -6.9282]] } }] }, depth: 'h', direction: '+Z' },
  { id: 'vastago', op: 'extrude', sketch: { plane: 'front', entities: [{ circle: { center: [0, 0], d: 'd' } }] }, depth: 'L', direction: '+Z' },
  { id: 'redondeo_R2', op: 'fillet', edges: hm(0), radius: 2 }, { id: 'chaflan_cabeza', op: 'chamfer', edges: hm(10), distance: 1 },
  { id: 'chaflan_punta', op: 'chamfer', edges: [{ near: [4.5, 0, 30] }], distance: 1 }], expect: { bodies: 1 } };
const SEEDS = [pol(23, 30), pol(40, 30), pol(58, 30), pol(50, 0)];
const cyl = (component, d, near) => ({ component, find: { kind: 'cylinder', diameter_mm: d, ...(near ? { near_mm: near } : {}) } });
const pl = (component, normal, offset_mm) => ({ component, find: { kind: 'plane', normal, offset_mm } });
const plan = { ir: 'assembly-ir/1', name: 'TableroFlujo_' + ts, parts: [base, tapa, perno, pivote],
  components: [{ id: 'B', file: base.part + '.SLDPRT', fixed: true }, { id: 'T', file: tapa.part + '.SLDPRT' }, { id: 'P', file: perno.part + '.SLDPRT', count: 6 }, { id: 'G', file: pivote.part + '.SLDPRT', count: 4 }],
  mates: [
    { name: 'tapa sobre base', type: 'coincident', align: 'anti_aligned', entities: [pl('T', [0, 0, -1], 0), pl('B', [0, 0, 1], 12)] },
    { name: 'tapa barreno 1', type: 'concentric', entities: [cyl('T', 8, [65, 0, 6]), cyl('B', 8, [65, 0, 6])] },
    { name: 'tapa barreno 2', type: 'concentric', entities: [cyl('T', 8, [-65, 0, 6]), cyl('B', 8, [-65, 0, 6])] },
    ...H7.flatMap(([x, y], k) => [{ name: `perno ${k + 1}`, type: 'concentric', entities: [cyl('P' + (k + 1), 8), cyl('B', 8, [x, y, 6])] },
      { name: `perno ${k + 1} al ras`, type: 'coincident', align: 'aligned', entities: [pl('P' + (k + 1), [0, 0, -1], 0), pl('B', [0, 0, -1], 0)] }]),
    ...SEEDS.flatMap(([x, y], k) => [{ name: `pivote ${k + 1}`, type: 'concentric', entities: [cyl('G' + (k + 1), 9), cyl('T', 9, [x, y, 6])] },
      { name: `pivote ${k + 1} apoyo`, type: 'coincident', align: 'anti_aligned', entities: [pl('G' + (k + 1), [0, 0, 1], 30), pl('B', [0, 0, 1], 12)] }])],
  patterns: [{ kind: 'circular', seeds: ['G1', 'G2', 'G3', 'G4'], count: 6, axis: { component: 'T', local_point_mm: [4.5, 0, 6], kind: 'face' } }],
  expect: { interferences_mm3: [], symmetric: ['x', 'y'] } };
let doc = null;
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flujo', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const e1 = await call('sw_exam_ready', { start: true, wait: false });
  console.log(at(), 'exam_ready', e1.err ? 'ERROR ' + e1.txt.slice(0, 200) : JSON.stringify(e1.j.result.started), '| herramientas', e1.j?.result?.tools);
  const d = await call('sw_drawing_read', { path: fileURLToPath(new URL('./drawings/support_plate.pdf', import.meta.url)), action: 'dimensions', page: 1 });
  console.log(at(), 'plano leído', d.err ? 'ERROR' : `${d.j.result.dimensions.length} cotas, material ${d.j.result.materials?.[0]?.raw}`);
  const gen = fileURLToPath(new URL('../server/generated', import.meta.url));
  const b = await call('sw_assembly_build', { action: 'build', plan, parts_dir: gen, reuse_parts: process.env.REUSE === '1', drawing: { size: 'A3', mass_units: 'g', length_units: 'mm', decimals: 2 }, answers: { mass_units: 'g', length_units: 'mm', decimals: 4 } });
  doc = b.j?.result?.document_id ?? null;
  console.log('respuesta al chat', b.txt.length, 'bytes | claves', Object.keys(b.j?.result ?? {}).join(','), '| verificación', JSON.stringify(b.j?.result?.verification).slice(0, 700));
  console.log(at(), 'assembly_build', b.err ? 'ERROR ' + b.txt.slice(0, 600) : `${b.j.result.verdict} | respuestas ${JSON.stringify(b.j.result.answers?.lines)} | plano ${JSON.stringify(b.j.result.drawing?.pending ? 'en segundo plano' : b.j.result.drawing?.ok)} | times ${JSON.stringify(b.j.result.times)}`);
  const e2 = await call('sw_exam_ready', {});
  console.log(at(), 'exam_ready (trabajos)', JSON.stringify((e2.j?.result?.background_jobs ?? []).map(j => ({ label: j.label, done: j.done, ok: j.result?.ok, s: j.result?.s }))));
  const st = await call('sw_status', {});   // a CAD tool: waits for the background drawing (barrier)
  console.log(at(), 'sw_status tras la barrera', st.err ? 'ERROR' : 'ok');
  const e3 = await call('sw_exam_ready', {});
  console.log(at(), 'trabajos al final', JSON.stringify((e3.j?.result?.background_jobs ?? []).map(j => ({ label: j.label, done: j.done, ok: j.result?.ok, path: j.result?.path }))));
} catch (e) { console.log('ERR', e.message); }
finally {
  try { if (doc) await call('sw_close_document', { document_id: doc, discard_changes: true }); } catch { }
  try { const s = await call('sw_instance', { action: 'stop' }); console.log('instance stop', s.err ? s.txt.slice(0, 200) : 'ok'); } catch { }
  server.kill();
}
