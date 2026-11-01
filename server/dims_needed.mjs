// v3.17 which dimensions a part needs (its author: "solo las necesarias... que tu la veas y digas con esto es suficiente para que alguien haga la
// pieza"). Worked out from the faces of the part, not from the dimensions the sheet happens to have:
//  - along each model axis the part has points: the planes normal to that axis and the centres of what is round. Each linear dimension joins two
//    points. Everything joined means nothing is missing; a dimension that joins what was already joined is too many. So N points take N-1 dimensions.
//  - each size of round is said once, with how many there are.
//  - some points need no dimension of their own: the centre of a fillet comes from its radius, a round centred on a symmetric part sits on the middle,
//    a twin on the other side of the middle comes with its pair, equal gaps between equal things are said once (TIP.), holes around a circle by
//    their separation and their distance to the contour, or with no contour by their separation and their count.
// Pure logic, no SolidWorks: drawing_part_sizes reads the faces, dims_layout.mjs puts on the sheet what this asks for.

const TOL = 0.05, VTOL = 0.02, AX = 'XYZ';
const near = (a, b, t = TOL) => Math.abs(a - b) <= t;
const VAL = v => Math.round(v * 100) / 100;
const alignedAxis = v => v.findIndex(x => Math.abs(x) > 0.999);
const othersOf = a => [0, 1, 2].filter(i => i !== a);
const isRD = m => /^RD\d+@/.test(m.name ?? '');
const FULL_TURN = 1.5 * Math.PI, HALF_TURN = Math.PI, STEP_ON_PAPER = [0.3, 1];
// how many separate stretches along its axis a round has: five journals of one diameter on one line are five, a face split in two is one, and so are
// two stretches mirrored about the middle of the part (the lips of a pulley, the ears of a clevis): one circle on the sheet
function stretches(c, mid) {
  const runs = [];
  for (const [lo, hi] of [...(c.spans ?? [])].sort((p, q) => p[0] - q[0])) { const last = runs[runs.length - 1]; if (last && lo <= last[1] + TOL) last[1] = Math.max(last[1], hi); else runs.push([lo, hi]); }
  if (runs.length === 2 && near(runs[0][0] + runs[1][1], 2 * mid, 2 * TOL) && near(runs[0][1] + runs[1][0], 2 * mid, 2 * TOL)) return 1;
  return Math.max(1, runs.length);
}

// two points are the same kind of thing: the same sizes of round, planes of about the same area
function similar(p, q) {
  const a = [...p.round].sort().join(), b = [...q.round].sort().join();
  if (a !== b) return false;
  return (!p.area && !q.area) || (Math.abs(p.area - q.area) <= 0.15 * Math.max(p.area, q.area));
}

// the circle through three points; null if they are in line
function circleThrough([ax, ay], [bx, by], [cx, cy]) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-6) return null;
  const A = ax * ax + ay * ay, B = bx * bx + by * by, C = cx * cx + cy * cy;
  return [(A * (by - cy) + B * (cy - ay) + C * (ay - by)) / d, (A * (cx - bx) + B * (ax - cx) + C * (bx - ax)) / d];
}
// holes of one size around a circle, evenly: their separation and their distance to the contour say where all of them are. A place of the ring may be empty (six of seven, where an arm leaves)
function findRings(rounds) {
  const groups = new Map(), rings = [];
  for (const c of rounds) {
    const a = alignedAxis(c.axis); if (a < 0 || c.sweep < FULL_TURN) continue;
    const k = a + '|' + VAL(c.r); if (!groups.has(k)) groups.set(k, { axis: a, r: c.r, holes: [] }); groups.get(k).holes.push(c);
  }
  for (const g of groups.values()) {
    if (g.holes.length < 3) continue;
    const [p, q] = othersOf(g.axis), pts = g.holes.map(h => [h.point[p], h.point[q]]), from = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
    const far = [...pts].sort((u, v) => from(v, pts[0]) - from(u, pts[0]))[0], off = u => Math.abs((far[0] - pts[0][0]) * (u[1] - pts[0][1]) - (far[1] - pts[0][1]) * (u[0] - pts[0][0]));
    const c = circleThrough(pts[0], far, [...pts].sort((u, v) => off(v) - off(u))[0]); if (!c) continue;
    const [cp, cq] = c, radius = from(pts[0], c);
    if (radius < 1e-6 || pts.some(u => !near(from(u, c), radius))) continue;
    const angles = pts.map(u => Math.atan2(u[1] - cq, u[0] - cp)).sort((x, y) => x - y), rough = polarStep(angles); if (!rough) continue;
    const slots = Math.round(TURN / rough), step = TURN / slots, gaps = angles.map((t, i) => i ? t - angles[i - 1] : t - angles[angles.length - 1] + TURN);
    if (gaps.some(t => Math.abs(t - Math.round(t / step) * step) > 0.01)) continue;
    // empty places: all together, and around something, or three holes of a grid would be a ring
    if (slots !== pts.length && (gaps.filter(t => t > 1.5 * step).length > 1 || !rounds.some(k => alignedAxis(k.axis) === g.axis && near(k.point[p], cp) && near(k.point[q], cq)))) continue;
    rings.push({ axis: g.axis, r: g.r, count: g.holes.length, holes: g.holes, center: { [p]: cp, [q]: cq }, radius, step, pitch: 2 * radius * Math.sin(step / 2) });
  }
  return rings;
}
// the sizes of hole that go around a circle: their dimensions come from the view that sees them as circles
export const ringDiameters = sizes => findRings(sizes?.rounds ?? []).map(r => VAL(r.r * 2));

