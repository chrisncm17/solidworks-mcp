// v3.7 sw_assembly_draft: from the drawing (sw_drawing_read analyze) and the folder of parts, a plan skeleton for
// sw_assembly_build: components (file, count, material) from the parts table, expect (mass, every center of mass with its units,
// interference list) from the key lines, and a check of the table: sum of masses x quantity vs the total mass.
// Mates are left for the planner (by intention); nothing is opened in SolidWorks.
import { readdirSync } from 'node:fs';
import { drawingRead } from './drawing_read.mjs';

const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const MASS_UNITS = { LIBRAS: 'lb', LIBRA: 'lb', LB: 'lb', LBS: 'lb', GRAMOS: 'g', G: 'g', KG: 'kg', KILOGRAMOS: 'kg' };
const TO_G = { g: 1, kg: 1000, lb: 453.59237 };

// parts table rows: "[grid letters] N DESCRIPCION CANTIDAD MATERIAL MASA", the material may wrap to the next lines
export function parseTable(lines) {
  const rows = []; let open = null;
  const rowRe = /^(?:[A-H] )*(\d{1,3}) ([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 .\-]*?) (\d{1,4})(?: (.*?))?$/;
  for (const raw of lines) {
    const t = raw.trim(); const m = rowRe.exec(t);
    if (m && !/^\d+$/.test(m[2])) {
      if (open) rows.push(open);
      // v3.7 review: the mass needs a decimal part; a bare integer at the end is part of the material (AISI 304, SAE 1020)
      let rest = (m[4] ?? '').trim(), mass = null; const mm = /^(.*?)\s*(\d+[.,]\d+)$/.exec(rest);
      if (mm && mm[1]) { rest = mm[1].trim(); mass = +mm[2].replace(',', '.'); } else if (mm && !mm[1]) { mass = +mm[2].replace(',', '.'); rest = ''; }
      open = { item: +m[1], name: m[2].trim(), quantity: +m[3], material: rest || null, mass: mass };
      if (mass !== null) { rows.push(open); open = null; }
      continue;
    }
    if (open) { // continuation of a wrapped material / mass
      const n = /^(\d+[.,]\d+)$/.exec(t);
      if (n) { open.mass = +n[1].replace(',', '.'); rows.push(open); open = null; }
      else if (/^[A-ZÁÉÍÓÚÑÜ0-9 .\-]+$/.test(t) && t.length > 1) open.material = ((open.material ?? '') + ' ' + t).trim();
    }
  }
  if (open) rows.push(open);
  return rows;
}
export function parseExpect(lines) {
  const ex = { com: [], interferences_mm3: [], warnings: [] };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const ms = /masa\s*(?:total)?\s*[=:]\s*([\d.,]+)\s*([a-záéíóú]+)/i.exec(t);
    if (ms && !/centro/i.test(t)) ex.mass = { value: +ms[1].replace(',', '.'), units: MASS_UNITS[fold(ms[2])] ?? 'g' };
    const it = /interferencia\s*\d*\s*[:=]\s*([\d.,]+)\s*mm/i.exec(t); if (it) ex.interferences_mm3.push(+it[1].replace(',', '.'));
    const cm = /centro de masa\s*(\d*)\s*\((mm|in|cm|m)\)/i.exec(t);
    // v3.7 review: each value goes to ITS axis by label (Z/X/Y order allowed); a repeated or missing axis is not guessed
    if (cm) { const v = {}; let dup = false;
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) { if (j > i + 1 && /centro de masa/i.test(lines[j])) break; const a = /^\s*([XYZ])\s*=\s*(-?[\d.,]+)/i.exec(lines[j]); if (!a) continue; const k = a[1].toUpperCase(); if (k in v) { dup = true; break; } v[k] = +a[2].replace(',', '.'); if (Object.keys(v).length === 3) break; }
      const label = 'Centro de masa ' + (cm[1] || ex.com.length + 1);
      if (dup || !['X', 'Y', 'Z'].every(k => k in v)) ex.warnings.push(`${label}: no se leyeron X, Y y Z una vez cada uno (${JSON.stringify(v)}); escríbelo a mano`);
      else ex.com.push({ coordinate_system: '#' + (cm[1] || ex.com.length + 1), value: [v.X, v.Y, v.Z], length_units: cm[2].toLowerCase() }); }
  }
  if (!ex.com.length) delete ex.com; if (!ex.interferences_mm3.length) delete ex.interferences_mm3; if (!ex.warnings.length) delete ex.warnings;
  return ex;
}
export async function assemblyDraft(args) {
  const r = await drawingRead({ path: args.drawing, action: 'analyze' });
  const lines = (r.pages ?? []).flatMap(p => [...(p.key_lines ?? []).map(l => l.text), ...(p.other_text ?? [])]);
  // the table and the key lines come from the page that has the parts table: keep reading order per page
  const ordered = (r.pages ?? []).flatMap(p => { const all = [...(p.key_lines ?? []).map(l => ({ t: l.text, y: l.bbox_mm?.[1] ?? 0 }))]; return all.map(x => x.t).concat(p.other_text ?? []); });
  const table = parseTable(ordered), expect = parseExpect((r.pages ?? []).flatMap(p => (p.key_lines ?? []).map(l => l.text)));
  const files = args.parts_dir ? readdirSync(args.parts_dir).filter(f => /\.sld(prt|asm)$/i.test(f) && !f.startsWith('~$')) : [];
  const warnings = [...(expect.warnings ?? [])]; delete expect.warnings;
  for (const t of table) if (t.mass === null) warnings.push(`${t.name}: sin masa legible en la tabla (¿columna de masa vacía?)`);
  const components = table.map(row => {
    const want = fold(row.name), file = files.find(f => fold(f.replace(/\.[^.]+$/, '')) === want) ?? files.find(f => fold(f).includes(want));
    if (!file) warnings.push(`Sin archivo para ${row.name} en parts_dir`);
    const c = { id: want.replace(/[^A-Z0-9]/g, '_'), file: file ?? null, material: row.material, table_mass_g: row.mass };
    if (row.quantity > 1) c.count = row.quantity;
    return c;
  });
  const base = components.find(c => /CUERPO|BASE|PLACA|BASTIDOR|SOPORTE|CHASIS|MARCO/.test(c.id)) ?? components[0];
  if (base) base.fixed = true;
  let table_check = null;
  if (expect.mass && table.every(t => t.mass !== null)) {
    const sum = table.reduce((s, t) => s + t.mass * t.quantity, 0), total = expect.mass.value * TO_G[expect.mass.units];
    table_check = { sum_of_table_g: +sum.toFixed(3), drawing_total_g: +total.toFixed(3), difference_percent: +((sum - total) / total * 100).toFixed(4),
      note: Math.abs(sum - total) / total < 0.005 ? 'La tabla cuadra con la masa total (masa POR PIEZA × cantidad).' : 'La tabla NO cuadra con la masa total: revisa cantidades o si la masa de la tabla es por pieza o total.' };
  }
  const holes = holeCallouts((r.pages ?? []).flatMap(p => [...(p.key_lines ?? []).map(l => l.text), ...(p.other_text ?? [])]));
  const suggested_mates = suggestMates(components, holes);
  return { plan: { ir: 'assembly-ir/1', name: args.name ?? 'Ensamble', components: components.map(({ material, table_mass_g, ...c }) => c), mates: [], expect },
    parts_table: table, expected_materials: table.filter(t => t.material).map(t => ({ part: t.name, material: t.material })), table_check, warnings,
    hole_callouts: holes, suggested_mates,
    next: 'Revisa suggested_mates (cambia las caras "?" por las del plano) y escribe el resto por intención (insert/face_to_face/flush/coaxial/fastener, find con Ø y normales del plano); auto_origins crea los sistemas por el CM; luego sw_assembly_build check y build.' };
}

