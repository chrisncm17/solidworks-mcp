// v3.8 "what does each dimension measure": the slowest part of an exam was reading the drawing (which view a dimension belongs
// to, horizontal or vertical, and FROM WHERE it measures - the "24" of the pillow block was misread). For PDFs exported by
// SolidWorks the answer is in the vector lines: geometry is drawn thicker than dimension/extension lines. For every linear
// dimension text this finds its dimension line (parallel to the text, next to it), the two extension lines that bracket it
// (their spacing must match value x sheet scale) and their far ends = the two points of the PART it measures. Geometry is
// grouped into views without needing view labels. An annotated PNG shows every dimension drawn in colour on the drawing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drawingPython, drawingRead } from './drawing_read.mjs';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const len = s => Math.hypot(s[2] - s[0], s[3] - s[1]);
const mid = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

// union-find of geometry segments whose endpoints touch -> views (bounding boxes), small pieces merged into the box they touch
function views(geo, size) {
  const n = geo.length, par = [...Array(n).keys()], f = i => par[i] === i ? i : (par[i] = f(par[i]));
  const key = (x, y) => `${Math.round(x / 0.6)},${Math.round(y / 0.6)}`, grid = new Map();
  geo.forEach((s, i) => { for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
    const k = `${Math.round(x / 0.6) + dx},${Math.round(y / 0.6) + dy}`; if (grid.has(k)) par[f(i)] = f(grid.get(k)); }
    for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) grid.set(key(x, y), i); });
  const boxes = new Map();
  geo.forEach((s, i) => { const r = f(i), b = boxes.get(r) ?? [1e9, 1e9, -1e9, -1e9];
    boxes.set(r, [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])]); });
  let list = [...boxes.values()].filter(b => !(b[2] - b[0] > 0.8 * size[0] || b[3] - b[1] > 0.8 * size[1]));   // sheet border / frame
  for (let changed = true; changed;) { changed = false;
    for (let i = 0; i < list.length && !changed; i++) for (let j = i + 1; j < list.length && !changed; j++) {
      const a = list[i], b = list[j], gap = 1.5;
      if (a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3]) { list[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; list.splice(j, 1); changed = true; } } }
  return list.filter(b => (b[2] - b[0]) * (b[3] - b[1]) > 100).sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((b, i) => ({ id: i + 1, box_mm: b.map(v => +v.toFixed(2)) }));
}

