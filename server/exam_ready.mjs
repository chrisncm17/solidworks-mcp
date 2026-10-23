// v3.8 sw_exam_ready: one call at the start of the exam. The tool itself proves the chat has this version loaded (a chat that
// opened before a restart of Claude Desktop keeps the old list and does not see it).
import { freemem, totalmem } from 'node:os';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tools } from './tools.mjs';
import { readState } from './exam_state.mjs';
// one version for the whole project: package.json at the repository root
export const MCP_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();

export async function examReady(args = {}, { worker, root } = {}) {
  const gb = b => +(b / 1024 ** 3).toFixed(1);
  const ram = { free_gb: gb(freemem()), total_gb: gb(totalmem()) };
  const todo = [];
  if (ram.free_gb < 3) todo.push(`Poca RAM libre (${ram.free_gb} GB): cierra Chrome, Spotify y lo que no uses antes de abrir SolidWorks.`);
  let instance = null;
  try { const s = await worker.call('instance', { action: 'status' }); instance = s.ok ? s.result : { error: s.error }; } catch (e) { instance = { error: e.message }; }
  let started = null;
  const running = instance?.mode === 'dedicated' && instance?.dedicated_running;
  const { trackJob, backgroundJobs } = await import('./assembly_build.mjs');
  const starting = backgroundJobs().find(j => j.label === 'arranque SolidWorks' && !j.done);
  if (!running && args.start && starting) started = { pending: true, note: 'ya se está arrancando' };
  else if (!running && args.start && args.wait === false) {
    // v3.8: start in the background (~40 s) while the chat reads the drawing (drawing_read does not use SolidWorks); the
    // first SolidWorks call simply waits behind it in the worker queue
    // and warm it up: the first new part pays ~7 s loading the template; a throwaway part (deleted) pays it now, in the background
    trackJob('arranque SolidWorks', worker.call('instance', { action: 'start' }).then(async s => {
      if (!s.ok) return { ok: false, error: s.error };
      let warm = null;
      try { const env = await worker.call('environment', {}); const name = '_calentar_' + Date.now().toString(36) + '.SLDPRT';
        const c = await worker.call('create_part', { name, template: env.result.default_part_template });
        if (c.ok) { await worker.call('close_document', { document_id: c.result.document_id, discard_changes: true });
          const { unlinkSync } = await import('node:fs'); try { unlinkSync(join(root, name)); } catch { } warm = true; } } catch { }
      return { ok: true, pid: s.result.pid, warmed_up: !!warm };
    }));
    started = { pending: true, note: 'Arrancando en segundo plano (~40 s): lee el plano mientras tanto; la primera llamada a SolidWorks espera a que termine.' };
  } else if (!running && args.start) {
    try { const s = await worker.call('instance', { action: 'start' }); started = s.ok ? { pid: s.result.pid } : { error: s.error }; } catch (e) { started = { error: e.message }; }
  }
  if (started?.error) todo.push('No arrancó el SolidWorks del MCP: ' + started.error);
  if (!running && !args.start) todo.push('El SolidWorks del MCP no está arrancado: sw_exam_ready start:true (o sw_instance start) lo abre minimizado; tarda cerca de 1 min.');
  const kits = root && existsSync(join(root, 'kits')) ? readdirSync(join(root, 'kits')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : [];
  // prebuild ["M8x30", ...]: bolt + washer + nut WITHOUT material, so the exam only copies them and sets the material
  let prebuilt = null;
  if (args.prebuild?.length) {
    const ok = (instance?.mode === 'dedicated' && instance?.dedicated_running) || (started && !started.error);
    if (!ok) todo.push('prebuild necesita el SolidWorks del MCP arrancado (start:true).');
    else {
      const { makeFasteners } = await import('./assembly_build.mjs');
      const { fastenerSpec } = await import('./fasteners.mjs');
      const comps = args.prebuild.flatMap(s => { const m = /^(M\d+)x(\d+(?:\.\d+)?)$/i.exec(s); if (!m) return [];
        return [{ type: 'bolt', size: m[1].toUpperCase(), length_mm: +m[2] }, { type: 'washer', size: m[1].toUpperCase() }, { type: 'nut', size: m[1].toUpperCase() }].map(make => ({ make, file: fastenerSpec(make).file })); });
      try { prebuilt = await makeFasteners({ components: comps }, { worker, root }); } catch (e) { prebuilt = { error: e.message }; }
    }
  }
  return {
    mcp_version: MCP_VERSION, tools: tools.length, last_steps: root ? readState(root, 10) : [], ...(prebuilt ? { prebuilt } : {}),
    chat_up_to_date: 'Si ves sw_exam_ready, este chat tiene v' + MCP_VERSION + '. Compara el número de herramientas sw_ que ves con tools; si ves menos, reinicia tu cliente MCP (Claude Desktop, Codex...).',
    ram, instance, started, kits, generated: root ?? null, background_jobs: backgroundJobs(),
    ready: !todo.length || (todo.length === 1 && !!started && !started.error && ram.free_gb >= 3),
    todo,
    exam_flow: 'sw_exam_ready start:true wait:false (SolidWorks arranca mientras lees) -> Plano: sw_drawing_read dimensions/analyze -> sw_assembly_draft (suggested_mates) -> piezas (sw-analista-plano en paralelo + sw_part_build) -> sw_assembly_build check -> build con auto_origins -> sw_mass_check (masa y CM en las unidades del plano).',
  };
}
