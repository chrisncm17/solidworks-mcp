// v3.8 what the CHAT receives from sw_assembly_build / sw_part_build: a build result was ~80 KB (~25 000 tokens, mostly
// assembly_doctor per-component detail, pattern and interference dumps) that the chat had to read on every call. It now gets
// the verdict, the answers, times, differences, failures, warnings and a short summary per verification; the complete result is
// written to generated/build_reports/<name>.json and its path is returned (details_file) for when something has to be dug out.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 1500;   // a verification block smaller than this goes as is
const short = v => { const s = JSON.stringify(v ?? null); return s.length <= LIMIT ? v : undefined; };

function summarizeVerification(ver = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ver)) {
    if (v === undefined || v === null) continue;
    if (['find_ms', 'mate_ms', 'symmetric_ms', 'symmetric_split'].includes(k)) continue;   // profiling: only in details_file
    if (k === 'assembly_doctor') { out[k] = { summary: v.summary ?? null, ...(v.read_errors?.length ? { read_errors: v.read_errors.slice(0, 5) } : {}) }; continue; }
    if (k === 'mass_checks') { out[k] = v.map(m => ({ mass: m.mass, center_of_mass: m.center_of_mass, units: m.units, coordinate_system: m.coordinate_system, ...(m.warnings?.length ? { warnings: m.warnings.slice(0, 5) } : {}), ...(m.exam_check?.blockers?.length ? { blockers: m.exam_check.blockers.slice(0, 5) } : {}) })); continue; }
    if (k === 'interference') { const pairs = v.pairs ?? v.result?.pairs ?? []; out[k] = { count: v.interference_count ?? v.count ?? pairs.length, pairs: pairs.slice(0, 10).map(p => ({ components: p.components, volume_mm3: p.volume_mm3, kind: p.kind })) }; continue; }
    if (k === 'patterns') { out[k] = (Array.isArray(v) ? v : [v]).map(p => ({ pattern: p?.pattern ?? p?.feature ?? null, instances: p?.instances?.length ?? p?.instance_count ?? null })); continue; }
    if (k === 'mates') { out[k] = { mate_count: v.mate_count ?? null, ...(v.problems?.length ? { problems: v.problems.slice(0, 10) } : {}) }; continue; }
    const s = short(v);
    if (s !== undefined) out[k] = s; else out[k] = '(detalle en details_file)';
  }
  return out;
}

// v3.11 every other tool: an inspection of a big assembly listed every component at every level (~25 000 tokens per
// sw_insert_component / sw_save / sw_resume_document in the jet engine). Above COMP_LIMIT components the chat gets the
// top-level ones plus counts; the complete response goes to generated/build_reports/<tool>_<id>.json (details_file).
const COMP_LIMIT = 30;
function compactInspection(ins) {
  if (!ins || typeof ins !== 'object' || !Array.isArray(ins.components) || ins.components.length <= COMP_LIMIT) return null;
  const all = ins.components, top = all.filter(c => !String(c.name).includes('/'));
  const nested = {};
  for (const c of all) { const parent = String(c.name).split('/')[0]; if (parent !== c.name) nested[parent] = (nested[parent] ?? 0) + 1; }
  return { ...ins, components: top.map(c => ({ name: c.name, file: String(c.path ?? '').split(/[\\/]/).pop(), fixed: c.fixed_position, origin_mm: Array.isArray(c.transform) ? c.transform.slice(9, 12).map(v => Math.round(v * 1e6) / 1e3) : undefined, unsaved: c.unsaved_changes || undefined, nested_components: nested[c.name] })),
    component_count: all.length, unsaved_count: all.filter(c => c.unsaved_changes).length, components_note: `${all.length} componentes en total; aquí solo los ${top.length} de primer nivel (lista completa en details_file)` };
}
export function compactWorkerResponse(response, root, operation) {
  if (!response || typeof response !== 'object') return response;
  if (JSON.stringify(response).length <= 4000) return response;
  const out = { ...response }; let changed = false;
  const fix = (holder, key) => { const c = compactInspection(holder?.[key]); if (c) { holder[key] = c; changed = true; } };
  if (out.result && typeof out.result === 'object') { out.result = { ...out.result }; fix(out.result, 'inspection'); if (Array.isArray(out.result.components) && out.result.document_type) fix(out, 'result'); }
  if (out.state_after) fix(out, 'state_after');
  if (!changed) return response;
  try {
    const dir = join(root, 'build_reports'); mkdirSync(dir, { recursive: true });
    out.details_file = join(dir, `${operation}_${Date.now().toString(36)}.json`);
    writeFileSync(out.details_file, JSON.stringify(response, null, 1));
  } catch { }
  return out;
}

export function compactBuildResult(result, root, operation) {
  if (!result || typeof result !== 'object') return result;
  const size = JSON.stringify(result).length;
  if (size <= 6000) return result;
  let details_file = null;
  try {
    const dir = join(root, 'build_reports'); mkdirSync(dir, { recursive: true });
    const name = String(result.path ?? result.part ?? operation).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_.-]/gu, '_');
    details_file = join(dir, `${name}_${Date.now().toString(36)}.json`);
    writeFileSync(details_file, JSON.stringify(result, null, 1));
  } catch { details_file = null; }
  const c = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'verification') c.verification = summarizeVerification(v);
    else if (k === 'moved_components' || k === 'features') c[k + '_count'] = Array.isArray(v) ? v.length : undefined;
    else if (k === 'warnings' && Array.isArray(v)) c.warnings = v.slice(0, 12);
    else if (k === 'answers' && v && typeof v === 'object') c.answers = { ok: v.ok, lines: v.lines, ...(v.created_systems ? { created_systems: v.created_systems } : {}), ...(v.file ? { file: v.file } : {}), ...(v.error ? { error: v.error } : {}) };
    else { const s = JSON.stringify(v ?? null); c[k] = s.length <= 4000 ? v : '(detalle en details_file)'; }
  }
  c.details_file = details_file;
  c.compacted = `respuesta resumida (${Math.round(size / 1024)} KB completos en details_file)`;
  return c;
}