// SolidWorks exports circles and arcs as chains of short straight pieces: rebuild them (chain the pieces end to end, fit the
// circle through first/middle/last point, keep it only if every point is on it) -> [cx, cy, r, width] in sheet mm
export function polyArcs(geo, loose = false) {
  const sh = geo.filter(g => len(g) < (loose ? 8 : 4) && len(g) > 0.01), key = (x, y) => `${Math.round(x / 0.02)},${Math.round(y / 0.02)}`, at = new Map();
  sh.forEach((g, i) => { for (const [x, y] of [[g[0], g[1]], [g[2], g[3]]]) { const k = key(x, y); (at.get(k) ?? at.set(k, []).get(k)).push(i); } });
  const used = new Set(), out = [];
  const next = (i, x, y) => (at.get(key(x, y)) ?? []).filter(j => j !== i && !used.has(j));
  for (let i0 = 0; i0 < sh.length; i0++) {
    if (used.has(i0)) continue; used.add(i0);
    let pts = [[sh[i0][0], sh[i0][1]], [sh[i0][2], sh[i0][3]]];
    for (const end of [1, 0]) {   // grow forwards, then backwards
      for (let cur = i0, guard = 0; guard < 2000; guard++) {
        const p = end ? pts[pts.length - 1] : pts[0], n = next(cur, p[0], p[1]); if (n.length !== 1) break;
        const g = sh[n[0]];
        const q = Math.hypot(g[0] - p[0], g[1] - p[1]) < Math.hypot(g[2] - p[0], g[3] - p[1]) ? [g[2], g[3]] : [g[0], g[1]];
        // a corner (turn over 35 degrees) ends the chain: an arc is not continued through a short straight connector into the
        // next arc (the three concentric bends of the Allen key were one chain and no circle)
        const prev = end ? pts[pts.length - 2] : pts[1], u = [p[0] - prev[0], p[1] - prev[1]], v = [q[0] - p[0], q[1] - p[1]];
        if ((u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(...u) * Math.hypot(...v)) || 1) < Math.cos(35 * Math.PI / 180)) break;
        used.add(n[0]); cur = n[0];
        if (end) pts.push(q); else pts.unshift(q);
      }
    }
    if (pts.length < (loose ? 4 : 5)) continue;
    // loose (second try, short arcs of few pieces): a tessellated arc turns a little at every vertex; a hexagon or octagon
    // also lies on a circle but turns 60 or 45 degrees
    if (loose) { let sharp = false; for (let q = 1; q + 1 < pts.length && !sharp; q++) { const u = [pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]], v = [pts[q + 1][0] - pts[q][0], pts[q + 1][1] - pts[q][1]]; sharp = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v)) < Math.cos(35 * Math.PI / 180); } if (sharp) continue; }
    const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.05, n = pts.length;
    const [A, B, C] = closed ? [pts[0], pts[Math.floor(n / 3)], pts[Math.floor(2 * n / 3)]] : [pts[0], pts[Math.floor(n / 2)], pts[n - 1]];
    const dd = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1])); if (Math.abs(dd) < 1e-9) continue;
    const ux = ((A[0] ** 2 + A[1] ** 2) * (B[1] - C[1]) + (B[0] ** 2 + B[1] ** 2) * (C[1] - A[1]) + (C[0] ** 2 + C[1] ** 2) * (A[1] - B[1])) / dd;
    const uy = ((A[0] ** 2 + A[1] ** 2) * (C[0] - B[0]) + (B[0] ** 2 + B[1] ** 2) * (A[0] - C[0]) + (C[0] ** 2 + C[1] ** 2) * (B[0] - A[0])) / dd;
    const r = Math.hypot(A[0] - ux, A[1] - uy);
    if (r > 0.2 && r < 400 && pts.every(q => Math.abs(Math.hypot(q[0] - ux, q[1] - uy) - r) < Math.max(0.03, r * 0.01))) out.push([ux, uy, r, sh[i0][4], pts[0], pts[n - 1], closed]);
  }
  return out;
}

