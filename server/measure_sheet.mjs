// v3.0 sw_measure_sheet: the measurement sheet ("ficha de medidas") of one part read from a drawing.
// Rule of the user: every measure has an identified source; blurry, contradictory or missing ones are flagged, never invented.
//  validate      - checks the sheet; for method 'pdf_text' it re-reads the PDF and proves the claimed number is really inside a
//                  TIGHT box around that callout (a box covering half the sheet proves nothing); 'derived' values are recomputed
//                  with a small arithmetic parser over other entries (no cycles, no constants-only formulas); plan dimensions
//                  that no entry uses are listed. Writes generated\fichas\<part>.json and .md (human sheet).
//  compare_model - matches the sheet against an open SolidWorks part: model dimensions of the SAME type (diameter/radial/linear/
//                  angular) from unsuppressed features, overall size from the union of all solid bodies, material.
import { writeFileSync, mkdirSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KINDS = ['linear', 'diameter', 'radius', 'angle', 'thread', 'chamfer', 'count', 'other'];
const STATUS = ['ok', 'uncertain', 'blurry', 'missing', 'contradictory'];
const METHODS = ['pdf_text', 'vision', 'derived', 'note'];
const num = v => typeof v === 'number' && Number.isFinite(v);
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// numbers in a text with their sign ("12,5" comma decimals accepted; "-0.1" stays negative, "±0.1" gives +0.1 and -0.1)
export const numbersIn = s => {
  const out = [];
  for (const m of String(s ?? '').replace(/(\d),(\d)/g, '$1.$2').matchAll(/(±|\+|-)?\s?(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[2]); if (m[1] === '±') out.push(v, -v); else out.push(m[1] === '-' ? -v : v);
  }
  return out;
};
const overlap = (a, b, pad = 0) => a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];
const union = ws => [Math.min(...ws.map(w => w.bbox_mm[0])), Math.min(...ws.map(w => w.bbox_mm[1])), Math.max(...ws.map(w => w.bbox_mm[2])), Math.max(...ws.map(w => w.bbox_mm[3]))];
const unitOf = (d, sheet) => d.kind === 'angle' ? 'deg' : (d.unit ?? sheet.units);
const toMm = (d, sheet) => d.kind === 'angle' ? d.value : d.value * (unitOf(d, sheet) === 'in' ? 25.4 : 1);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

// ---- derived formulas: + - * / ( ) unary minus, numbers and entry ids; nothing else ----
function parseFormula(src) {
  const toks = String(src).match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[-+*/()]|\S/g) ?? [];
  let i = 0; const ids = new Set();
  const peek = () => toks[i], take = () => toks[i++];
  const atom = () => {
    const t = take();
    if (t === undefined) throw new Error('fórmula incompleta');
    if (t === '(') { const e = expr(); if (take() !== ')') throw new Error('falta ")"'); return e; }
    if (t === '-') { const e = atom(); return v => -e(v); }
    if (/^\d/.test(t)) { const n = Number(t); return () => n; }
    if (/^[A-Za-z_]/.test(t)) { ids.add(t); return v => v[t]; }
    throw new Error(`token no permitido "${t}"`);
  };
  const term = () => { let e = atom(); while (peek() === '*' || peek() === '/') { const op = take(), l = e, r = atom(); e = op === '*' ? v => l(v) * r(v) : v => l(v) / r(v); } return e; };
  const expr = () => { let e = term(); while (peek() === '+' || peek() === '-') { const op = take(), l = e, r = term(); e = op === '+' ? v => l(v) + r(v) : v => l(v) - r(v); } return e; };
  const f = expr(); if (i !== toks.length) throw new Error(`sobra "${toks.slice(i).join(' ')}"`);
  return { f, ids: [...ids] };
}
export function evalFormula(formula, values) {
  const { f, ids } = parseFormula(formula);
  for (const id of ids) if (!num(values[id])) throw new Error(`unknown or valueless id "${id}"`);
  const v = f(values); if (!num(v)) throw new Error('formula is not a finite number');
  return v;
}

