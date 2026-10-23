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