export function measureDimensions({ words, dims, segments, size, scales, unit, arcs = [] }) {
  // Codex review: the most frequent width can be the dimension lines (many short ones). SolidWorks draws dimension and
  // extension lines with the THINNEST pen, so: thinnest width class (5+ straight segments) = dimensions; geometry = the most
  // frequent of the thicker classes (the frame and title block are thicker too, but have few segments)
  const straight = segments.filter(s => !s[5]), cnt = {};
  for (const s of straight) { const w = +s[4].toFixed(2); cnt[w] = (cnt[w] ?? 0) + 1; }
  const cls = Object.entries(cnt).map(([w, n]) => [+w, n]).filter(([, n]) => n >= 5).sort((a, b) => a[0] - b[0]);
  const thinW = cls.length > 1 ? cls[0][0] : null;
  const geoW = thinW === null ? cls[0]?.[0] : cls.filter(([w]) => w > thinW + 0.02).sort((a, b) => b[1] - a[1])[0]?.[0];
  const thin = thinW === null ? [] : straight.filter(s => s[4] < geoW - 0.02), geo = segments.filter(s => Math.abs(s[4] - geoW) < 0.02);
  if (thinW === null || geoW === undefined) return { views: views(geo, size), dimensions: [], line_widths_mm: { geometry: geoW ?? null, dimension: null }, uncertain: 'todas las líneas tienen el mismo grosor: no se distinguen cotas de geometría; revisa la imagen' };
  const vs = views(geo, size);
  const inView = p => vs.find(v => p[0] >= v.box_mm[0] - 2 && p[0] <= v.box_mm[2] + 2 && p[1] >= v.box_mm[1] - 2 && p[1] <= v.box_mm[3] + 2)?.id ?? null;
  const out = [], pend = [], radial = [], angular = [], failLin = [];
  // pass 1: for every linear dimension, its dimension line and the extension lines that touch it
  for (const dm of dims.filter(d => d.kind === 'linear' || d.kind === 'angle' || d.kind === 'diameter' || d.kind === 'radius')) {
    const w = words.find(x => x.text === dm.raw && Math.abs(x.bbox_mm[0] - dm.bbox_mm[0]) < 0.01 && Math.abs(x.bbox_mm[1] - dm.bbox_mm[1]) < 0.01);
    const ang = w?.angle_deg ?? 0, c = mid(dm.bbox_mm), r = { value: dm.value, raw: dm.raw, kind: dm.kind, text_angle_deg: +ang.toFixed(1) };
    if (dm.kind === 'diameter' || dm.kind === 'radius') { radial.push({ dm, r, c }); continue; }
    if (dm.kind === 'angle') { angular.push({ dm, r, c }); continue; }
    if (dm.kind !== 'linear') { out.push({ ...r, note: 'revisa en la imagen' }); continue; }
    // axis of the dimension: text at ~0 deg measures horizontally, at ~90 deg vertically; other angles = aligned dimension
    const a = Math.round(ang) % 180 === 0 ? 0 : Math.round(ang) % 180 === 90 ? Math.PI / 2 : ang * Math.PI / 180;
    const d = [Math.cos(a), -Math.sin(a)], nrm = [-d[1], d[0]];   // y grows downwards on the sheet
    const along = p => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1], across = p => (p[0] - c[0]) * nrm[0] + (p[1] - c[1]) * nrm[1];
    const par = thin.filter(s => { const v = [(s[2] - s[0]) / len(s), (s[3] - s[1]) / len(s)]; return Math.abs(v[0] * nrm[0] + v[1] * nrm[1]) < 0.02; });
    // dimension line: parallel thin segment 0..6 mm from the text centre, overlapping it along the axis (or close to it)
    const cand = par.map(s => ({ s, off: (across([s[0], s[1]]) + across([s[2], s[3]])) / 2, t: [along([s[0], s[1]]), along([s[2], s[3]])].sort((x, y) => x - y) }))
      .filter(x => Math.abs(x.off) < 6 && x.t[0] < 25 && x.t[1] > -25).sort((x, y) => Math.abs(x.off) - Math.abs(y.off));
    if (!cand.length) { failLin.push({ dm, c, o: { ...r, note: 'no encontré la línea de cota' } }); continue; }
    const off = cand[0].off;
    // extension lines: thin segments perpendicular to the axis with one end on the dimension line
    const perp = thin.filter(s => { const v = [(s[2] - s[0]) / len(s), (s[3] - s[1]) / len(s)]; return Math.abs(v[0] * d[0] + v[1] * d[1]) < 0.02; });
    const ext = [];
    for (const s of perp) { const e1 = [s[0], s[1]], e2 = [s[2], s[3]], o1 = Math.abs(across(e1) - off), o2 = Math.abs(across(e2) - off);
      const near = Math.min(o1, o2), far = o1 < o2 ? e2 : e1, t = along(e1);
      if (near < 2.5 && Math.abs(t) < 200) ext.push({ t, foot: far, base: o1 < o2 ? e1 : e2, len: len(s) }); }
    const uniq = []; for (const e of ext.sort((x, y) => x.t - y.t)) if (!uniq.length || Math.abs(e.t - uniq[uniq.length - 1].t) > 0.3) uniq.push(e); else if (e.len > uniq[uniq.length - 1].len) uniq[uniq.length - 1] = e;
    const mmv = dm.value * (unit ?? 1), pairs = [];
    for (let i = 0; i < uniq.length; i++) for (let k = i + 1; k < uniq.length; k++) { const sp = uniq[k].t - uniq[i].t; if (sp > 0.2) pairs.push({ i, j: k, sp, ratio: sp / mmv, brack: uniq[i].t <= 1 && uniq[k].t >= -1 }); }
    pend.push({ r, a, off, uniq, pairs, mmv, dm, c, dl: cand[0].s });
  }
  // pass 2: the view scale is voted by the dimensions themselves (the title block can say 1:5 while the views are at 1:3,
  // and sections/details have their own scale); every scale printed on the page is a candidate too
  const votes = new Map(), bin = x => Math.round(Math.log(x) / Math.log(1.01));
  for (const p of pend) for (const b of new Set(p.pairs.map(q => bin(q.ratio)))) votes.set(b, (votes.get(b) ?? 0) + 1);
  const known = [...new Set((scales ?? []).filter(v => v > 0))];
  const voted = [...votes].filter(([, n]) => n >= 3).map(([b]) => Math.pow(1.01, b));
  const allowed = [...known, ...voted];
  for (const p of pend) {
    let best = null;
    for (const q of p.pairs) for (const sc of allowed) {
      const err = Math.abs(q.ratio - sc) / sc; if (err > 0.02) continue;
      const score = err + (known.includes(sc) ? 0 : 0.005) + (q.brack ? 0 : 0.05) + 0.0005 * Math.abs(p.uniq[q.i].t + p.uniq[q.j].t);
      if (!best || score < best.score) best = { ...q, sc, err, score, source: known.includes(sc) ? 'escrita en el plano' : 'votada por las cotas' };
    }
    if (!best) { failLin.push({ dm: p.dm, c: p.c, p, o: { ...p.r, note: 'no encontré dos líneas de referencia que cuadren con una escala de la página', dimension_line_offset_mm: +p.off.toFixed(2) } }); continue; }
    const e1 = p.uniq[best.i], e2 = p.uniq[best.j], view = inView(e1.foot) ?? inView(e2.foot);
    // Codex review: extension lines stop short of the outline (gap). Walk on from the free end, along the extension line,
    // up to 3 mm to the first geometry it meets; that is the part point. If nothing is met, keep only the sheet evidence.
    const snap = e => { const u = [e.foot[0] - e.base[0], e.foot[1] - e.base[1]], L = Math.hypot(u[0], u[1]) || 1, dir = [u[0] / L, u[1] / L];
      let bestT = null;
      for (const g of geo) { const gx = g[2] - g[0], gy = g[3] - g[1], den = dir[0] * gy - dir[1] * gx; if (Math.abs(den) < 1e-9) {
          const dd = Math.abs((g[0] - e.foot[0]) * dir[1] - (g[1] - e.foot[1]) * dir[0]); if (dd < 0.05) { const t0 = Math.min(...[[g[0], g[1]], [g[2], g[3]]].map(q => (q[0] - e.foot[0]) * dir[0] + (q[1] - e.foot[1]) * dir[1]));
            if (t0 >= -0.05 && t0 <= 3 && (bestT === null || t0 < bestT)) bestT = Math.max(0, t0); } continue; }
        const wx = g[0] - e.foot[0], wy = g[1] - e.foot[1], t = (wx * gy - wy * gx) / den, sg = (wx * dir[1] - wy * dir[0]) / den;
        if (t >= -0.05 && t <= 3 && sg >= -0.01 && sg <= 1.01 && (bestT === null || t < bestT)) bestT = Math.max(0, t); }
      return bestT === null ? null : [e.foot[0] + dir[0] * bestT, e.foot[1] + dir[1] * bestT]; };
    const s1 = snap(e1), s2 = snap(e2), f1 = s1 ?? e1.foot, f2 = s2 ?? e2.foot;
    // the same two points in PART millimetres, from the lower-left corner of their view (x right, y up)
    const vb = vs.find(v => v.id === view)?.box_mm, k = best.sc;
    const inPart = q => vb ? [+((q[0] - vb[0]) / k).toFixed(2), +((vb[3] - q[1]) / k).toFixed(2)] : null;
    out.push({ ...p.r, direction: p.a === 0 ? 'horizontal' : p.a === Math.PI / 2 ? 'vertical' : 'alineada', view, from_mm: f1.map(v => +v.toFixed(2)), to_mm: f2.map(v => +v.toFixed(2)),
      ...(vb ? { from_part_mm: inPart(f1), to_part_mm: inPart(f2) } : {}), ...(s1 && s2 ? {} : { part_points: 'una línea de referencia no llega a geometría (eje, centro o hueco): ese extremo es el de la línea, verifica en la imagen' }),
      sheet_span_mm: +best.sp.toFixed(3), ratio: +best.ratio.toFixed(4), scale_used: +best.sc.toFixed(4), scale_source: best.source, scale_ok: true });
  }
  const geoArcs = polyArcs(geo);
  for (const a of arcs.filter(a => Math.abs(a[3] - geoW) < 0.02 && a[2] > 0.2)) if (!geoArcs.some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05 && Math.abs(a[2] - b[2]) < 0.05)) geoArcs.push(a);
  // scale of each view from its LINEAR dimensions; a radius/diameter uses it when it can (and never votes)
  const linScale = {}; for (const v of vs) { const u = out.filter(o => o.view === v.id && o.scale_used), cc = {}; for (const o of u) cc[o.scale_used] = (cc[o.scale_used] ?? 0) + 1; const e = Object.entries(cc).sort((x, y) => y[1] - x[1])[0]; if (e) linScale[v.id] = +e[0]; }
  let looseArcs = null;
  const matchCircle = (dm, c, asDiameter, loose = false) => {
    const want = dm.value * (unit ?? 1) * (asDiameter ? 0.5 : 1);
    let best = null;
    const pool = loose ? (looseArcs ??= polyArcs(geo, true)) : geoArcs;
    for (const a of pool) for (const sc of allowed) {
      const err = Math.abs(a[2] - want * sc) / (want * sc); if (err > 0.015) continue;
      const vsc = linScale[inView([a[0], a[1]])], d = Math.hypot(a[0] - c[0], a[1] - c[1]) - a[2], score = err * 50 + Math.abs(d) / 20 + (known.includes(sc) ? 0 : 0.05) + (vsc && Math.abs(vsc - sc) / vsc > 0.02 ? 1 : 0);
      if (Math.abs(d) < 60 && (!best || score < best.score)) best = { a, sc, err, score };
    }
    if (!best) return null;
    const view = inView([best.a[0], best.a[1]]), vb = vs.find(v => v.id === view)?.box_mm, k = best.sc;
    return { view, center_mm: [+best.a[0].toFixed(2), +best.a[1].toFixed(2)], ...(vb ? { center_part_mm: [+((best.a[0] - vb[0]) / k).toFixed(2), +((vb[3] - best.a[1]) / k).toFixed(2)] } : {}),
      sheet_radius_mm: +best.a[2].toFixed(3), scale_used: +k.toFixed(4), scale_ok: true, radial: true };
  };
  for (const { dm, r, c } of radial) {
    const m = matchCircle(dm, c, dm.kind === 'diameter') ?? (() => { const q = matchCircle(dm, c, dm.kind === 'diameter', true); return q && { ...q, note: 'arco corto (pocos tramos): revisa en la imagen' }; })();
    out.push(m ? { ...r, ...m } : { ...r, note: `${dm.kind === 'diameter' ? 'diámetro' : 'radio'}: no encontré un círculo o arco de ese tamaño a una escala de la página; revisa la imagen` });
  }
  // no extension lines: the dimension line itself may cross the two edges it measures (thin ribs, aligned dimensions with
  // the arrows outside). Cross the (infinite) dimension line with the geometry; two crossings value x scale apart
  const crossing = p => {
      const g0 = p.dl, d0 = [g0[2] - g0[0], g0[3] - g0[1]], L0 = Math.hypot(...d0), u0 = [d0[0] / L0, d0[1] / L0], xs = [];
      // the edges themselves, or thin lines perpendicular to the dimension (extension lines that run across it)
      const perpThin = thin.filter(g => Math.abs(((g[2] - g[0]) * u0[0] + (g[3] - g[1]) * u0[1]) / (len(g) || 1)) < 0.02);
      for (const g of [...geo, ...perpThin]) { const gx = g[2] - g[0], gy = g[3] - g[1], den = u0[0] * gy - u0[1] * gx; if (Math.abs(den) < 1e-6) continue;
        const wx = g[0] - g0[0], wy = g[1] - g0[1], t = (wx * gy - wy * gx) / den, sg = (wx * u0[1] - wy * u0[0]) / den;
        if (sg >= -0.01 && sg <= 1.01) xs.push(t); }
      xs.sort((x, y) => x - y);
      const tc = (p.c[0] - g0[0]) * u0[0] + (p.c[1] - g0[1]) * u0[1];
      let cb = null;
      for (let x = 0; x < xs.length; x++) for (let y = x + 1; y < xs.length; y++) { const sp = xs[y] - xs[x]; if (sp < 0.2) continue;
        for (const sc of allowed) { const err = Math.abs(sp / p.mmv - sc) / sc; if (err > 0.02 && Math.abs(sp - p.mmv * sc) > 0.06) continue;
          const score = err + 0.002 * Math.abs((xs[x] + xs[y]) / 2 - tc) + (known.includes(sc) ? 0 : 0.005);
          if (!cb || score < cb.score) cb = { t1: xs[x], t2: xs[y], sp, sc, score, source: known.includes(sc) ? 'escrita en el plano' : 'votada por las cotas' }; } }
      if (cb) {
        const P1 = [g0[0] + u0[0] * cb.t1, g0[1] + u0[1] * cb.t1], P2 = [g0[0] + u0[0] * cb.t2, g0[1] + u0[1] * cb.t2], view = inView(P1) ?? inView(P2);
        const vb = vs.find(v => v.id === view)?.box_mm, k = cb.sc, inPart = q => [+((q[0] - vb[0]) / k).toFixed(2), +((vb[3] - q[1]) / k).toFixed(2)];
        out.push({ ...p.r, direction: p.a === 0 ? 'horizontal' : p.a === Math.PI / 2 ? 'vertical' : 'alineada', view, from_mm: P1.map(v => +v.toFixed(2)), to_mm: P2.map(v => +v.toFixed(2)),
          ...(vb ? { from_part_mm: inPart(P1), to_part_mm: inPart(P2) } : {}), sheet_span_mm: +cb.sp.toFixed(3), ratio: +(cb.sp / p.mmv).toFixed(4), scale_used: +k.toFixed(4), scale_source: cb.source, scale_ok: true,
          note: 'sin líneas de referencia: la línea de cota cruza los dos bordes que mide' });
        return true;
      }
      return false;
  };
  // a number with no dimension lines next to a circle of that DIAMETER: the Ø symbol is often drawn, not text; else the crossings
  for (const { dm, c, o, p } of failLin) {
    const m = matchCircle(dm, c, true);
    const cc = m && [m.center_mm[0], m.center_mm[1]], rr = m && m.sheet_radius_mm;
    // the leader often runs UNDER the text: distance from the text centre to the whole segment, not to its ends
    const segDist = (g, q) => { const dx = g[2] - g[0], dy = g[3] - g[1], L2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((q[0] - g[0]) * dx + (q[1] - g[1]) * dy) / L2)); return Math.hypot(g[0] + u * dx - q[0], g[1] + u * dy - q[1]); };
    const leader = m && thin.some(g => { const near = segDist(g, c) < 6;
      const dx = g[2] - g[0], dy = g[3] - g[1], L = Math.hypot(dx, dy); return near && L > 2 && Math.abs((cc[0] - g[0]) * dy - (cc[1] - g[1]) * dx) / L < Math.max(0.3, 0.1 * rr); });
    if (m && leader) { out.push({ ...o, ...m, kind: 'diameter', note: 'diámetro deducido: el símbolo Ø viene dibujado, no como texto (línea guía hacia el centro)' }); continue; }
    if (p && crossing(p)) continue;
    out.push(o);
  }
  // v3.8 angles: the dimension is a THIN arc (chain of short pieces) whose centre is the vertex and whose span is the value;
  // gives the vertex in part mm and the two ray directions (degrees, x right, y up)
  // pieces of one arc (split by the text or the arrows) share centre and radius: join them, keep the widest pair of ends
  // pieces of one arc (split by the text or the arrows) share centre and radius: join them, keep the widest pair of ends
  const joinArcs = list => { const out2 = [];
    for (const a of list.filter(a => !a[6])) { const g = out2.find(b => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.1 && Math.abs(a[2] - b[2]) < 0.1); if (g) g.ends.push(a[4], a[5]); else out2.push(Object.assign([...a], { ends: [a[4], a[5]] })); }
    for (const g of out2) { let bw = -1; for (let i = 0; i < g.ends.length; i++) for (let j = i + 1; j < g.ends.length; j++) { const u = [g.ends[i][0] - g[0], g.ends[i][1] - g[1]], v = [g.ends[j][0] - g[0], g.ends[j][1] - g[1]]; const w = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))))); if (w > bw) { bw = w; g[4] = g.ends[i]; g[5] = g.ends[j]; } } }
    return out2; };
  const thinAll = segments.filter(s => s[4] < geoW - 0.02);
  const thinArcs = joinArcs(polyArcs(thinAll));
  let thinArcsLoose = null;
  // the arc only gives the VERTEX (its centre; it often runs past the rays because of the arrows); the two rays are the
  // straight lines (extension lines or the edges themselves) through that vertex whose directions make the dimensioned angle
  const straightAll = segments.filter(g => !g[5] && len(g) > 1);
  for (const { dm, r, c } of angular) {
    let best = null;
    for (const pass of [0, 1]) { if (best) break; const pool = pass ? (thinArcsLoose ??= joinArcs(polyArcs(thinAll, true))) : thinArcs;
    for (const a of pool) {
      const off = Math.abs(Math.hypot(c[0] - a[0], c[1] - a[1]) - a[2]); if (off > 8) continue;
      const rays = [];
      for (const g of straightAll) {
        const dx = g[2] - g[0], dy = g[3] - g[1], L = Math.hypot(dx, dy), dist = Math.abs((a[0] - g[0]) * dy - (a[1] - g[1]) * dx) / L;
        if (dist > Math.max(0.15, 0.006 * a[2])) continue;   // a big arc split in pieces has a less exact centre
        const far = Math.hypot(g[0] - a[0], g[1] - a[1]) > Math.hypot(g[2] - a[0], g[3] - a[1]) ? [g[0], g[1]] : [g[2], g[3]];
        const v = [far[0] - a[0], far[1] - a[1]], n = Math.hypot(...v); if (n < 1) continue;
        const u = [v[0] / n, v[1] / n]; if (!rays.some(q => q[0] * u[0] + q[1] * u[1] > 0.9999)) rays.push(u);
      }
      for (let x = 0; x < rays.length; x++) for (let y = x + 1; y < rays.length; y++) {
        const ang = Math.acos(Math.max(-1, Math.min(1, rays[x][0] * rays[y][0] + rays[x][1] * rays[y][1]))) * 180 / Math.PI;
        const err = Math.abs(ang - dm.value); if (err > 1) continue;
        const score = err + off / 10;
        if (!best || score < best.score) best = { a, span: ang, score, v1: rays[x], v2: rays[y] };
      }
    }
    }
    if (!best) { out.push({ ...r, note: 'ángulo: no encontré su vértice y sus dos rayos; revisa la imagen' }); continue; }
    const vtx = [best.a[0], best.a[1]], view = inView(vtx), vb = vs.find(v => v.id === view)?.box_mm, k = linScale[view] ?? (known.length === 1 ? known[0] : undefined);
    const dir = v => +((Math.atan2(-v[1], v[0]) * 180 / Math.PI + 360) % 360).toFixed(1);
    out.push({ ...r, view, vertex_mm: vtx.map(v => +v.toFixed(2)), ...(vb && k ? { vertex_part_mm: [+((vtx[0] - vb[0]) / k).toFixed(2), +((vb[3] - vtx[1]) / k).toFixed(2)] } : {}),
      rays_deg: [dir(best.v1), dir(best.v2)], measured_deg: +best.span.toFixed(2), angular: true });
  }
  // title block numbers and loose text: no dimension line and far from every view
  const near = b => vs.some(v => mid(b)[0] > v.box_mm[0] - 30 && mid(b)[0] < v.box_mm[2] + 30 && mid(b)[1] > v.box_mm[1] - 30 && mid(b)[1] < v.box_mm[3] + 30);
  const kept = out.filter(o => o.from_mm || o.radial || o.angular || (near(dims.find(d => d.raw === o.raw)?.bbox_mm ?? [0, 0, 0, 0]) && !/no encontré la línea/.test(o.note ?? '')));
  // scale actually used per view (the most common one among its dimensions)
  for (const v of vs) { const u = kept.filter(o => o.view === v.id && o.scale_used && !o.radial); if (u.length) { const c = {}; for (const o of u) c[o.scale_used] = (c[o.scale_used] ?? 0) + 1; v.scale = +Object.entries(c).sort((x, y) => y[1] - x[1])[0][0]; } }
  return { views: vs, dimensions: kept, line_widths_mm: { geometry: geoW, dimension: thin[0]?.[4] ?? null } };
}

