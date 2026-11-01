// v3.15 sw_drawing_dim_check: supervision of the dimensions of a drawing sheet (lesson from the CIGUENAL_MOTOR sheet: 46 model
// dimensions stacked over each other, texts over texts, lines across texts, and nobody looked: auto arrange only said "review the
// PDF"). Works on the REAL geometry SolidWorks reports (drawing_dim_geometry), never on estimates of where things should be.
// findIssues is the check, planLayout the placement (linear dimensions on tracks around their view, shortest nearest; radial ones
// around their centre), superviseDimensions applies a plan, reads back and keeps it only if the sheet really got better. Never saves.
// organizeDimensions goes first when a sheet has too many: every size once, shared among front, top and side, with a section if hollow.
import { planNeeded, dimensionsFromEdges, ringDiameters, pairKey, sizeKey } from './dims_needed.mjs';

const EPS = 0.05, PAD = 0.4;
const sq = x => x * x;
const near = (a, b, t = EPS) => Math.abs(a - b) <= t;

// --- geometry: a text box is an oriented box {x, y, hw, hh, a}, a line is [x1, y1, x2, y2]
const toLocal = (b, x, y) => { const c = Math.cos(b.a), s = Math.sin(b.a), dx = x - b.x, dy = y - b.y; return [dx * c + dy * s, -dx * s + dy * c]; };
const corners = b => { const c = Math.cos(b.a), s = Math.sin(b.a); return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) => [b.x + i * b.hw * c - j * b.hh * s, b.y + i * b.hw * s + j * b.hh * c]); };
const inside = (b, pad = 0) => (x, y) => { const [u, v] = toLocal(b, x, y); return Math.abs(u) <= b.hw + pad && Math.abs(v) <= b.hh + pad; };
export function boxesOverlap(a, b, pad = 0) {
  const dx = b.x - a.x, dy = b.y - a.y, reach = a.hw + a.hh + b.hw + b.hh + Math.max(pad, 0);
  if (dx * dx + dy * dy > reach * reach) return false;
  const apart = ang => Math.abs(dx * Math.cos(ang) + dy * Math.sin(ang)) > a.hw * Math.abs(Math.cos(a.a - ang)) + a.hh * Math.abs(Math.sin(a.a - ang)) + b.hw * Math.abs(Math.cos(b.a - ang)) + b.hh * Math.abs(Math.sin(b.a - ang)) + pad;
  return !(apart(a.a) || apart(a.a + Math.PI / 2) || apart(b.a) || apart(b.a + Math.PI / 2));
}
export function lineHitsBox(l, b, pad = 0) {
  const reach = b.hw + b.hh + 2 * Math.max(pad, 0);
  if (Math.max(l[0], l[2]) < b.x - reach || Math.min(l[0], l[2]) > b.x + reach || Math.max(l[1], l[3]) < b.y - reach || Math.min(l[1], l[3]) > b.y + reach) return false;
  const [x1, y1] = toLocal(b, l[0], l[1]), [x2, y2] = toLocal(b, l[2], l[3]);
  let t0 = 0, t1 = 1; const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 + b.hw + pad], [dx, b.hw + pad - x1], [-dy, y1 + b.hh + pad], [dy, b.hh + pad - y1]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
const rectBox = r => ({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, hw: Math.abs(r[2] - r[0]) / 2, hh: Math.abs(r[3] - r[1]) / 2, a: 0 });
const TAU = 2 * Math.PI, mod = a => ((a % TAU) + TAU) % TAU;
// never upside down
const upright = a => { const m = mod(a); return m > Math.PI / 2 + 1e-6 && m <= 3 * Math.PI / 2 + 1e-6 ? m - Math.PI : m; };
const lengthOf = l => Math.hypot(l[2] - l[0], l[3] - l[1]);
const chords = (cx, cy, r, a0, a1) => { const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12))), at = i => a0 + (a1 - a0) * i / n, out = []; for (let i = 0; i < n; i++) out.push([cx + r * Math.cos(at(i)), cy + r * Math.sin(at(i)), cx + r * Math.cos(at(i + 1)), cy + r * Math.sin(at(i + 1))]); return out; };
// v3.17 what a view really occupies (drawing_dim_shapes): the frame of a slender part is mostly air and a dimension can live there. "Over the part" is on its material
// or on what it encloses, like a hole: with material on all four sides
const grids = new WeakMap();
function shapeGrid(s) {
  let g = grids.get(s); if (g) return g;
  const ny = s.rows.length, nx = Math.max(1, ...s.rows.map(r => r[r.length - 1] ?? 0));
  const rowLo = new Int32Array(ny).fill(nx), rowHi = new Int32Array(ny).fill(-1), colLo = new Int32Array(nx).fill(ny), colHi = new Int32Array(nx).fill(-1);
  s.rows.forEach((sp, r) => { for (let i = 0; i + 1 < sp.length; i += 2) { rowLo[r] = Math.min(rowLo[r], sp[i]); rowHi[r] = Math.max(rowHi[r], sp[i + 1] - 1); for (let c = sp[i]; c < sp[i + 1]; c++) { colLo[c] = Math.min(colLo[c], r); colHi[c] = Math.max(colHi[c], r); } } });
  grids.set(s, g = { nx, ny, rowLo, rowHi, colLo, colHi });
  return g;
}
export function viewMask(s, v) {
  const g = shapeGrid(s), cell = s.cell_mm, dx = (v.origin_mm?.[0] ?? s.origin_mm[0]) - s.origin_mm[0], dy = (v.origin_mm?.[1] ?? s.origin_mm[1]) - s.origin_mm[1], x0 = s.x0 + dx, y0 = s.y0 + dy;
  let c0 = g.nx, c1 = -1, r0 = g.ny, r1 = -1;
  for (let r = 0; r < g.ny; r++) if (g.rowHi[r] >= 0) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, g.rowLo[r]); c1 = Math.max(c1, g.rowHi[r]); }
  if (c1 < 0) return null;
  const extent = [x0 + c0 * cell, y0 + r0 * cell, x0 + (c1 + 1) * cell, y0 + (r1 + 1) * cell];
  const over = (x, y) => { const c = Math.floor((x - x0) / cell), r = Math.floor((y - y0) / cell); return r >= 0 && r < g.ny && c >= 0 && c < g.nx && c >= g.rowLo[r] && c <= g.rowHi[r] && r >= g.colLo[c] && r <= g.colHi[c]; };
  const inRow = (x, y) => { const c = Math.floor((x - x0) / cell), r = Math.floor((y - y0) / cell); return r >= 0 && r < g.ny && c >= g.rowLo[r] && c <= g.rowHi[r]; };
  const shift = p => p && [p[0] + dx, p[1] + dy];
  return {
    over, inRow, extent, cell,
    arcs: (s.arcs ?? []).map(a => ({ ...a, center: shift(a.center), start: shift(a.start), end: shift(a.end), mid: shift(a.mid) })),
    // something is drawn at this coordinate of the sheet (0 x, 1 y): an edge that stands or ends there, a round centred there or with its side there, the outline of the view. undefined when the view does not tell its edges
    seenAt(k, u, t = 0.15) {
      if (!s.lines) return undefined;
      const on = w => Math.abs(w - u) <= t, d = k ? dy : dx;
      if (on(extent[k]) || on(extent[k + 2]) || Math.abs(extent[k] - u) <= cell || Math.abs(extent[k + 2] - u) <= cell) return true;
      return s.lines.some(l => on(l[k] + d) || on(l[k + 2] + d)) || (s.arcs ?? []).some(a => (a.center && (on(a.center[k] + d) || (a.r && (on(a.center[k] + d - a.r) || on(a.center[k] + d + a.r))))) || (a.start && on(a.start[k] + d)) || (a.end && on(a.end[k] + d)));
    },
    // how much of a line runs over the part
    lineLen(l) {
      if (Math.max(l[0], l[2]) < extent[0] || Math.min(l[0], l[2]) > extent[2] || Math.max(l[1], l[3]) < extent[1] || Math.min(l[1], l[3]) > extent[3]) return 0;
      const L = lengthOf(l), n = Math.max(1, Math.ceil(L / (cell / 2))); let hit = 0;
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; if (over(l[0] + (l[2] - l[0]) * t, l[1] + (l[3] - l[1]) * t)) hit++; }
      return L * hit / n;
    },
    // ...with part on both sides: a line along an edge lies on what is already drawn and hides nothing
    lineThrough(l) {
      const L = lengthOf(l); if (!L) return 0;
      const n = Math.max(1, Math.ceil(L / (cell / 2))), nx = (l[3] - l[1]) / L, ny = -(l[2] - l[0]) / L; let hit = 0;
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, x = l[0] + (l[2] - l[0]) * t, y = l[1] + (l[3] - l[1]) * t; if (over(x + nx, y + ny) && over(x - nx, y - ny)) hit++; }
      return L * hit / n;
    },
    // a text, with room around it
    boxHits(b, pad = 0) {
      const hw = b.hw + pad, hh = b.hh + pad, rad = Math.hypot(hw, hh);
      if (b.x + rad < extent[0] || b.x - rad > extent[2] || b.y + rad < extent[1] || b.y - rad > extent[3]) return false;
      const c = Math.cos(b.a), s = Math.sin(b.a), nu = Math.max(1, Math.ceil(2 * hw / cell)), nv = Math.max(1, Math.ceil(2 * hh / cell));
      for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const u = -hw + 2 * hw * i / nu, w = -hh + 2 * hh * j / nv; if (over(b.x + u * c - w * s, b.y + u * s + w * c)) return true; }
      return false;
    },
  };
}
// v3.17 one line over another ("no superponer cotas en otras"). They cross when the ends of each lie clearly on both sides of the other: a foot landing on a line does not count
export function segmentsCross(a, b, tol = 0.25) {
  const off = (s, x, y) => { const dx = s[2] - s[0], dy = s[3] - s[1], L = Math.hypot(dx, dy) || 1; return ((x - s[0]) * dy - (y - s[1]) * dx) / L; };
  const a0 = off(b, a[0], a[1]), a1 = off(b, a[2], a[3]), b0 = off(a, b[0], b[1]), b1 = off(a, b[2], b[3]);
  return a0 * a1 < 0 && b0 * b1 < 0 && Math.min(Math.abs(a0), Math.abs(a1)) > tol && Math.min(Math.abs(b0), Math.abs(b1)) > tol;
}
// ...or one lies on the other, along the same line, for more than a touch
export function segmentsOnTop(a, b, tol = 0.25) {
  const dx = a[2] - a[0], dy = a[3] - a[1], L = Math.hypot(dx, dy); if (L < 0.1) return false;
  const ux = dx / L, uy = dy / L, across = (x, y) => Math.abs((x - a[0]) * uy - (y - a[1]) * ux), along = (x, y) => (x - a[0]) * ux + (y - a[1]) * uy;
  if (across(b[0], b[1]) > tol || across(b[2], b[3]) > tol) return false;
  const s0 = along(b[0], b[1]), s1 = along(b[2], b[3]);
  return Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) > 0.5;
}
const distToSeg = (x, y, l) => { const dx = l[2] - l[0], dy = l[3] - l[1], q = dx * dx + dy * dy, t = q ? Math.max(0, Math.min(1, ((x - l[0]) * dx + (y - l[1]) * dy) / q)) : 0; return Math.hypot(x - l[0] - t * dx, y - l[1] - t * dy); };
// ...or they run so close, for longer than a crossing takes, that the eye reads them as one line, even if they never meet
const RUN_CLOSE = 0.6, RUN_LONG = 3;
export function segmentsAlong(a, b) {
  const La = lengthOf(a), Lb = lengthOf(b), [p, q, L] = La <= Lb ? [a, b, La] : [b, a, Lb];
  if (L < RUN_LONG || Math.abs((a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0])) > 0.4 * La * Lb) return false;
  const n = Math.ceil(L / 0.5); let hit = 0;
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; if (distToSeg(p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t, q) < RUN_CLOSE) hit++; }
  return hit * L / n >= RUN_LONG;
}
const apart = (a, b, t) => Math.max(a[0], a[2]) + t < Math.min(b[0], b[2]) || Math.max(b[0], b[2]) + t < Math.min(a[0], a[2]) || Math.max(a[1], a[3]) + t < Math.min(b[1], b[3]) || Math.max(b[1], b[3]) + t < Math.min(a[1], a[3]);
const over = (a, b) => !apart(a, b, RUN_CLOSE) && (segmentsCross(a, b) || segmentsOnTop(a, b) || segmentsAlong(a, b));
// ...or it goes through the point of an arrow [x, y, dx, dy] out in the air (a leader has its point on the part, where everything starts). A line square to the arrow, at its point, is another dimension from the same place: that is how they are stacked. One in line with the arrow is the next one of a chain
const TIP_CLOSE = 0.7;
export const onArrowTip = (t, l) => { if (t[0] < Math.min(l[0], l[2]) - TIP_CLOSE || t[0] > Math.max(l[0], l[2]) + TIP_CLOSE || t[1] < Math.min(l[1], l[3]) - TIP_CLOSE || t[1] > Math.max(l[1], l[3]) + TIP_CLOSE || distToSeg(t[0], t[1], l) > TIP_CLOSE) return false; const along = Math.abs((l[2] - l[0]) * t[2] + (l[3] - l[1]) * t[3]), L = lengthOf(l) || 1; return along >= 0.1 * L && along < 0.995 * L; };
// an extension line may go through the tail of an arrow that had no room inside, as long as it stays off the arrow itself
const ARROW_LONG = 3;
// ...or square to it right at its point: the other dimension starts a hair away from where this one ends (stacked sizes of 14 and 14.5) and the two feet read as one
const atItsPoint = (t, l) => distToSeg(t[0], t[1], l) <= TIP_CLOSE && Math.abs((l[2] - l[0]) * t[2] + (l[3] - l[1]) * t[3]) < 0.1 * (lengthOf(l) || 1);
const tailOnly = (ext, q, m) => !!q.tails?.includes(m) && (q.tips ?? []).every(t => distToSeg(t[0], t[1], ext) >= ARROW_LONG || atItsPoint(t, ext));
// a dimension or a place for one, by what the eye follows (dimension line, leader, main) and what only goes out to it (ext). Extension lines may cross each other: that is what they do inside a view
const countOver = (p, q) => {
  let n = 0;
  for (const l of p.main) { for (const m of q.main) if (over(l, m)) n++; for (const m of q.ext) if (over(l, m) && !tailOnly(m, p, l)) n++; }
  for (const l of p.ext) for (const m of q.main) if (over(l, m) && !tailOnly(l, q, m)) n++;
  for (const [r, o] of [[p, q], [q, p]]) for (const t of r.tips ?? []) { for (const m of o.main) if (onArrowTip(t, m)) n++; for (const m of o.ext) if (onArrowTip(t, m)) n++; }
  return n;
};
// v3.17 a text between the two extension lines of another dimension, close to both, reads as the value of that one: a drafter puts it elsewhere
const CHANNEL_WIDE = 4, IN_A_CHANNEL = 5;
const insideConvex = (pts, x, y) => { const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length, ring = [...pts].sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx)); let sign = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length], c = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]); if (Math.abs(c) < 1e-9) continue; if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); } return true; };
const inChannels = (placed, box, h) => placed.filter(p => p.ext?.length === 2 && insideConvex(p.ext.flatMap(l => [[l[0], l[1]], [l[2], l[3]]]), box.x, box.y) && distToSeg(box.x, box.y, p.ext[0]) + distToSeg(box.x, box.y, p.ext[1]) < CHANNEL_WIDE * h).length;
// ...and the other way round: two extension lines drawn around the text of a leader that is already there
const boxedTexts = (placed, c, h) => placed.filter(p => !p.ext?.length && p.box && inChannels([c], p.box, h)).length;

// --- reading the raw geometry of the worker
const LINEAR_AXIS = a => { const m = ((a % Math.PI) + Math.PI) % Math.PI; return m < 0.02 || m > Math.PI - 0.02 ? 'h' : near(m, Math.PI / 2, 0.02) ? 'v' : null; };
// width of the text: the worker gives the start of the text and the box centre, twice that distance along the text is its real width
const textWidth = d => {
  const raw = String(d.text ?? '').replace(/<[^>]*>/g, 'O'), seen = raw.trim().length;
  // ...without the blanks SolidWorks pads the text with, they hold no ink
  if (d.start && raw.length) { const c = Math.cos(d.angle), s = Math.sin(d.angle), w = 2 * Math.abs((d.pos[0] - d.start[0]) * c + (d.pos[1] - d.start[1]) * s); if (w > 0.5) return w * seen / raw.length; }
  return seen * (d.height || 3.5) * 0.6;
};
// where the ink of the text really is (compared with the PDF of the sheet): the annotation position gives the place along the text,
// across it the text sits on its baseline, which is where the text starts, and rises above it. The position alone was up to 2 mm off.
const INK_RISE = 0.55;
export function textBox(d, w, h) {
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  if (!d.start) return { x: d.pos[0], y: d.pos[1], hw: w / 2, hh: h * 0.6, a: d.angle };
  const along = (d.pos[0] - d.start[0]) * c + (d.pos[1] - d.start[1]) * s;
  return { x: d.start[0] + along * c - INK_RISE * h * s, y: d.start[1] + along * s + INK_RISE * h * c, hw: w / 2, hh: h * 0.6, a: d.angle };
}
// u is the measuring direction, v the one across it: u=x, v=y for a horizontal dimension and u=y, v=x for a vertical one
const uv = (axis, x, y) => axis === 'h' ? [x, y] : [y, x];
const xyOf = (axis, u, v) => axis === 'h' ? [u, v] : [v, u];