// v3.8: "4x Ø8", "4 X 8", "6× ⌀10.5" on the drawing -> how many equal holes (the repeat of the mates that go in them)
export function holeCallouts(lines) {
  const out = [], seen = new Set();
  for (const t of lines) for (const m of String(t).matchAll(/(?<![\d.,])(\d{1,2})\s*[xX×]\s*[ØøΦ⌀]?\s*(\d{1,3}(?:[.,]\d+)?)(?![\d.,])(?!\s*[xX×°])/g)) {
    const count = +m[1], diameter_mm = +m[2].replace(',', '.'), key = count + 'x' + diameter_mm;
    if (count >= 2 && diameter_mm > 0 && !seen.has(key)) { seen.add(key); out.push({ count, diameter_mm, text: m[0] }); }
  }
  return out;
}
// v3.8 (borrador con relaciones): tornillo + rondana + tuerca de la tabla -> UNA intencion fastener con repeat; si el plano dice
// "Nx ØD" con la misma cantidad, el barreno ya lleva ese Ø. Lo que el plano no dice (la pieza con barrenos, las caras) queda "?".
export function suggestMates(components, holes = []) {
  const by = re => components.find(c => re.test(c.id));
  const bolt = by(/TORNILLO|PERNO|BOLT/), washer = by(/RONDANA|ARANDELA|WASHER/), nut = by(/TUERCA|NUT/);
  if (!bolt) return [];
  const n = bolt.count ?? 1, id = c => c && ((c.count ?? 1) > 1 ? c.id + '#' : c.id);
  const hole = holes.find(h => h.count === n);
  const target = components.find(c => c.fixed)?.id ?? '?';
  const m = { intent: 'fastener', bolt: id(bolt), ...(washer && (washer.count ?? 1) === n ? { washer: id(washer) } : {}), ...(nut && (nut.count ?? 1) === n ? { nut: id(nut), nut_side: { component: target, find: { kind: 'plane', normal: '?' } } } : {}),
    hole: { component: target, find: { kind: 'cylinder', ...(hole ? { diameter_mm: hole.diameter_mm } : { diameter_mm: '?' }), ...(n > 1 ? { index: '#' } : {}) } },
    head_side: { component: target, find: { kind: 'plane', normal: '?' } }, ...(n > 1 ? { repeat: n } : {}) };
  return [m];
}