const TURN = 2 * Math.PI;
const wrap = t => { const m = ((t % TURN) + TURN) % TURN; return m > Math.PI ? m - TURN : m; };
const halfTurnOf = t => ((t % Math.PI) + Math.PI) % Math.PI;
const nearWhole = (v, t = 0.04) => Math.abs(v - Math.round(v)) <= t;
// angles that come in steps of a whole part of a turn, even with some missing; the step or nothing
function polarStep(angles) {
  const t = [...angles].sort((x, y) => x - y), gaps = t.map((x, i) => i ? x - t[i - 1] : x - t[t.length - 1] + TURN), step = Math.min(...gaps);
  return step > 0.01 && nearWhole(TURN / step, 0.08) && gaps.every(g => nearWhole(g / step)) ? step : null;
}
// faces that repeat around a line along axis a through c, each one a turn of the others: the same distance from c, the same lean against the radius, the same size
function familiesAround(flat, arcs, a, c) {
  const [p, q] = othersOf(a), fams = [];
  const add = (item, kind, r, lean, size, span, theta) => {
    let f = fams.find(x => x.kind === kind && near(x.r, r) && Math.abs(wrap(2 * (x.lean - lean))) < 0.03 && near(x.size, size, Math.max(TOL, 0.02 * size)) && near(x.span[0], span[0]) && near(x.span[1], span[1]));
    if (!f) fams.push(f = { kind, r, lean, size, span, items: [] });
    f.items.push({ item, theta });
  };
  for (const o of flat) {
    const dp = (o.box[p] + o.box[p + 3]) / 2 - c[0], dq = (o.box[q] + o.box[q + 3]) / 2 - c[1], r = Math.hypot(dp, dq); if (r < TOL) continue;
    const theta = Math.atan2(dq, dp);
    add(o, 'flat', r, halfTurnOf(Math.atan2(o.normal[q], o.normal[p]) - theta), o.area, [o.box[a], o.box[a + 3]], theta);
  }
  for (const k of arcs) {
    const dp = k.point[p] - c[0], dq = k.point[q] - c[1], r = Math.hypot(dp, dq); if (r < TOL) continue;
    add(k, 'arc', r, 0, k.r + k.sweep, [k.box[a], k.box[a + 3]], Math.atan2(dq, dp));
  }
  // the two flanks of a tooth look alike and are turned copies of themselves, not of each other: a family whose steps alternate is two
  const stepOf = f => polarStep(f.items.map(i => i.theta));
  const parted = fams.flatMap(f => { if (f.kind !== 'arc' || stepOf(f)) return [f]; const t = [...f.items].sort((x, y) => x.theta - y.theta); return [0, 1].map(k => ({ ...f, items: t.filter((_, i) => i % 2 === k) })); });
  return parted.filter(f => f.items.length >= 3 && (f.step = stepOf(f)));
}
// The teeth of a gear, the arms of a star: one of them says them all and the count is on the sheet to see. What is left to place is one of each kind of face,
// next to each other, the one nearest to a direction of the sheet so its dimensions run along it. Sizes of arcs still count them all.
export function findPolar(s) {
  const flatAll = s.slanted ?? [], roundAll = s.rounds ?? [], none = { slanted: flatAll, planes: s.planes ?? [], echo: new Set(), repeats: [] };
  let best = null;
  for (const a of [0, 1, 2]) {
    const [p, q] = othersOf(a), flat = flatAll.filter(o => !o.chamfer && Math.abs(o.normal[a]) < 1e-3), arcs = roundAll.filter(c => alignedAxis(c.axis) === a && c.sweep < FULL_TURN);
    if (flat.length + arcs.length < 3) continue;
    const mids = [...flat.map(o => [(o.box[p] + o.box[p + 3]) / 2, (o.box[q] + o.box[q + 3]) / 2]), ...arcs.map(k => [k.point[p], k.point[q]])];
    const centres = [...roundAll.filter(c => alignedAxis(c.axis) === a).sort((x, y) => y.r - x.r).map(c => [c.point[p], c.point[q]]), [mids.reduce((n, m) => n + m[0], 0) / mids.length, mids.reduce((n, m) => n + m[1], 0) / mids.length]];
    const tried = [];
    for (const c of centres) {
      if (tried.some(t => near(t[0], c[0]) && near(t[1], c[1])) || tried.length >= 8) continue; tried.push(c);
      const fams = familiesAround(flat, arcs, a, c), n = fams.reduce((m, f) => m + f.items.length, 0);
      if (fams.length && (!best || n > best.n)) best = { a, c, fams, n };
    }
  }
  if (!best) return none;
  const { a, c, fams } = best, [p, q] = othersOf(a);
  // the direction of the sheet nearest to something of every family: what is nearest to it, family by family, is one and the same tooth
  const away = (t, d) => Math.abs(wrap(t - d));
  const nearestTo = (f, d) => [...f.items].sort((x, y) => away(x.theta, d) - away(y.theta, d))[0];
  const dir = [Math.PI / 2, 0, -Math.PI / 2, Math.PI].map(d => ({ d, off: +fams.reduce((n, f) => n + away(nearestTo(f, d).theta, d), 0).toFixed(3) })).sort((x, y) => x.off - y.off)[0].d;
  const echoFlat = new Set(), echo = new Set(), reps = new Map();
  for (const f of fams) {
    const rep = nearestTo(f, dir).item;
    reps.set(rep, f.items.length);
    for (const { item } of f.items) if (item !== rep) (f.kind === 'flat' ? echoFlat : echo).add(item);
  }
  // those of a family that happen to lie along an axis of the part are planes in the list of planes: the same distance, the same size, and a direction the steps reach
  const planes = (s.planes ?? []).filter(pl => {
    if (pl.axis === a) return true;
    const k = pl.axis === p ? 0 : 1, normalAt = k === 0 ? 0 : Math.PI / 2;
    return !fams.some(f => f.kind === 'flat' && f.items.some(({ item }) => {
      const n = [item.normal[p], item.normal[q]], h = ((item.box[p] + item.box[p + 3]) / 2 - c[0]) * n[0] + ((item.box[q] + item.box[q + 3]) / 2 - c[1]) * n[1];
      const times = pl.area / item.area, phi = Math.atan2(n[1], n[0]);
      return near(Math.abs(pl.pos - c[k]), Math.abs(h)) && times > 0.9 && times < 4.2 && nearWhole(times, 0.1) && (nearWhole((normalAt - phi) / f.step) || nearWhole((normalAt + Math.PI - phi) / f.step));
    }));
  });
  const count = Math.max(...fams.map(f => f.items.length));
  return { slanted: flatAll.filter(o => !echoFlat.has(o)).map(o => reps.has(o) ? { ...o, repeats: reps.get(o) } : o), planes, echo, repeats: [{ axis: a, center: { [p]: c[0], [q]: c[1] }, count, kinds: fams.length }] };
}

// An arc that touches two things already placed needs only its radius: with it the two contacts put its centre. One that touches one needs one coordinate, the one the
// contact says least about. A fillet says nothing about what it joins, so it does not count; two contacts on one line (the end of a slot) only say how wide it is
function tangency(s) {
  const rounds = s.rounds ?? [], arcs = rounds.filter(c => alignedAxis(c.axis) >= 0 && c.sweep < FULL_TURN && !c.blend), touches = new Map();
  const inBox = (b, p, q, x, y) => x >= b[p] - 2 * TOL && x <= b[p + 3] + 2 * TOL && y >= b[q] - 2 * TOL && y <= b[q + 3] + 2 * TOL;
  for (const c of arcs) {
    const a = alignedAxis(c.axis), [p, q] = othersOf(a), cx = c.point[p], cy = c.point[q], row = [];
    const add = (x, y, by) => { if (inBox(c.box, p, q, x, y)) row.push({ n: [(x - cx) / c.r, (y - cy) / c.r], by }); };
    for (const pl of s.planes ?? []) {
      if (pl.axis === p && near(Math.abs(cx - pl.pos), c.r)) add(pl.pos, cy, null);
      if (pl.axis === q && near(Math.abs(cy - pl.pos), c.r)) add(cx, pl.pos, null);
    }
    for (const o of s.slanted ?? []) {
      if (Math.abs(o.normal[a]) > 1e-3) continue;
      const len = Math.hypot(o.normal[p], o.normal[q]), nx = o.normal[p] / len, ny = o.normal[q] / len;
      const dist = (cx - (o.box[p] + o.box[p + 3]) / 2) * nx + (cy - (o.box[q] + o.box[q + 3]) / 2) * ny, x = cx - nx * dist, y = cy - ny * dist;
      if (near(Math.abs(dist), c.r) && inBox(o.box, p, q, x, y)) add(x, y, null);
    }
    for (const k of rounds) {
      if (k === c || k.blend || alignedAxis(k.axis) !== a || k.box[a + 3] < c.box[a] - TOL || k.box[a] > c.box[a + 3] + TOL) continue;
      const dx = k.point[p] - cx, dy = k.point[q] - cy, d = Math.hypot(dx, dy); if (d < TOL) continue;
      const outside = near(d, c.r + k.r); if (!outside && !near(d, Math.abs(c.r - k.r))) continue;
      const sign = outside || c.r > k.r ? 1 : -1, x = cx + sign * dx / d * c.r, y = cy + sign * dy / d * c.r;
      if (inBox(k.box, p, q, x, y)) add(x, y, k);
    }
    touches.set(c, row);
  }
  // v3.17 a slot whose sides open a little (the tapered slot of a connecting rod) is still a slot: its ends are said by their centres and radii, as drafted, and its sides follow
  const SLOT_SIDES = 0.3, crossing = list => list.some((t, i) => list.some((u, j) => j > i && Math.abs(t.n[0] * u.n[1] - t.n[1] * u.n[0]) > SLOT_SIDES));
  // what is placed by itself: whole circles, and an arc around one of them has its centre said
  const placed = new Set(rounds.filter(k => k.sweep >= FULL_TURN)), around = c => { const a = alignedAxis(c.axis); return rounds.some(k => k !== c && k.sweep >= FULL_TURN && alignedAxis(k.axis) === a && othersOf(a).every(o => near(k.point[o], c.point[o]))); };
  const open = new Set(), derived = new Set(), one = new Map();
  for (const c of arcs) if (around(c)) placed.add(c); else open.add(c);
  while (open.size) {
    const real = c => touches.get(c).filter(t => !t.by || placed.has(t.by)), next = [...open].find(c => crossing(real(c)));
    if (next) { derived.add(next); placed.add(next); open.delete(next); continue; }
    // nothing follows: the largest is said, as little as it needs, and the search goes on
    const big = [...open].sort((x, y) => y.r - x.r)[0], t = real(big)[0];
    if (t) { const [p, q] = othersOf(alignedAxis(big.axis)); one.set(big, Math.abs(t.n[0]) < Math.abs(t.n[1]) ? p : q); }
    placed.add(big); open.delete(big);
  }
  return { derived, one };
}

