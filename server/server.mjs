import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resourceList, readRecipe } from './recipes.mjs';
import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';
import { tools, argumentError, isToolError } from './tools.mjs';
import { WorkerClient } from './worker-client.mjs';
import { assemblyDiff } from './compare.mjs';
import { drawingRead } from './drawing_read.mjs';
import { measureSheet } from './measure_sheet.mjs';
import { partBuild } from './part_ir.mjs';
import { assemblyBuild } from './assembly_build.mjs';
import { findOrigin } from './find_origin.mjs';
import { assemblyDraft } from './assembly_draft.mjs';
import { examReady, MCP_VERSION } from './exam_ready.mjs';
import { answerSheet } from './answers.mjs';
import { recordStep, summarize } from './exam_state.mjs';
import { assemblyDrawing } from './assembly_drawing.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const GENERATED = join(dirname(fileURLToPath(import.meta.url)), 'generated');

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map(tools.map(t => [t.name, ajv.compile(t.validationSchema || t.inputSchema)]));
const worker = new WorkerClient();
const server = new Server({ name: 'solidworks-local', version: MCP_VERSION }, {
  capabilities: { tools: {}, resources: {} },
  instructions: 'SolidWorks connector for Windows. Start with sw_status and sw_environment; sw_exam_ready {start:true} starts a minimized SolidWorks owned by the MCP (separate from the user one). Proven workflows are MCP resources (solidworks://recipe/...): read the matching one before building whole assemblies or drawings. CAD mutations are limited to managed copies/new documents, or to user files opened with sw_open_project, which first backs up the file and all its references (restore with sw_restore_backup; close with sw_close_document). Inspect before editing, checkpoint when needed, verify volume then save. Geometry reference tokens expire after edits; refresh sw_topology. New modeling tools use mm and degrees; legacy set_dimension uses SI meters/radians. Do not scale to disguise drawing errors, invent materials or override mass. Real cut threads require installed profiles and exact sizes. Sketch coordinates are local XY. All calls serialize; failed edits can leave unsaved changes and cancellation/timeout leaves outcome unknown. Assemblies: sw_assembly_new, sw_insert_component (component ORIGIN at position_mm), sw_add_mate (prefer {component, local_point_mm} faces or component planes; check moved_components to confirm the side chosen; width centers a tab in a slot), sw_move_component to pre-orient/drive free parts, sw_delete_mate, sw_mates (list/suppress), sw_set_dimension on mate dimensions (D1@Distancia1, radians for angles) to drive mechanisms, and sw_interference (never saves; sw_collision drives a distance/angle mate to the first contact; sw_edit_mate changes value/flip/alignment without deleting). Save with include_references=true before sw_pack_and_go; sw_part_diff proves changes against originals; sw_pack_and_go packages and verifies deliveries. Drawings: sw_assembly_drawing makes the whole sheet; sw_drawing_read reads PDF/DXF drawings. No unrestricted scripting.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ operation, validationSchema, ...definition }) => definition) }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resourceList() }));
server.setRequestHandler(ReadResourceRequestSchema, async request => readRecipe(request.params.uri));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const tool = tools.find(t => t.name === request.params.name);
  const args = request.params.arguments ?? {};
  const validator = validators.get(request.params.name);
  if (!tool || !validator(args)) return { isError: true, content: [{ type: 'text', text: tool ? `Invalid arguments: ${ajv.errorsText(validator.errors)}` : 'Unknown SolidWorks tool' }] };
  const error = argumentError(tool.operation, args);
  if (error) return { isError: true, content: [{ type: 'text', text: error }] };
  try {
    if (tool.operation === 'drawing_read' && args.action === 'dimensions') {
      const { drawingDimensions } = await import('./dims_geometry.mjs');
      const png = join(GENERATED, 'drawing_read', 'cotas_' + Date.now().toString(36) + '.png');
      const result = await drawingDimensions({ path: args.path, page: args.page ?? 1, out_png: png });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }, { type: 'image', mimeType: 'image/png', data: (await readFile(png)).toString('base64') }] };
    }
    if (tool.operation === 'drawing_read') {
      const result = await drawingRead(args, { signal: extra.signal });
      const content = [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
      if (args.action === 'render') content.push({ type: 'image', mimeType: 'image/png', data: (await readFile(result.path)).toString('base64') });
      return { content };
    }
    if (tool.operation === 'assembly_draft') {
      try { const result = await assemblyDraft(args); return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
    }
    // v3.8 (Codex review): a drawing finishing in the background is a multi-step CAD flow; no other CAD call may run in the
    // middle of it (closing or editing the assembly while its views are made). sw_exam_ready only reports, so it does not wait.
    if (tool.operation !== 'exam_ready') { const { waitBackground } = await import('./assembly_build.mjs'); await waitBackground(); }
    if (tool.operation === 'answer_sheet' || tool.operation === 'assembly_drawing') {
      try { const result = await (tool.operation === 'answer_sheet' ? answerSheet : assemblyDrawing)(args, { worker, signal: extra.signal, root: GENERATED }); try { recordStep(GENERATED, summarize(tool.operation, args, result)); } catch { } return { isError: result.ok === false, content: [{ type: 'text', text: JSON.stringify({ ok: result.ok !== false, result }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
    }
    if (tool.operation === 'exam_ready') {
      try { const result = await examReady(args, { worker, root: GENERATED }); return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
    }
    if (tool.operation === 'find_origin') {
      try { const result = await findOrigin(args, { worker }); return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
    }
    if (tool.operation === 'part_build' || tool.operation === 'assembly_build') {
      try { const result = await (tool.operation === 'assembly_build' ? assemblyBuild : partBuild)(args, { worker, signal: extra.signal, root: GENERATED }); if (args.action === 'build') try { recordStep(GENERATED, summarize(tool.operation, args, result)); } catch { } const { compactBuildResult } = await import('./compact.mjs'); return { isError: result.ok === false, content: [{ type: 'text', text: JSON.stringify({ ok: result.ok !== false, result: compactBuildResult(result, GENERATED, tool.operation) }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    if (tool.operation === 'measure_sheet') {
      const readText = (path, page) => drawingRead({ path, page, action: 'text' }, { signal: extra.signal });
      try { return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: await measureSheet(args, { root: GENERATED, readText, worker, signal: extra.signal }) }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    if (tool.operation === 'export_batch') {
      try { const { exportBatch } = await import('./export_batch.mjs'); const result = await exportBatch(args, { worker, signal: extra.signal }); return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify({ ok: result.ok, result }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    if (tool.operation === 'assembly_diff') {
      try { return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: await assemblyDiff(worker, args, { signal: extra.signal }) }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    const response = await worker.call(tool.operation, args, { signal: extra.signal });
    const content = [{ type: 'text', text: JSON.stringify(response) }];
    if (response.ok && tool.operation === 'preview') content.push({ type: 'image', mimeType: 'image/png', data: (await readFile(response.result.path)).toString('base64') });
    // A Pack and Go whose verification failed is an error even though the worker call itself succeeded.
    return { isError: isToolError(tool.operation, response), content };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
});
server.onclose = () => worker.close();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { worker.close(); process.exit(0); });
process.stdin.on('end', () => { worker.close(); setTimeout(() => process.exit(0), 50).unref(); });
await server.connect(new StdioServerTransport());