function readLinear(d, axis, scale) {
  const ext = [], par = [];
  for (const l of d.lines) {
    const [u1, v1] = uv(axis, l[0], l[1]), [u2, v2] = uv(axis, l[2], l[3]);
    if (near(u1, u2)) { if (!near(v1, v2)) ext.push([u1, v1, v2]); } else if (near(v1, v2)) par.push([u1, u2, v1]);
  }
  if (!par.length) return null;
  const lineV = par[0][2], feet = [];
  for (const [u, v1, v2] of ext) { const base = Math.abs(v1 - lineV) > Math.abs(v2 - lineV) ? v1 : v2; if (!feet.some(f => near(f[0], u))) feet.push([u, base]); }
  const ends = par.flatMap(p => [p[0], p[1]]);
  // a side without its own extension line (the dimension line lands on the edge): find it from the dimension value
  if (feet.length === 1 && scale && d.unit === 'mm') {
    const L = Math.abs(d.value) * scale, hit = ends.find(u => near(Math.abs(u - feet[0][0]), L, 0.2));
    if (hit !== undefined) feet.push([hit, lineV]);
  }
  // no extension lines at all: the dimension line lies between the very edges it measures. With tails or its text outside, it is the piece as long as the value
  if (!feet.length && scale && d.unit === 'mm') {
    const L = Math.abs(d.value) * scale, piece = par.find(p => near(Math.abs(p[1] - p[0]), L, 0.2))?.slice(0, 2) ?? (near(Math.max(...ends) - Math.min(...ends), L, 0.2) ? ends : null);
    if (piece) feet.push([Math.min(...piece), lineV], [Math.max(...piece), lineV]);
  }
  if (feet.length < 2) return null;
  feet.sort((a, b) => a[0] - b[0]);
  const f = [feet[0], feet[feet.length - 1]], [, pv] = uv(axis, d.pos[0], d.pos[1]);
  return { feet: f, u0: f[0][0], u1: f[1][0], span: f[1][0] - f[0][0], lineOffset: lineV - pv, lineV };
}
function readRadial(d, scale) {
  if (!d.lines.length) return null;
  const a = d.lines[0], b = d.lines[1], r = d.unit === 'mm' && scale ? Math.abs(d.value) * scale * (d.type === 6 ? 0.5 : 1) : 0;
  if (!b) {
    // an open leader: one line from the arc outwards, the centre is one radius back. With its arrow inside it goes from the arc to the centre
    const L = lengthOf(a), arc = d.arc_list?.[0];
    if (arc) return { center: [arc[4], arc[5]] };
    if (d.arrow_side === 0 && d.type === 5) return { center: [a[2], a[3]] };
    return { center: r && L > 0.1 ? [a[0] - (a[2] - a[0]) / L * r, a[1] - (a[3] - a[1]) / L * r] : [a[0], a[1]] };
  }
  // both lines start at the arrow on the arc: the second one ends at the centre
  const shared = near(a[0], b[0], 0.1) && near(a[1], b[1], 0.1);
  // ...on a diameter it crosses the whole circle, the centre is half way
  if (d.type === 6 && shared) return { center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] };
  return { center: shared ? [b[2], b[3]] : [b[0], b[1]] };
}
// v3.17 an angle: its first arc is the true sector between the two rays, counter-clockwise, and moving the text never changes which one (only a tail of arc goes out to it).
// Each ray starts at the real edge, or at the arc itself when the arc lies on the edge
function readAngle(d) {
  const a = d.arc_list?.[0]; if (!a) return null;
  const [sx, sy, ex, ey, cx, cy] = a, r = Math.hypot(sx - cx, sy - cy), from = Math.atan2(sy - cy, sx - cx), sweep = mod(Math.atan2(ey - cy, ex - cx) - from);
  const foot = ray => {
    for (const l of d.lines) {
      const r0 = Math.hypot(l[0] - cx, l[1] - cy), r1 = Math.hypot(l[2] - cx, l[3] - cy), far = r1 >= r0 ? [l[2], l[3]] : [l[0], l[1]], off = mod(Math.atan2(far[1] - cy, far[0] - cx) - ray);
      if (Math.min(off, TAU - off) < 0.03) return r0;
    }
    return r;
  };
  const here = Math.atan2(d.pos[1] - cy, d.pos[0] - cx);
  return { c: [cx, cy], r, from, sweep, feet: [foot(from), foot(from + sweep)], level: near(upright(d.angle), 0, 0.02) && !near(upright(here - Math.PI / 2), 0, 0.1) };
}
// a ray past what it measures goes out from the end of that. The sheet says where when it shows one starting away from the vertex; if not, a side tangent to a round of the view
// ends where it touches it, and any other no further than the last of the part beside it
const RAY_BESIDE = 0.75;
function rayEnds(ang, v) {
  const m = v?.mask, [cx, cy] = ang.c;
  return [ang.from, ang.from + ang.sweep].map((a, i) => {
    if (ang.feet[i] > 1.5 && ang.feet[i] < ang.r) return ang.feet[i] - GAP;
    if (!m) return Infinity;
    const dx = Math.cos(a), dy = Math.sin(a), e = m.extent, touch = [];
    for (const o of m.arcs) {
      if (o.curve) continue;
      const ox = o.center[0] - cx, oy = o.center[1] - cy, t = ox * dx + oy * dy;
      if (t <= 0 || !near(Math.abs(ox * dy - oy * dx), o.r, 0.15)) continue;
      if (!o.full) { const at = p => Math.atan2(p[1] - o.center[1], p[0] - o.center[0]), s0 = at(o.start), w0 = mod(at(o.end) - s0), [s, w] = mod(at(o.mid) - s0) <= w0 ? [s0, w0] : [at(o.end), mod(s0 - at(o.end))]; if (mod(Math.atan2(cy + t * dy - o.center[1], cx + t * dx - o.center[0]) - s + 0.04) > w + 0.08) continue; }
      touch.push(t);
    }
    if (touch.length) return Math.max(...touch);
    const t0 = Math.min(dx > 1e-9 ? (e[2] - cx) / dx : dx < -1e-9 ? (e[0] - cx) / dx : Infinity, dy > 1e-9 ? (e[3] - cy) / dy : dy < -1e-9 ? (e[1] - cy) / dy : Infinity);
    if (!(t0 > 0)) return Infinity;
    for (let t = t0; t > 0; t -= 0.25) if (m.inRow(cx + t * dx - dy * RAY_BESIDE, cy + t * dy + dx * RAY_BESIDE) || m.inRow(cx + t * dx + dy * RAY_BESIDE, cy + t * dy - dx * RAY_BESIDE)) return t;
    return t0;
  });
}
export function readSheet(geo, opts = {}) {
  const shapes = new Map((opts.shapes?.views ?? []).filter(s => s.rows?.length).map(s => [s.view, s]));
  const views = new Map((geo.views ?? []).filter(v => v.outline_mm).map(v => { const s = shapes.get(v.name), mask = s ? viewMask(s, v) : null; return [v.name, mask ? { ...v, mask } : v]; }));
  const dims = (geo.dimensions ?? []).map(d => {
    const h = d.height || 3.5, w = textWidth(d), scale = views.get(d.view)?.scale;
    const axis = d.hole_callout || d.type === 3 || d.type === 4 ? null : LINEAR_AXIS(d.angle);
    let mode = 'fixed', lin = null, rad = null, ang = null;
    if ((d.type === 5 || d.type === 6) && d.lines.length <= 2) { rad = readRadial(d, scale); if (rad) mode = 'free'; }
    else if (d.hole_callout) { rad = { center: views.get(d.view) ? [(views.get(d.view).outline_mm[0] + views.get(d.view).outline_mm[2]) / 2, (views.get(d.view).outline_mm[1] + views.get(d.view).outline_mm[3]) / 2] : d.pos }; mode = 'free'; }
    else if (axis) { lin = readLinear(d, axis, scale); if (lin) mode = axis; }
    else if (d.type === 3) { ang = readAngle(d); if (ang) { ang.ends = rayEnds(ang, views.get(d.view)); mode = 'angle'; } }
    const row = { ...d, h, w, axis, mode, lin, rad, ang, box: textBox(d, w, h) };
    return { ...row, ...linesByKind(row) };
  });
  const W = geo.sheet_mm[0], H = geo.sheet_mm[1];
  // keep_out_mm: what the sheet has and the geometry does not tell, like the arrows of a cut line
  const keepOut = (opts.keep_out_mm ?? []).map(box => ({ text: 'flecha de corte', box, soft: true }));
  // the name under a section is not in the geometry: centred under it, on two lines
  const names = [...views.values()].filter(v => v.section).map(v => { const c = (v.outline_mm[0] + v.outline_mm[2]) / 2; return { text: 'nombre del corte', box: [c - 17, v.outline_mm[1] - 9, c + 17, v.outline_mm[1] + 2] }; });
  return { sheet: geo.sheet, W, H, margin: opts.margin_mm ?? 8, title: opts.title_block_mm ?? geo.title_block_mm ?? null, views, notes: [...(geo.notes ?? []), ...keepOut, ...names], dims };
}

// --- the check
const label = d => `${String(d.text ?? d.value).replace(/<MOD-DIAM>/g, 'Ø').replace(/<[^>]*>/g, '').trim()} (${d.id})`;
const linearTips = (d, lineV) => d.lin.feet.map(([fu]) => [...xyOf(d.mode, fu, lineV), ...xyOf(d.mode, 1, 0)]);
const angleTips = (d, r) => { const { c: [cx, cy], from, sweep } = d.ang; return [from, from + sweep].map(a => [cx + r * Math.cos(a), cy + r * Math.sin(a), -Math.sin(a), Math.cos(a)]); };
// the pieces of a dimension line outside its feet that carry no text
const tailsOf = (d, main) => { const [tu] = uv(d.mode, d.box.x, d.box.y), t0 = tu - d.w / 2, t1 = tu + d.w / 2, { u0, u1 } = d.lin; return main.filter(l => { const [a] = uv(d.mode, l[0], l[1]), [b] = uv(d.mode, l[2], l[3]); return (Math.max(a, b) <= u0 + EPS && t0 >= u0 - EPS) || (Math.min(a, b) >= u1 - EPS && t1 <= u1 + EPS); }); };
const extensionLine = (d, l) => d.mode === 'h' ? near(l[0], l[2]) : near(l[1], l[3]);
const arcChords = d => (d.arc_list ?? []).flatMap(([sx, sy, ex, ey, cx, cy]) => { const a0 = Math.atan2(sy - cy, sx - cx); return chords(cx, cy, Math.hypot(sx - cx, sy - cy), a0, a0 + mod(Math.atan2(ey - cy, ex - cx) - a0)); });
// what is really on the paper: drawn. A solid leader goes on past its arrow: a radius to its centre, a diameter across its circle. An open leader stops at the arc
function linesByKind(d) {
  if (d.lin) { const main = d.lines.filter(l => !extensionLine(d, l)); return { ext: d.lines.filter(l => extensionLine(d, l)), main, tails: tailsOf(d, main), drawn: d.lines, tips: linearTips(d, d.lin.lineV) }; }
  if (d.ang) { const main = arcChords(d); return { ext: d.lines, main, drawn: [...d.lines, ...main], tips: angleTips(d, d.ang.r) }; }
  return { ext: [], main: d.lines, drawn: d.lines, tips: [] };
}
const textOverView = (box, v) => v.mask ? v.mask.boxHits(box, 0) : boxesOverlap(box, rectBox(v.outline_mm), -0.2);
// a small size may have its line over the part: there is no other way to say the depth of a slot seen from the side. A long line over the part hides it
const LINE_OVER_PART = 3.5;
// the inner frame of a sheet is drawn some 5 mm inside its edge: what goes past it is off the sheet too
const SHEET_FRAME = 5;
const lineOverView = (d, lines, v) => v.mask ? lines.reduce((s, l) => s + v.mask.lineLen(l), 0) > LINE_OVER_PART * d.h : lines.some(l => lineHitsBox(l, rectBox(v.outline_mm), -0.5));
// an angle on its construction line stays by its vertex, opened enough to see the two rays apart. What keeps the others off that line does not keep it off
const onItsLine = d => !!d.ang && (d.attached ?? []).some(k => /SKETCHSEGS/.test(k)) && (d.attached ?? []).some(k => /EDGES/.test(k));
const ownGuide = (d, b) => onItsLine(d) && near(d.ang.c[0], b.x, b.hw) && near(d.ang.c[1], b.y, b.hh);
export function findIssues(model) {
  const out = { text_overlap: [], text_on_line: [], lines_over: [], text_on_view: [], out_of_sheet: [], over_title_block: [], over_note: [], line_on_note: [], dim_line_on_view: [], duplicate: [], line_across_view: [], repeated: [], name_off_sheet: [] };
  const { dims, views, W, H, title, notes } = model;
  for (const n of notes) if (n.text === 'nombre del corte' && (n.box[1] < SHEET_FRAME || n.box[0] < SHEET_FRAME || n.box[2] > W - SHEET_FRAME || (title && boxesOverlap(rectBox(n.box), rectBox(title), 0)))) out.name_off_sheet.push({ note: n.text, ids: [] });
  for (let i = 0; i < dims.length; i++) {
    const a = dims[i];
    for (let j = i + 1; j < dims.length; j++) {
      if (boxesOverlap(a.box, dims[j].box, 0)) out.text_overlap.push({ a: label(a), b: label(dims[j]), ids: [a.id, dims[j].id] });
      if (countOver(a, dims[j])) out.lines_over.push({ a: label(a), b: label(dims[j]), ids: [a.id, dims[j].id] });
    }
    for (const b of dims) if ((b !== a || a.ang) && (b === a ? b.ext : b.drawn).some(l => lineHitsBox(l, a.box, 0))) out.text_on_line.push({ text: label(a), line_of: label(b), ids: b === a ? [a.id] : [a.id, b.id] });
    for (const [name, v] of views) if (textOverView(a.box, v)) out.text_on_view.push({ text: label(a), view: name, ids: [a.id] });
    if (corners(a.box).some(([x, y]) => x < 0 || y < 0 || x > W || y > H)) out.out_of_sheet.push({ text: label(a), ids: [a.id] });
    if (title && boxesOverlap(a.box, rectBox(title), -0.2)) out.over_title_block.push({ text: label(a), ids: [a.id] });
    for (const n of notes) if (boxesOverlap(a.box, rectBox(n.box), -0.2) && !(n.soft && ownGuide(a, rectBox(n.box)))) out.over_note.push({ text: label(a), note: n.text, ids: [a.id] });
    for (const n of notes) if (!n.soft && a.drawn.some(l => lineHitsBox(l, rectBox(n.box), -0.2))) { out.line_on_note.push({ text: label(a), note: n.text, ids: [a.id] }); break; }
    // a dimension line through a view hides the drawing; an extension line through it is ugly but readable: only a warning. The arc of an angle the same, where the part is known
    if (a.lin) for (const [name, v] of views) if (lineOverView(a, a.main, v)) { out.dim_line_on_view.push({ text: label(a), view: name, ids: [a.id] }); break; }
    if (a.ang) for (const [name, v] of views) if (v.mask && lineOverView(a, a.main, v)) { out.dim_line_on_view.push({ text: label(a), view: name, ids: [a.id] }); break; }
    if (a.mode === 'h' || a.mode === 'v') for (const [name, v] of views) if (name !== a.view && (v.mask ? a.drawn.some(l => v.mask.lineLen(l) > 0.5) : a.drawn.some(l => lineHitsBox(l, rectBox(v.outline_mm), -0.5)))) { out.line_across_view.push({ text: label(a), view: name, ids: [a.id] }); break; }
  }
  for (const group of duplicates(dims)) out.duplicate.push({ keep: label(group[0]), repeated: group.slice(1).map(label), ids: group.slice(1).map(d => d.id) });
  const shown = new Set(duplicates(dims).flat().map(d => d.id)), byValue = new Map();
  for (const d of dims) if (!shown.has(d.id)) { const k = `${d.view}|${d.type}|${d.value}`; byValue.set(k, [...(byValue.get(k) ?? []), d]); }
  for (const g of byValue.values()) if (g.length > 1) out.repeated.push({ value: g[0].value, view: g[0].view, count: g.length, ids: g.map(d => d.id) });
  return out;
}
// the same distance twice in one view (same two points, or same centre and radius): one of them says nothing new
export function duplicates(dims) {
  const groups = new Map();
  for (const d of dims) {
    let k = null;
    if (d.lin) k = `L|${d.view}|${d.mode}|${d.value}|${d.lin.u0.toFixed(1)}|${d.lin.u1.toFixed(1)}`;
    else if (d.rad && d.mode === 'free' && !d.hole_callout) k = `R|${d.view}|${d.type}|${d.value}|${d.rad.center[0].toFixed(1)}|${d.rad.center[1].toFixed(1)}`;
    if (k) groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  return [...groups.values()].filter(g => g.length > 1);
}
const ERROR_KINDS = ['text_overlap', 'text_on_line', 'lines_over', 'text_on_view', 'out_of_sheet', 'over_title_block', 'over_note', 'line_on_note', 'dim_line_on_view', 'duplicate'];
export const errorCount = issues => ERROR_KINDS.reduce((n, k) => n + issues[k].length, 0);
export const summarize = issues => Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length]));