export function partGeometry(s) {
  const axes = [0, 1, 2].map(i => ({ i, nodes: [], rims: [], ties: [], spans: [] })), review = [], needs = new Map();
  const at = (i, u) => axes[i].nodes.find(n => near(n.u, u));
  const put = (i, u, round) => { let n = at(i, u); if (!n) axes[i].nodes.push(n = { u, area: 0, round: new Set() }); if (round !== undefined) n.round.add(round); return n; };
  const needSize = (cls, value, axis, halfTurn, times = 1) => { const k = cls + VAL(value); let n = needs.get(k); if (!n) needs.set(k, n = { cls, value, count: 0, axes: new Set(), half_turn: false }); n.count += times; if (axis >= 0) n.axes.add(axis); if (halfTurn) n.half_turn = true; };
  const polar = findPolar(s), touch = tangency(s);
  for (const p of polar.planes) put(p.axis, p.pos).area += p.area;
  for (const g of polar.repeats) for (const o of othersOf(g.axis)) put(o, g.center[o], 'giro');
  const rounds = s.rounds ?? [], fulls = rounds.filter(c => c.sweep >= FULL_TURN), parts = rounds.filter(c => c.sweep < FULL_TURN).sort((a, b) => b.r - a.r);
  for (const c of rounds) { const a = alignedAxis(c.axis); if (a >= 0) for (const [lo, hi] of c.spans ?? []) axes[a].spans.push({ lo, hi, label: (c.sweep >= FULL_TURN ? 'Ø' : 'R') + VAL(c.r) }); }
  const middle = a => { const u = (a >= 0 ? axes[a].nodes : []).map(n => n.u); return u.length ? (Math.min(...u) + Math.max(...u)) / 2 : 0; };
  for (const c of fulls) {
    const a = alignedAxis(c.axis); needSize('D', c.r * 2, a, false, stretches(c, middle(a)));
    if (a < 0) { review.push('cilindro inclinado Ø' + VAL(c.r * 2) + ': su posición no se comprueba'); continue; }
    for (const o of othersOf(a)) { put(o, c.point[o], VAL(c.r * 2)); axes[o].rims.push({ u: c.point[o] - c.r, center: c.point[o], r: c.r }, { u: c.point[o] + c.r, center: c.point[o], r: c.r }); }
  }
  for (const c of parts) {
    const a = alignedAxis(c.axis); needSize('R', c.r, a, near(c.sweep, HALF_TURN, 0.05), stretches(c, middle(a)));
    if (a < 0) { if (!c.blend) review.push('arco inclinado R' + VAL(c.r) + ': su posición no se comprueba'); continue; }
    if (polar.echo.has(c)) continue;
    const os = othersOf(a);
    for (const o of os) {
      if (near(c.box[o], c.point[o] - c.r)) axes[o].rims.push({ u: c.point[o] - c.r, center: c.point[o], r: c.r });
      if (near(c.box[o + 3], c.point[o] + c.r)) axes[o].rims.push({ u: c.point[o] + c.r, center: c.point[o], r: c.r });
    }
    // a fillet is its radius and the two faces it joins, and so is an arc that touches two things
    if (c.blend || touch.derived.has(c)) continue;
    // an arc with its ends known comes with its radius, its centre may even be out of the part
    const ends = o => (at(o, c.box[o]) ? 1 : 0) + (at(o, c.box[o + 3]) ? 1 : 0), [p, q] = os;
    if ((ends(p) === 2 && ends(q) >= 1) || (ends(q) === 2 && ends(p) >= 1)) continue;
    const said = touch.one.get(c);
    for (const o of os) {
      if (ends(o) === 2 || (said !== undefined && o !== said && !at(o, c.point[o]))) continue;
      put(o, c.point[o], 'R' + VAL(c.r));
      // tangent to a plane: the radius says how far the centre is
      for (const u of [c.point[o] - c.r, c.point[o] + c.r]) if (axes[o].rims.some(x => near(x.u, u) && near(x.center, c.point[o])) && at(o, u)) axes[o].ties.push([c.point[o], u]);
    }
  }
  const rings = findRings(rounds);
  for (const g of rings) {
    for (const o of othersOf(g.axis)) { put(o, g.center[o], 'anillo'); for (const h of g.holes) axes[o].ties.push([g.center[o], h.point[o]]); }
    const around = fulls.filter(c => alignedAxis(c.axis) === g.axis && c.r > g.radius && othersOf(g.axis).every(o => near(c.point[o], g.center[o]))).sort((a, b) => a.r - b.r)[0];
    g.contour = around?.r ?? null;
  }
  for (const c of s.spheres ?? []) { needSize('R', c.r, -1); if (!c.blend) for (const o of [0, 1, 2]) put(o, c.center[o], 'R' + VAL(c.r)); }
  for (const c of s.tori ?? []) {
    needSize('R', c.minor, alignedAxis(c.axis));
    if (c.blend) continue;
    const a = alignedAxis(c.axis); if (a < 0) { review.push('toro inclinado R' + VAL(c.minor) + ': no se comprueba'); continue; }
    put(a, c.center[a], 'R' + VAL(c.minor)); needSize('D', c.major * 2, a);
  }
  const hardFree = (s.free ?? []).filter(f => !f.blend), softFree = (s.free ?? []).filter(f => f.blend);
  if (hardFree.length) {
    review.push(hardFree.length + ' caras curvas libres: su forma no se comprueba');
    // their shape cannot be followed, how far they reach can, unless that is the edge of a round already placed
    for (const A of axes) for (const [u, side] of [[Math.min(...hardFree.map(f => f.box[A.i])), -1], [Math.max(...hardFree.map(f => f.box[A.i + 3])), 1]]) if ((!A.nodes.length || A.nodes.every(n => side * (u - n.u) > TOL)) && !A.rims.some(r => near(r.u, u) && at(A.i, r.center))) put(A.i, u);
  }
  if (softFree.length) review.push(softFree.length + ' redondeos de radio variable: su radio no se comprueba');
  return { axes, needs, review, rings, at, put, slanted: polar.slanted, repeats: polar.repeats, cones: s.cones ?? [], fulls, rounds, tangent: touch.derived, free: hardFree };
}

// the model axis and the two model coordinates a linear dimension measures, in the view where it is; null if the view is turned
function readFeet(d, view) {
  if (!d.lin || !view?.axes || !view.origin_mm || !view.scale) return null;
  const k = d.mode === 'h' ? 0 : d.mode === 'v' ? 1 : -1; if (k < 0) return null;
  const axis = view.axes.findIndex(a => Math.abs(a[k]) > 0.99); if (axis < 0) return null;
  const to = u => (u - view.origin_mm[k]) / (view.scale * view.axes[axis][k]), p0 = to(d.lin.u0), p1 = to(d.lin.u1);
  return { axis, p0: Math.min(p0, p1), p1: Math.max(p0, p1), tol: Math.max(TOL, 0.0015 / view.scale), scale: view.scale };
}

