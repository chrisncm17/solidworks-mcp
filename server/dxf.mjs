// v3.3 DXF reader (pure JS, no dependencies) for sw_drawing_read: texts and DIMENSION entities as objective evidence.
// A DIMENSION carries its definition points, so its value is RECOMPUTED from geometry (not only read from the printed text);
// the printed text (override or the block's MTEXT) is kept next to it. Coordinates are drawing units with origin bottom-left as in
// the DXF; they are converted to the same "top-left, mm" frame used for PDFs when the sheet size is known ($EXTMIN/$EXTMAX).
import { readFileSync } from 'node:fs';

const UNITS = { 0: null, 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const TO_MM = { in: 25.4, ft: 304.8, mm: 1, cm: 10, m: 1000 };

// DXF text codes -> plain text (%%c Ø, %%d °, %%p ±, \U+XXXX, MTEXT formatting)
export function dxfText(s) {
  return String(s ?? '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/\\P/g, ' ').replace(/\\[ACFHQTWfhqtw][^;]*;/g, '').replace(/\\[LlOoKk]/g, '').replace(/\\S([^^;]*)\^([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

// group-code pairs
function pairs(src) {
  const lines = src.replace(/\r/g, '').split('\n'), out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  return out;
}

export function parseDxf(path) {
  const buf = readFileSync(path);
  if (buf.slice(0, 22).toString('latin1').startsWith('AutoCAD Binary DXF')) throw new Error('DXF binario no soportado: expórtalo como DXF ASCII');
  let src = buf.toString('utf8'); if (src.includes('�')) src = buf.toString('latin1');
  const P = pairs(src);
  const header = {}, blocks = new Map(), entities = [], tables = [];
  let section = null, cur = null, block = null, lastVar = null;
  const flush = () => { if (!cur) return; if (cur.table) tables.push(cur); else if (block) block.entities.push(cur); else if (section === 'ENTITIES') entities.push(cur); cur = null; };
  for (const [code, raw] of P) {
    const v = raw.trim();
    if (code === 0) {
      flush();
      if (v === 'SECTION') { section = 'pending'; continue; }
      if (v === 'ENDSEC') { section = null; continue; }
      if (v === 'BLOCK') { block = { name: null, entities: [] }; continue; }
      if (v === 'ENDBLK') { if (block?.name) blocks.set(block.name, block); block = null; continue; }
      if (section === 'ENTITIES' || (section === 'BLOCKS' && block)) cur = { type: v, g: [] };
      else if (section === 'TABLES' && v !== 'TABLE' && v !== 'ENDTAB') cur = { type: v, g: [], table: true };   // v3.9: LAYER, LTYPE, DIMSTYLE records
      continue;
    }
    if (section === 'pending' && code === 2) { section = v; continue; }
    if (section === 'HEADER') { if (code === 9) lastVar = v; else if (lastVar) (header[lastVar] ??= []).push([code, v]); continue; }
    if (block && !cur && code === 2 && !block.name) { block.name = v; continue; }
    if (block && !cur && (code === 10 || code === 20)) { (block.base ??= [0, 0])[code === 10 ? 0 : 1] = Number(v); continue; }   // v3.9: block base point
    if (cur) cur.g.push([code, raw]);
  }
  flush();
  const get = (e, c) => { const x = e.g.find(([k]) => k === c); return x ? x[1] : undefined; };
  const num = (e, c, d = 0) => { const x = get(e, c); return x === undefined ? d : Number(x); };
  const pt = (e, cx) => [num(e, cx), num(e, cx + 10)];
  const insUnits = Number(header.$INSUNITS?.[0]?.[1] ?? 0), units = UNITS[insUnits] ?? (Number(header.$MEASUREMENT?.[0]?.[1]) === 1 ? 'mm' : null);
  const extMin = header.$EXTMIN ? [Number(header.$EXTMIN.find(([k]) => k === 10)?.[1]), Number(header.$EXTMIN.find(([k]) => k === 20)?.[1])] : null;
  const extMax = header.$EXTMAX ? [Number(header.$EXTMAX.find(([k]) => k === 10)?.[1]), Number(header.$EXTMAX.find(([k]) => k === 20)?.[1])] : null;
  // v3.9: dimension styles (DIMLFAC = paper-to-model factor: SolidWorks writes every dimension in SHEET units, so on a 1:4 view
  // a 150 mm dimension measures 37.5 and its style carries DIMLFAC 4) and the linetype of each layer
  const dimstyles = new Map(), layers = new Map();
  for (const t of tables) {
    if (t.type === 'DIMSTYLE') dimstyles.set(get(t, 2), { dimlfac: Number(get(t, 144) ?? 1) || 1 });
    if (t.type === 'LAYER') layers.set(get(t, 2), { linetype: get(t, 6) ?? 'CONTINUOUS' });
  }
  return { header, blocks, entities, tables, dimstyles, layers, get, num, pt, units, extMin, extMax, version: header.$ACADVER?.[0]?.[1] };
}

// DIMLFAC of one DIMENSION: its style, overridden by ACAD XDATA (1070 144 followed by 1040 value)
export function dimLfac(d, e) {
  let f = d.dimstyles.get(d.get(e, 3))?.dimlfac ?? 1;
  const g = e.g, i = g.findIndex(([k, v]) => k === 1001 && v.trim() === 'ACAD');
  if (i >= 0) for (let j = i + 1; j + 1 < g.length; j++) if (g[j][0] === 1070 && Number(g[j][1]) === 144 && g[j + 1][0] === 1040) { f = Number(g[j + 1][1]) || f; break; }
  return f;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// measured value of a DIMENSION from its definition points (AutoCAD conventions)
function measure(d, e) {
  const t = d.num(e, 70) & 7, m42 = d.num(e, 42, -1);
  const p10 = d.pt(e, 10), p13 = d.pt(e, 13), p14 = d.pt(e, 14), p15 = d.pt(e, 15), p16 = d.pt(e, 16);
  let kind, value;
  if (t === 0) { kind = 'linear'; const a = d.num(e, 50) * Math.PI / 180; value = Math.abs((p14[0] - p13[0]) * Math.cos(a) + (p14[1] - p13[1]) * Math.sin(a)); }
  else if (t === 1) { kind = 'linear'; value = dist(p13, p14); }
  else if (t === 3) { kind = 'diameter'; value = dist(p10, p15); }
  else if (t === 4) { kind = 'radius'; value = dist(p10, p15); }
  else if (t === 2 || t === 5) { kind = 'angle';
    const v1 = t === 5 ? [p13[0] - p15[0], p13[1] - p15[1]] : [p14[0] - p13[0], p14[1] - p13[1]], v2 = t === 5 ? [p14[0] - p15[0], p14[1] - p15[1]] : [p10[0] - p15[0], p10[1] - p15[1]];
    value = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2))))) * 180 / Math.PI; }
  else if (t === 6) { kind = 'linear'; value = (d.num(e, 70) & 64) ? Math.abs(p14[0] - p13[0]) : Math.abs(p14[1] - p13[1]); }
  else kind = 'unknown';
  return { kind, value: m42 >= 0 ? m42 : value, stored: m42 >= 0 ? m42 : null, computed: value };
}