// --- the plan
const pushPlaced = (placed, d) => placed.push({ id: d.id, box: d.box, lines: d.drawn, ext: d.ext, main: d.main, tails: d.tails, tips: d.tips, track: null });
const crossings = (placed, cand) => placed.reduce((n, p) => n + countOver(cand, p), 0);
// room between a text and the part
const CLEAR = 1;
const nogoOf = model => [...[...model.views.values()].map(v => ({ ...rectBox(v.outline_mm), mask: v.mask ?? null })), ...(model.title ? [rectBox(model.title)] : []), ...model.notes.map(n => ({ ...rectBox(n.box), solid: !n.soft, soft: !!n.soft }))];
const chained = (a, b) => near(a.v, b.v, 0.01) && (near(a.lo, b.hi, 0.01) || near(a.hi, b.lo, 0.01));
function conflicts(placed, nogo, sheetRect, cand) {
  if (corners(cand.box).some(([x, y]) => x < sheetRect[0] || y < sheetRect[1] || x > sheetRect[2] || y > sheetRect[3])) return true;
  if (nogo.some(r => r.mask ? r.mask.boxHits(cand.box, cand.clear ?? CLEAR) || (cand.dimLine && r.mask.lineLen(cand.dimLine) > cand.overPart) : boxesOverlap(cand.box, r, PAD) || (cand.dimLine && lineHitsBox(cand.dimLine, r, 0)) || (r.solid && cand.lines.some(l => lineHitsBox(l, r, 0))))) return true;
  for (const p of placed) {
    if (boxesOverlap(cand.box, p.box, PAD)) return true;
    if (p.lines.some(l => lineHitsBox(l, cand.box, PAD))) return true;
    if (cand.lines.some(l => lineHitsBox(l, p.box, PAD))) return true;
    // two dimension lines on one track must not run into each other, unless they are a chain: one after the other on one line, from the foot they share
    if (cand.track && p.track && cand.track.axis === p.track.axis && near(cand.track.v, p.track.v, 3) && cand.track.lo - 1.5 < p.track.hi && p.track.lo - 1.5 < cand.track.hi && !chained(cand.track, p.track)) return true;
  }
  return false;
}
// the tail SolidWorks gives an arrow that does not fit inside, and the gap an extension line leaves at what it measures, always on the side of its dimension line
const TAIL = 6.35, GAP = 1;
const footTowards = (fv, was, to) => { const side = Math.sign(was - fv), real = fv - side * GAP, now = Math.sign(to - real); return now === side ? fv : real + now * GAP; };
function linearCandidate(d, v, u) {
  const axis = d.mode, lineV = v + d.lin.lineOffset, { u0, u1, span } = d.lin, t0 = u - d.w / 2, t1 = u + d.w / 2;
  // as it is really drawn: with the text between the feet and no room for the arrows too, they go out with a tail each. With the text outside, the line reaches the far end of the text, and on the other side a tail if the two arrows do not fit between the feet
  let lo = Math.min(u0, t0), hi = Math.max(u1, t1);
  if (t0 >= u0 && t1 <= u1) { if (span < d.w + 2 * TAIL) { lo = u0 - TAIL; hi = u1 + TAIL; } }
  else if (span < TAIL) { if (t1 > u1) lo = u0 - TAIL; else hi = u1 + TAIL; }
  const seg = (u1, v1, u2, v2) => [...xyOf(axis, u1, v1), ...xyOf(axis, u2, v2)];
  // the box keeps the offset it has from the annotation position: moving the text moves its dimension line with it
  const [x, y] = xyOf(axis, u, v), [bu, bv] = uv(axis, d.box.x - d.pos[0], d.box.y - d.pos[1]), [bx, by] = xyOf(axis, u + bu, v + bv);
  // the dimension line is drawn in pieces that end at its feet, as SolidWorks reports it: what starts from the same place does not cross it
  const ext = d.lin.feet.map(([fu, fv]) => seg(fu, footTowards(fv, d.lin.lineV, lineV), fu, lineV)), main = [[lo, u0], [u0, u1], [u1, hi]].filter(([a, b]) => b - a > 0.01).map(([a, b]) => seg(a, lineV, b, lineV));
  const box = { x: bx, y: by, hw: d.w / 2, hh: d.h * 0.6, a: d.angle };
  return { x, y, box,
    dimLine: seg(lo, lineV, hi, lineV), overPart: LINE_OVER_PART * d.h, lines: [...ext, ...main], ext, main, tails: tailsOf({ mode: axis, box, w: d.w, lin: d.lin }, main), tips: linearTips(d, lineV),
    track: { axis, v: lineV, lo, hi } };
}
// what a place costs, in tracks of distance from the view. A crossing is worth going a long way round; a shoulder only a little, but a text far from what it measures is hard to read
const CROSSING = 8, SHOULDER = 0.1, ON_A_FOOT = 2, ON_A_CUT_ARROW = 3, MM_TO_TRACKS = 0.2;
// a sheet with fewer crossings is the better one even if its texts have to go further (each crossing counts twice, once for each). How long the search goes on
const CROSSED_SHEET = 25, PLAN_MS = 12000, TRY_PLACES = 32, TRY_WORST = 4, MAX_IN_THE_WAY = 2;
// the feet of those still to come: their extension lines will run through here
const onLaterFoot = (ctx, view, box) => { const c = corners(box), hit = (k, i) => { const at = c.map(p => p[i]), lo = Math.min(...at), hi = Math.max(...at); return (ctx.feet.get(view + k) ?? []).some(f => f > lo && f < hi); }; return hit('v', 1) || hit('h', 0); };
// asked for all its places (ctx.all), a dimension leaves the best of each family
const offer = (ctx, family, c) => { if (ctx.all) { const had = ctx.all.get(family); if (!had || c.cost < had.cost) ctx.all.set(family, c); } };
const softHits = (nogo, c) => nogo.filter(r => r.soft && c.lines.some(l => lineHitsBox(l, r, 0))).length;
// over the part: an extension line is ugly but readable, a dimension line hides it a little, and right beside an edge, with the part on one side only, it reads as the edge. Long extension lines are hard to follow anywhere
function partCost(mask, c) {
  let s = 0;
  for (const l of c.ext) s += mask.lineThrough(l) / 5 + lengthOf(l) / 50;
  for (const l of c.main) { const L = lengthOf(l) || 1, nx = (l[3] - l[1]) / L * 1.5, ny = -(l[2] - l[0]) / L * 1.5; s += mask.lineLen(l) / 6 + Math.abs(mask.lineLen([l[0] + nx, l[1] + ny, l[2] + nx, l[3] + ny]) - mask.lineLen([l[0] - nx, l[1] - ny, l[2] - nx, l[3] - ny])) / 2.5; }
  return s;
}
// the gap between two views belongs to both: the outer side has the room to spare
const CORRIDOR = 1, CORRIDOR_WIDE = 60, INSIDE_LONG = 0.1;
const inCorridor = (ctx, view, axis, v, t) => { const eo = w => w.mask?.extent ?? w.outline_mm, own = eo(ctx.views.get(view)), [a, b] = axis === 'h' ? [1, 3] : [0, 2], [c, e] = axis === 'h' ? [0, 2] : [1, 3]; for (const [n, w] of ctx.views) { if (n === view) continue; const o = eo(w); if (o[c] > t.hi || o[e] < t.lo) continue; const gap = v > own[b] ? o[a] - own[b] : own[a] - o[b]; if (gap > 0 && gap < CORRIDOR_WIDE && (v > own[b] ? v < o[a] : v > o[b])) return true; } return false; };
function placeLinear(d, ctx) {
  const vw = ctx.views.get(d.view), o = vw?.outline_mm; if (!o) return null;
  // the tracks go around the part itself when its shape is known, around the frame otherwise
  const axis = d.mode, mask = vw.mask ?? null, around = mask?.extent ?? o, [lo, hi] = axis === 'h' ? [around[1], around[3]] : [around[0], around[2]];
  const [, pv] = uv(axis, d.pos[0], d.pos[1]), pitch = Math.max(d.h * 1.75, 5.5), first = Math.max(d.h * 2.5, 8), middle = (lo + hi) / 2;
  const limit = axis === 'h' ? [ctx.rect[1], ctx.rect[3]] : [ctx.rect[0], ctx.rect[2]];
  const [ulo, uhi] = axis === 'h' ? [o[0], o[2]] : [o[1], o[3]], centre = (d.lin.u0 + d.lin.u1) / 2, reach = Math.max(uhi - centre, centre - ulo) + d.w + 40, offs = [0];
  // never on its own extension lines. The feet of those still to come may reach this text or may not, it depends on where they go: only worth avoiding; those already placed say it with their lines
  const nearFoot = (list, u) => list.some(f => Math.abs(f - u) < d.w / 2 + 0.8), own = [d.lin.u0, d.lin.u1], later = ctx.feet.get(d.view + axis) ?? [];
  for (let s = 1.5; s <= reach; s += 1.5) offs.push(s, -s);
  // the air inside the frame comes first: beside a neck the extension lines are short. That is for what is short itself: a long line beside the part reads as one more edge of it
  const tracks = [], inside = d.lin.span * INSIDE_LONG;
  if (mask) for (let v = lo + pitch / 2; v < hi; v += pitch / 2) tracks.push({ v, k: inside, side: 0 });
  for (const side of pv < middle ? [-1, 1] : [1, -1]) for (let k = 0; ; k++) { const v = (side < 0 ? lo : hi) + side * (first + k * pitch); if (side < 0 ? v < limit[0] : v > limit[1]) break; tracks.push({ v, k, side }); }
  tracks.sort((a, b) => a.k - b.k);
  let best = null;
  for (const { v, k, side } of tracks) {
    if (best && k > best.cost && !ctx.all) break;
    for (const off of offs) {
      const shoulder = Math.max(0, Math.abs(off) + d.w / 2 - d.lin.span / 2), least = k + (side * (pv - middle) < 0 ? 1 : 0) + shoulder * SHOULDER;
      if ((best && least >= best.cost && !ctx.all) || nearFoot(own, centre + off)) continue;
      const found = linearCandidate(d, v, centre + off);
      if (conflicts(ctx.placed, ctx.nogo, ctx.rect, found)) continue;
      // tracks past another view make its extension lines run through that view: worth several tracks of detour
      const across = [...ctx.views].filter(([n, w]) => n !== d.view && (w.mask ? found.lines.some(l => w.mask.lineLen(l) > 0.5) : found.lines.some(l => lineHitsBox(l, rectBox(w.outline_mm), -0.5)))).length;
      const crossed = crossings(ctx.placed, found), boxed = boxedTexts(ctx.placed, found, d.h); let cost = least + across * 6 + (side && inCorridor(ctx, d.view, axis, v, found.track) ? CORRIDOR : 0) + crossed * CROSSING + (nearFoot(later, centre + off) ? ON_A_FOOT : 0) + softHits(ctx.nogo, found) * ON_A_CUT_ARROW + boxed * IN_A_CHANNEL;
      if (best && cost >= best.cost && !ctx.all) continue;
      if (mask) cost += partCost(mask, found);
      const cand = { ...found, cost, base: cost - crossed * CROSSING, channels: boxed };
      offer(ctx, v + '|' + (centre + off + d.w / 2 < d.lin.u0 ? 0 : centre + off - d.w / 2 > d.lin.u1 ? 2 : 1), cand);
      if (!best || cost < best.cost) best = cand;
    }
  }
  return best;
}
// where the ink goes for a position and an angle: the text keeps the offset it has from its annotation position, turned with it
const boxAt = (d, x, y, a) => { const c0 = Math.cos(d.angle), s0 = Math.sin(d.angle), dx = d.box.x - d.pos[0], dy = d.box.y - d.pos[1], u = dx * c0 + dy * s0, w = -dx * s0 + dy * c0, c = Math.cos(a), s = Math.sin(a); return { x: x + u * c - w * s, y: y + u * s + w * c, hw: d.w / 2, hh: d.h * 0.6, a }; };
// where an arc of this centre and size really is, as [start, sweep] counter-clockwise; null if it goes all the way round. A radius points wherever it is told, even at nothing
function arcRanges(mask, cx, cy, rim) {
  const found = mask.arcs.filter(a => !a.curve && near(a.center[0], cx, 0.3) && near(a.center[1], cy, 0.3) && near(a.r, rim, 0.1));
  if (found.some(a => a.full)) return null;
  const at = p => Math.atan2(p[1] - cy, p[0] - cx), on = p => near(Math.hypot(p[0] - cx, p[1] - cy), rim, 0.15);
  const ranges = found.map(a => { const s = at(a.start), e = at(a.end), w = mod(e - s); return mod(at(a.mid) - s) <= w ? [s, w] : [e, mod(s - e)]; });
  // a round on an inclined side: a curve with both ends on the circle, the short way between them
  for (const a of mask.arcs) if (a.curve && on(a.start) && on(a.end)) { const s = at(a.start), w = mod(at(a.end) - s); if (w > 1e-3) ranges.push(w <= Math.PI ? [s, w] : [at(a.end), TAU - w]); }
  return ranges;
}
function leaderDirections(d, mask, cx, cy, rim) {
  const every = Array.from({ length: 24 }, (_, i) => i * Math.PI / 12); let ranges = arcRanges(mask, cx, cy, rim);
  if (ranges === null) return every;
  if (!ranges.length) {
    // the view does not show its arc (a round seen only as a silhouette): the tip at least on the outline of the part; if nothing is, close to where it points now
    const onOutline = t => { const x = cx + rim * Math.cos(t), y = cy + rim * Math.sin(t), near4 = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([i, j]) => mask.over(x + i * 0.75, y + j * 0.75)); return near4.some(Boolean) && !near4.every(Boolean); };
    const outline = every.filter(onOutline); if (outline.length) return outline;
    const tip = d.lines[0]; ranges = [[Math.atan2(tip[1] - cy, tip[0] - cx) - Math.PI / 4, Math.PI / 2]];
  }
  // along the arc in short steps: a few degrees are what keeps two neighbouring texts apart
  const out = [];
  for (const [s, w] of ranges) { const m = Math.min(w / 8, Math.PI / 36), n = Math.max(1, Math.round((w - 2 * m) / (Math.PI / 72))); for (let i = 0; i <= n; i++) out.push(s + m + (w - 2 * m) * i / n); }
  return out;
}
// the text stays level wherever its leader goes, or it runs along the leader. Along a leader that happens to be level it says nothing: along, as every sheet seen
const flat = (a, t = 0.02) => Math.abs(Math.sin(a)) < t;
const leaderLevel = d => flat(d.angle) && (!!d.hole_callout || !flat(Math.atan2(d.pos[1] - d.rad.center[1], d.pos[0] - d.rad.center[0]), 0.1));
// v3.17 as on a drafter's sheet: a leader leaves its round on a slant, at 30 to 60 degrees, not level nor plumb, when it has the room
const SLANT = 6, slant = t => SLANT * (1 - Math.abs(Math.sin(2 * t)));
// how far past its text position a leader goes: under the whole text, the blanks SolidWorks pads it with too, not only under the ink (measured: 2 mm more on a 2 X R10.00)
const leaderPast = d => d.start ? Math.max(d.w / 2, Math.abs((d.pos[0] - d.start[0]) * Math.cos(d.angle) + (d.pos[1] - d.start[1]) * Math.sin(d.angle))) : d.w / 2;
function placeFree(d, ctx) {
  const [cx, cy] = d.rad.center, v = ctx.views.get(d.view), o = v?.outline_mm, level = leaderLevel(d);
  // where the leader really starts: on the rim, the part from there to the centre is not drawn
  const rim = !d.hole_callout && d.unit === 'mm' && v?.scale ? Math.abs(d.value) * v.scale * (d.type === 6 ? 0.5 : 1) : 0;
  const mask = rim && v?.mask ? v.mask : null, cands = [];
  // a concave round or a big hollow: the centre is in the air, so is the way to the arc. The text stays there and its arrow reaches the arc from inside; nothing goes through the part
  const hollow = mask && d.type === 5 && !level && !mask.over(cx, cy);
  for (const t of mask ? leaderDirections(d, mask, cx, cy, rim) : Array.from({ length: 24 }, (_, i) => i * Math.PI / 12)) {
    const dx = Math.cos(t), dy = Math.sin(t);
    // from the rim when the shape of the part is known; otherwise from the edge of the view along this direction
    let r0 = rim; if (!mask && o) { const tx = dx > 1e-9 ? (o[2] - cx) / dx : dx < -1e-9 ? (o[0] - cx) / dx : Infinity, ty = dy > 1e-9 ? (o[3] - cy) / dy : dy < -1e-9 ? (o[1] - cy) / dy : Infinity; r0 = Math.max(0, Math.min(tx, ty)); }
    for (const extra of mask ? [0, 3, 6, 9, 12, 16, 20, 25, 30, 36, 44] : [0, 6, 12, 18, 24, 32, 40]) {
      const r = r0 + (level ? Math.abs(dx) * d.w / 2 + Math.abs(dy) * d.h : d.w / 2) + 4 + extra, x = cx + dx * r, y = cy + dy * r;
      const a = level ? d.angle : (dx < 0 ? t + Math.PI : t), tip = [cx + dx * rim, cy + dy * rim];
      // the leader runs under the whole text; a solid one goes on past its arrow
      const leader = [...tip, ...(level ? [x, y] : [x + dx * leaderPast(d), y + dy * leaderPast(d)])], main = rim && d.lines.length > 1 ? [leader, [...tip, ...(d.type === 6 ? [cx - dx * rim, cy - dy * rim] : [cx, cy])]] : [leader];
      cands.push({ x, y, t, cost: mask ? r - rim + slant(t) : extra * 10 + Math.hypot(x - d.pos[0], y - d.pos[1]), box: boxAt(d, x, y, a), lines: rim ? main : [[cx, cy, x, y]], ext: [], main, tips: [], track: null });
    }
    if (hollow) {
      const main = [[cx + dx * rim, cy + dy * rim, cx, cy]], a = dx < 0 ? t + Math.PI : t;
      if (mask.lineLen(main[0]) < 1) for (const rho of [rim - d.w / 2 - 2, rim - d.w / 2 - 1, 0.3]) {
        if (rho < 0.25 || rho + d.w / 2 + 0.3 > rim) continue;
        const x = cx + dx * rho, y = cy + dy * rho;
        cands.push({ x, y, t, arrows: 'inside', clear: 0.3, cost: rim - rho - d.w / 2 + slant(t), box: boxAt(d, x, y, a), lines: main, ext: [], main, tips: [], track: null });
      }
    }
  }
  const others = ctx.placed.filter(p => p.id !== d.id);
  let best = null;
  cands.sort((a, b) => a.cost - b.cost);
  for (const c of cands) {
    if (best && c.cost >= best.cost && !ctx.all) break;
    if (conflicts(others, ctx.nogo, ctx.rect, c)) continue;
    // a leader that crosses another dimension is worth a long way round, and over the part it hides what it says
    const crossed = crossings(others, c), channels = inChannels(others, c.box, d.h), cost = c.cost + crossed * 80 + softHits(ctx.nogo, c) * 15 + channels * IN_A_CHANNEL / MM_TO_TRACKS + (mask ? mask.lineLen(c.main[0]) * 2 : 0) + (onLaterFoot(ctx, d.view, c.box) ? ON_A_FOOT / MM_TO_TRACKS : 0);
    const cand = { ...c, cost, base: (cost - crossed * 80) * MM_TO_TRACKS, channels };
    offer(ctx, c.t, cand);
    if (!best || cost < best.cost) best = cand;
  }
  return best;
}
// v3.17 an angle goes where there is room: its value never changes when the text moves, and what is drawn is known: the arc between the rays, each ray from its real edge to
// past the arc, a tail of arc out to a text beside the sector, and a tail for each arrow when the arc is too short for them
const ARROWS_FIT = 17;
function angleCandidate(d, r, t) {
  const { c: [cx, cy], from, sweep, feet, ends, level } = d.ang, to = from + sweep, x = cx + r * Math.cos(t), y = cy + r * Math.sin(t), main = chords(cx, cy, r, from, to), rel = mod(t - from), reach = d.w / 2 / r;
  let tail = 0, before = false, after = false;
  if (rel > sweep) {
    const past = rel - sweep, back = TAU - rel;
    if (past <= back) { main.push(...chords(cx, cy, r, to, to + past + reach)); tail = past * r + d.w / 2; after = true; }
    else { main.push(...chords(cx, cy, r, from, from - back - reach)); tail = back * r + d.w / 2; before = true; }
  }
  if (r * sweep < ARROWS_FIT) { if (!before) main.push(...chords(cx, cy, r, from, from - TAIL / r)); if (!after) main.push(...chords(cx, cy, r, to, to + TAIL / r)); }
  // on its line both rays start at the vertex: an arc over them needs no line, and past their end it goes out from there
  const ext = onItsLine(d) ? [from, to].flatMap((ray, i) => { const last = feet[i] < d.ang.r ? feet[i] - GAP : d.ang.r; return r > last ? [[cx + (last + GAP) * Math.cos(ray), cy + (last + GAP) * Math.sin(ray), cx + (r + 1) * Math.cos(ray), cy + (r + 1) * Math.sin(ray)]] : []; })
    : [from, to].map((ray, i) => { const f = feet[i], end = f <= r ? r + 1 : r - 1, start = f <= r && r > ends[i] ? Math.max(f, ends[i] + 1) : f; return [cx + start * Math.cos(ray), cy + start * Math.sin(ray), cx + end * Math.cos(ray), cy + end * Math.sin(ray)]; });
  return { x, y, tail, box: boxAt(d, x, y, level ? 0 : upright(t - Math.PI / 2)), ext, main, lines: [...ext, ...main], tips: angleTips(d, r), track: null };
}
function placeAngle(d, ctx) {
  const mask = ctx.views.get(d.view)?.mask ?? null, { from, sweep, feet } = d.ang, to = from + sweep, far = Math.max(...feet), radii = new Set(), byLine = onItsLine(d), least = Math.min(Math.max(5, 2 / sweep), far - 1), nogo = ctx.nogo.filter(r => !(r.soft && ownGuide(d, r)));
  if (byLine) for (let r = least; r <= least + 30; r += r < least + 8 ? 1 : 2) radii.add(r);
  else for (const s of [2, 4, 6, 8, 10, 12, 15, 18, 22, 26, 30, 36, 42]) { radii.add(far + s); if (far - s >= 6) radii.add(far - s); }
  const others = ctx.placed.filter(p => p.id !== d.id);
  let best = null;
  for (const r of radii) {
    const clear = (d.w / 2 + 1.5) / r, dirs = [from + sweep / 2];
    for (let k = 0; k < 4; k++) { const out = clear + k * 5 / r; dirs.push(from - out, to + out); }
    for (const t of dirs) {
      const c = angleCandidate(d, r, t);
      if (c.ext.some(l => lineHitsBox(l, c.box, 0.3)) || conflicts(others, nogo, ctx.rect, c)) continue;
      const crossed = crossings(others, c), channels = inChannels(others, c.box, d.h), cost = (byLine ? (r - least) * 0.5 : Math.abs(r - far) * 0.05) + c.tail * 0.1 + crossed * CROSSING + channels * IN_A_CHANNEL + (onLaterFoot(ctx, d.view, c.box) ? ON_A_FOOT : 0) + softHits(nogo, c) * ON_A_CUT_ARROW + (mask ? c.main.reduce((s, l) => s + mask.lineLen(l), 0) + c.ext.reduce((s, l) => s + mask.lineLen(l), 0) * 0.05 : 0);
      const cand = { ...c, cost, base: cost - crossed * CROSSING, channels };
      offer(ctx, r + '|' + (t > from + sweep ? 2 : t < from ? 0 : 1), cand);
      if (!best || cost < best.cost) best = cand;
    }
  }
  return best;
}
// an angle with a ray that follows no edge (it and the vertex are only in the sketch) does not say what it measures where it is drawn: it goes to an end of the edge it does follow,
// on a construction line parallel to the other ray, where arc and line stay off the part. With an edge on each ray, or on none, it stays. A 45° reads the same from the line square to it
const GUIDE_RADII = [5, 6, 7, 8, 10, 12, 15, 20, 25, 30], GUIDE_PAST = 3, GUIDE_OVER_PART = 2;
export function planAngleGuide(d, view, edges) {
  const mask = view?.mask; if (!mask || !d.ang || d.unit !== 'deg' || !(d.value > 0.5 && d.value < 179.5)) return null;
  const { c: [cx, cy], from, sweep } = d.ang, length = e => Math.hypot(e.end_sheet_mm[0] - e.start_sheet_mm[0], e.end_sheet_mm[1] - e.start_sheet_mm[1]), lines = edges.filter(e => e.kind === 'line' && e.start_sheet_mm && e.end_sheet_mm && length(e) > 0.2);
  const onRay = a => { const ux = Math.cos(a), uy = Math.sin(a), off = p => Math.abs((p[0] - cx) * uy - (p[1] - cy) * ux), at = p => (p[0] - cx) * ux + (p[1] - cy) * uy; return lines.filter(e => off(e.start_sheet_mm) < 0.15 && off(e.end_sheet_mm) < 0.15 && Math.max(at(e.start_sheet_mm), at(e.end_sheet_mm)) > 0.2); };
  const rays = [onRay(from), onRay(from + sweep)];
  if (!rays[0].length === !rays[1].length) return null;
  // the first of a line that opens slowly from its edge is that edge to the grid of the view
  const s = rays[0].length ? 1 : -1, rad = d.value * Math.PI / 180, r0 = Math.max(8, 2 / rad), turns = near(d.value, 45, 0.01) ? [s, -s] : [s], beside = mask.cell / Math.sin(Math.min(rad, Math.PI - rad));
  let best = null;
  for (const e of rays[s > 0 ? 0 : 1]) for (const [at, X, Y] of [['start', e.start_sheet_mm, e.end_sheet_mm], ['end', e.end_sheet_mm, e.start_sheet_mm]]) {
    const inward = Math.atan2(Y[1] - X[1], Y[0] - X[0]), to = (t, u) => [X[0] + t * Math.cos(u), X[1] + t * Math.sin(u)];
    for (const back of [false, true]) for (const k of turns) for (const r of GUIDE_RADII) {
      const dir = inward + (back ? Math.PI : 0), g = dir + k * rad, lo = k > 0 ? dir : g, guide = [...X, ...to(r + GUIDE_PAST, g)], drawn = [];
      if (beside < r + GUIDE_PAST) drawn.push([...to(beside, g), ...to(r + GUIDE_PAST, g)]);
      // ...and the ray goes on past the edge up to the arc
      if (back || r + 1 > length(e)) drawn.push([...(back ? X : Y), ...to(r + 1, dir)]);
      const lengthOver = list => list.reduce((n, l) => n + mask.lineLen(l), 0), over = Math.max(0, lengthOver(chords(X[0], X[1], r, lo, lo + rad)) - mask.cell) + lengthOver(drawn), cost = 3 * over + Math.abs(r - r0) * 0.1;
      if (!best || cost < best.cost) best = { cost, over, e, at, r, guide, turn: (back ? 180 : 0) + k * d.value, text: to(r, lo + rad / 2) };
    }
  }
  if (!best || best.over > GUIDE_OVER_PART) return null;
  const { e, at, r, guide, turn, text } = best;
  return { guides: [{ edge: e.index, at, turn_deg: turn, length_mm: r + GUIDE_PAST }], feet: [{ edge: e.index }, { guide: 0 }], type: 'angle', expect: d.value, position_mm: text, mark: [Math.min(guide[0], guide[2]) - 0.5, Math.min(guide[1], guide[3]) - 0.5, Math.max(guide[0], guide[2]) + 0.5, Math.max(guide[1], guide[3]) + 0.5] };
}
// which views have something to fix; the others stay as they are and their dimensions become obstacles
export function viewsToFix(model, issues) {
  const byId = new Map(model.dims.map(d => [d.id, d])), out = new Set();
  for (const k of ERROR_KINDS) if (k !== 'duplicate') for (const it of issues[k]) for (const id of it.ids) { const v = byId.get(id)?.view; if (v) out.add(v); }
  return out;
}
export function planLayout(model, issues) {
  const targets = viewsToFix(model, issues);
  const rect = [model.margin, model.margin, model.W - model.margin, model.H - model.margin];
  const ctx = { views: model.views, placed: [], nogo: nogoOf(model), rect, feet: new Map() };
  const movable = model.dims.filter(d => targets.has(d.view) && d.mode !== 'fixed' && model.views.has(d.view));
  const fixed = []; for (const d of model.dims) if (!movable.includes(d)) pushPlaced(fixed, d);
  // the feet of those still to come
  const feetLeft = from => { ctx.feet = new Map(); for (const d of from) { const k = d.view + d.mode; ctx.feet.set(k, [...(ctx.feet.get(k) ?? []), d.lin.u0, d.lin.u1]); } };
  const place = d => d.lin ? placeLinear(d, ctx) : d.ang ? placeAngle(d, ctx) : placeFree(d, ctx), put = (d, c, to = ctx.placed) => to.push({ id: d.id, box: c.box, lines: c.lines, ext: c.ext, main: c.main, tails: c.tails, tips: c.tips, track: c.track });
  // the fewer places one has, the sooner it chooses: a round with few directions to point at, those with least first, then the angles, the linear ones, and the rounds that can point almost anywhere
  const ways = d => { const v = model.views.get(d.view), rim = !d.hole_callout && d.unit === 'mm' && v?.scale ? Math.abs(d.value) * v.scale * (d.type === 6 ? 0.5 : 1) : 0; return rim && v.mask ? leaderDirections(d, v.mask, d.rad.center[0], d.rad.center[1], rim).length : 99; };
  // the whole sheet as it stands: what a place costs, and how many lines of it cross others
  const measure = (chosen, unplaced, order, around) => {
    const all = [...around]; for (const d of order) { const c = chosen.get(d.id); if (c) put(d, c, all); else pushPlaced(all, d); }
    const crossedBy = new Map(); for (const p of all) if (chosen.has(p.id)) crossedBy.set(p.id, crossings(all.filter(q => q.id !== p.id), p));
    const crossed = [...crossedBy.values()].reduce((a, b) => a + b, 0);
    return { chosen, unplaced, order, crossed, crossedBy, score: unplaced.length * 1000 + crossed * CROSSED_SHEET + [...chosen.values()].reduce((n, c) => n + c.base, 0) };
  };
  const lay = (order, linear, around) => {
    ctx.placed = [...around];
    const chosen = new Map(), unplaced = [];
    for (let n = 0; n < order.length; n++) {
      const d = order[n]; feetLeft(linear.filter(x => order.indexOf(x) > n));
      const c = place(d);
      if (!c) { unplaced.push(d); pushPlaced(ctx.placed, d); continue; }
      chosen.set(d.id, c); put(d, c);
    }
    // no room for one: the nearest of its view gives up its place if it can find another. Both or nothing
    for (const d of [...unplaced]) {
      const away = x => Math.hypot(chosen.get(x.id).box.x - d.box.x, chosen.get(x.id).box.y - d.box.y);
      for (const x of order.filter(x => chosen.has(x.id)).sort((p, q) => away(p) - away(q)).slice(0, 8)) {
        const saved = ctx.placed;
        ctx.placed = saved.filter(p => p.id !== x.id && p.id !== d.id);
        const c = place(d);
        if (c) put(d, c);
        const other = c ? place(x) : null;
        if (other) { put(x, other); chosen.set(d.id, c); chosen.set(x.id, other); unplaced.splice(unplaced.indexOf(d), 1); break; }
        ctx.placed = saved;
      }
    }
    // a second look, now that all have their place: what still crosses another may find a better one, one at a time and only if it really crosses less
    ctx.feet = new Map();
    for (let round = 0; round < 3; round++) {
      let better = false;
      for (const d of order) {
        if (!chosen.has(d.id)) continue;
        const i = ctx.placed.findIndex(p => p.id === d.id), now = ctx.placed[i];
        ctx.placed.splice(i, 1);
        const n = crossings(ctx.placed, now), c = n ? place(d) : null;
        if (c && crossings(ctx.placed, c) < n) { chosen.set(d.id, c); put(d, c); better = true; } else ctx.placed.splice(i, 0, now);
      }
      if (!better) break;
    }
    return measure(chosen, unplaced, order, around);
  };
  const started = Date.now(), inTime = () => Date.now() - started < PLAN_MS;
  const load = new Map(); for (const d of movable) load.set(d.view, (load.get(d.view) ?? 0) + 1);
  // who chooses first decides the sheet. What found no room chooses sooner the next time; then what came off worst
  const search = (list, around) => {
    const angles = list.filter(d => d.ang && !onItsLine(d)), onLines = list.filter(onItsLine);
    // the busiest view first, as there the tracks run out; shortest first: they get the tracks nearest to the view and the long ones go around them; angles and radial ones take what is left
    const linear = list.filter(d => d.lin).sort((a, b) => load.get(b.view) - load.get(a.view) || a.lin.span - b.lin.span);
    const rounds = list.filter(d => d.rad).map(d => [d, ways(d)]).sort((a, b) => a[1] - b[1]), tied = rounds.filter(r => r[1] <= 36).map(r => r[0]), loose = rounds.filter(r => r[1] > 36).map(r => r[0]);
    let best = null;
    const attempt = next => { const now = lay(next, linear, around); if (!best || now.score < best.score) best = now; return now; };
    tries: for (let next of [[...onLines, ...tied, ...angles, ...linear, ...loose], [...onLines, ...tied, ...linear, ...angles, ...loose], [...onLines, ...linear, ...tied, ...angles, ...loose], [...onLines, ...tied, ...linear, ...loose, ...angles]]) {
      for (let n = 0; n < 4; n++) {
        const now = attempt(next);
        if ((!now.unplaced.length && !now.crossed) || !inTime()) break tries;
        if (!now.unplaced.length) break;
        next = [...now.unplaced, ...next.filter(d => !now.unplaced.includes(d))];
      }
    }
    let last = best;
    for (let round = 0; round < 4 && (last.crossed || last.unplaced.length) && inTime(); round++) {
      const pain = d => last.unplaced.includes(d) ? Infinity : (last.crossedBy.get(d.id) ?? 0) * 100 + last.chosen.get(d.id).base;
      last = attempt([...last.order].sort((a, b) => pain(b) - pain(a)));
    }
    return best;
  };
  // what one order of choosing cannot find. One goes to each of its other places; the other of a crossing pair and whoever stood there take the best they can with that one there
  const allPlaces = d => { ctx.all = new Map(); place(d); const list = [...ctx.all.values()].sort((a, b) => a.cost - b.cost); ctx.all = null; return list; };
  const untangle = sheet => {
    const { chosen, order } = sheet, placedOn = d => { const o = []; put(d, chosen.get(d.id), o); return o; };
    const without = gone => { const o = [...fixed]; for (const d of order) if (!gone.has(d)) { const c = chosen.get(d.id); if (c) put(d, c, o); else pushPlaced(o, d); } return o; };
    const valueOf = (list, rest) => { let n = 0; list.forEach(([, c], i) => { n += crossings(rest, c); for (let j = i + 1; j < list.length; j++) n += countOver(c, list[j][1]); }); return n * 2 * CROSSED_SHEET + list.reduce((v, [, c]) => v + c.base, 0); };
    const move = (p, q) => {
      ctx.placed = [...fixed];
      let found = null, least = Infinity;
      for (const alt of allPlaces(p).slice(0, TRY_PLACES)) {
        if (!inTime()) break;
        const inTheWay = order.filter(d => d !== p && d !== q && chosen.has(d.id) && conflicts(placedOn(d), [], ctx.rect, alt));
        if (inTheWay.length > MAX_IN_THE_WAY) continue;
        const gone = new Set([p, ...(q ? [q] : []), ...inTheWay]), rest = without(gone), now = [[p, alt]];
        ctx.placed = [...rest]; put(p, alt);
        let room = true;
        for (const d of gone) { if (d === p) continue; const c = place(d); if (!c) { room = false; break; } now.push([d, c]); put(d, c); }
        if (!room) continue;
        const value = valueOf(now, rest) - valueOf([...gone].map(d => [d, chosen.get(d.id)]), rest);
        if (value < least) { least = value; found = now; }
      }
      if (found && least < -0.01) { for (const [d, c] of found) chosen.set(d.id, c); return true; }
      return false;
    };
    ctx.feet = new Map();
    for (let round = 0; round < 3 && inTime(); round++) {
      let better = false;
      for (const a of order) for (const b of order) {
        const ca = chosen.get(a.id), cb = chosen.get(b.id);
        if (a === b || !ca || !cb || a.id > b.id || !countOver(ca, cb)) continue;
        if (move(a, b) || move(b, a)) better = true;
      }
      // ...and those that came off worst
      for (const d of [...order].filter(x => chosen.has(x.id)).sort((x, y) => chosen.get(y.id).base - chosen.get(x.id).base).slice(0, TRY_WORST)) if (move(d, null)) better = true;
      if (!better) break;
    }
    return measure(chosen, sheet.unplaced, order, fixed);
  };
  const sheet = untangle(search(movable, fixed));
  const { chosen, unplaced, order } = sheet;
  // the last look: with everyone in place, what is far from where it could be now comes closer, as long as it does not cross more
  ctx.feet = new Map(); ctx.placed = [...fixed];
  for (const d of order) { const c = chosen.get(d.id); if (c) put(d, c); else pushPlaced(ctx.placed, d); }
  // ...and what it chose may have changed around it since: a text that a later dimension shut in between its extension lines pays for that now
  const baseNow = d => { const c = chosen.get(d.id), n = d.lin ? boxedTexts(ctx.placed, c, d.h) : inChannels(ctx.placed, c.box, d.h); return c.base + (n - (c.channels ?? 0)) * IN_A_CHANNEL; };
  for (let round = 0; round < 2; round++) {
    let better = false;
    for (const d of order) {
      if (!chosen.has(d.id)) continue;
      const i = ctx.placed.findIndex(p => p.id === d.id), was = ctx.placed[i];
      ctx.placed.splice(i, 1);
      const c = place(d);
      if (c && c.base < baseNow(d) - 0.01 && crossings(ctx.placed, c) <= crossings(ctx.placed, was)) { chosen.set(d.id, c); put(d, c); better = true; } else ctx.placed.splice(i, 0, was);
    }
    if (!better) break;
  }
  const moves = [];
  for (const d of order) {
    const c = chosen.get(d.id); if (!c) continue;
    // the arrow goes back out with its text
    const arrows = c.arrows ?? (d.arrow_side === 0 ? 'doc' : null), turn = !!arrows && (arrows === 'inside') !== (d.arrow_side === 0);
    if (turn || !near(c.x, d.pos[0], 0.3) || !near(c.y, d.pos[1], 0.3)) moves.push({ id: d.id, pos: [+c.x.toFixed(2), +c.y.toFixed(2)], ...(turn ? { arrows } : {}) });
  }
  return { moves, unplaced: unplaced.map(label), targets: [...targets] };
}
// no room: a view without dimensions (the isometric) goes to the top-right corner, which frees the middle of the sheet
export function planViewMoves(model) {
  const withDims = new Set(model.dims.map(d => d.view)), out = [];
  for (const [name, v] of model.views) {
    if (withDims.has(name)) continue;
    const o = v.outline_mm, by = [model.W - model.margin - o[2], model.H - model.margin - o[3]];
    const moved = [o[0] + by[0], o[1] + by[1], o[2] + by[0], o[3] + by[1]];
    if (Math.hypot(...by) > 1 && ![...model.views].some(([n, w]) => n !== name && boxesOverlap(rectBox(moved), rectBox(w.outline_mm)))) { out.push({ view: name, by: by.map(x => +x.toFixed(2)) }); break; }
  }
  return out;
}
// a diameter inside a view: its leader takes the shortest way out on a slant, as drafters draw it, instead of running through the whole view and over the dimension lines
export function planLeaders(model) {
  const rect = [model.margin, model.margin, model.W - model.margin, model.H - model.margin], moves = [];
  const nogo = nogoOf(model);
  // the name under a section is not in the geometry
  for (const v of model.views.values()) if (v.section) { const c = (v.outline_mm[0] + v.outline_mm[2]) / 2; nogo.push(rectBox([c - 24, v.outline_mm[1] - 18, c + 24, v.outline_mm[1]])); }
  const placed = []; for (const d of model.dims) pushPlaced(placed, d);
  for (const d of model.dims) {
    const vw = model.views.get(d.view), o = vw?.outline_mm; if (d.type !== 6 || d.hole_callout || !d.rad || !o) continue;
    const [cx, cy] = d.rad.center; if (cx <= o[0] || cx >= o[2] || cy <= o[1] || cy >= o[3]) continue;
    const others = placed.filter(p => p.id !== d.id);
    // with an open leader the line starts on the circle; a solid one crosses it
    const from = d.lines.length > 1 || !vw.scale || d.unit !== 'mm' ? 0 : Math.abs(d.value) * vw.scale / 2;
    const cost = (x, y, t) => { const len = Math.hypot(x - cx, y - cy), s = from / (len || 1), leader = [cx + (x - cx) * s, cy + (y - cy) * s, x, y]; return len + (Math.abs(Math.sin(2 * t)) < 0.5 ? 6 : 0) + 15 * others.filter(p => p.box && lineHitsBox(leader, p.box, 0) || countOver({ ext: [], main: [leader], tips: [] }, p)).length; };
    const now = cost(d.pos[0], d.pos[1], Math.atan2(d.pos[1] - cy, d.pos[0] - cx)) + 15 * inChannels(others, d.box, d.h), cands = [];
    // it can only land where the circle really is
    const ranges = vw.mask && vw.scale ? arcRanges(vw.mask, cx, cy, Math.abs(d.value) * vw.scale / 2) : null;
    for (const deg of [0, 180, 30, -30, 150, -150, 45, -45, 135, -135]) {
      const t = deg * Math.PI / 180, dx = Math.cos(t), dy = Math.sin(t), tx = dx > 0 ? (o[2] - cx) / dx : (o[0] - cx) / dx, ty = dy > 1e-9 ? (o[3] - cy) / dy : dy < -1e-9 ? (o[1] - cy) / dy : Infinity;
      if (ranges?.length && !ranges.some(([s, w]) => mod(t - s) <= w)) continue;
      for (const extra of [0, 6, 12, 18, 24, 32, 40]) {
        const r = Math.min(tx, ty) + d.w / 2 + 4 + extra, x = cx + dx * r, y = cy + dy * r;
        const c = { box: boxAt(d, x, y, leaderLevel(d) ? d.angle : dx < 0 ? t + Math.PI : t), lines: [[cx + dx * from, cy + dy * from, x + dx * leaderPast(d), y + dy * leaderPast(d)]], track: null };
        if (!conflicts(others, nogo, rect, c)) cands.push({ x, y, cost: cost(x, y, t) + 15 * inChannels(others, c.box, d.h), box: c.box, lines: c.lines });
      }
    }
    const best = cands.sort((a, b) => a.cost - b.cost)[0];
    if (best && best.cost < now - 3) {
      moves.push({ id: d.id, pos: [+best.x.toFixed(2), +best.y.toFixed(2)] });
      // the next one has to see it where it went
      Object.assign(placed.find(p => p.id === d.id), { box: best.box, lines: best.lines, ext: [], main: best.lines, tails: [], tips: [] });
    }
  }
  return moves;
}

