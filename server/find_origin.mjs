// v3.7 sw_find_origin: the drawing gives a center of mass but not WHERE its origin is nor how its axes point. Candidates:
// every component origin and every hole/shaft axis point (from find_faces cylinders), each with the 24 axis-aligned
// orientations of the assembly frame. The one that reproduces the drawing CM is the origin (method of the butterfly-valve
// exercise). Returns the ranking and, with create:true, makes the coordinate system (point_mm + axes) and re-checks it.
const U = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const LEN = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export function orientations() {
  const out = [];
  for (const a of U) for (const sa of [1, -1]) for (const b of U) for (const sb of [1, -1]) {
    const X = a.map(v => v * sa), Y = b.map(v => v * sb); if (dot(X, Y) !== 0) continue; out.push({ X, Y, Z: cross(X, Y) });
  }
  return out;
}
// rank candidate origins (mm, assembly frame) against the drawing CM (in `units`)
export function rankOrigins(cm_mm, candidates, expected, units = 'in') {
  const k = LEN[units], res = [];
  for (const c of candidates) for (const ax of orientations()) {
    const r = cm_mm.map((v, i) => v - c.point_mm[i]), rel = [dot(r, ax.X), dot(r, ax.Y), dot(r, ax.Z)].map(v => v / k);
    res.push({ ...c, axes: ax, com: rel.map(v => +v.toFixed(6)), error: Math.hypot(...rel.map((v, i) => v - expected[i])) });
  }
  return res.sort((p, q) => p.error - q.error);
}
const call = async (worker, op, a) => { const r = await worker.call(op, a); if (!r.ok) throw new Error(op + ': ' + r.error); return r.result; };
const toWorld = (t, p) => [0, 1, 2].map(i => t[9 + i] * 1000 + p[0] * t[i] + p[1] * t[3 + i] + p[2] * t[6 + i]);
const dirWorld = (t, v) => [0, 1, 2].map(i => v[0] * t[i] + v[1] * t[3 + i] + v[2] * t[6 + i]);

// several drawing CMs in one call ([[x,y,z],[x,y,z]]): the faces of every component are read ONCE (half the time for two CMs)
export async function findOrigin(args, ctx = {}) {
  const cms = args.center_of_mass;
  if (Array.isArray(cms) && cms.length && Array.isArray(cms[0])) {
    const shared = {}; const results = [];
    // length_units may be one unit for all or one per CM
    for (const [i, cm] of cms.entries()) results.push(await findOriginOne({ ...args, center_of_mass: cm, length_units: Array.isArray(args.length_units) ? args.length_units[i] : args.length_units }, ctx, shared));
    return { results };
  }
  return findOriginOne(args, ctx, {});
}
async function findOriginOne(args, { worker } = {}, shared) {
  const id = args.document_id, units = args.length_units ?? 'in', expected = args.center_of_mass;
  if (!Array.isArray(expected) || expected.length !== 3 || !expected.every(Number.isFinite)) throw new Error('center_of_mass: [x,y,z] del plano requerido');
  if (!LEN[units]) throw new Error('length_units: mm|cm|m|in');
  const ins = shared.ins ?? (shared.ins = await call(worker, 'inspect', { document_id: id }));
  const mc = shared.mc ?? (shared.mc = await call(worker, 'mass_check', { document_id: id, length_units: 'mm' }));
  const cm = mc.center_of_mass;
  let cands = shared.cands;
  if (!cands) { cands = shared.cands = [];
  // v3.7: cylinders of every component in one call (fallback: one call per component)
  let allFaces = null;
  if (args.holes !== false) try { allFaces = Object.fromEntries((await call(worker, 'find_faces', { document_id: id, kind: 'cylinder' })).components.map(x => [x.component, x])); } catch { }
  for (const k of ins.components || []) {
    const t = k.transform; if (!t) continue;
    cands.push({ source: 'origen de ' + k.name, component: k.name, point_mm: toWorld(t, [0, 0, 0]).map(v => v / 1000 * 1000) });
    if (args.holes === false) continue;
    try {
      const f = allFaces?.[k.name] ?? await call(worker, 'find_faces', { document_id: id, component: k.name, kind: 'cylinder' });
      for (const c of f.candidates) {
        const d = dirWorld(t, c.axis);
        for (const [where, q] of [['un extremo', c.axis_start_mm], ['el otro extremo', c.axis_end_mm], ['punto base', c.axis_point_mm]]) if (q)
          cands.push({ source: `centro del cilindro Ø${c.diameter_mm} de ${k.name} (${where})`, component: k.name, point_mm: toWorld(t, q), axis: d });
      }
    } catch { }
  } }
  // de-duplicate candidate points (same place from several faces)
  const uniq = []; for (const c of cands) if (!uniq.some(u => Math.hypot(...u.point_mm.map((v, i) => v - c.point_mm[i])) < 1e-4)) uniq.push(c);
  const ranked = rankOrigins(cm, uniq, expected, units);
  // v3.7 review: the runner-up is the next DIFFERENT system (other point or other axes), ties included
  const best = ranked[0], second = ranked[1];
  const tol = args.max_error ?? Math.max(1e-3, 0.005 * Math.hypot(...expected));   // 0.5 % of the CM distance
  const ambiguous = !!second && second.error - best.error < 1e-3;
  const out = { center_of_mass_assembly_mm: cm, candidates_tested: uniq.length * 24,
    best: { source: best.source, point_mm: best.point_mm.map(v => +v.toFixed(4)), x_axis: best.axes.X, y_axis: best.axes.Y, z_axis: best.axes.Z, com: best.com, error: +best.error.toFixed(6) },
    runner_up_error: second ? +second.error.toFixed(6) : null, ambiguous, within_tolerance: best.error <= tol,
    top: ranked.slice(0, 8).map(r => ({ source: r.source, point_mm: r.point_mm.map(v => +v.toFixed(3)), x_axis: r.axes.X, y_axis: r.axes.Y, com: r.com, error: +r.error.toFixed(6) })),
    note: `Error en ${units}. Si el mejor y el segundo están muy cerca, el CM no distingue: decide con el plano (dónde está dibujado "Origen").` };
  if (args.create) {
    if (best.error > tol) throw new Error(`find_origin: el mejor candidato no reproduce el CM (error ${best.error.toFixed(6)} ${units} > ${tol.toFixed(6)}); no se crea nada. Revisa el plano o el ensamble.`);
    // a tie means the CM cannot tell those systems apart (the CM VALUES are the same in all of them); creating one needs consent
    if (ambiguous && !args.accept_ambiguous) throw new Error(`find_origin: ${out.top.filter(t => t.error - best.error < 1e-3).length} sistemas distintos reproducen el CM igual de bien; decide con el plano o usa accept_ambiguous:true. Top: ${JSON.stringify(out.top.slice(0, 4))}`);
    const cs = await call(worker, 'coordinate_system', { document_id: id, action: 'create', point_mm: out.best.point_mm, axes: { x: out.best.x_axis, y: out.best.y_axis } });
    const chk = await call(worker, 'mass_check', { document_id: id, coordinate_system: cs.coordinate_system, length_units: units, mass_units: args.mass_units ?? 'lb' });
    out.created = { coordinate_system: cs.coordinate_system, center_of_mass: chk.center_of_mass };
  }
  return out;
}