// one axis: the points are joined by what is given, then by the dimensions there are, shortest first; what stays apart is what is missing
function solveAxis(A, cands, chosen, missing, stats, stray, blockedPair) {
  const N = [...A.nodes].sort((p, q) => p.u - q.u), blocked = (p, q) => blockedPair(A.i, p.u, q.u);
  if (N.length < 2) { stats.push({ axis: AX[A.i], points: N.length, dimensions: 0, missing: 0 }); return; }
  // a part inside one round (a wheel with a keyway, even with the centre of a flank beyond it): its size is the diameter of that round, and the rest is said from its centre
  const solid = [...N.filter(n => n.area).map(n => n.u), ...A.rims.map(r => r.u)], outLo = Math.min(...solid), outHi = Math.max(...solid);
  const whole = A.rims.find(x => near(x.u, outLo) && A.rims.some(y => near(y.u, outHi) && near(x.center, y.center) && near(x.r, y.r)));
  const hub = whole ? N.find(n => near(n.u, whole.center)) : null;
  const lo = hub ?? N[0], hi = hub ?? N[N.length - 1], midU = (lo.u + hi.u) / 2, realMid = N.find(n => near(n.u, midU)), mid = { u: midU, virtual: true, area: 0, round: new Set() };
  const parent = new Map([...N, mid].map(n => [n, n]));
  const find = n => { while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n))); n = parent.get(n); } return n; };
  const join = (a, b) => { const x = find(a), y = find(b); if (x === y) return false; parent.set(x, y); return true; };
  const at = (u, t = TOL) => N.find(n => near(n.u, u, t));
  for (const [u, v] of A.ties) { const a = at(u), b = at(v); if (a && b) join(a, b); }
  const endsTied = find(lo) === find(hi), tiedTo = new Map(N.map(n => [n, find(n)]));
  // the end of a ring is one of its holes; what is said goes to its centre
  const head = e => N.find(n => tiedTo.get(n) === tiedTo.get(e) && n.round.has('anillo')) ?? e, hl = head(lo), hh = head(hi);
  // no view can show the total (to the centre of a ring when it ends in one): it has to come out of the chain, every gap counts and nothing can be taken from the middle
  const noTotal = blocked(lo, hi) || blocked(hl, hh);
  // twins on both sides of the middle come together
  const mirror = new Map();
  if (!noTotal) for (const n of N) { const m = at(2 * midU - n.u); if (m && m !== n && ((n === lo || n === hi) || similar(n, m))) { mirror.set(n, m); join(n, m); } }
  // equal gaps between equal things: one dimension says them all
  const holds = (p, q) => [...new Set(A.spans.filter(s => s.lo <= p.u + TOL && s.hi >= q.u - TOL).map(s => s.label))].sort().join();
  const gaps = N.slice(0, -1).map((n, i) => [n, N[i + 1]]), classes = [];
  // and so are equal stretches of one round: a groove with a face of the inside across it is still one of the grooves
  for (const s of A.spans) { const p = at(s.lo), q = at(s.hi); if (p && q && p !== q && !gaps.some(([a, b]) => a === p && b === q)) gaps.push([p, q]); }
  for (const g of gaps) {
    const v = g[1].u - g[0].u, inG = holds(g[0], g[1]), same = c => { const h = c.rows[0], inH = holds(h[0], h[1]); if (!near(c.v, v, VTOL)) return false; if (inG || inH) return inG === inH; return (similar(g[0], h[0]) && similar(g[1], h[1])) || (similar(g[0], h[1]) && similar(g[1], h[0])); };
    const c = classes.find(same); if (c) c.rows.push(g); else classes.push({ v, rows: [g] });
  }
  const classOf = (a, b) => classes.find(c => c.rows.length > 1 && c.rows.some(([p, q]) => (p === a && q === b) || (p === b && q === a)));
  const isPair = (a, b) => a !== b && (mirror.get(a) === b || (a === lo && b === hi));
  // what a dimension between a and b adds. A pair says how far both are from the middle, a gap of a class says all of them
  const apply = (a, b) => {
    let changed = isPair(a, b) ? join(a, mid) : join(a, b);
    const c = classOf(a, b); if (c) for (const [p, q] of c.rows) changed = (isPair(p, q) ? join(p, mid) : join(p, q)) || changed;
    return changed;
  };
  const tipOf = (a, b) => (classOf(a, b) || (!isPair(a, b) && mirror.get(a) && mirror.get(b) && mirror.get(a) !== b)) ? ' TYP' : null;
  const nodeOf = (u, t) => {
    const direct = at(u, t); if (direct) return direct;
    const rim = A.rims.find(r => near(r.u, u, t)); if (rim) { const c = at(rim.center, t); if (c) return c; }
    return near(mid.u, u, t) ? mid : null;
  };
  const rows = cands.map(c => ({ ...c, a: nodeOf(c.f.p0, c.f.tol), b: nodeOf(c.f.p1, c.f.tol), rim: !at(c.f.p0, c.f.tol) || !at(c.f.p1, c.f.tol) }));
  let used = 0;
  // already kept for another reason (a chamfer, a separation of holes)
  for (const r of rows) if (r.kept && r.a && r.b && r.a !== r.b) { apply(r.a, r.b); const tip = tipOf(r.a, r.b); if (tip && !r.said) chosen(r.m, { suffix: tip }); }
  const overallDone = endsTied || rows.some(r => r.kept && r.a === lo && r.b === hi);
  const order = (p, q) => isRD(p.m) - isRD(q.m) || (p.rim ? 1 : 0) - (q.rim ? 1 : 0) || Math.abs(p.f.p1 - p.f.p0) - Math.abs(q.f.p1 - q.f.p0);
  const need = [], said = new Set(rows.filter(r => r.kept).map(r => VAL(r.m.value)));
  if (!overallDone) {
    // the total goes first, from the very ends if a dimension says so
    const inMiddle = n => n === mid || n === realMid;
    const group = r => r.a && r.b && r.a !== mid && r.b !== mid && ((tiedTo.get(r.a) === tiedTo.get(lo) && tiedTo.get(r.b) === tiedTo.get(hi)) || (tiedTo.get(r.a) === tiedTo.get(hi) && tiedTo.get(r.b) === tiedTo.get(lo)));
    const total = rows.filter(r => r.a === lo && r.b === hi).sort((p, q) => isRD(p.m) - isRD(q.m) || (q.rim ? 1 : 0) - (p.rim ? 1 : 0))[0] ?? rows.filter(r => (r.a === lo && inMiddle(r.b)) || (r.b === hi && inMiddle(r.a))).sort((p, q) => isRD(p.m) - isRD(q.m))[0] ?? rows.filter(group).sort((p, q) => isRD(p.m) - isRD(q.m))[0];
    if (total) { chosen(total.m, {}); used++; said.add(VAL(total.m.value)); join(lo, hi); } else if (!noTotal) { need.push({ pairs: [[hl.u, hh.u]], value: VAL(hh.u - hl.u), what: 'total' }); join(lo, hi); }
  }
  if (!noTotal) {
    join(lo, mid);
    // what is round and sits on the middle of the part
    if (realMid?.round.size) join(realMid, lo);
  }
  const adjacent = (a, b) => !N.some(n => n.u > Math.min(a.u, b.u) + TOL && n.u < Math.max(a.u, b.u) - TOL);
  // a step of a block is said by itself; what has no face of its own there (the corners of a tooth, of a trapezoid) by its width
  const widthIsNatural = n => !!hub || n.round.size > 0 || !n.area || !(adjacent(n, lo) || adjacent(n, hi));
  const bucket = r => isPair(r.a, r.b) && widthIsNatural(r.a) ? 0 : adjacent(r.a, r.b) ? 1 : 2;
  // from the middle of the part, where nothing can be seen to measure from: only if what it stands for cannot be drawn
  const fromNothing = r => { if (r.a !== mid && r.b !== mid) return false; const n = r.a === mid ? r.b : r.a, m = mirror.get(n); return !!m && !blocked(n, m); };
  for (const r of rows) if (r.a && r.b && !r.kept && fromNothing(r)) stray.add(r.m.name);
  // a corner with no face of its own a hair from a point that has one: two long dimensions side by side would say what their small step says (14 and 14.5: the 0.5).
  // Too small to read on paper it stays as it was, and so does one whose step cannot be drawn
  const onPaper = rows.find(r => r.f.scale)?.f.scale ?? 1, stepFits = (n, o) => { const g = Math.abs(n.u - o.u) * onPaper; return g >= STEP_ON_PAPER[0] && g <= STEP_ON_PAPER[1]; };
  const stepTo = n => { if (!n || n === mid || n.area || n.round.size || [lo, hi, hl, hh].includes(n)) return null; const i = N.indexOf(n); return [N[i - 1], N[i + 1]].filter(o => o && (o.area || o.round.size) && stepFits(n, o) && !blocked(n, o)).sort((p, q) => Math.abs(p.u - n.u) - Math.abs(q.u - n.u))[0] ?? null; };
  const saidByStep = r => { const x = stepTo(r.a), y = stepTo(r.b); return (!!x && x !== r.b) || (!!y && y !== r.a); };
  const usable = rows.filter(r => r.a && r.b && r.a !== r.b && !r.kept && !fromNothing(r) && !saidByStep(r)).sort((p, q) => bucket(p) - bucket(q) || order(p, q));
  for (const repeat of [false, true]) for (const r of usable) {
    if (!repeat && said.has(VAL(r.m.value))) continue;
    if (apply(r.a, r.b)) { const tip = tipOf(r.a, r.b); chosen(r.m, tip ? { suffix: tip } : {}); used++; said.add(VAL(r.m.value)); }
  }
  // a dimension whose feet could not be placed, when its value fits two points still apart
  for (const r of rows.filter(r => !(r.a && r.b) && !r.kept)) {
    const v = Math.abs(r.f.p1 - r.f.p0), hit = N.flatMap(a => N.filter(b => b.u > a.u && near(b.u - a.u, v, VTOL) && find(a) !== find(b)).map(b => [a, b]))[0];
    if (hit) { apply(hit[0], hit[1]); const tip = tipOf(hit[0], hit[1]); chosen(r.m, tip ? { suffix: tip } : {}); used++; } else stray.add(r.m.name);
  }
  // what stays apart: a dimension to make, nearest first. Holes in twos are said by their separation, the rest from the nearest point already known
  for (let guard = 0; guard < N.length * 2; guard++) {
    const main = find(lo), loose = N.filter(n => find(n) !== main); if (!loose.length) break;
    let options = [];
    for (const n of loose) {
      const m = mirror.get(n); if (m && widthIsNatural(n)) options.push({ a: n, b: m, rank: 0, gap: Math.abs(m.u - n.u) });
      for (const o of N) if (find(o) === main) options.push({ a: n, b: o, rank: stepTo(n) === o ? -1 : o === hub ? 0.5 : adjacent(n, o) ? 1 : 2, gap: Math.abs(o.u - n.u) });
    }
    options = options.filter(o => !blocked(o.a, o.b)).sort((p, q) => p.rank - q.rank || p.gap - q.gap);
    // nothing can be drawn to it: it is said, once, and the search goes on
    if (!options.length) { const n = loose[0]; need.push({ pairs: [], value: VAL(Math.abs(n.u - lo.u)), what: 'posición', unreachable: true }); join(n, lo); continue; }
    const best = options[0], tip = tipOf(best.a, best.b);
    need.push({ pairs: options.slice(0, 6).map(o => [o.a.u, o.b.u]), value: VAL(best.gap), what: best.rank === -1 ? 'escalón' : best.rank === 0 ? 'separación' : 'posición', ...(tip ? { suffix: tip } : {}) });
    apply(best.a, best.b);
  }
  for (const n of need) missing.push({ kind: 'L', axis: A.i, ...n });
  stats.push({ axis: AX[A.i], points: N.length, dimensions: used + rows.filter(r => r.kept && r.a && r.b && r.a !== r.b).length, missing: need.length });
}