// --- talking to SolidWorks
async function call(worker, op, args, signal) {
  const r = await worker.call(op, args, { signal });
  if (!r.ok) throw new Error(r.error?.message ?? r.error ?? `${op} failed`);
  return r.result;
}
const trim = issues => Object.fromEntries(Object.entries(issues).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 12).map(({ ids, ...x }) => x)]));
// what moving texts cannot fix: too many dimensions, all in one view, no section of a hollow part
export function reviewDimensions(model, hollows, sizes = null) {
  const dims = model.dims.filter(d => d.name && !d.hole_callout && model.views.has(d.view)), measures = measuresOf(dims);
  const plan = sizes ? planNeeded(sizes, measures, model.views, { callouts: calloutValues(model.dims) }) : planReduction(measures, { pattern_sketches: patternSketches(measures, holeCountsOf(hollows)) });
  const perView = new Map(); for (const d of dims) perView.set(d.view, (perView.get(d.view) ?? 0) + 1);
  const part = [...model.views.values()].filter(v => v.model_type === 1), ortho = part.filter(v => !v.section && lookAxis(v) !== null);
  const looks = new Set(ortho.map(lookAxis)), others = part.filter(v => v.section || lookAxis(v) !== null).length;
  const share = dims.length ? Math.max(...perView.values()) / dims.length : 0;
  const out = {
    repeated_or_redundant: plan.dropped.length, // sizes said twice, that come from adding others, or that place each hole of a pattern
    ...(sizes ? { missing_to_make_the_part: plan.report.missing, ...(plan.report.not_checked ? { not_checked: plan.report.not_checked } : {}) } : {}),
    busiest_view_share: +share.toFixed(2),
    crowded_in_one_view: dims.length >= 8 && others > 1 && share > 0.7,
    missing_views: part.length ? [2, 1, 0].filter(a => !looks.has(a)).map(a => AXIS_VIEW[a]) : [],
    section_missing: !!hollows && ((hollows.holes ?? []).length + (hollows.features ?? []).length > 0) && !part.some(v => v.section),
  };
  out.needs_organize = out.repeated_or_redundant > 0 || (out.missing_to_make_the_part?.length ?? 0) > 0 || out.crowded_in_one_view || out.missing_views.length > 0 || out.section_missing;
  return out;
}
// what a hole note already says
const calloutValues = dims => dims.filter(d => d.hole_callout).flatMap(d => { const m = String(d.text ?? '').match(/<MOD-DIAM>\s*([\d.]+)/); return m ? [+m[1]] : d.unit === 'mm' && d.value > 0 ? [d.value] : []; });
// the faces of the part of this sheet; nothing if the worker cannot tell, or its views show another configuration than the one open
async function partSizes(worker, sh, signal) {
  try { const s = await call(worker, 'drawing_part_sizes', sh, signal); return Array.isArray(s.planes) && !s.configuration_differs ? s : null; } catch { return null; }
}
const ADVICE = 'Hay demasiadas cotas para el espacio: agranda la hoja, baja la escala de las otras vistas, aumenta la de esta o reparte las cotas en otra vista o en un corte.';
const ratio = s => s >= 1 ? +s.toFixed(3) + ':1' : '1:' + +(1 / s).toFixed(3);
// the view that carries the most, its scale and the next one up (to 1:1 at most)
export function crowdedAdvice(perView, views, errors) {
  const [name, n] = Object.entries(perView).sort((a, b) => b[1] - a[1])[0] ?? ['', 0], k = views.get(name)?.scale, total = Object.values(perView).reduce((s, x) => s + x, 0);
  return 'La vista ' + name + ' lleva ' + n + ' de las ' + total + ' cotas' + (k ? ' a escala ' + ratio(k) : '') + ' y quedan ' + errors + ' problemas sin acomodar: súbele la escala' + (k && k < 1 ? ' (' + ratio(Math.min(1, k * 2)) + ')' : '') + ' si la hoja tiene lugar, o agranda la hoja.';
}
// what each view really occupies; without it the frame of the view stands for the part, as it always did
async function viewShapes(worker, sh, signal) {
  try { return await call(worker, 'drawing_dim_shapes', sh, signal); } catch { return null; }
}

