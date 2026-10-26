// v3.11 sw_session_recipe (idea from andrewbartels1/SolidworksMCP-python): record the tool calls of a session and turn them
// into a recipe .md that the next chat reads as an MCP resource (solidworks://recipe/<id>). Only successful calls that changed
// something are written as steps (inspections, previews and status checks are left out); document ids are replaced by the
// document name, so the recipe can be followed again with new files.
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECIPES = process.env.SW_MCP_RECIPES_DIR ?? fileURLToPath(new URL('./recipes/', import.meta.url));
const READ_ONLY = new Set(['status', 'environment', 'inspect', 'topology', 'geometry', 'sketch', 'relations', 'preview', 'mass_check', 'feature_info', 'find_faces', 'assembly_doctor', 'session_health', 'interference', 'drawing_read', 'measure_sheet', 'compare_volume', 'part_diff', 'equations', 'exam_ready', 'session_recipe', 'answer_sheet', 'instance', 'mates', 'collision', 'assembly_diff']);
let rec = null;          // { name, started, steps: [] }
const docNames = new Map();   // document_id -> file name (learned from results)

function stateFile(root) { return join(root, 'session_recipe', 'current.json'); }
function persist(root) { try { mkdirSync(join(root, 'session_recipe'), { recursive: true }); writeFileSync(stateFile(root), JSON.stringify(rec)); } catch { } }
function load(root) { if (rec) return rec; try { if (existsSync(stateFile(root))) rec = JSON.parse(readFileSync(stateFile(root), 'utf8')); } catch { } return rec; }

function learn(result) {
  const r = result?.result ?? result;
  const id = r?.document_id, path = r?.path ?? r?.inspection?.path;
  if (typeof id === 'string' && typeof path === 'string') docNames.set(id, basename(path));
}
function scrub(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === 'document_id' && docNames.has(v)) out.document = docNames.get(v);
    else if (k === 'document_id') out.document_id = '<id del documento>';
    else out[k] = v;
  }
  return out;
}

// called by server.mjs for every tool call (cheap when not recording)
export function recordCall(root, operation, args, response, ms) {
  try { learn(response); } catch { }
  if (!load(root) || operation === 'session_recipe') return;
  const ok = response && response.ok !== false && !response.isError;
  const step = { tool: `sw_${operation}`, ok, ms: Math.round(ms), args: scrub(args) };
  if (!ok) step.error = String(response?.error ?? '').slice(0, 300);
  rec.steps.push(step);
  try { appendFileSync(join(root, 'session_recipe', 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...step }) + '\n'); } catch { }
  persist(root);
}

const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'receta';

export function sessionRecipe(args, { root }) {
  const action = args.action;
  if (action === 'start') {
    if (load(root) && !args.restart) return { recording: true, already: true, name: rec.name, steps: rec.steps.length, note: 'Ya se está grabando; restart:true empieza de cero.' };
    rec = { name: args.name ?? 'Sesión grabada', started: new Date().toISOString(), steps: [] }; persist(root);
    return { recording: true, name: rec.name, note: 'Cada llamada que cambie algo se anota. Termina con action export.' };
  }
  if (action === 'status') { load(root); return rec ? { recording: true, name: rec.name, started: rec.started, steps: rec.steps.length, last: rec.steps.slice(-5) } : { recording: false }; }
  if (action === 'stop') { load(root); const n = rec?.steps.length ?? 0; rec = null; try { writeFileSync(stateFile(root), 'null'); } catch { } return { recording: false, discarded_steps: n }; }
  if (action !== 'export') throw new Error('action: start | status | stop | export');
  if (!load(root)) throw new Error('No hay grabación: empieza con action start');
  const keep = rec.steps.filter(s => s.ok && !READ_ONLY.has(s.tool.slice(3)) && !(s.tool === 'sw_drawing_dimension' && s.args.action === 'probe'));
  if (!keep.length) throw new Error('La grabación no tiene pasos que cambien algo');
  const id = slug(args.id ?? rec.name);
  const file = join(RECIPES, id + '.md');
  if (existsSync(file) && !args.overwrite) throw new Error(`Ya existe la receta ${id}; usa otro id u overwrite:true`);
  const name = args.name ?? rec.name, description = args.description ?? `Pasos grabados el ${rec.started.slice(0, 10)} (${keep.length} llamadas) para repetir: ${name}`;
  const failed = rec.steps.filter(s => !s.ok);
  const lines = ['---', `name: ${name}`, `description: ${description.replace(/\r?\n/g, ' ')}`, '---', '', `# ${name}`, '',
    `Grabada con \`sw_session_recipe\` (${rec.started.slice(0, 16).replace('T', ' ')}). Cada paso es una llamada real que funcionó; los ids de documento se cambiaron por el nombre del archivo: usa el document_id que te dé tu propia sesión.`, '',
    ...(args.notes ? ['## Notas', '', args.notes, ''] : []), '## Pasos', ''];
  keep.forEach((s, i) => { lines.push(`${i + 1}. \`${s.tool}\` (${(s.ms / 1000).toFixed(1)} s)`, '', '```json', JSON.stringify(s.args, null, 1), '```', ''); });
  if (failed.length) { lines.push('## Lo que falló en la sesión (no repetir)', ''); for (const s of failed.slice(-10)) lines.push(`- \`${s.tool}\`: ${s.error}`); lines.push(''); }
  mkdirSync(RECIPES, { recursive: true }); writeFileSync(file, lines.join('\n'));
  const total = rec.steps.length; if (!args.keep_recording) { rec = null; try { writeFileSync(stateFile(root), 'null'); } catch { } }
  return { file, resource: `solidworks://recipe/${id}`, steps_written: keep.length, steps_recorded: total, failed_calls: failed.length, recording: !!rec };
}
