// v3.9 DXF geometry for sw_drawing_read: what the drawing really draws (lines, arcs, circles, polylines, splines, ellipses and the
// geometry inside block references), each primitive classed by its linetype (visible, hidden, center, phantom = section cut),
// the views found by clustering the visible geometry (the sheet frame and title block are recognised and set apart), and every
// DIMENSION entity turned into the same record the PDF reader gives (value, from/to on the sheet, the view, the points in PART
// coordinates of that view). Unlike a PDF, a DXF dimension carries its definition points, so nothing has to be guessed: the
// measured value is sheet distance x DIMLFAC (the view scale SolidWorks writes in the dimension style).
import { parseDxf, dimLfac, dxfText, dxfEvidence } from './dxf.mjs';

const TO_MM = { in: 25.4, ft: 304.8, mm: 1, cm: 10, m: 1000 };

export function lineClass(lt) {
  const s = String(lt ?? 'CONTINUOUS').toUpperCase();
  if (/CENTER|DASHDOT|CENTRO/.test(s)) return 'center';
  if (/PHANTOM|FANTASMA/.test(s)) return 'phantom';
  if (/HIDDEN|DASH|OCULT/.test(s)) return 'hidden';
  return 'visible';
}

const ident = { s: [1, 1], r: 0, apply: p => p };
// block geometry is placed relative to the BLOCK base point, then scaled, rotated and moved to the insert point
function insertT(d, e) {
  const o = d.pt(e, 10), s = [d.num(e, 41, 1), d.num(e, 42, 1)], r = d.num(e, 50) * Math.PI / 180, c = Math.cos(r), si = Math.sin(r), b = d.blocks.get(d.get(e, 2))?.base ?? [0, 0];
  return { s, r, apply: p => { const x = p[0] - b[0], y = p[1] - b[1]; return [o[0] + c * s[0] * x - si * s[1] * y, o[1] + si * s[0] * x + c * s[1] * y]; } };
}
// point of a (rational) B-spline: de Boor on homogeneous coordinates
function nurbsPoint(deg, U, P, W, t) {
  const n = P.length - 1; let k = deg; while (k < n && !(t >= U[k] && t < U[k + 1])) k++;
  const dpt = []; for (let j = 0; j <= deg; j++) { const i = k - deg + j, w = W[i] ?? 1; dpt.push([P[i][0] * w, P[i][1] * w, w]); }
  for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
    const i = k - deg + j, den = U[i + deg - r + 1] - U[i], a = den === 0 ? 0 : (t - U[i]) / den;
    dpt[j] = dpt[j].map((v, q) => (1 - a) * dpt[j - 1][q] + a * v);
  }
  return [dpt[deg][0] / dpt[deg][2], dpt[deg][1] / dpt[deg][2]];
}
const compose = (A, B) => ({ s: [A.s[0] * B.s[0], A.s[1] * B.s[1]], r: A.r + B.r, apply: p => A.apply(B.apply(p)) });

