// v3.8 sw_answer_sheet: the exam answers (mass and every center of mass) read from SolidWorks and rounded the way the exam asks,
// ready to copy. Rounding is decimal half-up (0.39505 -> 0.3951; JS toFixed would give 0.3950 for some binary values) and never
// prints -0.0000. Read-only unless set_document_units (then the document units change, unsaved until sw_save).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function roundHalfUp(x, d) {
  const f = 10 ** d, y = Math.abs(x) * f;
  const r = Math.sign(x) * Math.floor(y + 0.5 + 1e-9 * Math.max(1, y)) / f;
  return r === 0 ? 0 : r;
}
export const fmt = (x, d) => roundHalfUp(x, d).toFixed(d);
const csOrder = n => { const m = /(\d+)\s*$/.exec(n); return m ? +m[1] : 1e9; };
export function orderSystems(names) { return [...names].sort((a, b) => csOrder(a) - csOrder(b) || a.localeCompare(b)); }

export function formatAnswers({ mass, mass_units, length_units, decimals, com }) {
  const lines = [`Masa = ${fmt(mass, decimals)} ${mass_units}`];
  for (const c of com) lines.push(`Centro de masa ${c.label} (${length_units}${c.coordinate_system ? ', ' + c.coordinate_system : ''}): X = ${fmt(c.value[0], decimals)}  Y = ${fmt(c.value[1], decimals)}  Z = ${fmt(c.value[2], decimals)}`);
  return lines;
}

async function call(worker, op, a) { const r = await worker.call(op, a); if (!r.ok) throw new Error(`${op}: ${r.error}`); return r.result; }

