// Writes docs/TOOLS.md from server/tools.mjs: every tool with its description and every option (type, allowed values,
// required). Run `npm run tools` after adding or changing a tool so the documentation never drifts from the code.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tools } from '../server/tools.mjs';

const type = s => {
  if (!s) return '';
  if (s.enum) return s.enum.map(v => '`' + v + '`').join(' \\| ');
  if (s.const !== undefined) return '`' + s.const + '`';
  if (s.type === 'array') return 'array of ' + (s.items ? type(s.items) : 'any') + (s.minItems === s.maxItems && s.minItems ? ` (${s.minItems})` : '');
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf).map(type).join(' or ');
  const range = [s.minimum !== undefined ? '>= ' + s.minimum : s.exclusiveMinimum !== undefined ? '> ' + s.exclusiveMinimum : '', s.maximum !== undefined ? '<= ' + s.maximum : s.exclusiveMaximum !== undefined ? '< ' + s.exclusiveMaximum : ''].filter(Boolean).join(', ');
  return (s.type ?? 'object') + (range ? ` (${range})` : '');
};
const esc = t => String(t ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const groups = [
  ['Session and documents', /^sw_(status|environment|instance|session_health|exam_ready|create_part|create_assembly|open_copy|open_project|resume|close_document|save|checkpoint|restore_backup|copy_renamed|import_model|document_units|configuration)/],
  ['Part modeling', /^sw_(create_sketch|sketch|extrude|cut|revolve|fillet|chamfer|shell|rib|draft|sweep|loft|helix|thread|hole_wizard|mirror|circular_pattern|linear_pattern|ref_|sketch_plane|tangent|move_body|scale_uniform|create_cylinder|set_dimension|equations|parameters|part_flex|part_build|extrude_edit|delete_feature|suppress_feature|delete_relation|relations|radius_dimension|set_material|sheet_metal|save_body)/],
  ['Assemblies', /^sw_(assembly|insert_component|add_mate|edit_mate|delete_mate|mates|move_component|component|replace_component|find_faces|find_origin|coordinate_system|collision|interference|explode|mass_override)/],
  ['Drawings and reading drawings', /^sw_(drawing|create_drawing|bom|balloons|measure_sheet|answer_sheet)/],
  ['Verification, export and delivery', /^sw_/],
];
const out = ['# Tools', '', `${tools.length} tools. Generated from \`server/tools.mjs\` by \`npm run tools\` - do not edit by hand.`, ''];
const done = new Set();
for (const [title, re] of groups) {
  const list = tools.filter(t => re.test(t.name) && !done.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) continue;
  out.push(`## ${title}`, '');
  for (const t of list) {
    done.add(t.name);
    const s = t.inputSchema ?? {}, req = new Set(s.required ?? []), props = Object.entries(s.properties ?? {});
    out.push(`### \`${t.name}\`${t.annotations?.readOnlyHint ? ' (read-only)' : ''}`, '', esc(t.description), '');
    if (props.length) {
      out.push('| Option | Type / values | Required | Notes |', '|---|---|---|---|');
      for (const [k, v] of props) out.push(`| \`${k}\` | ${esc(type(v))} | ${req.has(k) ? 'yes' : ''} | ${esc(v.description ?? '')} |`);
      out.push('');
    }
  }
}
writeFileSync(fileURLToPath(new URL('../docs/TOOLS.md', import.meta.url)), out.join('\n'));
console.log(`docs/TOOLS.md: ${tools.length} tools`);

// README: the same groups as a compact table (one line per tool) between the tools:start / tools:end markers
const first = d => { const s = String(d ?? '').replace(/^v\d+(\.\d+)*:?\s*/i, '').replace(/\s+/g, ' '); const m = /^(.{20,170}?[.;])(\s|$)/.exec(s); return (m ? m[1] : s.slice(0, 170) + (s.length > 170 ? '…' : '')).replace(/\|/g, '\\|'); };
const rows = [`**${tools.length} tools.** Every option of every tool: [docs/TOOLS.md](docs/TOOLS.md).`, ''];
const done2 = new Set();
for (const [title, re] of groups) {
  const list = tools.filter(t => re.test(t.name) && !done2.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) continue;
  rows.push(`<details><summary><b>${title}</b> (${list.length})</summary>`, '', '| Tool | What it does |', '|---|---|');
  for (const t of list) { done2.add(t.name); rows.push(`| \`${t.name}\` | ${first(t.description)} |`); }
  rows.push('', '</details>', '');
}
const readme = fileURLToPath(new URL('../README.md', import.meta.url)), text = readFileSync(readme, 'utf8');
const a = text.indexOf('<!-- tools:start -->'), b = text.indexOf('<!-- tools:end -->');
if (a >= 0 && b > a) { writeFileSync(readme, text.slice(0, a) + '<!-- tools:start -->\n' + rows.join('\n') + '\n' + text.slice(b)); console.log('README.md: tool list updated'); }