// arc points from a0 to a1 (radians, counter-clockwise) in drawing units
function arcPts(c, r, a0, a1, n) {
  while (a1 <= a0) a1 += 2 * Math.PI;
  const k = Math.max(2, Math.ceil(n * (a1 - a0) / (2 * Math.PI))), out = [];
  for (let i = 0; i <= k; i++) { const a = a0 + (a1 - a0) * i / k; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
  return out;
}
// polyline segment with DXF bulge (tan of a quarter of the included angle; + = counter-clockwise)
function bulgePts(p, q, b) {
  if (!b) return [p, q];
  const th = 4 * Math.atan(b), chord = Math.hypot(q[0] - p[0], q[1] - p[1]); if (chord < 1e-12) return [p, q];
  const r = chord / (2 * Math.sin(Math.abs(th) / 2)), m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const h = r * Math.cos(Math.abs(th) / 2), dir = [(q[0] - p[0]) / chord, (q[1] - p[1]) / chord], nrm = b > 0 ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
  const c = [m[0] + nrm[0] * h, m[1] + nrm[1] * h];   // h < 0 already puts the centre on the far side for a sweep over 180 deg
  let a0 = Math.atan2(p[1] - c[1], p[0] - c[0]), a1 = Math.atan2(q[1] - c[1], q[0] - c[0]);
  const pts = b > 0 ? arcPts(c, r, a0, a1, 48) : arcPts(c, r, a1, a0, 48).reverse();
  return pts;
}

export function dxfGeometry(path) {
  const d = parseDxf(path);
  const f = d.units ? TO_MM[d.units] : 1;
  const top = d.extMax ? d.extMax[1] : 0, left = d.extMin ? d.extMin[0] : 0;
  const M = p => [+((p[0] - left) * f).toFixed(4), +((top - p[1]) * f).toFixed(4)];   // drawing units -> mm, origin top-left
  const segs = [], circles = [], arcs = [], dimLines = [];
  let stack = null;   // blocks being expanded (cycle guard)
  const ltOf = (e, inherited) => { let lt = d.get(e, 6); if (lt) lt = lt.trim(); if (!lt || /^BYLAYER$/i.test(lt)) lt = d.layers.get(d.get(e, 8))?.linetype ?? 'CONTINUOUS'; if (/^BYBLOCK$/i.test(lt)) lt = inherited ?? 'CONTINUOUS'; return lt; };
  const poly = (pts, cls, T, out = segs, src) => { for (let i = 0; i + 1 < pts.length; i++) { const a = M(T.apply(pts[i])), b = M(T.apply(pts[i + 1])); if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1], b[0], b[1], cls, src]); } };
  const walk = (ents, T, inherited, depth, out, blk) => {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i], lt = ltOf(e, inherited), cls = out === dimLines ? 'dimension' : lineClass(lt), sc = Math.abs(T.s[0]);
      if (e.type === 'LINE') poly([d.pt(e, 10), d.pt(e, 11)], cls, T, out, blk);
      else if (e.type === 'CIRCLE' || e.type === 'ARC') {
        const c = d.pt(e, 10), r = d.num(e, 40), full = e.type === 'CIRCLE';
        const a0 = full ? 0 : d.num(e, 50) * Math.PI / 180 + T.r, a1 = full ? 2 * Math.PI : d.num(e, 51) * Math.PI / 180 + T.r;
        // through T with the rotation folded into the angles: rotate the centre only
        const pts = arcPts([0, 0], r, a0 - T.r, a1 - T.r, 64).map(p => [c[0] + p[0], c[1] + p[1]]);
        poly(pts, cls, T, out, blk);
        if (out === segs) {
          const cm = M(T.apply(c)), rr = +(r * sc * f).toFixed(4);
          // a non-uniform insert scale turns it into an ellipse: drawn (segments above) but not reported as a circle/arc
          if (Math.abs(Math.abs(T.s[0]) - Math.abs(T.s[1])) > 1e-9) { }
          else if (full) circles.push({ center_mm: cm, r_mm: rr, d_mm: +(2 * rr).toFixed(4), cls, ...(blk ? { block: blk } : {}) });
          // y flips in the top-left frame: angles change sign and swap ends
          else arcs.push({ center_mm: cm, r_mm: rr, start_deg: +(-(a1 * 180 / Math.PI)).toFixed(3), end_deg: +(-(a0 * 180 / Math.PI)).toFixed(3), cls });
        }
      } else if (e.type === 'LWPOLYLINE') {
        const v = []; let cur = null;
        for (const [k, raw] of e.g) { if (k === 10) { cur = [Number(raw), 0, 0]; v.push(cur); } else if (k === 20 && cur) cur[1] = Number(raw); else if (k === 42 && cur) cur[2] = Number(raw); }
        const closed = d.num(e, 70) & 1, n = closed ? v.length : v.length - 1;
        for (let j = 0; j < n; j++) { const p = v[j], q = v[(j + 1) % v.length]; poly(bulgePts([p[0], p[1]], [q[0], q[1]], p[2]), cls, T, out, blk); }
      } else if (e.type === 'POLYLINE') {
        const v = []; let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) v.push([d.num(ents[j], 10), d.num(ents[j], 20), d.num(ents[j], 42)]);
        if (ents[j]?.type === 'SEQEND') i = j; else i = j - 1;
        const closed = d.num(e, 70) & 1, n = closed ? v.length : v.length - 1;
        for (let k = 0; k < n; k++) { const p = v[k], q = v[(k + 1) % v.length]; poly(bulgePts([p[0], p[1]], [q[0], q[1]], p[2]), cls, T, out, blk); }
      } else if (e.type === 'SPLINE') {
        // the real curve: control points, knots and weights evaluated as a NURBS; only fit points (which lie ON the curve) are
        // joined directly when the file gives no control points
        const fit = [], ctl = [], U = [], W = []; let cx = null;
        for (const [k, raw] of e.g) { if (k === 11) cx = [Number(raw), 0, 'f']; else if (k === 21 && cx) { cx[1] = Number(raw); fit.push(cx); cx = null; } else if (k === 10) cx = [Number(raw), 0, 'c']; else if (k === 20 && cx) { cx[1] = Number(raw); ctl.push(cx); cx = null; } else if (k === 40) U.push(Number(raw)); else if (k === 41) W.push(Number(raw)); }
        const deg = d.num(e, 71, 3);
        if (ctl.length > deg && U.length === ctl.length + deg + 1) {
          const t0 = U[deg], t1 = U[ctl.length], N = Math.max(16, Math.min(400, ctl.length * 8)), pts = [];
          for (let k = 0; k <= N; k++) pts.push(k === N ? (W.length ? nurbsPoint(deg, U, ctl, W, t1 - 1e-12 * (t1 - t0)) : [ctl.at(-1)[0], ctl.at(-1)[1]]) : nurbsPoint(deg, U, ctl, W, t0 + (t1 - t0) * k / N));
          poly(pts, cls, T, out, blk);
        } else if (fit.length > 1) poly(fit.map(p => [p[0], p[1]]), cls, T, out, blk);
        else if (ctl.length > 1) poly(ctl.map(p => [p[0], p[1]]), cls, T, out, blk);
      } else if (e.type === 'ELLIPSE') {
        const c = d.pt(e, 10), ma = d.pt(e, 11), ratio = d.num(e, 40, 1), t0 = d.num(e, 41, 0), t1 = d.num(e, 42, 2 * Math.PI);
        const mb = [-ma[1] * ratio, ma[0] * ratio], pts = [];
        let b = t1; while (b <= t0) b += 2 * Math.PI;
        for (let k = 0; k <= 64; k++) { const t = t0 + (b - t0) * k / 64; pts.push([c[0] + ma[0] * Math.cos(t) + mb[0] * Math.sin(t), c[1] + ma[1] * Math.cos(t) + mb[1] * Math.sin(t)]); }
        poly(pts, cls, T, out, blk);
      } else if (e.type === 'INSERT' && depth < 8) {
        // anonymous blocks (*U...) are real geometry too; model/paper space blocks are not inserted; a block never inserts itself
        const name = d.get(e, 2), b = d.blocks.get(name);
        if (b && !/^\*(model|paper)_space/i.test(name) && !(stack ??= new Set()).has(name)) { stack.add(name); try { walk(b.entities, compose(T, insertT(d, e)), lt, depth + 1, out, name); } finally { stack.delete(name); } }
      }
    }
  };
  walk(d.entities, ident, null, 0, segs, null);
  // dimension graphics (lines of the anonymous *D blocks), only for drawing the picture
  for (const e of d.entities) if (e.type === 'DIMENSION') { const b = d.blocks.get(d.get(e, 2)); if (b) walk(b.entities, ident, null, 1, dimLines, null); }
  const W = d.extMax && d.extMin ? (d.extMax[0] - d.extMin[0]) * f : Math.max(...segs.flatMap(s => [s[0], s[2]]), 1);
  const H = d.extMax && d.extMin ? (d.extMax[1] - d.extMin[1]) * f : Math.max(...segs.flatMap(s => [s[1], s[3]]), 1);
  return { d, f, M, size_mm: [+W.toFixed(3), +H.toFixed(3)], segments: segs, circles, arcs, dimension_lines: dimLines };
}