// what still has to be said about where a slanted face ends. Its ends are two opposite corners of its box. Tangent to a round, an end needs nothing:
// the line leaves the round where it has to. On a round, one coordinate says the other. Elsewhere, both
function slantedEnds(o, i, j, geo, feet) {
  const k = 3 - i - j, ni = o.normal[i], nj = o.normal[j], lean = ni * nj > 0;
  const corners = lean ? [[o.box[i], o.box[j + 3]], [o.box[i + 3], o.box[j]]] : [[o.box[i], o.box[j]], [o.box[i + 3], o.box[j + 3]]];
  const said = (axis, u) => [...feet.values()].some(f => f.axis === axis && (near(Math.abs(f.p0), Math.abs(u), f.tol) || near(Math.abs(f.p1), Math.abs(u), f.tol)));
  // the edge of a round whose centre is placed is placed too: the taper that starts under the eye of a connecting rod needs no dimension of its own there
  const placed = (a, u) => !!geo.at(a, u) || geo.axes[a].rims.some(r => near(r.u, u) && geo.at(a, r.center));
  const unknown = [];
  for (const [u, v] of corners) {
    const known = [placed(i, u) ? 1 : 0, placed(j, v) ? 1 : 0], circle = geo.rounds.find(c => alignedAxis(c.axis) === k && near(Math.hypot(u - c.point[i], v - c.point[j]), c.r));
    if (known[0] && known[1]) continue;
    if (circle) {
      const radial = ((u - circle.point[i]) * ni + (v - circle.point[j]) * nj) / circle.r / Math.hypot(ni, nj);
      // tangent to an arc that takes its place from this very face says nothing about the face
      if (Math.abs(radial) > 0.999 && !circle.blend && !geo.tangent.has(circle)) continue;
      if (known[0] || known[1]) continue;
      // the coordinate a dimension already says, or else the smaller one
      const pick = said(i, u) === said(j, v) ? (Math.abs(u) <= Math.abs(v) ? 0 : 1) : said(i, u) ? 0 : 1;
      unknown.push(pick === 0 ? [i, u] : [j, v]);
      continue;
    }
    if (!known[0]) unknown.push([i, u]);
    if (!known[1]) unknown.push([j, v]);
  }
  return unknown;
}

// a corner a fillet rounded is the sharp corner it was drawn with: where the line of the face meets the plane the fillet runs into
function sharpBox(o, i, j, geo) {
  const k = 3 - i - j, ni = o.normal[i], nj = o.normal[j], box = [...o.box];
  for (const [ci, cj] of ni * nj > 0 ? [[i, j + 3], [i + 3, j]] : [[i, j], [i + 3, j + 3]]) {
    const u = o.box[ci], v = o.box[cj], c = geo.rounds.find(r => r.blend && alignedAxis(r.axis) === k && near(Math.hypot(u - r.point[i], v - r.point[j]), r.r));
    const wall = c && [i, j].flatMap(a => [-1, 1].map(s => [a, c.point[a] + s * c.r])).find(([a, w]) => geo.at(a, w) && geo.axes[a].rims.some(r => near(r.u, w) && near(r.center, c.point[a])));
    if (!wall) continue;
    const [a, w] = wall;
    [box[ci], box[cj]] = a === i ? [w, v - (w - u) * ni / nj] : [u - (w - v) * nj / ni, w];
  }
  return box;
}

// where the line of a slanted face meets a plane: the corner it had before its rounds, as it was drawn. A dimension with a foot there says where the face is
function sharpCorner(o, i, j, geo, feet, corners) {
  const mid = k => (o.box[k] + o.box[k + 3]) / 2;
  // a foot on something real (a plane, the edge of a circle) is there for that. The corner of its twin is the same corner
  const free = (a, p, t) => corners.has(a + '|' + VAL(p)) || !(geo.at(a, p) || geo.axes[a].rims.some(r => near(r.u, p, t)));
  for (const [a, b] of [[i, j], [j, i]]) for (const f of feet.values()) {
    if (f.axis !== a) continue;
    for (const p of [f.p0, f.p1]) { const q = mid(b) - (p - mid(a)) * o.normal[a] / o.normal[b]; if (free(a, p, f.tol) && geo.at(b, q)?.area) return { axis: a, u: p, other: b, v: q }; }
  }
  return null;
}