// pdfPages: Map(page -> words) or null when there is no PDF text to check against
export function checkSheet(sheet, pdfPages = null) {
  const errors = [], warnings = [], info = [], usedBoxes = [];
  const dims = Array.isArray(sheet?.dims) ? sheet.dims : [];
  const defPage = sheet?.drawing?.page ?? 1;
  if (!sheet?.part) errors.push('part: falta el nombre de la pieza');
  if (!['mm', 'in'].includes(sheet?.units)) errors.push('units: debe ser "mm" o "in" (tomado del plano, no supuesto)');
  if (!dims.length) errors.push('dims: la ficha no tiene medidas');
  const ids = new Set(), values = {}, byId = new Map();
  for (const d of dims) {
    const where = `${d.id ?? '?'} (${d.feature ?? 'sin descripción'})`;
    if (!d.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.id)) errors.push(`${where}: id inválido (letras, números y _)`);
    else if (ids.has(d.id)) errors.push(`${where}: id repetido`); else { ids.add(d.id); byId.set(d.id, d); }
    if (!KINDS.includes(d.kind)) errors.push(`${where}: kind debe ser ${KINDS.join('|')}`);
    if (!STATUS.includes(d.status)) errors.push(`${where}: status debe ser ${STATUS.join('|')}`);
    if (d.unit && d.kind === 'angle' && d.unit !== 'deg') errors.push(`${where}: un ángulo va en deg`);
    if (d.unit === 'deg' && d.kind !== 'angle') errors.push(`${where}: unit deg solo para ángulos`);
    const hasValue = d.value !== undefined && d.value !== null;
    if (d.status === 'missing' || d.status === 'blurry') {
      if (hasValue) errors.push(`${where}: marcada "${d.status}" pero trae valor (no inventar; si hay una lectura dudosa usa "uncertain" con notes)`);
      if (!d.notes) warnings.push(`${where}: ${d.status === 'missing' ? 'falta en el plano' : 'ilegible'}; explica en notes qué y dónde`);
    } else if (!num(d.value)) errors.push(`${where}: sin valor numérico (si no se lee, status "blurry"/"missing" sin valor)`);
    else if (d.value < 0) errors.push(`${where}: una medida no es negativa`);
    else values[d.id] = d.value;
    if ((d.status === 'uncertain' || d.status === 'contradictory') && !d.notes) warnings.push(`${where}: status ${d.status} sin notes que expliquen por qué`);
    const s = d.source;
    if (!s || !METHODS.includes(s.method)) { if (d.status !== 'missing') errors.push(`${where}: sin fuente (source.method ${METHODS.join('|')})`); continue; }
    if (s.method === 'pdf_text' && !(Array.isArray(s.bbox_mm) && s.bbox_mm.length === 4)) errors.push(`${where}: la fuente pdf_text necesita bbox_mm (zona en mm de la hoja); region_px es para imágenes`);
    if (s.method === 'vision' && !(Array.isArray(s.bbox_mm) && s.bbox_mm.length === 4) && !(Array.isArray(s.region_px) && s.region_px.length === 4)) errors.push(`${where}: la lectura visual debe ubicar la cota (bbox_mm o region_px)`);
    if (s.method === 'vision' && num(d.value)) info.push(`${where}: leída visualmente; evidencia en ${JSON.stringify(s.bbox_mm ?? s.region_px)} (render de esa zona para revisarla)`);
    if (s.method === 'note') { if (!s.text) errors.push(`${where}: fuente "note" sin el texto de la nota`); else if (num(d.value) && !numbersIn(s.text).some(n => near(n, d.value))) errors.push(`${where}: la nota "${s.text}" no contiene ${d.value}`); }
  }
  // derived: parse, no cycles, at least one id, evaluated in dependency order, status inherited
  const derived = dims.filter(d => d.source?.method === 'derived');
  const deps = new Map();
  for (const d of derived) {
    const where = `${d.id} (${d.feature ?? ''})`;
    if (!d.source.formula) { errors.push(`${where}: derivada sin formula`); continue; }
    try { const { ids: used } = parseFormula(d.source.formula); if (!used.length) errors.push(`${where}: la fórmula solo tiene constantes: eso no es una fuente`); deps.set(d.id, used); }
    catch (e) { errors.push(`${where}: fórmula inválida: ${e.message}`); }
  }
  const state = new Map(), order = [];
  const visit = (id, path) => {
    if (state.get(id) === 2) return true; if (state.get(id) === 1) { errors.push(`derivadas circulares: ${[...path, id].join(' → ')}`); return false; }
    state.set(id, 1); for (const x of deps.get(id) ?? []) if (deps.has(x) && !visit(x, [...path, id])) return false; state.set(id, 2); order.push(id); return true;
  };
  for (const id of deps.keys()) visit(id, []);
  for (const id of order) {
    const d = byId.get(id), where = `${d.id} (${d.feature ?? ''})`;
    for (const x of deps.get(id)) {
      const dep = byId.get(x);
      if (!dep) { errors.push(`${where}: usa "${x}", que no está en la ficha`); continue; }
      if (dep.status !== 'ok' && d.status === 'ok') errors.push(`${where}: es "ok" pero depende de ${x} (${dep.status}); hereda ese estado`);
      if (num(dep.value) && unitOf(dep, sheet) !== unitOf(d, sheet)) errors.push(`${where}: mezcla unidades (${x} en ${unitOf(dep, sheet)})`);
    }
    try { const v = evalFormula(d.source.formula, values); if (num(d.value) && !near(v, d.value) && Math.abs(v - d.value) > 1e-6) errors.push(`${where}: la fórmula da ${+v.toFixed(6)}, no ${d.value}`); }
    catch (e) { errors.push(`${where}: ${e.message}`); }
  }
  // contradictions: same feature and kind, different values once units are normalised
  const byFeature = new Map();
  for (const d of dims) if (d.feature && num(d.value)) { const k = norm(d.feature) + '|' + d.kind; byFeature.set(k, [...(byFeature.get(k) ?? []), d]); }
  for (const [, list] of byFeature) {
    const vals = list.map(d => toMm(d, sheet));
    if (vals.some(v => !near(v, vals[0]) && Math.abs(v - vals[0]) > 1e-6) && !list.every(d => d.status === 'contradictory'))
      errors.push(`"${list[0].feature}": valores distintos ${list.map(d => `${d.value} ${unitOf(d, sheet)}`).join(' vs ')} (${list.map(d => d.id).join(', ')}); márcalas "contradictory" con notes`);
  }
  // pdf_text: each claimed box must be tight around a few words that really contain the number (and the quoted text)
  const pdfEntries = [...dims.filter(d => d.source?.method === 'pdf_text' && Array.isArray(d.source.bbox_mm)).map(d => ({ d, s: d.source })),
    ...(sheet?.material?.source?.method === 'pdf_text' && Array.isArray(sheet.material.source.bbox_mm) ? [{ d: { id: 'material', feature: 'material', kind: 'material', value: null, status: sheet.material.status ?? 'ok' }, s: sheet.material.source, text: sheet.material.value }] : [])];
  if (pdfPages) for (const { d, s, text: matText } of pdfEntries) {
    const page = s.page ?? defPage, words = pdfPages.get(page);
    const boxesList = [s.bbox_mm, ...(s.more_bbox_mm ?? [])];
    if (!words) { errors.push(`${d.id}: no hay texto del PDF en la página ${page}`); continue; }
    const texts = [];
    boxesList.forEach((b, k) => {
      const where = `${d.id}${k ? `[${k + 1}]` : ''} (${d.feature ?? ''})`;
      const inBox = words.filter(w => overlap(w.bbox_mm, b, 0.3))
        .sort((p, q) => Math.round(p.bbox_mm[1] / 2) - Math.round(q.bbox_mm[1] / 2) || p.bbox_mm[0] - q.bbox_mm[0]);
      if (!inBox.length) { errors.push(`${where}: no hay texto del PDF en ${JSON.stringify(b)} (página ${page})`); return; }
      const u = union(inBox);
      if (inBox.length > 6 || (b[2] - b[0]) > (u[2] - u[0]) + 8 || (b[3] - b[1]) > (u[3] - u[1]) + 8)
        { errors.push(`${where}: la zona ${JSON.stringify(b.map(v => Math.round(v)))} es demasiado grande (${inBox.length} palabras); encierra solo esa cota`); return; }
      usedBoxes.push({ page, box: b });
      const t = inBox.map(w => w.text).join(' '); texts.push(t);
      const flat = norm(t).replace(/\s/g, '');
      const quoted = matText ?? s.text;
      if (quoted && !flat.includes(norm(quoted).replace(/\s/g, '')) && !norm(quoted).split(' ').every(x => flat.includes(x))) errors.push(`${where}: el PDF dice "${t}" ahí, no "${quoted}"`);
      if (num(d.value)) {
        if (!numbersIn(t).some(n => near(n, d.value))) errors.push(`${where}: el valor ${d.value} no aparece en el texto del PDF "${t}"`);
        if (s.text && !numbersIn(s.text).some(n => near(n, d.value))) errors.push(`${where}: el texto citado "${s.text}" no contiene ${d.value}`);
      }
    });
    if (!texts.length || d.id === 'material') continue;
    const all = texts.join(' ');
    if (d.count > 1) {
      const pref = [...all.matchAll(/(\d+)\s*[xX×]/g)].map(m => Number(m[1]));
      if (!pref.includes(d.count) && boxesList.length !== d.count) warnings.push(`${d.id}: cantidad ${d.count} sin evidencia (ni prefijo ${d.count}X en el texto ni ${d.count} zonas en more_bbox_mm)`);
    }
    if (d.tolerance && typeof d.tolerance === 'object') {
      const ns = numbersIn(all);
      if (!ns.some(n => near(n, Math.abs(d.tolerance.plus))) || !ns.some(n => near(n, -Math.abs(d.tolerance.minus)) || near(n, Math.abs(d.tolerance.minus))))
        errors.push(`${d.id}: la tolerancia +${d.tolerance.plus}/-${d.tolerance.minus} no aparece en "${all}"`);
    } else if (typeof d.tolerance === 'string' && !numbersIn(d.tolerance).every(x => numbersIn(all).some(n => near(Math.abs(n), Math.abs(x))))) errors.push(`${d.id}: la tolerancia "${d.tolerance}" no aparece en "${all}"`);
  }
  if (sheet?.material?.value && !sheet.material.source && sheet.material.status !== 'missing') errors.push('material: tiene valor pero no fuente (cajetín/nota); si el plano no lo dice, status "missing" sin valor');
  return { errors, warnings, info, usedBoxes };
}