async function superviseSheet(worker, args, sheet, signal) {
  const docArgs = { document_id: args.document_id, sheet }, shapes = args.shapes ?? await viewShapes(worker, docArgs, signal);
  const read = async () => { const m = readSheet(await call(worker, 'drawing_dim_geometry', docArgs, signal), { ...args, shapes }); const i = findIssues(m); return { model: m, issues: i, errors: errorCount(i) }; };
  let cur = await read();
  const before = cur, row = { sheet, dimensions: cur.model.dims.length, errors_before: cur.errors, found_before: summarize(cur.issues) };
  if (args.fix && cur.errors > 0) {
    const deleted = [], moved = new Set(), viewMoves = [];
    if (args.delete_duplicates !== false && cur.issues.duplicate.length) {
      const ids = cur.issues.duplicate.flatMap(g => g.ids);
      const r = await call(worker, 'drawing_dim_apply', { ...docArgs, deletes: ids }, signal);
      deleted.push(...cur.issues.duplicate.flatMap(g => g.repeated).slice(0, r.deleted.length)); cur = await read();
    }
    const apply = moves => call(worker, 'drawing_dim_apply', { ...docArgs, moves }, signal);
    // what to send to have these dimensions as they are in a sheet already read
    const back = (from, now, ids) => { const was = new Map(from.model.dims.map(d => [d.id, d])), is = new Map(now.model.dims.map(d => [d.id, d])); return ids.filter(id => was.has(id)).map(id => { const w = was.get(id), turn = w.arrow_side !== is.get(id)?.arrow_side; return { id, pos: w.pos, ...(turn ? { arrows: w.arrow_side === 0 ? 'inside' : 'doc' } : {}) }; }); };
    let best = cur, arranged = args.arrange_views === false, unplaced = [];
    for (let pass = 0; pass < (args.max_passes ?? 4) && best.errors > 0; pass++) {
      const plan = planLayout(cur.model, cur.issues);
      unplaced = plan.unplaced;
      if (plan.unplaced.length && !arranged) {
        arranged = true;
        const vm = planViewMoves(cur.model);
        if (vm.length) { await call(worker, 'drawing_dim_apply', { ...docArgs, view_moves: vm }, signal); viewMoves.push(...vm); cur = await read(); best = cur; pass--; continue; }
      }
      if (!plan.moves.length) break;
      const ids = plan.moves.map(m => m.id), was = best;
      await apply(plan.moves);
      ids.forEach(id => moved.add(id));
      cur = await read();
      if (cur.errors < best.errors) { best = cur; continue; }
      // worse or equal: back to the best sheet seen, measured again...
      await apply(back(was, cur, ids));
      cur = await read(); best = cur;
      // ...and a plan may be good in one view and bad in another: each view on its own, kept only if the sheet really gets better
      const viewOf = new Map(cur.model.dims.map(d => [d.id, d.view])), byView = new Map();
      for (const m of plan.moves) byView.set(viewOf.get(m.id), [...(byView.get(viewOf.get(m.id)) ?? []), m]);
      let kept = false;
      if (byView.size > 1) for (const moves of byView.values()) {
        await apply(moves);
        const now = await read();
        if (now.errors < best.errors) { best = cur = now; kept = true; continue; }
        await apply(back(best, now, moves.map(m => m.id)));
        cur = await read(); best = cur;
      }
      if (!kept) break;
    }
    Object.assign(row, { deleted, texts_moved: moved.size, views_moved: viewMoves, not_placed: unplaced.slice(0, 20) });
    if (unplaced.length && cur.errors) row.advice = ADVICE;
    // a section has its hatching cut around what was on it: moved away, the hatching has to be drawn again
    if ((moved.size || viewMoves.length) && [...cur.model.views.values()].some(v => v.section)) await call(worker, 'drawing_dim_apply', { ...docArgs, rebuild: true }, signal);
  }
  Object.assign(row, { errors: cur.errors, found: summarize(cur.issues), details: trim(cur.issues) });
  let hollows = null; const partModels = new Set([...cur.model.views.values()].filter(v => v.model_type === 1).map(v => v.model));
  if (partModels.size) try { hollows = await call(worker, 'drawing_part_hollows', docArgs, signal); } catch { }
  row.review = reviewDimensions(cur.model, hollows, partModels.size === 1 ? await partSizes(worker, docArgs, signal) : null);
  if (before !== cur) row.improved = cur.errors < before.errors;
  return row;
}
// check (fix false) or check and fix one drawing, every sheet unless args.sheet; leaves the active sheet as it was
export async function superviseDimensions(worker, args, { signal } = {}) {
  const first = await call(worker, 'drawing_dim_geometry', { document_id: args.document_id, ...(args.sheet ? { sheet: args.sheet } : {}) }, signal);
  const sheets = args.sheet ? [args.sheet] : first.sheets, rows = [];
  try { for (const s of sheets) rows.push(await superviseSheet(worker, args, s, signal)); }
  finally { await worker.call('drawing_dim_geometry', { document_id: args.document_id, sheet: first.active_sheet }, { signal }).catch(() => {}); }
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  return { clean: errors === 0, errors, needs_organize: rows.some(r => r.review?.needs_organize), sheets: rows, note: args.fix ? (errors ? `Quedan ${errors} problemas de cotas que no se pudieron acomodar solos. Sin guardar: revisa con sw_preview o el PDF y luego sw_save.` : 'Cotas sin choques medidos. Sin guardar: revisa con sw_preview o el PDF y luego sw_save.') : (errors ? `${errors} problemas de cotas; fix true los acomoda.` : 'Cotas sin choques medidos.') };
}
// --- fewer dimensions, in the three views (the same sheet again, its author: "no debes de repetir cotas... distribuirlas en las 3 vistas").
// One drawing says each size once. SolidWorks only inserts a model dimension in a view if no other view shows it, so the views where
// it can live are found by clearing and inserting view by view; deleting it from a view and inserting it in another moves it.
const VAL = v => Math.round(v * 100) / 100;
// what Insert Model Items can bring back; one not marked for drawing, or a radius (its arc may be hidden in every view and it would be lost), stays in its view
const isSheetDim = d => /^RD\d+@/.test(d.name ?? '');
// ...with the other foot on a line drawn for it: the end of that line for a length, the line itself for an angle. A length from a whole line of the view hangs from the line of a section
const onThePart = d => { const part = k => /EDGES|VERTICES|FACES|SILHOUETTE/.test(k), guide = d.type === 3 ? /SKETCHSEGS/ : /SKETCHPOINTS/; return (d.attached ?? []).some(part) && d.attached.every(k => part(k) || guide.test(k)); };
const modelDim = d => !!d.name && !isSheetDim(d) && !d.hole_callout && d.marked !== false && d.type !== 5;
const dimClass = d => d.type === 6 ? 'D' : d.type === 5 ? 'R' : d.type === 3 ? 'A' : d.type === 4 ? 'C' : d.lin ? 'L' : 'X';
const pairs = m => m.dims.filter(d => d.lin).map(d => d.view + '|' + d.mode);
// points of one view and direction that a chain of dimensions connects (positions closer than EPS are one point)
function chainGraph() {
  const nodes = new Map(), parent = [];
  const id = (k, u) => { let a = nodes.get(k); if (!a) nodes.set(k, a = []); const hit = a.find(n => near(n.u, u)); if (hit) return hit.i; const i = parent.length; parent.push(i); a.push({ u, i }); return i; };
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  return { joined: (k, u0, u1) => find(id(k, u0)) === find(id(k, u1)), join: (k, u0, u1) => { parent[find(id(k, u0))] = find(id(k, u1)); } };
}
// measures: one per model dimension, with its appearance in each view where it can live. Returns what stays, what goes and why.
export function planReduction(measures, opts = {}) {
  const dropped = [], ref = opts.reference_values, inRef = v => ref.some(x => Math.abs(x - v) <= Math.max(0.01, Math.abs(x) * 0.0005));
  const say = (m, why) => dropped.push({ dimension: m.name, value: m.value, why });
  let rest = measures;
  // a reference sheet decides which sizes the drawing shows
  if (ref?.length) { rest = []; for (const m of measures) if (inRef(m.value)) rest.push(m); else say(m, 'no está en el plano de referencia'); }
  // the sum of other dimensions adds nothing: chain and overall size stay, positions measured from an origin go
  else {
    // a pattern of holes: its pitch and its distance to the contour say where all of them are
    const pat = opts.pattern_sketches;
    if (pat?.size) rest = rest.filter(m => {
      const keep = pat.get(sketchOf(m.name));
      if (!keep || (m.cls !== 'L' && m.cls !== 'X') || keep.some(v => near(v, m.value, 0.01))) return true;
      say(m, 'posición de un barreno del patrón: basta la separación y la distancia al contorno'); return false;
    });
    const g = chainGraph(), lens = rest.filter(m => m.cls === 'L').sort((a, b) => a.value - b.value), total = lens[lens.length - 1], feet = new Set();
    const links = (m, f) => m.dims.filter(d => d.lin).forEach(d => f(d.view + '|' + d.mode, d.lin.u0, d.lin.u1));
    for (const m of lens) {
      let closes = false; links(m, (k, a, b) => { if (g.joined(k, a, b)) closes = true; });
      const same = m.dims.some(d => d.lin && feet.has(d.view + '|' + d.mode + '|' + d.lin.u0.toFixed(1) + '|' + d.lin.u1.toFixed(1)));
      if (closes && (m !== total || same)) { say(m, 'sale de sumar otras cotas'); continue; }
      links(m, (k, a, b) => { g.join(k, a, b); feet.add(k + '|' + a.toFixed(1) + '|' + b.toFixed(1)); });
    }
    const gone = new Set(dropped.map(x => x.dimension));
    rest = rest.filter(m => !gone.has(m.name));
  }
  // the same size again: once, saying how many when that is known for certain (real holes of the part), TIP. otherwise
  const kept = [], holeCount = opts.hole_counts ?? {};
  const sameGroup = (a, b) => a.cls === b.cls && VAL(a.value) === VAL(b.value) && (a.cls === 'D' || a.cls === 'R' || (a.cls === 'L' ? pairs(a).some(p => pairs(b).includes(p)) : a.dims.some(x => b.dims.some(y => x.view === y.view))));
  for (const m of rest) {
    if (m.cls === 'X') { kept.push({ ...m, same: 1 }); continue; }
    const k = kept.find(x => sameGroup(x, m));
    if (k) { k.same++; say(m, 'misma medida que ' + k.name); } else kept.push({ ...m, same: 1 });
  }
  for (const k of kept) {
    const n = k.cls === 'D' ? holeCount[VAL(k.value)] ?? 0 : 0;
    if (n > 1 && n >= k.same) k.prefix = n + ' X <MOD-DIAM>'; else if (k.same > 1) k.suffix = ' TYP';
  }
  const missing = ref?.length ? ref.filter(x => !measures.some(m => Math.abs(x - m.value) <= Math.max(0.01, Math.abs(x) * 0.0005))) : [];
  return { kept, dropped, reference_not_found: missing };
}
const sketchOf = name => String(name).split('@')[1];
const holeCountsOf = hollows => { const n = {}; for (const h of hollows?.holes ?? []) n[VAL(h.diameter_mm)] = (n[VAL(h.diameter_mm)] ?? 0) + 1; return n; };
// the sketches that draw a size of hole the part has more than once: what is linear in them only places holes
export function patternSketches(measures, holeCounts) {
  const out = new Map();
  for (const m of measures) if (m.cls === 'D' && (holeCounts[VAL(m.value)] ?? 0) >= 2 && !out.has(sketchOf(m.name))) out.set(sketchOf(m.name), []);
  return out;
}
// A pattern of equal holes in the view that sees them as circles: the distance between two neighbours and from a hole to the contour.
// Null when they are not evenly spaced: then each position means something and they stay. keep: what is the size of the part, never a position.
export function planHolePattern(edges, diameter, scale = 1) {
  const at = e => e.center_sheet_mm, gap = (a, b) => Math.hypot(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1]);
  const rounds = edges.filter(e => (e.kind === 'circle' || e.kind === 'arc') && at(e)), holes = [];
  // a through hole has two circles, one over the other
  for (const e of rounds) if (e.kind === 'circle' && near(e.diameter_mm, diameter, 0.01) && !holes.some(h => gap(h, e) < 0.1)) holes.push(e);
  if (holes.length < 2) return null;
  const TOL = 0.06, R = e => e.diameter_mm * scale / 2, nearest = h => Math.min(...holes.filter(o => o !== h).map(o => gap(h, o)));
  const pitch = nearest(holes[0]); if (holes.some(h => !near(nearest(h), pitch, TOL))) return null;
  const cx = holes.reduce((s, h) => s + at(h)[0], 0) / holes.length, cy = holes.reduce((s, h) => s + at(h)[1], 0) / holes.length;
  const dirOf = (dx, dy) => Math.abs(dy) < TOL ? 'horizontal' : Math.abs(dx) < TOL ? 'vertical' : 'smart';
  // the rim they are drilled in: the smallest circle around them, a bigger one is another part of the piece seen behind
  const contour = rounds.filter(e => e.diameter_mm > diameter && holes.every(h => gap(h, e) + R(h) < R(e)) && holes.every(h => near(gap(h, e), gap(holes[0], e), TOL))).sort((a, b) => a.diameter_mm - b.diameter_mm)[0];
  const pairs = holes.flatMap((a, i) => holes.slice(i + 1).filter(b => near(gap(a, b), pitch, TOL)).map(b => [a, b]));
  const pitchDim = ([a, b], off) => {
    const dx = at(b)[0] - at(a)[0], dy = at(b)[1] - at(a)[1], type = dirOf(dx, dy), mid = [(at(a)[0] + at(b)[0]) / 2, (at(a)[1] + at(b)[1]) / 2];
    return { what: 'separación entre barrenos', edges: [a.index, b.index], type, expected_mm: gap(a, b) / scale, position_mm: type === 'horizontal' ? [mid[0], mid[1] + off] : [mid[0] + off, mid[1]] };
  };
  if (contour) {
    const c = at(contour), out = R(contour) + 10, pair = [...pairs].sort((p, q) => (dirOf(q[0].center_sheet_mm[0] - q[1].center_sheet_mm[0], q[0].center_sheet_mm[1] - q[1].center_sheet_mm[1]) !== 'smart') - (dirOf(p[0].center_sheet_mm[0] - p[1].center_sheet_mm[0], p[0].center_sheet_mm[1] - p[1].center_sheet_mm[1]) !== 'smart') || (at(q[0])[1] + at(q[1])[1]) - (at(p[0])[1] + at(p[1])[1]))[0];
    // the hole straight beside the centre, so the dimension runs along the sheet
    const hole = [...holes].sort((p, q) => (dirOf(at(q)[0] - c[0], at(q)[1] - c[1]) !== 'smart') - (dirOf(at(p)[0] - c[0], at(p)[1] - c[1]) !== 'smart') || at(q)[0] - at(p)[0])[0];
    const type = dirOf(at(hole)[0] - c[0], at(hole)[1] - c[1]), a = pitchDim(pair, c[1] + out - (at(pair[0])[1] + at(pair[1])[1]) / 2);
    return { contour_diameter: contour.diameter_mm, keep: [], dims: [a, { what: 'contorno a barreno', edges: [hole.index, contour.index], type, arc_end: ['center', 'min'], expected_mm: (R(contour) - gap(hole, contour)) / scale, position_mm: type === 'horizontal' ? [c[0] + R(contour) * 0.8, c[1] - out] : [c[0] + out, c[1] + R(contour) * 0.8] }] };
  }
  // no rim around them: what they turn around, and how far
  const hub = holes.length >= 3 ? rounds.filter(e => !holes.includes(e) && holes.every(h => gap(h, e) > R(h) + TOL && near(gap(h, e), gap(holes[0], e), TOL))).sort((a, b) => b.diameter_mm - a.diameter_mm)[0] : null;
  if (hub) {
    const c = at(hub), dirOfPair = p => dirOf(at(p[0])[0] - at(p[1])[0], at(p[0])[1] - at(p[1])[1]), pair = [...pairs].sort((p, q) => (dirOfPair(q) !== 'smart') - (dirOfPair(p) !== 'smart'))[0];
    const hole = [...holes].sort((p, q) => (dirOf(at(q)[0] - c[0], at(q)[1] - c[1]) !== 'smart') - (dirOf(at(p)[0] - c[0], at(p)[1] - c[1]) !== 'smart'))[0], type = dirOf(at(hole)[0] - c[0], at(hole)[1] - c[1]), out = gap(hole, hub) + R(hole) + 10, mid = [(at(hole)[0] + c[0]) / 2, (at(hole)[1] + c[1]) / 2];
    // all the way round, the separation and how many say the circle; with a place empty, its radius too
    const full = near(pitch, 2 * gap(hole, hub) * Math.sin(Math.PI / holes.length), TOL), sep = pitchDim(pair, c[1] + out - (at(pair[0])[1] + at(pair[1])[1]) / 2);
    return { contour_diameter: null, keep: [], dims: full ? [sep] : [sep, { what: 'radio del círculo de barrenos', edges: [hole.index, hub.index], type, expected_mm: gap(hole, hub) / scale, position_mm: type === 'vertical' ? [c[0] + out, mid[1]] : [mid[0], c[1] - out] }] };
  }
  // a plate: rows and columns evenly spaced, each from its edge. The overall size of the plate is not a position.
  const lines = edges.filter(e => e.kind === 'line' && e.start_sheet_mm && e.end_sheet_mm), dims = [], keep = [];
  for (const [i, type, cross] of [[0, 'horizontal', 'vertical'], [1, 'vertical', 'horizontal']]) {
    const ends = lines.filter(l => near(l.start_sheet_mm[i], l.end_sheet_mm[i], 0.02)), side = ends.sort((a, b) => a.start_sheet_mm[i] - b.start_sheet_mm[i]);
    if (!side.length) return null;
    keep.push(+((side[side.length - 1].start_sheet_mm[i] - side[0].start_sheet_mm[i]) / scale).toFixed(2));
    const vals = [...holes].sort((a, b) => at(a)[i] - at(b)[i]), first = vals[0], stops = vals.map(h => at(h)[i]).filter((v, k, a) => !k || v - a[k - 1] > TOL);
    if (stops.length > 1) {
      const step = stops[1] - stops[0]; if (stops.some((v, k) => k && !near(v - stops[k - 1], step, TOL))) return null;
      const pair = pairs.find(([a, b]) => dirOf(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1]) === type); if (!pair) return null;
      dims.push(pitchDim(pair, -12));
    }
    if (side[0].start_sheet_mm[i] >= at(first)[i]) return null;
    const dist = at(first)[i] - side[0].start_sheet_mm[i], pos = i === 0 ? [at(first)[0] - dist / 2, at(first)[1] + 12] : [at(first)[0] + 12, at(first)[1] - dist / 2];
    dims.push({ what: 'contorno a barreno', edges: [side[0].index, first.index], type, expected_mm: dist / scale, position_mm: pos });
  }
  return { keep, dims };
}
// the last touches between a text and a line: a small step of the text, read back, kept only if the sheet really has fewer problems
const issueCount = m => Object.values(findIssues(m)).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
export function nudgeSteps(d) {
  const out = [];
  if (d.mode === 'free' && d.rad) { const dx = d.pos[0] - d.rad.center[0], dy = d.pos[1] - d.rad.center[1], n = Math.hypot(dx, dy) || 1; for (const s of [4, 8, 12]) out.push([dx / n * s, dy / n * s]); }
  else if (d.mode === 'h' || d.mode === 'v') for (const s of [3, -3, 6, -6, 9, -9]) { out.push([s, 0]); out.push([0, s]); }
  else if (d.mode === 'angle') { const [cx, cy] = d.ang.c, r = Math.hypot(d.pos[0] - cx, d.pos[1] - cy), t = Math.atan2(d.pos[1] - cy, d.pos[0] - cx); for (const [dr, dt] of [[4, 0], [-4, 0], [8, 0], [0, 10], [0, -10], [4, 10], [4, -10]]) { if (r + dr < 5) continue; const q = t + dt * Math.PI / 180; out.push([cx + (r + dr) * Math.cos(q) - d.pos[0], cy + (r + dr) * Math.sin(q) - d.pos[1]]); } }
  return out;
}
async function nudgeTexts(worker, sh, read, signal, maxTries = 12) {
  let m = await read(), best = issueCount(m), moved = 0, tries = 0;
  const start = best;
  for (let round = 0; round < 6 && best > 0 && tries < maxTries; round++) {
    const f = findIssues(m), ids = [...new Set([...f.text_on_line, ...f.text_overlap, ...f.line_on_note, ...f.lines_over].flatMap(x => x.ids ?? []))];
    let better = false;
    for (const id of ids) {
      const d = m.dims.find(x => x.id === id); if (!d) continue;
      for (const [dx, dy] of nudgeSteps(d)) {
        if (++tries > maxTries) break;
        await call(worker, 'drawing_dim_apply', { ...sh, moves: [{ id, pos: [d.pos[0] + dx, d.pos[1] + dy] }] }, signal);
        const n = await read(), c = issueCount(n);
        if (c < best) { best = c; m = n; moved++; better = true; break; }
        await call(worker, 'drawing_dim_apply', { ...sh, moves: [{ id, pos: d.pos }] }, signal);
      }
      if (better) break;
    }
    if (!better) break;
  }
  return { moved, issues_before: start, issues_after: best };
}
async function addHolePatterns(worker, sh, views, measures, hollows, holeCounts, warnings, signal, only = null) {
  const sketches = new Map(), prefer = new Map(), names = [], report = [];
  const sizes = only ? only.map(v => measures.find(m => m.cls === 'D' && VAL(m.value) === v) ?? { name: '@' + v, cls: 'D', value: v }) : measures.filter(m => m.cls === 'D' && (holeCounts[VAL(m.value)] ?? 0) >= 2);
  for (const m of sizes) {
    if (sketches.has(sketchOf(m.name))) continue;
    const hole = (hollows.holes ?? []).find(h => VAL(h.diameter_mm) === VAL(m.value)), axis = hole?.axis.findIndex(x => Math.abs(x) > 0.99);
    const view = views.find(v => !v.section && lookAxis(v) === axis); if (!view) continue;
    const probe = await call(worker, 'drawing_dimension', { ...sh, view: view.name, action: 'probe', max_edges: 1000 }, signal);
    // with the faces of the part known, what is still missing is said by the plan
    const plan = planHolePattern(probe.edges ?? [], m.value, probe.scale); if (!plan) { if (!only) warnings.push('Los barrenos Ø' + VAL(m.value) + ' no están parejos: se quedan sus cotas de posición.'); continue; }
    const made = [];
    try {
      for (const p of plan.dims) {
        const { what, expected_mm, ...add } = p, r = await call(worker, 'drawing_dimension', { ...sh, view: view.name, action: 'add', ...add }, signal);
        made.push(r.name);
        // what SolidWorks measures decides, never what was expected
        if (Math.abs(r.value - expected_mm) > Math.max(0.5, expected_mm * 0.01)) throw new Error(what + ' mide ' + r.value + ' y debía medir ' + expected_mm.toFixed(2));
        report.push({ what, value: r.value, view: view.name });
      }
    } catch (e) {
      const g = await call(worker, 'drawing_dim_geometry', sh, signal), ids = g.dimensions.filter(d => made.includes(d.name)).map(d => d.id);
      if (ids.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: ids }, signal);
      warnings.push('Patrón de barrenos Ø' + VAL(m.value) + ': ' + e.message + '. Se quedan sus cotas de posición.'); continue;
    }
    names.push(...made); sketches.set(sketchOf(m.name), plan.keep); prefer.set(m.name, view.name);
    if (plan.contour_diameter) for (const c of measures) if (c.cls === 'D' && near(c.value, plan.contour_diameter, 0.01)) prefer.set(c.name, view.name);
  }
  return { sketches, prefer, names, report };
}
// what the part needs and no dimension of the model says: made on the sheet from the edges of a view, the emptiest first; what SolidWorks measures decides.
// One at a time and the plan again after each: what it can stop asking for depends on what really came out. What no view can show is left out of the next plan
const MAX_MADE = 24;
const sameNeed = (a, b) => a.kind === b.kind && a.value === b.value && a.axis === b.axis && JSON.stringify(a.pairs ?? []) === JSON.stringify(b.pairs ?? []);
async function addNeeded(worker, sh, firstPlan, replan, viewNames, read, signal) {
  const names = [], failed = [], cannot = new Set(), probes = new Map(), lines = [];
  const edgesOf = async name => { if (!probes.has(name)) probes.set(name, (await call(worker, 'drawing_dimension', { ...sh, view: name, action: 'probe', max_edges: 2000 }, signal)).edges ?? []); return probes.get(name); };
  const dropName = async name => { const g = await call(worker, 'drawing_dim_geometry', sh, signal), ids = g.dimensions.filter(d => d.name === name).map(d => d.id); if (ids.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: ids }, signal); };
  let plan = firstPlan;
  for (let guard = 0; guard < 200; guard++) {
    const need = plan.missing.find(n => !n.unreachable && !cannot.has(sizeKey(n)));
    if (!need) break;
    // no sheet takes this many: what asks for them is something the plan does not understand, it is said and nothing more is made
    if (names.length >= MAX_MADE) { lines.push('pide más de ' + MAX_MADE + ' cotas nuevas: se detuvo, revisa la pieza a ojo'); break; }
    const m = await read(), count = n => m.dims.filter(d => d.view === n).length;
    const views = [...m.views.values()].filter(v => viewNames.includes(v.name)).sort((a, b) => (a.section ? 1 : 0) - (b.section ? 1 : 0) || count(a.name) - count(b.name));
    const offers = [], walls = [[m.W, 0, m.W + 1, m.H], [-1, 0, 0, m.H], [0, -1, m.W, 0], [0, m.H, m.W, m.H + 1], ...(m.title ? [m.title] : [])];
    for (const v of views) for (const o of dimensionsFromEdges(need, v, await edgesOf(v.name), [...walls, ...[...m.views.values()].filter(w => w !== v && w.outline_mm).map(w => w.outline_mm)])) offers.push({ ...o, view: v.name });
    // the pair the plan prefers before the emptiest view
    const place = o => (need.pairs ?? []).findIndex(p => o.pair && p[0] === o.pair[0] && p[1] === o.pair[1]);
    offers.sort((p, q) => place(p) - place(q));
    let done = null;
    for (const { expected, pair, view, ...add } of offers) {
      let r; try { r = await call(worker, 'drawing_dimension', { ...sh, view, action: 'add', ...add }, signal); } catch (e) { lines.push((need.what ?? need.kind) + ' ' + need.value + ' en ' + view + ': ' + e.message); continue; }
      if (Math.abs(r.value - expected) <= Math.max(0.02, expected * 0.001)) { done = r; break; }
      lines.push((need.what ?? need.kind) + ' ' + need.value + ' en ' + view + ': midió ' + r.value + ' y debía ser ' + VAL(expected));
      await dropName(r.name);
    }
    const cannotDo = () => { if (need.kind === 'L') for (const [u, v] of need.pairs) cannot.add(pairKey(need.axis, u, v)); else cannot.add(sizeKey(need)); failed.push(need); };
    if (done) names.push(done.name); else cannotDo();
    plan = await replan(names, cannot);
    // it came out and the plan asks for it again: it could not be read back, one more would only be a copy of it
    if (done && plan.missing.some(n => sameNeed(n, need))) { names.pop(); await dropName(done.name); lines.push((need.what ?? need.kind) + ' ' + need.value + ': salió pero no se puede leer dónde mide'); cannotDo(); plan = await replan(names, cannot); }
  }
  return { names, failed, cannot, plan, lines };
}
export const addNeededForTest = addNeeded;
export const candidatesForTest = { linearCandidate, angleCandidate };
// how a view shows a round: 2 the whole circle, 1 an arc of it, 0 not at all or not known
function roundShown(d, v) {
  if ((d.type !== 5 && d.type !== 6) || !v?.mask || !v.scale || d.unit !== 'mm') return 0;
  const r = Math.abs(d.value) * v.scale * (d.type === 6 ? 0.5 : 1);
  if (d.rad && d.mode === 'free') { const ranges = arcRanges(v.mask, d.rad.center[0], d.rad.center[1], r); return ranges === null ? 2 : ranges.length ? 1 : 0; }
  if (!d.lin) return 0;
  const k = d.mode === 'h' ? 0 : 1, mid = (d.lin.u0 + d.lin.u1) / 2, hits = v.mask.arcs.filter(a => !a.curve && near(a.r, r, 0.05) && near(a.center[k], mid, 0.1));
  return hits.some(a => a.full) ? 2 : hits.length ? 1 : 0;
}
// each dimension to one view where it can live: as many as the size of the view allows, a circle where it is seen as a circle, a chain
// together when the load allows it, what is inside the part in the section
export function assignViews(kept, views, opts = {}) {
  const names = [...new Set(kept.flatMap(m => m.dims.map(d => d.view)))];
  const perim = n => { const o = views.get(n)?.outline_mm; return o ? (o[2] - o[0]) + (o[3] - o[1]) : 100; };
  const sum = names.reduce((s, n) => s + perim(n), 0), ideal = Object.fromEntries(names.map(n => [n, Math.max(1, kept.length * perim(n) / sum)]));
  const load = Object.fromEntries(names.map(n => [n, 0])), feetOf = new Map(), out = new Map(), rank = { D: 0, R: 0, C: 0, A: 1, L: 2, X: 3 };
  const inside = opts.hollow_names ?? new Set(), isHollow = m => [...inside].some(n => m.name.includes('@' + n + '@'));
  const order = [...kept].sort((a, b) => new Set(a.dims.map(d => d.view)).size - new Set(b.dims.map(d => d.view)).size || rank[a.cls] - rank[b.cls] || b.value - a.value);
  for (const m of order) {
    let best = null;
    for (const d of m.dims) {
      let cost = (load[d.view] + 1) / ideal[d.view];
      // inside the part: its size in the section; where the holes are, in the view that sees them as circles
      if (views.get(d.view)?.section && isHollow(m) && m.cls !== 'L') cost -= 1.5;
      if (isHollow(m) && m.cls === 'L' && opts.hole_axes?.has(lookAxis(views.get(d.view) ?? {}))) cost -= 2;
      // a circle where it is seen as a circle. A radius where its arc is not seen would point at nothing. The section is for what is inside
      const v = views.get(d.view), shown = roundShown(d, v);
      if (v?.section && !isHollow(m)) cost += 0.5;
      if (d.rad && d.mode === 'free' && !v?.mask) cost -= 0.6;
      else if (shown) cost -= shown === 2 ? 1.5 : 0.6;
      else if (d.rad && d.mode === 'free') cost += 2;
      if (opts.prefer?.get(m.name) === d.view) cost -= 3;
      if (m.look !== undefined && v && lookAxis(v) === m.look) cost -= 3;
      if (d.lin && (feetOf.get(d.view + d.mode) ?? []).some(u => near(u, d.lin.u0) || near(u, d.lin.u1))) cost -= 0.4;
      // a foot on something this view does not show points at nothing: inside the part it is for the section
      if (m.cls === 'L' && d.lin && v?.mask && !v.section && (d.mode === 'h' || d.mode === 'v')) { const k = d.mode === 'h' ? 0 : 1; if (v.mask.seenAt(k, d.lin.u0) === false || v.mask.seenAt(k, d.lin.u1) === false) cost += 2.5; }
      if (!best || cost < best.cost - 1e-9) best = { d, cost };
    }
    if (!best) continue;
    out.set(m.name, best.d.view); load[best.d.view]++;
    if (best.d.lin) { const k = best.d.view + best.d.mode; feetOf.set(k, [...(feetOf.get(k) ?? []), best.d.lin.u0, best.d.lin.u1]); }
  }
  return { view_of: out, load };
}
// a diameter with extension lines, in a view that has its circle
const seenRound = (d, v) => { if (d.type !== 6 || !d.lin || !v?.mask || !v.scale) return false; const k = d.mode === 'h' ? 0 : 1, mid = (d.lin.u0 + d.lin.u1) / 2; return v.mask.arcs.some(a => near(a.r, Math.abs(d.value) * v.scale / 2, 0.05) && near(a.center[k], mid, 0.1)); };
// the model axis a view looks along (0 X, 1 Y, 2 Z), null for an isometric
const lookAxis = v =>{ const i = (v.axes ?? []).findIndex(a => Math.abs(a[2]) > 0.99); return i < 0 ? null : i; };
const AXIS_VIEW = ['right', 'top', 'front'];
const ROOM_AROUND = 30;
// a section shows a hole cut along its axis: the view that sees the axis lying straight on the sheet, the largest one
export function planSection(geo, hollows) {
  const views = (geo.views ?? []).filter(v => v.outline_mm && !v.section && v.model_type === 1 && lookAxis(v) !== null);
  const area = v => (v.outline_mm[2] - v.outline_mm[0]) * (v.outline_mm[3] - v.outline_mm[1]);
  const holes = [...(hollows.holes ?? [])].sort((a, b) => b.diameter_mm - a.diameter_mm);
  for (const h of holes) {
    const rows = [];
    for (const v of views) {
      const s = [0, 1, 2].map(i => h.axis[0] * v.axes[0][i] + h.axis[1] * v.axes[1][i] + h.axis[2] * v.axes[2][i]);
      if (Math.abs(s[2]) > 0.02) continue;
      const direction = Math.abs(s[0]) > 0.98 ? 'horizontal' : Math.abs(s[1]) > 0.98 ? 'vertical' : null;
      if (direction) rows.push({ view: v.name, direction, through_mm: h.point_mm, reason: 'barreno Ø' + VAL(h.diameter_mm), area: area(v) });
    }
    if (rows.length) return rows.sort((a, b) => b.area - a.area)[0];
  }
  const f = (hollows.features ?? [])[0];
  if (f && views.length) { const v = [...views].sort((a, b) => area(b) - area(a))[0]; return { view: v.name, direction: 'horizontal', ...(f.center_mm ? { through_mm: f.center_mm } : {}), reason: 'vaciado ' + f.name, area: area(v) }; }
  return null;
}
function freeSpot(geo, w, h, margin = 8, from = null) {
  const rects = [...geo.views.filter(v => v.outline_mm).map(v => v.outline_mm), ...(geo.title_block_mm ? [geo.title_block_mm] : [])], [W, H] = geo.sheet_mm;
  let best = null;
  for (let y = H - margin - h / 2; y >= margin + h / 2; y -= 5) for (let x = margin + w / 2; x <= W - margin - w / 2; x += 5) {
    if (rects.some(r => x - w / 2 - 8 < r[2] && x + w / 2 + 8 > r[0] && y - h / 2 - 8 < r[3] && y + h / 2 + 8 > r[1])) continue;
    if (!from) return [x, y];
    // what will carry dimensions wants room for them on every side; of those with the most, the one nearest to where it comes from
    const b = [x - w / 2, y - h / 2, x + w / 2, y + h / 2], acrossY = r => r[1] < b[3] && r[3] > b[1], acrossX = r => r[0] < b[2] && r[2] > b[0];
    const sides = [Math.min(b[0], ...rects.filter(r => acrossY(r) && r[2] <= b[0]).map(r => b[0] - r[2])), Math.min(W - b[2], ...rects.filter(r => acrossY(r) && r[0] >= b[2]).map(r => r[0] - b[2])), Math.min(b[1], ...rects.filter(r => acrossX(r) && r[3] <= b[1]).map(r => b[1] - r[3])), Math.min(H - b[3], ...rects.filter(r => acrossX(r) && r[1] >= b[3]).map(r => r[1] - b[3]))];
    const room = sides.reduce((s, v) => s + Math.min(v, ROOM_AROUND), 0), dist = Math.hypot(x - from[0], y - from[1]);
    if (!best || room > best.room + 1e-6 || (room > best.room - 1e-6 && dist < best.dist)) best = { room, dist, at: [x, y] };
  }
  return best?.at ?? null;
}
// the section keeps its line with the parent as far as the sheet allows, and the isometric, which keeps nothing, makes way. With no room along that
// line it leaves the line: its letters say where it comes from. False when it does not fit anywhere
export function planSectionPlace(geo, name, parentName, direction, { margin = 8, wide = 25 } = {}) {
  const sec = geo.views.find(v => v.name === name), parent = geo.views.find(v => v.name === parentName);
  if (!sec?.outline_mm || !parent?.outline_mm) return null;
  const o = sec.outline_mm, k = direction === 'vertical' ? 0 : 1, [W, H] = geo.sheet_mm, title = geo.title_block_mm;
  const others = geo.views.filter(v => v.outline_mm && v !== sec), floating = others.filter(v => !v.section && lookAxis(v) === null);
  const solid = [...others.filter(v => !floating.includes(v)).map(v => v.outline_mm), ...(title ? [title] : [])];
  const fits = (r, gap) => r[0] >= margin && r[1] >= margin && r[2] <= W - margin && r[3] <= H - margin && !solid.some(b => r[0] < b[2] + gap && r[2] > b[0] - gap && r[1] < b[3] + gap && r[3] > b[1] - gap);
  const side = (o[k] + o[k + 2]) >= (parent.outline_mm[k] + parent.outline_mm[k + 2]) ? 1 : -1, reach = Math.max(W, H);
  const beside = (r, s) => s > 0 ? r[k] >= parent.outline_mm[k + 2] : r[k + 2] <= parent.outline_mm[k];
  let spot = null;
  for (const s of [side, -side]) for (const gap of [wide, margin]) {
    if (spot) break;
    for (let d = 0; d <= reach && !spot; d += 5) for (const sign of [1, -1]) { const r = o.map((x, i) => i % 2 === k ? x + sign * d : x); if (beside(r, s) && fits(r, gap)) { spot = r; break; } }
  }
  const without = list => ({ ...geo, views: geo.views.filter(v => !list.includes(v)) });
  const centre = r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  const moves = [];
  if (spot) moves.push({ view: name, center_mm: centre(spot) });
  else {
    const w = o[2] - o[0], h = o[3] - o[1];
    // off the line: in what is free even with the isometric where it is, or else in what it leaves
    const from = [(parent.outline_mm[0] + parent.outline_mm[2]) / 2, (parent.outline_mm[1] + parent.outline_mm[3]) / 2];
    let c = freeSpot(without([sec]), w, h, 8, from);
    if (!c) c = freeSpot(without([sec, ...floating]), w, h, 8, from);
    if (!c) return null;
    spot = [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2];
    moves.push({ view: name, center_mm: c, break_alignment: true });
  }
  // the isometric goes where nothing is, with the section already in its new place
  const placed = { ...geo, views: geo.views.map(v => v === sec ? { ...v, outline_mm: spot } : v) };
  for (const f of floating) {
    const b = f.outline_mm; if (!(spot[0] < b[2] + 8 && spot[2] > b[0] - 8 && spot[1] < b[3] + 8 && spot[3] > b[1] - 8)) continue;
    const c = freeSpot({ ...placed, views: placed.views.filter(v => v.name !== f.name) }, b[2] - b[0], b[3] - b[1]);
    if (!c) return null;
    moves.push({ view: f.name, center_mm: c });
    placed.views = placed.views.map(v => v.name === f.name ? { ...v, outline_mm: [c[0] - (b[2] - b[0]) / 2, c[1] - (b[3] - b[1]) / 2, c[0] + (b[2] - b[0]) / 2, c[1] + (b[3] - b[1]) / 2] } : v);
  }
  return moves;
}
// room for the rows of dimensions: the views over and under the front view move away from it, as far as the sheet allows. Only along
// the projection, so they stay aligned; the front view and whatever is beside it stay.
export function planViewGaps(geo, { want = 30, margin = 8 } = {}) {
  const part = geo.views.filter(v => v.outline_mm && v.model_type === 1 && (v.section || lookAxis(v) !== null));
  const front = part.find(v => !v.section && lookAxis(v) === 2) ?? part[0]; if (!front) return [];
  const f = front.outline_mm, H = geo.sheet_mm[1], title = geo.title_block_mm, moves = [];
  const overlapsX = (a, b) => a[0] < b[2] && a[2] > b[0];
  const others = geo.views.filter(v => v.outline_mm && v !== front);
  for (const v of others) {
    if (!part.includes(v)) continue;
    const o = v.outline_mm; if (!overlapsX(o, f)) continue;
    const up = o[1] >= f[3], gap = up ? o[1] - f[3] : f[1] - o[3]; if (gap >= want) continue;
    // the name of a section hangs under it, wider than a narrow view: it has to stay on the sheet and off the title block
    const c = (o[0] + o[2]) / 2, foot = v.section ? [Math.min(o[0], c - 17), 0, Math.max(o[2], c + 17), 0] : o;
    const floor = (title && overlapsX(foot, title) ? title[3] + margin : margin) + (v.section ? 9 : 0);
    const by = up ? Math.max(0, Math.min(want - gap, H - margin - o[3])) : o[1] < floor ? Math.max(0, Math.min(floor - o[1], gap - 5)) : -Math.max(0, Math.min(want - gap, o[1] - floor));
    if (Math.abs(by) < 1) continue;
    const moved = [o[0], o[1] + by, o[2], o[3] + by];
    if (others.some(w => w !== v && overlapsX(moved, w.outline_mm) && moved[1] < w.outline_mm[3] && moved[3] > w.outline_mm[1])) continue;
    moves.push({ view: v.name, by: [0, +by.toFixed(2)] });
  }
  // the name of any other section too: one that sinks into the frame goes up, as far as what is over it allows. Not one in line beside
  // the view it comes from, which only slides sideways
  for (const v of part) {
    if (!v.section || moves.some(m => m.view === v.name)) continue;
    const o = v.outline_mm, c = (o[0] + o[2]) / 2, foot = [Math.min(o[0], c - 17), 0, Math.max(o[2], c + 17), 0];
    const floor = (title && overlapsX(foot, title) ? title[3] + margin : margin) + 9; if (o[1] >= floor - 0.5) continue;
    if (part.some(w => w !== v && !w.section && !overlapsX(w.outline_mm, o) && near((w.outline_mm[1] + w.outline_mm[3]) / 2, (o[1] + o[3]) / 2, 1))) continue;
    const room = Math.min(H - margin - o[3], ...geo.views.filter(w => w.outline_mm && w !== v && overlapsX(w.outline_mm, o) && w.outline_mm[1] >= o[3] - 0.01).map(w => w.outline_mm[1] - o[3] - 5));
    const by = Math.min(floor - o[1], room); if (by < 1) continue;
    moves.push({ view: v.name, by: [0, +by.toFixed(2)] });
  }
  // beside it the same: each one away from what is before it, the ones behind going along so nothing is left closer than it was
  const rowOf = geo.views.filter(v => v.outline_mm && v !== front && part.includes(v) && v.outline_mm[1] < f[3] && v.outline_mm[3] > f[1]);
  const W = geo.sheet_mm[0], overlapsY = (a, b) => a[1] < b[3] && a[3] > b[1];
  for (const sign of [1, -1]) {
    const side = rowOf.filter(v => sign > 0 ? v.outline_mm[0] >= f[2] : v.outline_mm[2] <= f[0]).sort((a, b) => sign * (a.outline_mm[0] - b.outline_mm[0]));
    const wall = v => (title && overlapsY(v.outline_mm, title) && (sign > 0 ? title[0] > v.outline_mm[2] : title[2] < v.outline_mm[0]) ? (sign > 0 ? title[0] - margin : title[2] + margin) : (sign > 0 ? W - margin : margin));
    let reach = Infinity; for (const v of side) reach = Math.min(reach, sign * (wall(v) - (sign > 0 ? v.outline_mm[2] : v.outline_mm[0])));
    // a section hanging from one of them goes along, with its name under it: that must not end on the title block
    if (sign > 0 && title) for (const v of side) for (const c of geo.views) {
      const o = c.outline_mm, mid = o && (o[0] + o[2]) / 2; if (!o || !c.section || c === v || !near(mid, (v.outline_mm[0] + v.outline_mm[2]) / 2, 1) || overlapsY(o, v.outline_mm)) continue;
      if (o[1] - 9 < title[3] && o[3] > title[1] && title[0] > mid) reach = Math.min(reach, Math.max(0, title[0] - 2 - Math.max(mid + 17, o[2])));
    }
    let shift = 0, before = sign > 0 ? f[2] : f[0];
    for (const v of side) {
      const o = v.outline_mm, near0 = sign > 0 ? o[0] : o[2], gap = sign * (near0 - before), by = Math.min(Math.max(shift, want - gap), reach);
      before = sign > 0 ? o[2] : o[0];
      shift = Math.max(shift, by);
      const moved = [o[0] + sign * by, o[1], o[2] + sign * by, o[3]];
      // what the sheet does not leave on that side, the front view gives by going the other way, with what hangs from it: the view beside it stays
      const short = sign > 0 && v === side[0] ? want - gap - by : 0, free = f[0] - margin - 40;
      if (short >= 1 && free >= 1 && !rowOf.some(w => w.outline_mm[2] <= f[0])) moves.push({ view: front.name, by: [-+Math.min(short, free).toFixed(2), 0] });
      if (by < 1 || others.some(w => !side.includes(w) && moved[0] < w.outline_mm[2] && moved[2] > w.outline_mm[0] && overlapsY(moved, w.outline_mm))) continue;
      moves.push({ view: v.name, by: [+(sign * by).toFixed(2), 0] });
    }
  }
  return moves;
}
// the views of a projection stay in line: what was in line with the front view and no longer is goes back to it. Some follow the front view when it moves and some do not
export function planRealign(before, after) {
  const was = new Map(before.views.filter(v => v.outline_mm).map(v => [v.name, v.outline_mm]));
  const part = after.views.filter(v => v.outline_mm && v.model_type === 1 && (v.section || lookAxis(v) !== null));
  const front = part.find(v => !v.section && lookAxis(v) === 2) ?? part[0]; if (!front || !was.has(front.name)) return [];
  const mid = (o, k) => (o[k] + o[k + 2]) / 2, f0 = was.get(front.name), f1 = front.outline_mm, out = [];
  for (const v of part) {
    if (v === front || v.section || !was.has(v.name)) continue;
    const o0 = was.get(v.name), o1 = v.outline_mm, by = [0, 1].map(k => near(mid(o0, k), mid(f0, k), 1) && !near(mid(o1, k), mid(f1, k), 0.05) ? mid(f1, k) - mid(o1, k) : 0);
    if (by[0] || by[1]) out.push({ view: v.name, by: by.map(x => +x.toFixed(2)) });
  }
  return out;
}
export function measuresOf(dims) {
  const by = new Map();
  for (const d of dims) { let m = by.get(d.name); if (!m) by.set(d.name, m = { name: d.name, value: d.value, cls: dimClass(d), dims: [] }); if (!m.dims.some(x => x.view === d.view)) m.dims.push(d); }
  return [...by.values()];
}
// always front, top and side; a section when the part has something hollow; every size once; shared among the views. Never saves.
export async function organizeDimensions(worker, args, { signal } = {}) {
  const doc = { document_id: args.document_id }, warnings = [], report = {}, cutMarks = [], guideMarks = [], keepOut = () => [...(args.keep_out_mm ?? []), ...cutMarks, ...guideMarks];
  const first = await call(worker, 'drawing_dim_geometry', doc, signal), sheet = args.sheet ?? first.active_sheet, sh = { ...doc, sheet };
  const geoNow = () => call(worker, 'drawing_dim_geometry', sh, signal), read = async () => readSheet(await geoNow(), args);
  let geo = await geoNow();
  const partViews = () => geo.views.filter(v => v.model_type === 1 && v.outline_mm);
  if (!partViews().length) return { skipped: 'La hoja no tiene vistas de una pieza: en ensambles las cotas no se reparten.', ...await superviseDimensions(worker, { ...args, sheet, fix: true }, { signal }) };
  // the three views
  const added = [], seen = new Set(partViews().filter(v => !v.section).map(lookAxis));
  for (const ax of [2, 1, 0]) {
    if (seen.has(ax)) continue;
    const base = partViews()[0], made = await call(worker, 'drawing_sheets', { ...doc, action: 'add_view', model_path: base.model, view_orientation: AXIS_VIEW[ax], position_mm: [geo.sheet_mm[0] / 2, geo.sheet_mm[1] / 2], scale: base.scale, display: 'hidden_lines_removed' }, signal);
    await call(worker, 'drawing_views', { ...doc, action: 'set', sheet, view: made.view, scale: base.scale }, signal);
    geo = await geoNow();
    const v = geo.views.find(x => x.name === made.view), o = v?.outline_mm;
    if (o) { const others = { ...geo, views: geo.views.filter(x => x.name !== made.view) }, spot = freeSpot(others, o[2] - o[0], o[3] - o[1]); if (spot) await call(worker, 'drawing_views', { ...doc, action: 'set', sheet, view: made.view, center_mm: spot }, signal); else warnings.push('No hay lugar libre para la vista ' + made.view + ': agranda la hoja o baja la escala.'); }
    added.push({ view: made.view, orientation: AXIS_VIEW[ax] }); geo = await geoNow();
  }
  if (added.length) report.views_added = added;
  // the section
  const hollows = await call(worker, 'drawing_part_hollows', sh, signal);
  const holeCounts = holeCountsOf(hollows);
  report.hollows = { holes: holeCounts, features: (hollows.features ?? []).map(f => f.name) };
  if (args.section !== false && !geo.views.some(v => v.section)) {
    const plan = planSection(geo, hollows);
    if (plan) try {
      const { area, reason, ...p } = plan, sec = await call(worker, 'drawing_views', { ...doc, action: 'section', sheet, ...p }, signal);
      report.section = { view: sec.section?.name, parent: p.view, direction: p.direction, reason, placement: sec.placement }; geo = await geoNow();
      const po = geo.views.find(v => v.name === p.view)?.outline_mm, cut = sec.cut_on_sheet_mm;
      // the arrows and letters at both ends of the cut line. They look towards where the section hangs, so they stand on the other side of the line
      if (po && cut) cutMarks.push(...(p.direction === 'horizontal' ? [[po[0] - 6, cut[1] - 1, po[0] + 3, cut[1] + 14], [po[2] - 3, cut[1] - 1, po[2] + 6, cut[1] + 14]] : [[cut[0] - 14, po[1] - 6, cut[0] + 1, po[1] + 3], [cut[0] - 14, po[3] - 3, cut[0] + 1, po[3] + 6]]));
      if (/no free place/.test(sec.placement ?? '')) {
        const moves = planSectionPlace(geo, sec.section?.name, p.view, p.direction);
        if (moves) { for (const m of moves) await call(worker, 'drawing_views', { ...doc, action: 'set', sheet, ...m }, signal); geo = await geoNow(); report.section.placement = moves.some(m => m.break_alignment) ? 'fuera de la línea de su vista, donde hay lugar' : 'en la línea de su vista'; }
        else warnings.push('El corte no cabe sin encimarse: agranda la hoja o baja la escala.');
      }
    } catch (e) { warnings.push('No se pudo crear el corte: ' + e.message); }
  }
  // where each dimension can live
  const targets = partViews().filter(v => v.section || lookAxis(v) !== null).map(v => v.name), original = readSheet(geo, args).dims.filter(modelDim);
  // what the part needs comes from its faces. With a reference sheet, or several parts on the sheet, the older reduction decides
  const sizes = !args.reference_values?.length && new Set(partViews().map(v => v.model)).size === 1 ? await partSizes(worker, sh, signal) : null;
  // ...and then a radius goes and comes like any other: what is not needed must not stay in every view where it fits
  const inScope = d => modelDim(d) || (!!sizes && !!d.name && !isSheetDim(d) && !d.hole_callout && d.marked !== false && d.type === 5);
  const clear = async () => { const m = await read(), ids = m.dims.filter(d => inScope(d) && targets.includes(d.view)).map(d => d.id); if (ids.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: ids }, signal); };
  const found = [];
  for (const v of targets) { await clear(); await call(worker, 'drawing_dim_insert', { ...sh, views: [v] }, signal); found.push(...(await read()).dims.filter(d => inScope(d) && d.view === v)); }
  // the model does not offer what the sheet showed: it is another file with the same name (SolidWorks looks first in the folder of the drawing). Going on would leave the sheet without its dimensions
  const wereThere = [...new Set(original.map(d => d.name))], offeredNow = new Set(found.map(d => d.name)), gone = wereThere.filter(n => !offeredNow.has(n));
  if (wereThere.length >= 4 && gone.length > wereThere.length / 2) throw new Error('El modelo solo ofrece ' + (wereThere.length - gone.length) + ' de las ' + wereThere.length + ' cotas de la hoja (' + (partViews()[0]?.model ?? 'modelo desconocido') + '). Probablemente el dibujo tomo otra pieza con el mismo nombre de su carpeta. La hoja abierta ya perdio sus cotas: cierrala SIN guardar y revisa la referencia.');
  await clear();
  // a dimension of the old sheet that Insert Model Items does not offer (not marked for drawing) keeps its view
  const offered = new Set(found.map(d => d.name)), byHand = readSheet(geo, args).dims.filter(d => d.name && !d.hole_callout && !offered.has(d.name) && (sizes ? d.marked === false || (isSheetDim(d) && onThePart(d)) : !isSheetDim(d)));
  // made on the sheet and hanging from something that is not the part (the line of a section, a sketch of the view): it says nothing about the part
  if (sizes) { const ids = (await read()).dims.filter(d => isSheetDim(d) && !d.hole_callout && targets.includes(d.view) && !onThePart(d)).map(d => d.id); if (ids.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: ids }, signal); report.dimensions_not_on_the_part = ids.length; }
  // no reference sheet: the holes of a pattern are said with its pitch and its distance to the contour, drawn here before the plan counts on them
  const pattern = args.reference_values?.length ? { sketches: new Map(), prefer: new Map(), names: [], report: [] } : await addHolePatterns(worker, sh, partViews(), measuresOf([...found, ...byHand]), hollows, holeCounts, warnings, signal, sizes ? ringDiameters(sizes) : null);
  if (pattern.report.length) report.hole_patterns = pattern.report;
  const madeForPattern = pattern.names.length ? (await read()).dims.filter(d => pattern.names.includes(d.name)) : [];
  const measures = measuresOf([...found, ...byHand, ...madeForPattern]);
  const shapes = await viewShapes(worker, sh, signal), model = readSheet(geo, { ...args, shapes });
  // of two dimensions of one size, the one on a round the sheet shows
  const shown = new Map(measures.map(m => [m.name, Math.max(0, ...m.dims.map(d => roundShown(d, model.views.get(d.view))))]));
  let plan = sizes ? planNeeded(sizes, measures, model.views, { fixed_names: pattern.names, callouts: calloutValues(model.dims), shown }) : planReduction(measures, { reference_values: args.reference_values, hole_counts: holeCounts, pattern_sketches: pattern.sketches });
  // what the part needs and no dimension says: on the sheet before the model dimensions are shared out, which depends on it
  let cannotMake = new Set();
  if (sizes && plan.missing.length) {
    const replan = async (names, cannot) => { const now = await read(), madeNow = now.dims.filter(d => names.includes(d.name)); return planNeeded(sizes, measuresOf([...found, ...byHand, ...madeForPattern, ...madeNow]), model.views, { fixed_names: [...pattern.names, ...names], callouts: calloutValues(model.dims), could_not_make: cannot, shown }); };
    const made = await addNeeded(worker, sh, plan, replan, targets, read, signal);
    pattern.names.push(...made.names); plan = made.plan; cannotMake = made.cannot;
    report.dimensions_made_on_the_sheet = made.names.length;
    if (made.lines.length) report.dimensions_refused = made.lines.slice(0, 12);
  }
  const hollowNames = new Set((hollows.features ?? []).flatMap(f => [f.name, ...(f.sketches ?? [])]));
  const holeAxes = new Set((hollows.holes ?? []).map(h => h.axis.findIndex(x => Math.abs(x) > 0.99)));
  const { view_of } = assignViews(plan.kept, model.views, { hollow_names: hollowNames, hole_axes: holeAxes, prefer: pattern.prefer });
  // final sheet: view by view, what was inserted and belongs to another view goes away and comes back there
  const unwanted = (m, v) => { const seenHere = new Set(), ids = []; for (const d of m.dims) { if (!inScope(d) || d.view !== v) continue; if (view_of.get(d.name) !== v || seenHere.has(d.name)) ids.push(d.id); seenHere.add(d.name); } return ids; };
  for (const v of targets) {
    await call(worker, 'drawing_dim_insert', { ...sh, views: [v] }, signal);
    const ids = unwanted(await read(), v);
    if (ids.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: ids }, signal);
  }
  // ...and a repeat among those not marked for drawing simply goes
  const m1 = await read(), stale = m1.dims.filter(d => byHand.some(b => b.name === d.name) && !view_of.has(d.name)).map(d => d.id);
  if (stale.length) await call(worker, 'drawing_dim_apply', { ...sh, deletes: stale }, signal);
  // Insert Model Items did not bring it back (the first look at the sheet could not tell): a circle or arc can be dimensioned from the view
  let final = await read();
  for (const k of plan.kept.filter(k => (k.cls === 'R' || k.cls === 'D') && !final.dims.some(d => d.name === k.name))) {
    const view = view_of.get(k.name), type = k.cls === 'R' ? 'radius' : 'diameter', dia = k.cls === 'R' ? k.value * 2 : k.value;
    try {
      const edges = (await call(worker, 'drawing_dimension', { ...sh, view, action: 'probe' }, signal)).edges ?? [];
      const e = edges.find(x => x.diameter_mm && Math.abs(x.diameter_mm - dia) < 0.01);
      if (e) { const made = await call(worker, 'drawing_dimension', { ...sh, view, action: 'add', edges: [e.index], type }, signal); k.name = made.name; final = await read(); }
    } catch (e) { warnings.push('Cota ' + k.name + ': ' + e.message); }
  }
  const texts = [];
  // those not marked for drawing keep the colour SolidWorks gives them, blue on the PDF
  for (const k of plan.kept) { const d = final.dims.find(x => x.name === k.name); if (d && (k.prefix || k.suffix || d.marked === false || d.type === 5)) texts.push({ id: d.id, black: true, ...(k.prefix ? { prefix: k.prefix } : {}), ...(k.suffix ? { suffix: k.suffix } : {}) }); }
  for (const d of final.dims) if (pattern.names.includes(d.name) && !texts.some(t => t.id === d.id && t.black)) texts.push({ id: d.id, black: true });
  // a diameter where it is seen as a circle takes a leader: its two extension lines would only cross what is around it. And every leader stops at its arc: going on it would cross what is inside
  const shaped = readSheet(await geoNow(), { ...args, shapes });
  const textOf = d => { let t = texts.find(x => x.id === d.id); if (!t) texts.push(t = { id: d.id }); return t; };
  for (const d of shaped.dims) {
    if (seenRound(d, shaped.views.get(d.view)) || (d.type === 6 && d.rad && !d.hole_callout && d.lines.length > 1)) textOf(d).as_leader = true;
    else if (d.type === 5 && d.rad && !d.hole_callout && d.lines.length > 1) textOf(d).open_leader = true;
  }
  if (texts.length) await call(worker, 'drawing_dim_apply', { ...sh, texts }, signal);
  const lost = plan.kept.filter(k => !final.dims.some(d => d.name === k.name)).map(k => k.name);
  if (lost.length) warnings.push('No se pudieron volver a poner estas cotas: ' + lost.join(', ') + '. Acótalas con sw_drawing_dimension.');
  if (plan.reference_not_found.length) warnings.push('Medidas del plano de referencia que el modelo no tiene como cota: ' + plan.reference_not_found.join(', ') + '.');
  const spreadFrom = await geoNow(), gaps = planViewGaps(spreadFrom);
  if (gaps.length) {
    await call(worker, 'drawing_dim_apply', { ...sh, view_moves: gaps }, signal);
    const realign = planRealign(spreadFrom, await geoNow());
    if (realign.length) await call(worker, 'drawing_dim_apply', { ...sh, view_moves: realign }, signal);
    report.views_spread = [...gaps, ...realign];
    // the arrows of the cut go with their view
    for (const { view, by } of report.views_spread) for (const b of view === report.section?.parent ? cutMarks : []) { b[0] += by[0]; b[2] += by[0]; b[1] += by[1]; b[3] += by[1]; }
  }
  // an angle with a ray in the air: the new one on its line first, and only if the sheet reads the same value the old one goes. With the views already in their places: a line widens the frame of its view
  const angled = readSheet(await geoNow(), { ...args, shapes });
  for (const d of angled.dims.filter(x => x.ang && x.name && targets.includes(x.view))) {
    try {
      const plan2 = planAngleGuide(d, angled.views.get(d.view), (await call(worker, 'drawing_dimension', { ...sh, view: d.view, action: 'probe', max_edges: 2000 }, signal)).edges ?? []);
      if (!plan2) continue;
      const { mark, ...guided } = plan2, made = await call(worker, 'drawing_dimension', { ...sh, view: d.view, action: 'guided', ...guided }, signal), ink = (await read()).dims.filter(x => x.name === made.name).map(x => ({ id: x.id, black: true }));
      if (ink.length) await call(worker, 'drawing_dim_apply', { ...sh, texts: ink }, signal);
      await call(worker, 'drawing_dim_apply', { ...sh, deletes: (await read()).dims.filter(x => x.name === d.name && x.view === d.view).map(x => x.id) }, signal);
      const k = plan.kept.find(x => x.name === d.name); if (k) k.name = made.name;
      view_of.set(made.name, d.view); pattern.names.push(made.name); guideMarks.push(mark);
      report.angles_on_a_line = (report.angles_on_a_line ?? 0) + 1;
    } catch (e) { warnings.push('Ángulo ' + d.name + ': ' + e.message); }
  }
  const checkArgs = fix => ({ ...doc, sheet, fix, shapes, keep_out_mm: keepOut(), ...(args.margin_mm !== undefined ? { margin_mm: args.margin_mm } : {}), ...(args.title_block_mm ? { title_block_mm: args.title_block_mm } : {}) });
  await superviseDimensions(worker, checkArgs(true), { signal });
  const readAll = async () => readSheet(await geoNow(), { ...args, shapes, keep_out_mm: keepOut() });
  // last, with the rows of dimensions in place: it only takes what is free, so the check stays true
  const leaders = planLeaders(await readAll());
  if (leaders.length) await call(worker, 'drawing_dim_apply', { ...sh, moves: leaders }, signal);
  report.text_nudges = await nudgeTexts(worker, sh, readAll, signal);
  // the hatching of a section, cut around the dimensions that were on it when they were inserted, is drawn whole again
  if ((await geoNow()).views.some(v => v.section)) await call(worker, 'drawing_dim_apply', { ...sh, rebuild: true }, signal);
  // what is said about the sheet is what it has now, not what it had before the last touches
  const check = await superviseDimensions(worker, checkArgs(false), { signal });
  const end = readSheet(await geoNow(), args), perView = {}; for (const d of end.dims) perView[d.view] = (perView[d.view] ?? 0) + 1;
  // v3.17 what stays over because one view carries almost everything: moving texts cannot make room there, a larger scale can (the star part at 1:2)
  const busy = check.sheets.find(s => s.errors && s.review?.crowded_in_one_view);
  if (busy) warnings.push(crowdedAdvice(perView, end.views, busy.errors));
  // the last word is the sheet as it stayed, not the plan
  if (sizes) {
    const verdict = planNeeded(sizes, measuresOf(end.dims.filter(d => d.name && !d.hole_callout && targets.includes(d.view))), end.views, { fixed_names: pattern.names, callouts: calloutValues(end.dims), could_not_make: cannotMake });
    report.sufficiency = { ...verdict.report, ...(verdict.dropped.length ? { too_many_detail: verdict.dropped.slice(0, 20) } : {}) };
    if (verdict.report.sufficient === false) warnings.push(verdict.report.summary);
  }
  return { sheet, dimensions_before: original.length, dimensions_offered: offered.size + byHand.length, dimensions_after: end.dims.length, per_view: perView, ...report, dropped: plan.dropped.length, dropped_detail: plan.dropped.slice(0, 40), assignment: plan.kept.map(k => ({ dimension: k.name, can_go: k.dims.map(d => d.view), view: view_of.get(k.name) })), ...(warnings.length ? { warnings } : {}), check: { clean: check.clean, errors: check.errors, sheets: check.sheets.map(({ details, ...s }) => (s.errors ? { ...s, details } : s)) }, note: 'Sin guardar: revisa con sw_preview o el PDF y luego sw_save.' };
}
// one line for a tool result (export, annotate) when the sheet still has problems
export function dimensionWarning(r) {
  if (r.clean && !r.needs_organize) return null;
  const more = r.needs_organize ? describeReview(r) : '';
  if (r.clean) return more;
  const sum = {}; for (const s of r.sheets) for (const [k, v] of Object.entries(s.found)) if (v && ERROR_KINDS.includes(k)) sum[k] = (sum[k] ?? 0) + v;
  return `El plano tiene ${r.errors} problemas de cotas (${Object.entries(sum).map(([k, v]) => `${k}: ${v}`).join(', ')}). Usa sw_drawing_dim_check fix true antes de entregar.${more ? ' ' + more : ''}`;
}
function describeReview(r) {
  const n = { repeated: 0, crowded: false, views: new Set(), section: false };
  for (const s of r.sheets) { const v = s.review; if (!v) continue; n.repeated += v.repeated_or_redundant; n.crowded ||= v.crowded_in_one_view; v.missing_views.forEach(x => n.views.add(x)); n.section ||= v.section_missing; }
  const parts = [];
  if (n.repeated) parts.push(n.repeated + ' cotas repetidas o que salen de sumar otras');
  if (n.crowded) parts.push('casi todas las cotas en una sola vista');
  if (n.views.size) parts.push('faltan las vistas ' + [...n.views].join(', '));
  if (n.section) parts.push('la pieza tiene vaciados y no hay corte');
  const missing = r.sheets.flatMap(s => s.review?.missing_to_make_the_part ?? []);
  if (missing.length) parts.push('faltan cotas para hacer la pieza: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? '...' : ''));
  return 'Plano por organizar: ' + parts.join('; ') + '. Usa sw_drawing_dim_organize.';
}