// what could not be drawn on the sheet: the next plan asks for something else
export const pairKey = (axis, u, v) => axis + '|' + VAL(Math.min(u, v)) + '|' + VAL(Math.max(u, v));
export const sizeKey = n => n.kind + '|' + n.value;
export function planNeeded(sizes, measures, views, opts = {}) {
  const geo = partGeometry(sizes), fixed = new Set(opts.fixed_names ?? []), callouts = opts.callouts ?? [], kept = new Map(), missing = [], stats = [], covered = [], stray = new Set();
  const cannot = opts.could_not_make ?? new Set(), blockedPair = (axis, u, v) => cannot.has(pairKey(axis, u, v));
  const keep = (m, extra = {}) => { const k = kept.get(m.name) ?? { ...m, same: 1 }; Object.assign(k, extra); kept.set(m.name, k); return k; };
  for (const m of measures) if (fixed.has(m.name)) keep(m);
  const feet = new Map();
  for (const m of measures) for (const d of m.dims) { const f = readFeet(d, views.get(d.view)); if (f) { feet.set(m.name, f); break; } }
  const shown = m => opts.shown?.get(m.name) ?? 0, byPref = list => [...list].sort((a, b) => (fixed.has(b.name) ? 1 : 0) - (fixed.has(a.name) ? 1 : 0) || shown(b) - shown(a) || isRD(a) - isRD(b));
  const has = (m, cls, v) => m.cls === cls && near(m.value, v, VTOL);
  const across = (m, r) => {
    const f = feet.get(m.name); if (!f || m.cls !== 'L' || !near(m.value, 2 * r, VTOL)) return false;
    const rims = geo.axes[f.axis].rims.filter(x => near(x.r, r, VTOL));
    return rims.some(x => near(x.u, f.p0, f.tol)) && rims.some(x => near(x.u, f.p1, f.tol));
  };
  // the slanted faces first: they may add points and sizes
  const angleOf = v => measures.find(m => m.cls === 'A' && v.some(x => near(m.value, x, 0.05)));
  const chamfers = new Map(), seenFrom = new Map(), derivedCorners = [], lostCorners = [];
  const addChamfer = (value, row) => { const k = VAL(value); if (!chamfers.has(k)) chamfers.set(k, { value, rows: [] }); chamfers.get(k).rows.push(row); };
  for (const o of geo.slanted) {
    const comps = o.normal.map((n, i) => [Math.abs(n), i]).filter(([n]) => n > 1e-4);
    if (comps.length !== 2) { geo.review.push('cara inclinada en dos direcciones: no se comprueba'); continue; }
    const [[ni, i], [nj, j]] = comps, f = { ...o, box: sharpBox(o, i, j, geo) }, ends = k => [f.box[k], f.box[k + 3]];
    // a line is two numbers, however many corners it has
    const unknown = slantedEnds(f, i, j, geo, feet).sort((p, q) => Math.abs(p[1]) - Math.abs(q[1])).slice(0, 2);
    if (!unknown.length) continue;
    const deg = Math.atan2(nj, ni) * 180 / Math.PI;
    // a chamfer at 45: one size for both sides
    if (unknown.length === 2 && unknown[0][0] !== unknown[1][0] && near(deg, 45, 0.1)) {
      const off = ([k, u]) => { const [a, b] = ends(k), hard = near(a, u) ? b : a; return { axis: k, soft: u, hard, value: Math.abs(u - hard) }; };
      const r0 = off(unknown[0]), r1 = off(unknown[1]);
      if (near(r0.value, r1.value)) { addChamfer(r0.value, { ...r0, repeats: o.repeats }); addChamfer(r0.value, { ...r1, repeats: o.repeats }); continue; }
    }
    // the two sides of something symmetric: the angle between them
    const twin = geo.slanted.some(q => q !== o && near(q.normal[i] * q.normal[j], -o.normal[i] * o.normal[j], 1e-3) && near(Math.abs(q.normal[i]), Math.abs(o.normal[i]), 1e-3));
    const ang = angleOf([deg, 90 - deg, 180 - deg, 90 + deg, ...(twin ? [2 * deg, 180 - 2 * deg] : [])]);
    if (ang) keep(ang);
    const rest = ang ? unknown.slice(0, -1) : unknown, corner = rest.length ? sharpCorner(f, i, j, geo, feet, seenFrom) : null;
    if (corner) { geo.put(corner.axis, corner.u); rest.pop(); seenFrom.set(corner.axis + '|' + VAL(corner.u), 3 - i - j); lostCorners.push({ ...corner, look: 3 - i - j }); }
    for (const [k, u] of rest) geo.put(k, u);
    // the corners the rest of the face already says
    for (const [k, u] of unknown) if (!geo.at(k, u)) derivedCorners.push([k, u]);
  }
  for (const c of geo.cones) {
    const a = alignedAxis(c.axis);
    if (a < 0) { geo.review.push('cono inclinado: no se comprueba'); continue; }
    for (const o of othersOf(a)) geo.put(o, c.ends[0].point[o], 'cono');
    const [e0, e1] = c.ends, L = Math.abs(e1.point[a] - e0.point[a]);
    // the tip of a drilled hole: the depth is where its straight part ends
    if (Math.min(e0.r, e1.r) < 0.01) { geo.put(a, (e0.r > e1.r ? e0 : e1).point[a]); continue; }
    const isKnownR = e => geo.fulls.some(f => alignedAxis(f.axis) === a && near(f.r, e.r));
    const unknownEnds = c.ends.filter(e => !geo.at(a, e.point[a]));
    if (unknownEnds.length === 1 && near(Math.abs(e0.r - e1.r), L, 0.05) && (isKnownR(e0) || isKnownR(e1))) {
      const soft = unknownEnds[0], hard = soft === e0 ? e1 : e0;
      addChamfer(L, { axis: a, soft: soft.point[a], hard: hard.point[a], value: L }); continue;
    }
    const ang = angleOf([c.half_angle_deg, 90 - c.half_angle_deg, 2 * c.half_angle_deg]);
    if (ang) keep(ang);
    let known = (isKnownR(e0) ? 1 : 0) + (isKnownR(e1) ? 1 : 0) + (unknownEnds.length ? 0 : 1) + (ang ? 1 : 0);
    if (known < 3 && unknownEnds.length) { for (const e of unknownEnds) geo.put(a, e.point[a]); known++; }
    for (const e of [...c.ends].sort((p, q) => p.r - q.r)) { if (known >= 3 || isKnownR(e)) continue; const k = 'D' + VAL(e.r * 2); if (!geo.needs.has(k)) geo.needs.set(k, { cls: 'D', value: e.r * 2, count: 1, axes: new Set([a]), half_turn: false }); known++; }
  }
  // chamfers: one dimension for each size of chamfer, "2 X 45° TYP"
  for (const ch of chamfers.values()) {
    for (const row of ch.rows) { geo.put(row.axis, row.soft); geo.put(row.axis, row.hard); geo.axes[row.axis].ties.push([row.soft, row.hard]); }
    const many = ch.rows.length > 2 || ch.rows.some(r => r.repeats > 1) ? ' TYP' : '';
    const dim = byPref(measures).find(m => has(m, 'C', ch.value)) ?? byPref(measures).find(m => m.cls === 'L' && near(m.value, ch.value, VTOL) && feet.has(m.name) && ch.rows.some(r => r.axis === feet.get(m.name).axis && ((near(feet.get(m.name).p0, r.soft) && near(feet.get(m.name).p1, r.hard)) || (near(feet.get(m.name).p1, r.soft) && near(feet.get(m.name).p0, r.hard)))));
    if (dim) keep(dim, dim.cls === 'C' ? (many ? { suffix: many } : {}) : { suffix: ' X 45°' + many });
    else {
      const pairs = ch.rows.filter(r => r.axis === ch.rows[0].axis).map(r => [r.hard, r.soft]).filter(([u, v]) => !blockedPair(ch.rows[0].axis, u, v));
      missing.push({ kind: 'L', axis: ch.rows[0].axis, pairs, value: VAL(ch.value), what: 'chaflán', suffix: ' X 45°' + many, ...(pairs.length ? {} : { unreachable: true }) });
    }
  }
  // the sizes of what is round
  for (const n of [...geo.needs.values()].sort((a, b) => b.value - a.value)) {
    const many = n.count > 1;
    if (n.cls === 'D') {
      if (callouts.some(v => near(v, n.value, VTOL))) { covered.push('Ø' + VAL(n.value) + ' (nota de barreno)'); continue; }
      const dim = byPref(measures).find(m => has(m, 'D', n.value)) ?? (geo.needs.has('R' + VAL(n.value / 2)) ? null : byPref(measures).find(m => has(m, 'R', n.value / 2)));
      if (dim) { keep(dim, many && dim.cls === 'D' ? { prefix: n.count + ' X <MOD-DIAM>' } : {}); continue; }
      const flat = byPref(measures).find(m => across(m, n.value / 2));
      if (flat) { keep(flat, { prefix: (many ? n.count + ' X ' : '') + '<MOD-DIAM>' }); continue; }
      missing.push({ kind: 'D', value: VAL(n.value), count: n.count, axes: [...n.axes], ...(many ? { prefix: n.count + ' X <MOD-DIAM>' } : {}), ...(cannot.has('D|' + VAL(n.value)) ? { unreachable: true } : {}) });
    } else {
      const text = !many ? {} : n.count <= 4 ? { prefix: n.count + ' X R' } : { suffix: ' TYP' };
      const dim = byPref(measures).find(m => has(m, 'R', n.value)) ?? (geo.needs.has('D' + VAL(n.value * 2)) ? null : byPref(measures).find(m => has(m, 'D', n.value * 2)));
      if (dim) { keep(dim, dim.cls === 'R' ? text : {}); continue; }
      // the two sides of a slot: its width says its radius
      const flat = n.half_turn ? byPref(measures).find(m => across(m, n.value)) : null;
      if (flat) { keep(flat, many ? { suffix: ' TYP' } : {}); continue; }
      missing.push({ kind: 'R', value: VAL(n.value), count: n.count, axes: [...n.axes], ...text, ...(cannot.has('R|' + VAL(n.value)) ? { unreachable: true } : {}) });
    }
  }
  // holes around a circle: their separation and, with a round contour around them, their distance to it. Without one the separation and the count say
  // the circle, unless a place of it is empty (six holes of seven): then so does its radius
  for (const g of geo.rings) {
    const radial = [g.radius, g.radius * 2, ...(g.contour ? [g.contour - g.radius] : [])];
    const cand = (v, not) => byPref(measures).find(m => m !== not && (m.cls === 'L' || m.cls === 'X' || m.cls === 'D') && v.some(x => near(m.value, x, 0.05)) && !(m.cls === 'D' && geo.needs.has('D' + VAL(m.value))));
    // six holes: the separation measures the same as the radius, it cannot say both
    const pitch = cand([g.pitch]) ?? byPref(measures).find(m => m.cls === 'A' && near(m.value, g.step * 180 / Math.PI, 0.05)), rad = cand(radial, pitch);
    let pitchSaid = !!pitch;
    if (pitch) keep(pitch);
    else {
      // two neighbours level with each other: a straight dimension says it
      const level = othersOf(g.axis).flatMap(o => g.holes.flatMap(h => g.holes.filter(j => h.point[o] < j.point[o] && near(h.point[3 - g.axis - o], j.point[3 - g.axis - o]) && near(j.point[o] - h.point[o], g.pitch, VTOL)).map(j => ({ axis: o, pair: [h.point[o], j.point[o]] })))).filter(x => !blockedPair(x.axis, ...x.pair));
      if (level.length) { missing.push({ kind: 'L', axis: level[0].axis, pairs: level.filter(x => x.axis === level[0].axis).map(x => x.pair), value: VAL(g.pitch), what: 'separación entre barrenos' }); pitchSaid = true; }
      else missing.push({ kind: 'ring', what: 'separación entre barrenos', value: VAL(g.pitch), diameter: VAL(g.r * 2), axis: g.axis, unreachable: true });
    }
    if (pitchSaid && !g.contour && Math.round(TURN / g.step) === g.count) continue;
    if (rad) keep(rad); else missing.push({ kind: 'ring', what: g.contour ? 'contorno a barreno' : 'radio del círculo de barrenos', value: VAL(g.contour ? g.contour - g.radius : g.radius), diameter: VAL(g.r * 2), axis: g.axis, unreachable: true });
  }
  // the points of each axis
  for (const A of geo.axes) {
    const cands = measures.filter(m => m.cls === 'L' && feet.get(m.name)?.axis === A.i).map(m => ({ m, f: feet.get(m.name), kept: kept.has(m.name), said: kept.get(m.name)?.suffix }));
    const before = stats.length; solveAxis(A, cands, (m, extra) => keep(m, extra), missing, stats, stray, blockedPair); if (stats.length === before) stats.push({ axis: AX[A.i], points: 0, dimensions: 0, missing: 0 });
  }
  // a foot on a corner that is no longer there only reads where the face is seen as a line
  for (const k of kept.values()) { const f = feet.get(k.name), look = f ? [f.p0, f.p1].map(p => seenFrom.get(f.axis + '|' + VAL(p))).find(x => x !== undefined) : undefined; if (look !== undefined) k.look = look; }
  // the geometry that could not be followed may hang from dimensions this cannot read: they stay, and the report says it was not checked. So does one that lands on no face and has both feet where the free faces are
  const unchecked = [], reachesFree = f => [f.p0, f.p1].every(u => geo.free.some(b => u >= b.box[f.axis] - f.tol && u <= b.box[f.axis + 3] + f.tol));
  // the radius or the diameter of a circle of holes is not something that hangs from those faces: the circle is already said
  const ofRing = m => m.cls !== 'A' && geo.rings.some(g => near(m.value, g.radius, 0.05) || near(m.value, 2 * g.radius, 0.05));
  // nor is a length across the middle of a round where its circle is seen edge-on: it is that diameter again
  const diameterAgain = m => { const f = m.cls === 'L' && feet.get(m.name); return !!f && !!geo.at(f.axis, (f.p0 + f.p1) / 2)?.round.size && [...kept.values()].some(k => k.cls === 'D' && near(k.value, m.value, VTOL)); };
  if (geo.review.length) for (const m of measures) if (!kept.has(m.name) && (m.cls === 'A' || m.cls === 'X' || (m.cls === 'L' && (!feet.has(m.name) || (stray.has(m.name) && reachesFree(feet.get(m.name))))))) { if ([...kept.values()].some(k => k.cls === m.cls && VAL(k.value) === VAL(m.value)) || ofRing(m) || diameterAgain(m)) continue; keep(m); unchecked.push(m.name); }
  // of those, a length and a 45° that are all one feature has are its chamfer (on a curved edge its face is no cone): one dimension, "1 X 45°"
  const featureOf = m => /\.Drawing$/i.test(m.name) ? null : m.name.split('@')[1], chamfered = new Set();
  for (const a of unchecked.map(n => kept.get(n)).filter(k => k.cls === 'A' && near(k.value, 45, 0.01) && featureOf(k))) {
    const mates = measures.filter(m => featureOf(m) === featureOf(a)), l = mates.length === 2 ? kept.get(mates.find(m => m.name !== a.name).name) : null;
    if (!l || l.cls !== 'L' || l.suffix || !unchecked.includes(l.name)) continue;
    l.suffix = ' X 45°'; kept.delete(a.name); chamfered.add(a.name);
  }
  const dropped = measures.filter(m => !kept.has(m.name)).map(m => ({ dimension: m.name, value: m.value, why: chamfered.has(m.name) ? 'el 45° va en la cota del chaflán (X 45°)' : diameterAgain(m) ? 'ese diámetro ya está dicho' : whyGone(m, kept, feet, stray, derivedCorners) }));
  // the corners with no edge to hang from: what asks for one can draw it
  for (const n of missing) { const c = n.kind === 'L' ? lostCorners.filter(x => x.axis === n.axis) : []; if (c.length) n.corners = c; }
  const missingText = missing.map(describeMissing);
  const report = {
    sufficient: missing.length ? false : geo.review.length ? null : true,
    axes: stats.map(({ axis, points, dimensions, missing }) => ({ axis, points, dimensions, missing })),
    sizes: [...geo.needs.values()].map(n => (n.cls === 'D' ? 'Ø' : 'R') + VAL(n.value) + (n.count > 1 ? ' x' + n.count : '')),
    ...(covered.length ? { in_hole_notes: covered } : {}),
    ...(geo.rings.length ? { rings: geo.rings.map(g => g.count + ' barrenos Ø' + VAL(g.r * 2) + ' en círculo de radio ' + VAL(g.radius)) } : {}),
    ...(geo.repeats.length ? { repeated_around: geo.repeats.map(g => g.count + ' veces alrededor de ' + AX[g.axis] + ': se acota una') } : {}),
    kept: kept.size, too_many: dropped.length, missing: missingText,
    ...(geo.review.length ? { not_checked: [...new Set(geo.review)] } : {}),
  };
  report.summary = sayIt(report);
  return { kept: [...kept.values()], dropped, missing, reference_not_found: [], report };
}
function whyGone(m, kept, feet, stray, derivedCorners) {
  if (m.cls === 'D' || m.cls === 'R' || m.cls === 'C') return [...kept.values()].some(k => k.cls === m.cls && VAL(k.value) === VAL(m.value)) ? 'ese tamaño ya está dicho' : 'ese tamaño no aparece en la pieza';
  if (m.cls === 'A') return 'el ángulo sale de las cotas lineales';
  const f = feet.get(m.name);
  if (stray.has(m.name) && f && derivedCorners.some(([k, u]) => k === f.axis && (near(u, f.p0, f.tol) || near(u, f.p1, f.tol)))) return 'esa esquina de la cara inclinada ya sale de las otras cotas de la cara';
  if (stray.has(m.name)) return 'no mide nada de la pieza: no cae en una cara ni en un centro';
  if (m.cls === 'L' && feet.has(m.name)) return 'esa distancia ya sale de las otras cotas';
  return 'no se pudo ubicar en la pieza (vista girada o cota inclinada)';
}
function describeMissing(n) {
  if (n.unreachable) return describeMissing({ ...n, unreachable: false }) + ' (no se pudo acotar en ninguna vista)';
  if (n.kind === 'L') return AX[n.axis] + ': ' + n.what + ' ' + n.value;
  if (n.kind === 'ring') return n.what + ' ' + n.value + ' de los barrenos Ø' + n.diameter;
  return (n.kind === 'D' ? 'Ø' : 'R') + n.value + (n.count > 1 ? ' (' + n.count + ' veces)' : '');
}
function sayIt(r) {
  const axes = r.axes.filter(a => a.points > 1).map(a => a.axis + ' ' + a.points + ' puntos').join(', ');
  if (r.sufficient === false) return 'Faltan cotas para hacer la pieza: ' + r.missing.join('; ') + '.';
  if (r.sufficient === null) return 'Lo que se puede comprobar está completo (' + axes + '), pero falta revisar a ojo: ' + r.not_checked.join('; ') + '.';
  return 'Con estas cotas se puede hacer la pieza: ' + r.kept + ' cotas (' + axes + ').' + (r.too_many ? ' Sobran ' + r.too_many + '.' : '');
}