// views: union-find of the visible/hidden primitives whose boxes touch (1 mm); the cluster spanning most of the sheet that
// contains the others is the FRAME (border + title block), not a view
export function dxfViews(g, tol = 1.0) {
  const items = g.segments.map((s, i) => ({ i, s, b: [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])] }));
  const main = items.filter(x => x.s[4] === 'visible' || x.s[4] === 'hidden');
  const par = main.map((_, k) => k), find = k => { while (par[k] !== k) k = par[k] = par[par[k]]; return k; };
  // sweep on x to keep the pairing near-linear for big drawings
  const order = main.map((x, k) => k).sort((a, b) => main[a].b[0] - main[b].b[0]);
  for (let a = 0; a < order.length; a++) {
    const A = main[order[a]].b;
    for (let b = a + 1; b < order.length; b++) {
      const B = main[order[b]].b; if (B[0] > A[2] + tol) break;
      if (B[1] <= A[3] + tol && B[3] >= A[1] - tol) { const ra = find(order[a]), rb = find(order[b]); if (ra !== rb) par[ra] = rb; }
    }
  }
  const groups = new Map();
  main.forEach((x, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x); });
  let clusters = [...groups.values()].map(list => ({ list, box: [Math.min(...list.map(x => x.b[0])), Math.min(...list.map(x => x.b[1])), Math.max(...list.map(x => x.b[2])), Math.max(...list.map(x => x.b[3]))] }));
  const [W, H] = g.size_mm;
  const frame = clusters.find(c => (c.box[2] - c.box[0]) > 0.8 * W && (c.box[3] - c.box[1]) > 0.8 * H) ?? null;
  clusters = clusters.filter(c => c !== frame && (c.box[2] - c.box[0]) + (c.box[3] - c.box[1]) > 3 && c.list.length >= 3);   // loose arrows of a cut line are not views
  // a cluster entirely inside another one (a hole outline drawn apart, a detail) belongs to it
  clusters = clusters.filter(c => !clusters.some(o => o !== c && o.box[0] <= c.box[0] && o.box[1] <= c.box[1] && o.box[2] >= c.box[2] && o.box[3] >= c.box[3] && (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) > (c.box[2] - c.box[0]) * (c.box[3] - c.box[1])));
  clusters.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) > 20 ? a.box[1] - b.box[1] : a.box[0] - b.box[0]));
  const views = clusters.map((c, k) => ({ id: k + 1, box_mm: c.box.map(v => +v.toFixed(4)), primitives: c.list.length, hidden_lines: c.list.filter(x => x.s[4] === 'hidden').length }));
  // section cut lines (phantom) and centre lines belong to the view their middle lies in
  const inBox = (p, b, m = 6) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
  for (const x of items) if (x.s[4] === 'phantom') { const mid = [(x.s[0] + x.s[2]) / 2, (x.s[1] + x.s[3]) / 2]; const v = views.find(v => inBox(mid, v.box_mm)); if (v) (v.section_cut_lines ??= []).push(x.s.slice(0, 4)); }
  return { views, frame: frame ? { box_mm: frame.box.map(v => +v.toFixed(2)), primitives: frame.list.length } : null };
}

