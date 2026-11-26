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
import { superviseDimensions, dimensionWarning, organizeDimensions } from './dims_layout.mjs';
import { recordCall, sessionRecipe } from './session_recorder.mjs';
import { answerInTime } from './answer_in_time.mjs';
import { surfacesModeCall } from './surfaces_mode.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const GENERATED = join(dirname(fileURLToPath(import.meta.url)), 'generated');

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map(tools.map(t => [t.name, ajv.compile(t.validationSchema || t.inputSchema)]));
// v3.18 no soft timeout per worker call: answerInTime answers the client, and a step past 150 s must not fail a job of several steps
const worker = new WorkerClient({ timeoutMs: 0 });
const server = new Server({ name: 'solidworks-local', version: MCP_VERSION }, {
  capabilities: { tools: {}, resources: {} },
  instructions: 'SolidWorks connector for Windows. Start with sw_status and sw_environment; sw_exam_ready {start:true} starts a minimized SolidWorks owned by the MCP (separate from the user one). Proven workflows are MCP resources (solidworks://recipe/...): read the matching one before building whole assemblies or drawings. CAD mutations are limited to managed copies/new documents, or to user files opened with sw_open_project, which first backs up the file and all its references (restore with sw_restore_backup; close with sw_close_document). Inspect before editing, checkpoint when needed, verify volume then save. Geometry reference tokens expire after edits; refresh sw_topology. New modeling tools use mm and degrees; legacy set_dimension uses SI meters/radians. Do not scale to disguise drawing errors, invent materials or override mass. Real cut threads require installed profiles and exact sizes. Sketch coordinates are local XY. All calls serialize; failed edits can leave unsaved changes and cancellation/timeout leaves outcome unknown. A call that passes 50 s answers running:true and keeps going: do not repeat it or save; its result arrives as late_results in the next response. Assemblies: sw_assembly_new, sw_insert_component (component ORIGIN at position_mm), sw_add_mate (prefer {component, local_point_mm} faces or component planes; check moved_components to confirm the side chosen; width centers a tab in a slot), sw_move_component to pre-orient/drive free parts, sw_delete_mate, sw_mates (list/suppress), sw_set_dimension on mate dimensions (D1@Distancia1, radians for angles) to drive mechanisms, and sw_interference (never saves; sw_collision drives a distance/angle mate to the first contact; sw_edit_mate changes value/flip/alignment without deleting). Save with include_references=true before sw_pack_and_go; sw_part_diff proves changes against originals; sw_pack_and_go packages and verifies deliveries. Drawings: sw_assembly_drawing makes the whole sheet; sw_drawing_read reads PDF/DXF drawings. No unrestricted scripting.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ operation, validationSchema, ...definition }) => definition) }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resourceList() }));
server.setRequestHandler(ReadResourceRequestSchema, async request => readRecipe(request.params.uri));
// v3.11 late_results: what finished after its own call was cancelled or timed out is attached to the next response
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const t0 = performance.now();
  const job = handleCall(request, extra).then(out => {
    // v3.11 session recording (sw_session_recipe): every call is noted while a recording is active
    try { const tool = tools.find(t => t.name === request.params.name); if (tool) { let parsed = null; try { parsed = JSON.parse(out.content?.[0]?.text ?? 'null'); } catch { parsed = { ok: !out.isError, error: out.content?.[0]?.text }; } if (out.isError && parsed && typeof parsed === 'object') parsed.ok = false; recordCall(GENERATED, tool.operation, request.params.arguments ?? {}, parsed, performance.now() - t0); } } catch { }
    return out;
  });
  const out = await answerInTime(job, { tool: request.params.name, late: () => worker.late, signal: extra.signal });
  const late = worker.takeLate();
  if (late.length) {
    const { compactWorkerResponse } = await import('./compact.mjs');
    out.content = [...(out.content ?? []), { type: 'text', text: JSON.stringify({ late_results: late.map(l => ({ ...l, response: l.response && compactWorkerResponse(l.response, GENERATED, l.operation) })) }) }];
  }
  return out;
});
async function handleCall(request, extra) {
  const tool = tools.find(t => t.name === request.params.name);
  const args = request.params.arguments ?? {};
  const validator = validators.get(request.params.name);
  if (!tool || !validator(args)) return { isError: true, content: [{ type: 'text', text: tool ? `Invalid arguments: ${ajv.errorsText(validator.errors)}` : 'Unknown SolidWorks tool' }] };
  const error = argumentError(tool.operation, args);
  if (error) return { isError: true, content: [{ type: 'text', text: error }] };
  const surfaceMode = surfacesModeCall(tool.operation, args);
  if (surfaceMode) return surfaceMode;
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
    if (tool.operation === 'session_recipe') {
      try { return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: sessionRecipe(args, { root: GENERATED }) }) }] }; }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
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
      // v3.11: a build is not stopped by a client timeout/cancel (it used to stop half way, between two worker calls). It runs as
      // a tracked job (other calls wait for it) and, when the client already gave up, its result arrives as late_results.
      const { trackJob } = await import('./assembly_build.mjs'); const { compactBuildResult } = await import('./compact.mjs');
      // v3.14: no per-call soft timeout inside a build (each worker call waits for SolidWorks; only the hard timeout stops it)
      const buildWorker = Object.create(worker, { call: { value: (op, a, o = {}) => worker.call(op, a, { ...o, timeoutMs: 0 }) } });
      const run = (tool.operation === 'assembly_build' ? assemblyBuild : partBuild)(args, { worker: buildWorker, root: GENERATED });
      trackJob(`${tool.operation}:${args.plan?.name ?? args.ir?.part ?? Date.now()}`, run);
      try {
        const result = await run; if (args.action === 'build') try { recordStep(GENERATED, summarize(tool.operation, args, result)); } catch { }
        const compact = compactBuildResult(result, GENERATED, tool.operation);
        if (extra.signal?.aborted) worker.late.push({ operation: tool.operation, reason: 'client timeout/cancel', response: { ok: result.ok !== false, result: compact } });
        return { isError: result.ok === false, content: [{ type: 'text', text: JSON.stringify({ ok: result.ok !== false, result: compact }) }] };
      }
      catch (e) { if (extra.signal?.aborted) worker.late.push({ operation: tool.operation, reason: 'client timeout/cancel', error: e.message }); return { isError: true, content: [{ type: 'text', text: e.message }] }; }
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
    if (tool.operation === 'drawing_dim_organize' || tool.operation === 'drawing_dim_check') {
      // v3.18 these delete dimensions and put them back: like a build, a cancel does not stop them half way, and other calls wait
      const { trackJob } = await import('./assembly_build.mjs'), organize = tool.operation === 'drawing_dim_organize';
      const run = (organize ? organizeDimensions : superviseDimensions)(worker, args);
      if (organize || args.fix) trackJob(`${tool.operation}:${Date.now()}`, run, { forget: true });
      try {
        const result = await run;
        if (extra.signal?.aborted) worker.late.push({ operation: tool.operation, reason: 'client cancel', response: { ok: true, result } });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] };
      }
      catch (e) { if (extra.signal?.aborted) worker.late.push({ operation: tool.operation, reason: 'client cancel', error: e.message }); return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    const raw = await worker.call(tool.operation, args, { signal: extra.signal });
    // v3.15 nobody delivers a sheet with crashed dimensions unseen: annotate leaves them fixed, a PDF export reports what is left
    if (raw?.ok && raw.result && typeof raw.result === 'object') {
      if (tool.operation === 'drawing_annotate' && args.dimensions !== false && args.check_layout !== false) {
        try { raw.result.dimension_check = await superviseDimensions(worker, { document_id: args.document_id, fix: true }, { signal: extra.signal }); }
        catch (e) { raw.result.dimension_check = { error: e.message }; }
      }
      if (tool.operation === 'export' && /\.pdf$/i.test(args.name ?? '')) {
        try { const w = dimensionWarning(await superviseDimensions(worker, { document_id: args.document_id }, { signal: extra.signal })); if (w) raw.result.dimension_warning = w; } catch { }
      }
    }
    const { compactWorkerResponse } = await import('./compact.mjs');
    const response = compactWorkerResponse(raw, GENERATED, tool.operation);
    const content = [{ type: 'text', text: JSON.stringify(response) }];
    if (response.ok && ['preview', 'iso_check'].includes(tool.operation)) for (const p of response.result.paths ?? [response.result.path]) content.push({ type: 'image', mimeType: 'image/png', data: (await readFile(p)).toString('base64') });
    // A Pack and Go whose verification failed is an error even though the worker call itself succeeded.
    return { isError: isToolError(tool.operation, response), content };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
}
server.onclose = () => worker.close();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { worker.close(); process.exit(0); });
process.stdin.on('end', () => { worker.close(); setTimeout(() => process.exit(0), 50).unref(); });
await server.connect(new StdioServerTransport());