export async function answerSheet(args, { worker, root } = {}) {
  const mass_units = args.mass_units ?? 'lb', length_units = args.length_units ?? 'in', decimals = args.decimals ?? 4;
  const base = { document_id: args.document_id, mass_units, length_units, ...(args.expected_materials ? { expected_materials: args.expected_materials } : {}) };
  // v3.8 create: the teacher often asks for several systems; create them all here (axes as the drawing shows them: "+Y", "-Z")
  // and answer in exactly those, in the given order and with the given labels
  // Codex review: the whole list is validated BEFORE creating anything, and a failure halfway deletes what this call created
  const created = [], requests = (args.create ?? []).map((s, i) => {
    const vec = t => { const m = /^([+-]?)([XYZ])$/i.exec(String(t ?? '')); if (!m) throw new Error(`create[${i}].axes: usa "+X", "-Y", "Z"...`); const v = [0, 0, 0]; v['XYZ'.indexOf(m[2].toUpperCase())] = m[1] === '-' ? -1 : 1; return v; };
    if (!s || (s.point_mm === undefined) === (s.local_point_mm === undefined)) throw new Error(`create[${i}]: da point_mm (modelo) o local_point_mm con component y kind`);
    if (s.local_point_mm !== undefined && (!s.component || !s.kind)) throw new Error(`create[${i}]: local_point_mm necesita component y kind`);
    const a = { document_id: args.document_id, action: 'create' };
    for (const k of ['point_mm', 'local_point_mm', 'component', 'kind']) if (s[k] !== undefined) a[k] = s[k];
    if (s.axes) { const x = vec(s.axes.x), y = vec(s.axes.y); if (x.every((v, k) => Math.abs(v) === Math.abs(y[k]))) throw new Error(`create[${i}]: x e y no pueden ir sobre el mismo eje`); a.axes = { x, y }; }
    return { a, label: s.label ?? String(i + 1) };
  });
  try {
    for (const [i, q] of requests.entries()) {
      const r = await call(worker, 'coordinate_system', q.a);
      if (r.coordinate_system) created.push({ label: q.label, name: r.coordinate_system });
      if (!r.coordinate_system || r.verified === false) throw new Error(`create[${i}]: el sistema no quedó verificado`);
    }
  } catch (e) {
    const left = [];
    for (const c of created) { try { await call(worker, 'coordinate_system', { document_id: args.document_id, action: 'delete', name: c.name }); } catch { left.push(c.name); } }
    throw new Error(`${e.message}. ${created.length ? (left.length ? `No se pudieron borrar: ${left.join(', ')}` : `Se borraron los ${created.length} sistemas que esta llamada había creado`) : 'No se creó ningún sistema'}.`);
  }
  if (created.length && !args.coordinate_systems) args = { ...args, coordinate_systems: created.map(c => c.name) };
  const first = await call(worker, 'mass_check', base);
  const available = first.coordinate_systems_available ?? [];
  const wanted = args.coordinate_systems ?? orderSystems(available);
  const missing = wanted.filter(n => !available.includes(n));
  if (missing.length) throw new Error(`No existen en el modelo: ${missing.join(', ')} (hay: ${available.join(', ') || 'ninguno'})`);
  const com = [], warnings = [];
  if (!wanted.length || args.include_model_origin) com.push({ label: wanted.length ? '0' : '1', coordinate_system: null, value: first.center_of_mass, note: 'origen del modelo' });
  if (!wanted.length) warnings.push('No hay sistemas de coordenadas: el CM sale del ORIGEN DEL MODELO. Si el plano marca otro origen, créalo (sw_find_origin o auto_origins) antes de contestar.');
  for (const [i, name] of wanted.entries()) {
    const r = await call(worker, 'mass_check', { ...base, coordinate_system: name });
    if (Math.abs(r.mass - first.mass) > 1e-9 * Math.max(1, first.mass)) warnings.push(`La masa cambió entre lecturas (${first.mass} vs ${r.mass})`);
    com.push({ label: created.find(c => c.name === name)?.label ?? String(i + 1), coordinate_system: name, value: r.center_of_mass });
  }
  // what decides the numbers: every part with a material, no mass override, nothing hidden or suppressed
  const parts = first.parts ?? [];
  const noMaterial = parts.filter(p => !p.material).map(p => p.part), overrides = parts.filter(p => p.mass_override).map(p => p.part);
  const notCounted = parts.filter(p => p.hidden || (p.state && p.state !== 'resolved')).map(p => `${p.part} (${p.hidden ? 'oculta' : p.state})`);
  if (noMaterial.length) warnings.push(`Sin material (densidad 1000 kg/m3): ${noMaterial.join(', ')}`);
  if (overrides.length) warnings.push(`Con masa sobrescrita: ${overrides.join(', ')}`);
  if (notCounted.length) warnings.push(`Revisa si cuentan: ${notCounted.join(', ')}`);
  if (first.materials_ok === false) warnings.push('Algún material no coincide con la tabla del plano (expected_materials).');
  const lines = formatAnswers({ mass: first.mass, mass_units, length_units, decimals, com });
  let units = null;
  if (args.set_document_units) units = await call(worker, 'document_units', { document_id: args.document_id, action: 'set', mass_length: length_units, mass: mass_units, volume: args.volume_units ?? 'mm3', decimals });
  let file = null;
  if (root && args.save_file !== false) {
    const dir = join(root, 'answers'); mkdirSync(dir, { recursive: true });
    file = join(dir, `${String(first.document ?? 'respuestas').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(file, [...lines, '', ...warnings.map(w => 'AVISO: ' + w)].join('\r\n'), 'utf8');
  }
  return {
    document: first.document, lines, warnings, file, ...(created.length ? { created_systems: created, note_created: 'Sistemas nuevos sin guardar hasta sw_save.' } : {}),
    mass: { value: roundHalfUp(first.mass, decimals), units: mass_units, raw: first.mass },
    center_of_mass: com.map(c => ({ label: c.label, coordinate_system: c.coordinate_system, value: c.value.map(v => roundHalfUp(v, decimals)), raw: c.value, units: length_units })),
    volume_mm3: first.volume_mm3, parts: parts.map(p => ({ part: p.part, count: p.count, material: p.material, mass_each: p.mass_each })),
    ...(units ? { document_units: units } : {}),
    note: 'Copia las líneas tal cual. Redondeo decimal (0.5 hacia arriba en magnitud). Revisa los avisos antes de entregar.',
  };
}