export function sheetMarkdown(sheet, report) {
  const st = { ok: '✓', uncertain: '?', blurry: 'ILEGIBLE', missing: 'FALTA', contradictory: 'CONTRADICTORIA' };
  const src = s => !s ? '—' : s.method === 'derived' ? `derivada: ${s.formula}` : s.method === 'note' ? `nota: "${s.text}"` : `${s.method === 'pdf_text' ? 'texto PDF' : 'visual'} p.${s.page ?? 1} ${JSON.stringify(s.bbox_mm ?? s.region_px)}${s.more_bbox_mm ? ` +${s.more_bbox_mm.length} zona(s)` : ''}${s.text ? ` "${s.text}"` : ''}${s.symbol === 'vision' ? ' (símbolo visto en el render)' : ''}`;
  const L = [`# Ficha de medidas — ${sheet.part}`, '', `- Plano: ${sheet.drawing?.path ?? '—'}${sheet.drawing?.page ? ` (página ${sheet.drawing.page})` : ''}`, `- Unidades: ${sheet.units}${sheet.scale ? ` · Escala: ${sheet.scale}` : ''}`,
    `- Material: ${sheet.material?.value ?? 'no indicado en el plano'}${sheet.material?.source ? ` (${src(sheet.material.source)})` : ''}`, '',
    '| id | Elemento | Tipo | Valor | Tol. | Cant. | Vista | Fuente | Estado | Notas |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const d of sheet.dims ?? []) L.push(`| ${d.id} | ${d.feature ?? ''} | ${d.kind} | ${d.value ?? '—'}${d.unit && d.unit !== sheet.units ? ' ' + d.unit : ''} | ${d.tolerance ? (typeof d.tolerance === 'string' ? d.tolerance : `+${d.tolerance.plus}/-${d.tolerance.minus}`) : ''} | ${d.count ?? ''} | ${d.view ?? ''} | ${src(d.source)} | ${st[d.status] ?? d.status} | ${d.notes ?? ''} |`);
  L.push('', `**Revisión:** ${report.errors.length} errores, ${report.warnings.length} avisos.`);
  for (const e of report.errors) L.push(`- ERROR: ${e}`);
  for (const w of report.warnings) L.push(`- Aviso: ${w}`);
  for (const u of report.unused_plan_dimensions ?? []) L.push(`- Cota del plano no incluida: "${u.raw}" en ${JSON.stringify(u.bbox_mm)} (página ${u.page})`);
  return L.join('\n') + '\n';
}

// never follow junctions/symlinks out of generated\fichas
function safeOutDir(root) {
  const dir = join(root, 'fichas'); mkdirSync(dir, { recursive: true });
  const real = realpathSync.native(dir);
  if (resolve(real).toLowerCase() !== resolve(dir).toLowerCase()) throw new Error('generated\\fichas está redirigido (enlace/junction): no se escribe');
  return dir;
}
function safeWrite(file, data) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${file} es un enlace: no se escribe`);
  writeFileSync(file, data);
}

// readText(path,page) -> {words:[{text,bbox_mm}], dimension_candidates:[{raw,kind,value,bbox_mm}]} (drawing_read.mjs)
export async function measureSheet(args, { root, readText, worker, signal } = {}) {
  const sheet = args.sheet;
  if (args.action === 'validate') {
    let pdfPages = null; const candidates = [];
    const p = sheet?.drawing?.path;
    if (p && /\.(pdf|dxf)$/i.test(p) && readText) {
      const pages = new Set([sheet.drawing.page ?? 1, ...(sheet.dims ?? []).map(d => d.source?.page).filter(Number.isInteger), ...(sheet.material?.source?.page ? [sheet.material.source.page] : [])]);
      pdfPages = new Map();
      for (const pg of pages) {
        try { const t = await readText(p, pg); pdfPages.set(pg, t.words ?? []); for (const c of t.dimension_candidates ?? []) candidates.push({ ...c, page: pg }); } catch { /* page without text: reported per entry */ }
      }
      if (!pdfPages.size) pdfPages = null;
    }
    const r = checkSheet(sheet, pdfPages);
    if (!pdfPages && (sheet?.dims ?? []).some(d => d.source?.method === 'pdf_text')) r.errors.push('hay fuentes pdf_text pero no hay PDF con texto legible en drawing.path: usa method "vision" con su zona');
    // plan dimensions nobody cited (only boxes that passed the tightness check count as cited)
    const unused = pdfPages ? candidates.filter(c => ['diameter', 'radius', 'thread', 'angle', 'chamfer', 'linear'].includes(c.kind) && !r.usedBoxes.some(u => u.page === c.page && overlap(c.bbox_mm, u.box, 0.3)))
      .map(c => ({ raw: c.raw, kind: c.kind, value: c.value, page: c.page, bbox_mm: c.bbox_mm })) : [];
    if (unused.length) r.warnings.push(`${unused.length} cota(s) del plano no están en la ficha (ver unused_plan_dimensions): inclúyelas o explica por qué no aplican`);
    const counts = Object.fromEntries(STATUS.map(s => [s, (sheet?.dims ?? []).filter(d => d.status === s).length]));
    const report = { valid: r.errors.length === 0, errors: r.errors, warnings: r.warnings, info: r.info, counts, pdf_text_checked: !!pdfPages, unused_plan_dimensions: unused };
    let files = null;
    if (sheet?.part) {
      const dir = safeOutDir(root);
      const base = String(sheet.part).replace(/[^\p{L}\p{N}_ .-]/gu, '_').replace(/^\.+/, '_').slice(0, 80);
      safeWrite(join(dir, base + '.json'), JSON.stringify({ ...sheet, review: report }, null, 2));
      safeWrite(join(dir, base + '.md'), sheetMarkdown(sheet, report));
      files = { json: join(dir, base + '.json'), markdown: join(dir, base + '.md') };
    }
    return { ...report, files };
  }
  if (args.action === 'compare_model') {
    const pre = checkSheet(sheet, null);
    if (pre.errors.length) return { verdict: 'la ficha tiene errores: corrígela (action validate) antes de compararla', errors: pre.errors };
    const r = await worker.call('inspect', { document_id: args.document_id }, { signal });
    if (!r.ok) throw new Error('inspect: ' + r.error);
    const ins = r.result; if (!Array.isArray(ins.bodies)) throw new Error('compare_model needs a part');
    const tol = args.tolerance_mm ?? 0.01, tolDeg = args.tolerance_deg ?? 0.01;
    // model dimensions of unsuppressed features, with their SolidWorks type (swDimensionType_e)
    const model = [];
    // kind of a model dimension: SolidWorks reports a sketch circle's Ø as type 5 (radial) with Diametric=true and the DIAMETER as
    // value (tested); a true radius (slot end R3) is type 5 with Diametric=false.
    const mkind = (t, diam) => t === 6 || t === 15 || ((t === 5 || t === 14) && diam) ? 'diameter' : t === 5 || t === 14 ? 'radius' : t === 3 || t === 16 ? 'angle' : t === 10 ? 'chamfer' : 'linear';
    for (const ft of ins.features ?? []) if (!ft.suppressed) for (const dm of ft.dimensions ?? []) if (!model.some(m => m.name === dm.name)) model.push({ name: dm.name, feature: ft.name, si: dm.value_si, kind: mkind(dm.dim_type ?? 0, !!dm.diametric) });
    const T = { linear: ['linear'], diameter: ['diameter'], radius: ['radius'], angle: ['angle'], chamfer: ['chamfer', 'linear'] };
    const bx = ins.bodies.map(b => b.box_exact_mm).filter(Boolean);
    const box = bx.length ? [0, 1, 2].map(i => Math.min(...bx.map(b => b[i]))).concat([3, 4, 5].map(i => Math.max(...bx.map(b => b[i])))) : null;
    const ext = box ? [box[3] - box[0], box[4] - box[1], box[5] - box[2]] : null;
    const rows = [], usedModel = new Set();
    for (const d of sheet.dims ?? []) {
      if (!num(d.value) || !T[d.kind]) { rows.push({ id: d.id, result: 'not_compared', reason: num(d.value) ? `kind ${d.kind}: verificar a mano` : `status ${d.status}` }); continue; }
      const v = toMm(d, sheet), mmOf = m => d.kind === 'angle' ? m.si * 180 / Math.PI : m.si * 1000, tl = d.kind === 'angle' ? tolDeg : tol;
      const typed = model.filter(m => T[d.kind].includes(m.kind) && Math.abs(mmOf(m) - v) <= tl).map(m => `${m.name} (mismo tipo)`);
      if (d.kind === 'diameter') typed.push(...model.filter(m => m.kind === 'radius' && Math.abs(m.si * 2000 - v) <= tol).map(m => `${m.name} (radio en el modelo)`));
      if (d.kind === 'radius') typed.push(...model.filter(m => m.kind === 'diameter' && Math.abs(m.si * 500 - v) <= tol).map(m => `${m.name} (diámetro en el modelo)`));
      const valueOnly = typed.length ? [] : model.filter(m => d.kind !== 'angle' && m.kind !== 'angle' && Math.abs(m.si * 1000 - v) <= tol).map(m => `${m.name} (mismo valor, cota de tipo ${m.kind})`);
      let overall = null;
      if (d.overall && ext) { const i = { x: 0, y: 1, z: 2 }[d.overall]; overall = { axis: d.overall, model_mm: +ext[i].toFixed(4), ok: Math.abs(ext[i] - v) <= tol }; }
      model.forEach(m => { if (typed.concat(valueOnly).some(t => t.startsWith(m.name + ' '))) usedModel.add(m.name); });
      rows.push({ id: d.id, feature: d.feature, value: d.value, unit: unitOf(d, sheet), status: d.status, result: typed.length || (overall?.ok && !valueOnly.length) ? 'match' : valueOnly.length ? 'value_only' : 'NO_MATCH', model_dimensions: typed.concat(valueOnly), overall });
    }
    const mat = sheet.material?.value ? { sheet: sheet.material.value, model: ins.material || null, match: !!ins.material && norm(ins.material).includes(norm(sheet.material.value)) } : null;
    const mismatch = rows.filter(x => x.result === 'NO_MATCH' || (x.overall && !x.overall.ok)), weak = rows.filter(x => x.result === 'value_only'), pending = rows.filter(x => x.result === 'not_compared' || (x.status && x.status !== 'ok'));
    const warnings = [];
    if (ins.bodies.length > 1) warnings.push(`La pieza tiene ${ins.bodies.length} cuerpos sólidos (caja total ${ext.map(v => +v.toFixed(2)).join(' × ')} mm): revisa que el plano pida eso; una cota del plano puede ser de un solo cuerpo.`);
    for (const x of rows.filter(x => x.overall && !x.overall.ok)) warnings.push(`${x.id}: la ficha dice ${x.value} como tamaño total en ${x.overall.axis}, la pieza mide ${x.overall.model_mm}.`);
    for (const x of weak) warnings.push(`${x.id}: ${x.value} existe en el modelo solo como otro tipo de cota (${x.model_dimensions.join(', ')}); revisa a qué corresponde.`);
    const verdict = mismatch.length || (mat && !mat.match) ? 'hay diferencias entre la ficha y la pieza'
      : weak.length || pending.length ? `coincide en lo comparado, pero quedan ${weak.length + pending.length} medidas por confirmar (${[...weak, ...pending].map(x => x.id).join(', ')})`
      : 'la pieza coincide con la ficha';
    return { verdict, rows, warnings, material: mat, body_count: ins.bodies.length, part_box_mm: ext && ext.map(v => +v.toFixed(4)), volume_mm3: ins.volume_mm3,
      model_dimensions_not_in_sheet: model.filter(m => !usedModel.has(m.name)).map(m => `${m.name}=${+(m.si * 1000).toFixed(4)} mm`), note: 'A match means a model dimension of the same type has that value; check the feature names to be sure it is the same geometry.' };
  }
  throw new Error('action: validate or compare_model');
}