// one call: words + vector lines + matching + annotated PNG
export async function drawingDimensions({ path: pdf, page = 1, out_png }) {
  // v3.9 DXF: the dimensions carry their own definition points: nothing is matched, every record is exact
  if (/\.dxf$/i.test(pdf)) {
    const { dxfDimensions, renderDxf } = await import('./dxf_geometry.mjs');
    const r = dxfDimensions(pdf), t = await drawingRead({ action: 'text', path: pdf });
    const res = { page: 1, format: 'dxf', sheet_scale: null, materials: t.materials, views: r.views, frame: r.frame, dimensions: r.dimensions, units: 'mm (DIMLFAC aplicado: valores reales de la pieza)',
      warnings: [...(r.evidence.warnings ?? []), ...r.dimensions.filter(x => x.scale_ok === false).map(x => `Cota ${x.raw}: ${x.note}`)] };
    if (out_png) {
      const { mkdirSync } = await import('node:fs'); mkdirSync(path.dirname(out_png), { recursive: true });
      const py = await drawingPython(), base = out_png.replace(/\.png$/i, '') + '_page.png';
      await renderDxf(pdf, base, 3000, py);
      await exec(py, ['-E', path.join(here, 'dims_overlay.py'), base, out_png, JSON.stringify({ size_mm: r.geometry.size_mm, views: r.views, dimensions: r.dimensions })], { windowsHide: true, timeout: 120000, maxBuffer: 16 << 20 });
      res.annotated_png = out_png;
    }
    return res;
  }
  const t = await drawingRead({ action: 'text', path: pdf, page: Number(page) });
  const py = await drawingPython();
  const { stdout } = await exec(py, ['-E', path.join(here, 'pdf_lines.py'), pdf, String(page)], { windowsHide: true, maxBuffer: 64 << 20, timeout: 60000 });
  const lines = JSON.parse(stdout);
  const scales = (t.scales ?? []).map(x => x.value ?? x.ratio).filter(v => v > 0), scale = scales[0] ?? null;
  // inches when the notes say so ("LAS COTAS SE EXPRESAN EN IN"): values are converted to mm before matching
  const allText = (t.words ?? []).map(w => w.text).join(' ').toUpperCase();
  const inch = /EXPRESAN EN IN\b|EN PULGADAS|\bINCHES\b/.test(allText);
  const r = measureDimensions({ words: t.words, dims: t.dimension_candidates, segments: lines.segments, arcs: lines.arcs ?? [], size: lines.size_mm, scales, unit: inch ? 25.4 : 1 });
  r.units = inch ? 'in (convertidas a mm para medir; from_part_mm en mm)' : 'mm';
  if (out_png) {
    // Codex review: the PNGs are written only inside the real generated tree (no junction anywhere on the way)
    const { realpathSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(out_png), { recursive: true });
    const gen = path.join(here, 'generated');
    if (realpathSync(path.dirname(out_png)).toLowerCase() !== path.resolve(path.dirname(out_png)).toLowerCase() || !path.resolve(out_png).toLowerCase().startsWith(gen.toLowerCase() + path.sep) || realpathSync(gen).toLowerCase() !== gen.toLowerCase()) throw new Error('out_png fuera de generated o redirigido (junction): rechazado');
    // page image with the same Windows renderer as the rest of drawing_read, then the overlay
    const dir = path.dirname(out_png), pre = 'dimpage' + Date.now().toString(36);
    const { stdout: ro } = await exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'render-pdf-many.ps1'), '-InputPath', pdf, '-OutputDir', dir, '-Pages', String(page), '-Width', '3000', '-Prefix', pre], { windowsHide: true, timeout: 120000 });
    const png = JSON.parse(ro.trim().split(String.fromCharCode(10)).pop().trim()).path;
    await exec(py, ['-E', path.join(here, 'dims_overlay.py'), png, out_png, JSON.stringify({ size_mm: lines.size_mm, views: r.views, dimensions: r.dimensions })], { windowsHide: true, timeout: 120000, maxBuffer: 16 << 20 });
    r.annotated_png = out_png;
  }
  return { page, sheet_scale: scale, materials: t.materials, ...r };
}
