// v3.8 exam state on disk (generated\exam_state.json): every finished build, drawing and answer sheet leaves one line, so a chat
// opened after a crash or an app restart sees what is done (sw_exam_ready shows the last ones) instead of starting over.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = root => join(root, 'exam_state.json');
export function readState(root, last = 15) {
  try { const all = JSON.parse(readFileSync(FILE(root), 'utf8')); return Array.isArray(all) ? all.slice(-last) : []; } catch { return []; }
}
export function recordStep(root, entry) {
  if (!root) return;
  let all = [];
  try { if (existsSync(FILE(root))) all = JSON.parse(readFileSync(FILE(root), 'utf8')); } catch { all = []; }
  if (!Array.isArray(all)) all = [];
  all.push({ at: new Date().toISOString(), ...entry });
  writeFileSync(FILE(root), JSON.stringify(all.slice(-200), null, 1));
}
// what to keep of each tool result: enough to resume, small
export function summarize(operation, args, result) {
  const r = result ?? {};
  if (operation === 'assembly_build') return { tool: 'sw_assembly_build', action: args.action, name: args.plan?.name, verdict: r.verdict, path: r.path, document_id: r.document_id, mates: r.verification?.mates?.mate_count, mass: r.verification?.mass_checks?.[0]?.mass, failures: (r.failures ?? []).length, differences: (r.differences ?? []).length };
  if (operation === 'assembly_drawing') return { tool: 'sw_assembly_drawing', name: args.name, ok: r.ok, drawing: r.drawing, pdf: r.pdf, scale: r.scale, answers: r.answers };
  if (operation === 'answer_sheet') return { tool: 'sw_answer_sheet', document: r.document, lines: r.lines, file: r.file, warnings: (r.warnings ?? []).length };
  if (operation === 'part_build') return { tool: 'sw_part_build', action: args.action, part: args.ir?.part ?? r.part, ok: r.ok, document_id: r.document_id, failed_at: r.failed_at };
  return { tool: 'sw_' + operation };
}