// texts + dimensions of a DXF in the drawing_read 'text' shape (bbox in mm, origin top-left of the extents)
export function dxfEvidence(path) {
  const d = parseDxf(path);
  const f = d.units ? TO_MM[d.units] : 1;
  const top = d.extMax ? d.extMax[1] : 0, left = d.extMin ? d.extMin[0] : 0;
  const box = (p, w, h) => [(p[0] - left) * f, (top - p[1] - h) * f, (p[0] - left + w) * f, (top - p[1]) * f];
  const words = [], dims = [];
  const textOf = e => e.type === 'MTEXT' ? dxfText(e.g.filter(([k]) => k === 3 || k === 1).map(([, v]) => v).join('')) : dxfText(d.get(e, 1));
  for (const e of d.entities) {
    if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const text = textOf(e); if (!text) continue;
      const h = d.num(e, 40, 2.5), p = d.pt(e, 10);
      let x = 0; for (const wtxt of text.split(' ')) { words.push({ text: wtxt, bbox_mm: box([p[0] + x, p[1]], wtxt.length * h * 0.6, h), source: e.type }); x += (wtxt.length + 1) * h * 0.6; }
    }
    if (e.type === 'DIMENSION') {
      const m = measure(d, e), override = dxfText(d.get(e, 1) ?? '');
      // v3.9: true size = sheet measurement x DIMLFAC (the stored measurement, code 42, is already the true value)
      const lf = dimLfac(d, e); if (m.kind !== 'angle') { m.computed *= lf; m.value = m.computed; }   // Codex review: the scaled geometry is canonical; code 42 is kept apart for diagnosis
      const blk = d.blocks.get(d.get(e, 2)), shown = blk ? blk.entities.filter(x => x.type === 'MTEXT' || x.type === 'TEXT').map(textOf).filter(Boolean).join(' ') : '';
      const textPos = d.pt(e, 11), h = 3.5;
      const printed = override && override !== '<>' ? override.replace('<>', String(+m.value.toFixed(4))) : shown || String(+m.value.toFixed(4));
      dims.push({ kind: m.kind, value_drawing_units: +m.value.toFixed(6), value_mm: m.kind === 'angle' ? null : +(m.value * f).toFixed(6), printed, measured_from_geometry: +m.computed.toFixed(6),
        stored_measurement: m.stored, dimlfac: lf, view_scale: m.kind === 'angle' ? undefined : lf >= 1 ? `1:${+lf.toFixed(4)}` : `${+(1 / lf).toFixed(4)}:1`, text_override: override && override !== '<>' ? override : null, handle: d.get(e, 5), bbox_mm: box([textPos[0] - printed.length * h * 0.3, textPos[1] - h / 2], printed.length * h * 0.6, h) });
      words.push({ text: printed, bbox_mm: dims.at(-1).bbox_mm, source: 'DIMENSION', handle: d.get(e, 5) });
    }
  }
  // INSERT: annotations exported as block references (notes, hole callouts, balloons...): their TEXT/MTEXT (and nested inserts),
  // moved by the insert point, scale and rotation
  const expand = (blkName, T, depth) => {
    const blk = d.blocks.get(blkName); if (!blk || depth > 4) return;
    for (const e of blk.entities) {
      if (e.type === 'TEXT' || e.type === 'MTEXT') {
        const text = textOf(e); if (!text) continue;
        const h = d.num(e, 40, 2.5) * Math.abs(T.s[1]), p = T.apply(d.pt(e, 10));
        let x = 0; for (const wtxt of text.split(' ')) { words.push({ text: wtxt, bbox_mm: box([p[0] + x, p[1]], wtxt.length * h * 0.6, h), source: 'INSERT:' + blkName }); x += (wtxt.length + 1) * h * 0.6; }
      } else if (e.type === 'INSERT') expand(d.get(e, 2), compose(T, insertT(e)), depth + 1);
    }
  };
  // the block geometry is placed relative to its base point (BLOCK 10/20), then scaled, rotated and moved to the insert point
  const insertT = e => { const o = d.pt(e, 10), s = [d.num(e, 41, 1), d.num(e, 42, 1)], a = d.num(e, 50) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a), b = d.blocks.get(d.get(e, 2))?.base ?? [0, 0];
    return { s, apply: p => { const x = p[0] - b[0], y = p[1] - b[1]; return [o[0] + c * s[0] * x - si * s[1] * y, o[1] + si * s[0] * x + c * s[1] * y]; } }; };
  const compose = (A, B) => ({ s: [A.s[0] * B.s[0], A.s[1] * B.s[1]], apply: p => A.apply(B.apply(p)) });
  for (const e of d.entities) if (e.type === 'INSERT') expand(d.get(e, 2), insertT(e), 0);
  const counts = {}; for (const e of d.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const circles = d.entities.filter(e => e.type === 'CIRCLE').map(e => ({ center: d.pt(e, 10).map(v => +(v * f).toFixed(4)), diameter_mm: +(2 * d.num(e, 40) * f).toFixed(4) }));
  return { format: 'dxf', version: d.version, units: d.units ?? 'sin $INSUNITS (se asume la unidad del dibujo)', to_mm: f, extents: d.extMin && d.extMax ? [d.extMin, d.extMax] : null, entity_counts: counts,
    words, dimensions: dims, circles,
    warnings: [...(d.units ? [] : ['El DXF no declara unidades ($INSUNITS): los valores se reportan en unidades del dibujo.']),
      ...dims.filter(x => x.stored_measurement !== null && x.kind !== 'angle' && Math.abs(x.stored_measurement - x.measured_from_geometry) > 1e-3 && Math.abs(x.stored_measurement * (x.dimlfac ?? 1) - x.measured_from_geometry) > 1e-3).map(x => `Cota ${x.handle}: el valor guardado ${x.stored_measurement} no coincide con su geometría ${x.measured_from_geometry}`),
      ...dims.filter(x => x.text_override && !/<>/.test(x.text_override)).map(x => `Cota ${x.handle}: texto sustituido a mano "${x.text_override}" (la geometría mide ${x.measured_from_geometry})`)] };
}