// DIMENSION entities -> records like the PDF reader (dims_geometry.mjs measureDimensions)
export function dxfDimensions(path) {
  const g = dxfGeometry(path), { d, f, M } = g, { views, frame } = dxfViews(g);
  const ev = dxfEvidence(path);
  const byHandle = new Map(ev.dimensions.map(x => [x.handle, x]));
  const near = (p) => {
    const inside = views.filter(v => p.every(q => q[0] >= v.box_mm[0] - 1 && q[0] <= v.box_mm[2] + 1 && q[1] >= v.box_mm[1] - 1 && q[1] <= v.box_mm[3] + 1));
    if (inside.length) return inside.sort((a, b) => (a.box_mm[2] - a.box_mm[0]) * (a.box_mm[3] - a.box_mm[1]) - (b.box_mm[2] - b.box_mm[0]) * (b.box_mm[3] - b.box_mm[1]))[0];
    const m = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
    const dist = v => Math.hypot(Math.max(v.box_mm[0] - m[0], 0, m[0] - v.box_mm[2]), Math.max(v.box_mm[1] - m[1], 0, m[1] - v.box_mm[3]));
    return views.slice().sort((a, b) => dist(a) - dist(b))[0] ?? null;
  };
  const r2 = x => +x.toFixed(3);
  const out = [];
  for (const e of d.entities.filter(x => x.type === 'DIMENSION')) {
    const t = d.num(e, 70) & 7, lf = dimLfac(d, e), ev1 = byHandle.get(d.get(e, 5));
    const printed = ev1?.printed ?? '', num = Number((printed.match(/-?\d+(?:[.,]\d+)?/) ?? [''])[0].replace(',', '.'));
    const p10 = M(d.pt(e, 10)), p13 = M(d.pt(e, 13)), p14 = M(d.pt(e, 14)), p15 = M(d.pt(e, 15));
    // Codex review: every length in mm (an inch drawing prints 2.000 for 50.8 mm); the printed number is kept apart
    const lin = t !== 2 && t !== 5, hasNum = Number.isFinite(num) && printed !== '';
    const rec = { value: hasNum ? (lin ? +(num * f).toFixed(6) : num) : lin ? ev1?.value_mm ?? null : ev1?.value_drawing_units ?? null, printed_value: hasNum ? num : null, raw: printed, kind: ev1?.kind ?? 'unknown', source: 'DXF DIMENSION (puntos de definición, sin adivinar)', handle: d.get(e, 5) };
    const toPart = (v, p) => [r2((p[0] - v.box_mm[0]) * lf), r2((v.box_mm[3] - p[1]) * lf)];
    if (t === 0 || t === 1 || t === 6) {
      const ang = d.num(e, 50);
      rec.direction = t === 1 ? 'aligned' : Math.abs(Math.sin(ang * Math.PI / 180)) < 1e-6 ? 'horizontal' : Math.abs(Math.cos(ang * Math.PI / 180)) < 1e-6 ? 'vertical' : 'rotated';
      const v = near([p13, p14]); rec.view = v?.id ?? null;
      rec.from_mm = p13; rec.to_mm = p14;
      if (v) { rec.from_part_mm = toPart(v, p13); rec.to_part_mm = toPart(v, p14); }
    } else if (t === 3 || t === 4) {
      const c = t === 3 ? [(p10[0] + p15[0]) / 2, (p10[1] + p15[1]) / 2] : p10, rr = Math.hypot(p15[0] - c[0], p15[1] - c[1]);
      const v = near([c]); rec.view = v?.id ?? null; rec.radial = true;
      rec.center_mm = c.map(r2); rec.sheet_radius_mm = r2(rr); if (v) rec.center_part_mm = toPart(v, c);
    } else if (t === 2 || t === 5) {
      rec.angular = true;
      // vertex: the 3-point form gives it; the 2-line form is the intersection of its two lines (13-14 and 15-10)
      let vx = t === 5 ? p15 : null, ends = t === 5 ? [p13, p14] : [p14, p10];
      if (!vx) { const [a, b] = [p13, p14], [c, e] = [p15, p10], den = (a[0] - b[0]) * (c[1] - e[1]) - (a[1] - b[1]) * (c[0] - e[0]);
        if (Math.abs(den) > 1e-9) { const u = ((a[0] - c[0]) * (c[1] - e[1]) - (a[1] - c[1]) * (c[0] - e[0])) / den; vx = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]; }
        ends = [Math.hypot(p13[0] - vx?.[0], p13[1] - vx?.[1]) > Math.hypot(p14[0] - vx?.[0], p14[1] - vx?.[1]) ? p13 : p14, Math.hypot(p15[0] - vx?.[0], p15[1] - vx?.[1]) > Math.hypot(p10[0] - vx?.[0], p10[1] - vx?.[1]) ? p15 : p10]; }
      if (vx) { rec.vertex_mm = vx.map(r2); rec.rays_deg = ends.map(q => +(((Math.atan2(-(q[1] - vx[1]), q[0] - vx[0]) * 180 / Math.PI) + 360) % 360).toFixed(2)); const v = near([vx]); rec.view = v?.id ?? null; if (v) rec.vertex_part_mm = toPart(v, vx); }
    }
    if (!rec.angular) {
      rec.measured_mm = ev1 ? +(Number(ev1.measured_from_geometry) * f).toFixed(4) : null;
      rec.scale_used = +(1 / lf).toFixed(6); rec.dimlfac = lf;
      // printed vs what its own points measure: an edited text ("10x45°" typed over) shows up here
      rec.scale_ok = rec.measured_mm !== null && rec.value !== null && Math.abs(rec.measured_mm - rec.value) <= Math.max(0.01, 0.005 * Math.abs(rec.value));
      if (!rec.scale_ok) rec.note = `el texto dice ${printed} pero sus puntos miden ${rec.measured_mm}: texto escrito a mano o cota no asociativa`;
    } else rec.measured_deg = ev1?.value_drawing_units ?? null;
    out.push(rec);
  }
  for (const v of views) { const u = out.filter(o => o.view === v.id && o.scale_used); if (u.length) { const c = {}; for (const o of u) c[o.scale_used] = (c[o.scale_used] ?? 0) + 1; v.scale = +Object.entries(c).sort((x, y) => y[1] - x[1])[0][0]; } }
  // view titles written under/over a view (SECCIÓN A-A, DETALLE B, VISTA C)
  const lines = [];
  for (const w of ev.words) { const l = lines.find(l => Math.abs(l.y - w.bbox_mm[1]) < 1.5 && w.bbox_mm[0] - l.x1 < 6 && w.bbox_mm[0] >= l.x0); if (l) { l.text += ' ' + w.text; l.x1 = w.bbox_mm[2]; } else lines.push({ text: w.text, x0: w.bbox_mm[0], x1: w.bbox_mm[2], y: w.bbox_mm[1] }); }
  for (const l of lines) if (/^(SECCI[OÓ]N|SECTION|DETALLE|DETAIL|VISTA|VIEW)\b/i.test(l.text)) {
    const cx = (l.x0 + l.x1) / 2, v = views.filter(v => cx >= v.box_mm[0] - 5 && cx <= v.box_mm[2] + 5).sort((a, b) => Math.min(Math.abs(l.y - a.box_mm[3]), Math.abs(l.y - a.box_mm[1])) - Math.min(Math.abs(l.y - b.box_mm[3]), Math.abs(l.y - b.box_mm[1])))[0];
    if (v && Math.min(Math.abs(l.y - v.box_mm[3]), Math.abs(l.y - v.box_mm[1])) < 20) v.label = l.text;
  }
  // views without a dimension: the most common scale of the drawing
  const sc = {}; for (const v of views) if (v.scale) sc[v.scale] = (sc[v.scale] ?? 0) + 1; const common = Object.entries(sc).sort((x, y) => y[1] - x[1])[0]?.[0];
  if (common) for (const v of views) if (!v.scale) { v.scale = +common; v.scale_source = 'la más común del plano (la vista no tiene cotas)'; }
  return { geometry: g, views, frame, dimensions: out, evidence: ev };
}

// picture of the DXF (white page, geometry by class, dimension graphics, texts); returns the PNG path
export async function renderDxf(path, out_png, width_px, python) {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url'); const here = fileURLToPath(new URL('.', import.meta.url));
  const g = dxfGeometry(path), ev = dxfEvidence(path), tmp = out_png + '.json';
  writeFileSync(tmp, JSON.stringify({ size_mm: g.size_mm, segments: g.segments.map(s => s.slice(0, 5)), dimension_lines: g.dimension_lines, words: ev.words }));
  try { await promisify(execFile)(python, ['-E', here + 'dxf_render.py', tmp, out_png, String(width_px)], { windowsHide: true, timeout: 120000, maxBuffer: 16 << 20 }); }
  finally { try { unlinkSync(tmp); } catch { } }
  return { path: out_png, size_mm: g.size_mm };
}
