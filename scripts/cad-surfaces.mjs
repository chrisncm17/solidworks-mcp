// CAD regression of the whole Surfaces tab (sw_surface, its curves and sw_boundary): every case builds a small part in the
// MCP's own SolidWorks and checks the surface area or the volume against the exact value (0.5 % or 0.05).
// Run: npm run test:cad [-- out.txt [case,prefixes]]. It starts the MCP's minimized SolidWorks when it is not running (not
// the user's), closes every part it made without saving and leaves SolidWorks running. Surfaces-only mode (action mode)
// lives in the Node server, so it is covered by the unit tests and not here.
import { WorkerClient } from '../server/worker-client.mjs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const w = new WorkerClient({ timeoutMs: 0 }); const out = [];
const OUT = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const log = s => { out.push(s); console.log(s); if (OUT) writeFileSync(OUT, out.join('\n')); };
const call = async (op, a) => { const r = await w.call(op, a); if (!r.ok) throw new Error(op + ' -> ' + r.error); return r.result; };
const ids = []; const tag = Date.now().toString(36); let T;
const line = (a, b, c) => ({ kind: 'line', start_mm: a, end_mm: b, ...(c ? { construction: true } : {}) });
const rect = (x0, y0, x1, y1) => [line([x0, y0], [x1, y0]), line([x1, y0], [x1, y1]), line([x1, y1], [x0, y1]), line([x0, y1], [x0, y0])];
const circ = (x, y, r) => ({ kind: 'circle', center_mm: [x, y], radius_mm: r });
const findKey = (o, k) => { if (!o || typeof o !== 'object') return undefined; if (k in o) return o[k]; for (const v of Object.values(o)) { const r = findKey(v, k); if (r !== undefined) return r; } };
const res = [];
const area = async id => { const r = await call('surface', { document_id: id, action: 'inspect' }); return (r.surface_bodies ?? []).reduce((s, b) => s + b.area_mm2, 0); };
const vol = async id => findKey(await call('inspect', { document_id: id }), 'volume_mm3');
async function caso(name, fn, expect, kind = 'area') {
  if (ONLY && !ONLY.some(x => name.startsWith(x))) return;
  let id;
  try {
    id = (await call('create_part', { name: 'reg ' + name.replace(/[^a-z0-9]/gi, '') + ' ' + tag, template: T })).document_id; ids.push(id);
    const sk = async (plane, ents) => (await call('create_sketch', { document_id: id, plane_index: plane, entities: ents })).sketch;
    const S = a => call('surface', { document_id: id, ...a });
    const plane = async off => (await call('ref_plane', { document_id: id, plane_index: 0, offset_mm: off })).plane_index;
    const extra = await fn({ id, sk, S, plane });
    const got = kind === 'area' ? await area(id) : await vol(id);
    const okv = Math.abs(got - expect) <= Math.max(0.005 * Math.abs(expect), 0.05);
    const s = (okv ? 'OK    ' : 'WRONG ') + name + ': ' + kind + ' ' + (+got).toFixed(2) + ' (expected ' + expect.toFixed(2) + ')' + (extra ? ' ' + JSON.stringify(extra).slice(0, 400) : '');
    log(s); res.push(okv);
  } catch (e) { log('ERROR ' + name + ': ' + e.message.slice(0, 1500)); res.push(false); }
  finally { if (id) { try { await call('close_document', { document_id: id, discard_changes: true }); } catch { } ids.splice(ids.indexOf(id), 1); } }
}
const PI = Math.PI;
try {
  for (let k = 0; k < 12; k++) { const r = await w.call('instance', { action: 'status' }); if (r.ok && r.result.dedicated_running && r.result.status === 'ready') break; if (k === 0 || (r.ok && !r.result.dedicated_running)) await w.call('instance', { action: 'start' }); await new Promise(z => setTimeout(z, 15000)); }
  T = (await call('environment', {})).default_part_template;
  await caso('extrude', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [line([0, 0], [40, 0])]), depth_mm: 20 }); }, 800);
  await caso('revolve', async ({ sk, S }) => { await S({ action: 'revolve', sketch: await sk(0, [line([10, 0], [10, 30]), line([0, 0], [0, 30], true)]), angle_deg: 360 }); }, 2 * PI * 10 * 30);
  await caso('planar', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); }, 1600);
  await caso('loft', async ({ sk, S, plane }) => { const a = await sk(0, [circ(0, 0, 10)]); const p = await plane(30); const b = await sk(p, [circ(0, 0, 10)]); await S({ action: 'loft', profiles: [a, b] }); }, 2 * PI * 10 * 30);
  await caso('sweep', async ({ sk, S }) => { const a = await sk(0, [circ(0, 0, 5)]); const p = await sk(1, [line([0, 0], [0, 40])]); await S({ action: 'sweep', profile: a, path: p }); }, 2 * PI * 5 * 40);
  await caso('offset', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'offset', face_points_mm: [[0, 0, 0]], distance_mm: 5 }); }, 3200);
  await caso('ruled tangent', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'ruled', ruled_type: 'tangent', edge_points_mm: [[20, 0, 0]], distance_mm: 10 }); }, 2000);
  await caso('ruled normal', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'ruled', ruled_type: 'normal', edge_points_mm: [[20, 0, 0]], distance_mm: 10 }); }, 2000);
  await caso('ruled normal tubo', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 20 }); const r = await S({ action: 'ruled', ruled_type: 'normal', edge_points_mm: [[10, 0, 20]], distance_mm: 10 }); return r.tried?.slice(-3); }, 2 * PI * 10 * 20 + PI * (400 - 100));
  await caso('fill', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 20 }); await S({ action: 'fill', edge_points_mm: [[10, 0, 20]] }); }, 2 * PI * 10 * 20 + PI * 100);
  await caso('boundary', async ({ sk, S, plane }) => { const a = await sk(0, [circ(0, 0, 10)]); const p = await plane(30); const b = await sk(p, [circ(0, 0, 10)]); await S({ action: 'boundary', profiles: [a, b] }); }, 2 * PI * 10 * 30);
  await caso('flatten', async ({ sk, S, plane }) => { await S({ action: 'extrude', sketch: await sk(0, [{ kind: 'arc', center_mm: [0, 0], start_mm: [10, 0], end_mm: [-10, 0] }]), depth_mm: 40 }); await S({ action: 'flatten', face_points_mm: [[0, 10, 20]], up_to_point_mm: [10, 0, 0] }); }, 2 * PI * 10 * 40);
  await caso('radiate', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 20 }); await S({ action: 'radiate', edge_points_mm: [[10, 0, 20]], tool_plane_index: 0, distance_mm: 10 }); }, 2 * PI * 10 * 20 + PI * (400 - 100));
  await caso('mid_surface', async ({ id, sk, S }) => { await call('extrude', { document_id: id, sketch: await sk(0, rect(0, 0, 40, 20)), depth_mm: 10 }); await S({ action: 'mid_surface' }); }, 800);
  await caso('mid_surface caras', async ({ id, sk, S }) => { await call('extrude', { document_id: id, sketch: await sk(0, [...rect(0, 0, 40, 20)]), depth_mm: 10 }); const r = await S({ action: 'mid_surface', face_points_mm: [[20, 10, 0], [20, 10, 10]] }); return r.tried?.slice(-3); }, 800);
  await caso('freeform', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'freeform', face_point_mm: [0, 0, 0], freeform_curves: [{ direction: 0, at: 0.5, points: [{ at: 0.5, offset_mm: [0, 0, 5] }] }] }); }, 1655.44);
  await caso('trim plano tubo', async ({ sk, S, plane }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 40 }); const p = await plane(25); await S({ action: 'trim', tool_plane_index: p, keep_points_mm: [[10, 0, 10]] }); }, 2 * PI * 10 * 25);
  await caso('trim mutuo', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'extrude', sketch: await sk(0, [line([-20, 0], [20, 0])]), depth_mm: 20, mid_plane: true }); await S({ action: 'trim', mutual: true, keep_points_mm: [[0, 10, 0], [0, 0, 5]] }); }, 800 + 400);
  await caso('trim tubo con tubo', async ({ sk, S, plane }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 40 }); await S({ action: 'extrude', sketch: await sk(2, [circ(-20, 0, 5)]), depth_mm: 30, mid_plane: true }); const r = await S({ action: 'trim', mutual: true, keep_points_mm: [[0, -10, 5], [13, 0, 25]] }); return r.tried?.slice(-3); }, 2528.51);
  await caso('untrim', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, [...rect(-20, -20, 20, 20), circ(0, 0, 5)]) }); await S({ action: 'untrim', face_point_mm: [10, 10, 0] }); }, 1600);
  await caso('delete_hole', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, [...rect(-20, -20, 20, 20), circ(0, 0, 5)]) }); await S({ action: 'delete_hole', edge_points_mm: [[5, 0, 0]] }); }, 1600);
  await caso('extend', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'extend', edge_points_mm: [[20, 0, 0]], distance_mm: 10, linear: true }); }, 2000);
  await caso('knit solido', async ({ sk, S, plane }) => { await S({ action: 'extrude', sketch: await sk(0, rect(0, 0, 20, 20)), depth_mm: 20 }); await S({ action: 'planar', sketch: await sk(0, rect(0, 0, 20, 20)) }); const p = await plane(20); await S({ action: 'planar', sketch: await sk(p, rect(0, 0, 20, 20)) }); await S({ action: 'knit', form_solid: true }); }, 8000, 'vol');
  await caso('delete_face', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 20 }); await S({ action: 'fill', edge_points_mm: [[10, 0, 20]] }); await S({ action: 'delete_face', face_points_mm: [[0, 0, 20]], mode: 'delete' }); }, 2 * PI * 10 * 20);
  await caso('replace_face', async ({ id, sk, S, plane }) => { await call('extrude', { document_id: id, sketch: await sk(0, rect(0, 0, 40, 40)), depth_mm: 10 }); const p = await plane(15); await S({ action: 'planar', sketch: await sk(p, rect(-10, -10, 50, 50)) }); await S({ action: 'replace_face', face_points_mm: [[20, 20, 10]], body_point_mm: [20, 20, 15] }); }, 24000, 'vol');
  await caso('thicken', async ({ sk, S }) => { await S({ action: 'planar', sketch: await sk(0, rect(-20, -20, 20, 20)) }); await S({ action: 'thicken', body_point_mm: [0, 0, 0], thickness_mm: 2 }); }, 3200, 'vol');
  await caso('thicken_cut', async ({ id, sk, S, plane }) => { await call('extrude', { document_id: id, sketch: await sk(0, rect(-20, -20, 20, 20)), depth_mm: 10 }); const p = await plane(10); await S({ action: 'planar', sketch: await sk(p, [circ(0, 0, 5)]) }); await S({ action: 'thicken_cut', body_point_mm: [0, 0, 10], thickness_mm: 10, side: 'both' }); }, 16000 - PI * 25 * 10, 'vol');
  await caso('cut_with_surface', async ({ id, sk, S, plane }) => { await call('extrude', { document_id: id, sketch: await sk(0, rect(0, 0, 40, 40)), depth_mm: 10 }); const p = await plane(5); await S({ action: 'planar', sketch: await sk(p, rect(-10, -10, 50, 50)) }); await S({ action: 'cut_with_surface', body_point_mm: [20, 20, 5] }); }, 8000, 'vol');
  await caso('join', async ({ id, sk, S }) => { await call('extrude', { document_id: id, sketch: await sk(0, rect(0, 0, 20, 20)), depth_mm: 10 }); await call('extrude', { document_id: id, sketch: await sk(0, rect(20, 0, 40, 20)), depth_mm: 10, merge: false }); const r = await S({ action: 'join', face_point_mm: [20, 10, 5] }); return { solids: findKey(r, 'solid_bodies') ?? findKey(r, 'solids') }; }, 8000, 'vol');
  await caso('sw_boundary saliente', async ({ id, sk, plane }) => { const a = await sk(0, [circ(0, 0, 10)]); const p = await plane(40); const b = await sk(p, [circ(0, 0, 15)]); await call('boundary', { document_id: id, profiles: [a, b] }); }, PI * 40 / 3 * (100 + 150 + 225), 'vol');
  // v3.23 the Curves menu: the curve length is checked, then a surface along it
  const near = (a, b, what) => { if (Math.abs(a - b) > Math.max(0.005 * Math.abs(b), 0.05)) throw new Error(what + ' ' + a + ' (expected ' + b.toFixed(3) + ')'); };
  await caso('curve_points sweep', async ({ sk, S }) => { const c = await S({ action: 'curve_points', points_mm: [[0, 0, 0], [0, 0, 20], [0, 0, 40]] }); near(c.curve.length_mm, 40, 'length'); await S({ action: 'sweep', profile: await sk(0, [circ(0, 0, 5)]), path: c.feature }); return c.curve; }, 2 * PI * 5 * 40);
  await caso('curve_composite', async ({ sk, S }) => { const a = await sk(0, [line([0, 0], [20, 0])]); const b = await sk(0, [line([20, 0], [20, 20])]); const c = await S({ action: 'curve_composite', curves: [a, b] }); near(c.curve.length_mm, 40, 'length'); if (c.curve.closed) throw new Error('open chain reported closed'); return { ...c.curve, way: c.tried?.at(-1) }; }, 0);
  const projLen = (() => { let L = 0, n = 20000; for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, y = -5 + 10 * t, x = Math.sqrt(100 - y * y); L += Math.sqrt(900 + 100 + (10 * y / x) ** 2) / n; } return L; })();
  await caso('curve_projected faces', async ({ sk, S }) => { await S({ action: 'extrude', sketch: await sk(0, [circ(0, 0, 10)]), depth_mm: 40 }); const c = await S({ action: 'curve_projected', sketch: await sk(2, [line([-5, -5], [-35, 5])]), face_points_mm: [[10, 0, 20]] }); near(c.curve.length_mm, projLen, 'length'); return c.curve; }, 2 * PI * 10 * 40);
  await caso('curve_projected sketches', async ({ sk, S }) => { const a = await sk(0, [line([0, 0], [20, 10])]); const b = await sk(2, [line([0, 0], [-20, 10])]); const c = await S({ action: 'curve_projected', sketch: a, onto_sketch: b }); near(c.curve.length_mm, 30, 'length'); return c.curve; }, 0);
  // v3.23 mutual trim of a revolved tube (no extrusion sketch to project): same geometry and value as the extruded case
  await caso('trim tubo revolucionado con tubo', async ({ sk, S }) => { await S({ action: 'revolve', sketch: await sk(2, [line([0, 10], [-40, 10]), line([0, 0], [-40, 0], true)]), angle_deg: 360 }); await S({ action: 'extrude', sketch: await sk(2, [circ(-20, 0, 5)]), depth_mm: 30, mid_plane: true }); const r = await S({ action: 'trim', mutual: true, keep_points_mm: [[0, -10, 5], [13, 0, 25]] }); return r.tried?.slice(-4); }, 2528.51);
  // v3.24 airplane from a 3-view: picture to scale, guides from segments + loft_check, section area (checked inside each case)
  const bmp = (() => { const W = 200, H = 100, row = W * 3, size = 54 + row * H; const b = Buffer.alloc(size, 0); b.fill(255, 54); b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(W, 18); b.writeInt32LE(H, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * H, 34);
    for (let y = 20; y < 80; y++) for (let x = 50; x < 150; x++) { const o = 54 + (H - 1 - y) * row + x * 3; b[o] = b[o + 1] = b[o + 2] = 0; }
    const f = join(tmpdir(), 'reg_picture_' + tag + '.bmp'); writeFileSync(f, b); return f; })();
  await caso('sketch_picture', async ({ id }) => {
    const r = await call('sketch_picture', { document_id: id, image_path: bmp, plane_index: 0, scale_ref: { px_a: [50, 50], px_b: [150, 50], distance_mm: 100 }, anchor: { px: [50, 80], at_mm: [0, 0] }, trace_columns: 40, px_to_mm: [[150, 20]] });
    near(r.mm_per_px, 1, 'mm_per_px'); near(r.size_mm[0], 200, 'width'); near(r.size_mm[1], 100, 'height'); near(r.px_to_mm[0].mm[0], 100, 'px x'); near(r.px_to_mm[0].mm[1], 60, 'px y');
    const pts = r.outline.points_mm; if (pts.length < 15) throw new Error('outline has ' + pts.length + ' columns');
    for (const q of pts) { near(q[1], 60, 'outline top'); near(q[2], 0, 'outline bottom'); }
    const c = await call('sketch_picture', { document_id: id, image_path: bmp, plane_index: 1, crop_px: [40, 10, 160, 90], flip_x: true, mm_per_px: 1, anchor: { px: [150, 80], at_mm: [0, 0] }, px_to_mm: [[50, 20]] });
    near(c.size_mm[0], 120, 'crop width'); near(c.size_mm[1], 80, 'crop height'); near(c.px_to_mm[0].mm[0], 100, 'flip x'); near(c.px_to_mm[0].mm[1], 60, 'flip y');
    return { a: r.sketch, b: c.sketch, cols: pts.length };
  }, 0);
  await caso('loft guia de segmentos', async ({ id, sk, S, plane }) => {
    const a = await sk(0, [circ(0, 0, 10)]); const p = await plane(30); const b = await sk(p, [circ(0, 0, 10)]);
    const g = await sk(1, [line([10, 0], [10, -30]), line([10, 0], [10, 30]), line([12, 0], [12, 30]), line([12, 30], [14, 30])]);
    const c = await S({ action: 'loft_check', profiles: [a, b], guides: [{ sketch: g, segments: [0] }, { sketch: g, segments: [1] }, { sketch: g, segments: [2, 3] }] });
    const good = c.guides.filter(x => x.profiles.every(q => q.touches)); if (good.length !== 1) throw new Error('expected one good guide: ' + JSON.stringify(c.problems));
    const bad = c.guides[2]; if (!bad.chain.ok || bad.profiles.some(q => q.touches)) throw new Error('the x=12 guide: ' + JSON.stringify(bad));
    near(bad.profiles[0].distance_mm, 2, 'miss distance');
    const seg = good[0].guide.endsWith('[0]') ? 0 : 1;
    await S({ action: 'loft', profiles: [a, b], guides: [{ sketch: g, segments: [seg] }] });
    return { good: good[0].guide, problems: c.problems.length };
  }, 2 * PI * 10 * 30);
  await caso('section_area', async ({ id, sk }) => {
    await call('extrude', { document_id: id, sketch: await sk(0, rect(0, 0, 40, 20)), depth_mm: 10, direction: '+Z' });
    const r = await call('section_area', { document_id: id, sections: [{ origin_mm: [20, 10, 5], normal: [1, 0, 0] }, { origin_mm: [10, 10, 5], normal: [0, 1, 0], size_mm: 20 }, { origin_mm: [20, 10, 50], normal: [0, 0, 1] }] });
    near(r.sections[0].area_mm2, 200, 'x cut'); near(r.sections[1].area_mm2, 200, 'half y cut'); if (r.sections[2].area_mm2 !== 0) throw new Error('outside cut ' + r.sections[2].area_mm2);
    return r.sections.map(x => x.area_mm2);
  }, 0);
  log('SUMMARY ' + res.filter(Boolean).length + '/' + res.length); process.exitCode = res.every(Boolean) ? 0 : 1;
} catch (e) { log('FATAL ' + e.message.slice(0, 900)); process.exitCode = 1; }
finally { for (const id of ids) try { await w.call('close_document', { document_id: id, discard_changes: true }); } catch { } w.close?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); }