// which edges of a view can carry a dimension that is missing, best first. Edges come from drawing_dimension probe
export function dimensionsFromEdges(need, view, edges, around = []) {
  const look = (view.axes ?? []).findIndex(a => Math.abs(a[2]) > 0.99), out = [];
  const seenRound = e => look >= 0 && e.normal_model && Math.abs(e.normal_model[look]) > 0.99;
  if (need.kind === 'D' || need.kind === 'R') {
    if (need.axes?.length && !need.axes.includes(look)) return out;
    const wanted = need.kind === 'D' ? need.value : need.value * 2;
    const hit = edges.filter(e => (e.kind === 'circle' || e.kind === 'arc') && seenRound(e) && near(e.diameter_mm, wanted, VTOL)).sort((a, b) => (b.kind === (need.kind === 'D' ? 'circle' : 'arc')) - (a.kind === (need.kind === 'D' ? 'circle' : 'arc')));
    if (hit[0]) out.push({ edges: [hit[0].index], type: need.kind === 'D' ? 'diameter' : 'radius', expected: need.value });
    return out;
  }
  if (need.kind !== 'L') return out;
  const a = need.axis, k = Math.abs(view.axes?.[a]?.[0] ?? 0) > 0.99 ? 0 : Math.abs(view.axes?.[a]?.[1] ?? 0) > 0.99 ? 1 : -1;
  if (k < 0) return out;
  const type = k === 0 ? 'horizontal' : 'vertical';
  const on = u => {
    const row = [];
    for (const e of edges) {
      if (e.kind === 'line' && e.start_model_mm && e.end_model_mm && near(e.start_model_mm[a], u) && near(e.end_model_mm[a], u) && e.start_sheet_mm && e.end_sheet_mm && Math.hypot(e.start_sheet_mm[0] - e.end_sheet_mm[0], e.start_sheet_mm[1] - e.end_sheet_mm[1]) > 0.05) row.push({ e, rank: 0, size: e.length_mm });
      else if ((e.kind === 'circle' || e.kind === 'arc') && e.center_model_mm && seenRound(e) && near(e.center_model_mm[a], u)) row.push({ e, rank: 1, size: e.diameter_mm });
      // the end of a cylinder: from the side its circle is the line of that plane
      else if ((e.kind === 'circle' || e.kind === 'arc') && e.center_model_mm && e.normal_model && Math.abs(e.normal_model[a]) > 0.99 && near(e.center_model_mm[a], u)) row.push({ e, rank: 2, size: e.diameter_mm });
      // the corner where a slanted edge ends
      else if (e.start_model_mm && near(e.start_model_mm[a], u)) row.push({ e, rank: 3, size: e.length_mm ?? 0, end: 'start' });
      else if (e.end_model_mm && near(e.end_model_mm[a], u)) row.push({ e, rank: 3, size: e.length_mm ?? 0, end: 'end' });
    }
    if (!row.length) return lostCorner(u);
    row.sort((p, q) => p.rank - q.rank || (q.e.kind === 'circle') - (p.e.kind === 'circle') || q.size - p.size);
    return row.filter(x => x.rank === row[0].rank && x.e.kind === row[0].e.kind && near(x.size ?? 0, row[0].size ?? 0));
  };
  // a corner a round took away has no edge: where the face is seen as a line, that line goes on from the end of its edge to where the corner was.
  // On a symmetric part the same face on the other side has the same corner
  const lostCorner = u => (need.corners ?? []).filter(c => c.look === look && near(c.u, u)).flatMap(c => {
    const lines = edges.filter(e => e.kind === 'line' && e.start_model_mm && e.end_model_mm), run = (e, k) => e.end_model_mm[k] - e.start_model_mm[k];
    const past = lines.map(e => {
      const sx = e.start_model_mm[c.axis], sy = e.start_model_mm[c.other], dx = run(e, c.axis), dy = run(e, c.other), L = Math.hypot(dx, dy); if (L < 0.1) return null;
      const t = ((c.u - sx) * dx + (c.v - sy) * dy) / L, off = Math.abs((c.u - sx) * dy - (c.v - sy) * dx) / L;
      return off > 0.03 || (t >= -TOL && t <= L + TOL) ? null : { e, at: t < 0 ? 'start' : 'end', length: t < 0 ? -t : t - L };
    }).filter(Boolean).sort((p, q) => p.length - q.length)[0];
    if (!past) return [];
    const endAt = (e, at) => (at === 'start' ? e.start_model_mm : e.end_model_mm)[c.axis], twins = lines.filter(e => e !== past.e && near(Math.abs(run(e, c.axis)), Math.abs(run(past.e, c.axis)), 0.03) && near(Math.abs(run(e, c.other)), Math.abs(run(past.e, c.other)), 0.03)).flatMap(e => { const at = Math.abs(endAt(e, 'start') - u) < Math.abs(endAt(e, 'end') - u) ? 'start' : 'end'; return near(endAt(e, at), endAt(past.e, past.at), 0.03) ? [{ e, at, length: past.length }] : []; });
    return [past, ...twins].map(p => ({ e: p.e, rank: 4, size: 0, guide: { edge: p.e.index, at: p.at, turn_deg: 180, length_mm: p.length * (view.scale ?? 1) } }));
  });
  const spot = x => x.guide ? x.e[x.guide.at === 'start' ? 'start_sheet_mm' : 'end_sheet_mm'] ?? null : x.e.center_sheet_mm ?? (x.e.start_sheet_mm && x.e.end_sheet_mm ? [0, 1].map(i => (x.e.start_sheet_mm[i] + x.e.end_sheet_mm[i]) / 2) : null);
  const apart = (p, q) => { const s = spot(p), t = spot(q); return s && t ? Math.hypot(s[0] - t[0], s[1] - t[1]) : 0; };
  // how far a dimension can go from a corner on its side of the view, up to what is beside the view: its extension line does not cross the part to get there
  const room = x => {
    const o = view.outline_mm, s = x.guide && o ? spot(x) : null; if (!s) return 0;
    const i = 1 - k, right = s[i] > (o[i] + o[i + 2]) / 2, rooms = around.filter(w => w[1 - i] < o[3 - i] && w[3 - i] > o[1 - i]).map(w => right ? w[i] - o[i + 2] : o[i] - w[i + 2]).filter(g => g >= 0);
    return rooms.length ? Math.min(...rooms) : 1e6;
  };
  const closer = (p, q, b) => { const by = apart(p, q) - apart(b[0], b[1]), more = room(p) + room(q) - room(b[0]) - room(b[1]); return by < -0.01 || (by < 0.01 && (more > 0 || (more === 0 && by < 0))); };
  for (const [u, v] of need.pairs) {
    // of those equally good, the two nearest on the sheet: both on one tooth, not on two
    let best = null;
    for (const p of on(u)) for (const q of on(v)) if (!(p.e === q.e && p.end === q.end) && (!best || closer(p, q, best))) best = [p, q];
    if (!best) continue;
    const [p, q] = best, expected = Math.abs(u - v);
    if (p.guide || q.guide) {
      const guides = [p, q].filter(x => x.guide).map(x => x.guide), foot = x => x.guide ? { guide: guides.indexOf(x.guide), end: 'end' } : { edge: x.e.index, ...(x.end ? { end: x.end } : {}) };
      out.push({ action: 'guided', guides, feet: [foot(p), foot(q)], type, expect: expected, tolerance: 0.02, expected, pair: [u, v] });
    } else out.push({ edges: [p.e.index, q.e.index], ...(p.end || q.end ? { ends: [p.end ?? null, q.end ?? null] } : {}), type, expected, pair: [u, v] });
  }
  return out;
}
