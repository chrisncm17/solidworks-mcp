// v3.8 sw_assembly_drawing: the drawing of an assembly in ONE call. New drawing in generated\drawings (never overwritten), sheet
// size and title block (format COPIED from another drawing, read-only), front / top / side views in the right projection plus a
// shaded isometric (or exploded) view, one standard scale that fits, BOM with material and mass, balloons, the answer note (mass
// and every CM, sw_answer_sheet), sheet scale 1:1, save, PDF and a final check of what is on the sheet.
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { answerSheet } from './answers.mjs';

const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841], letter: [279.4, 215.9], tabloid: [431.8, 279.4] };
export const SCALES = [10, 5, 2, 1, 0.5, 0.4, 0.25, 0.2, 0.1, 0.05, 0.04, 0.025, 0.02, 0.01];
export const scaleText = s => s >= 1 ? `${s}:1` : `1:${+(1 / s).toFixed(3)}`;

// sheet layout as fractions of the sheet (x, y from the bottom-left), first or third angle projection
export function layout(w, h, firstAngle) {
  const L = { col1: 0.2 * w, col2: 0.46 * w, rowHi: 0.64 * h, rowLo: 0.28 * h };
  const v = firstAngle
    ? { front: [L.col1, L.rowHi], top: [L.col1, L.rowLo], side: [L.col2, L.rowHi], iso: [L.col2, L.rowLo], sideOrientation: 'left' }
    : { front: [L.col1, L.rowLo], top: [L.col1, L.rowHi], side: [L.col2, L.rowLo], iso: [L.col2, L.rowHi], sideOrientation: 'right' };
  return { ...v, cell: [0.24 * w, 0.3 * h], bom: [0.62 * w, h - 12], note: [0.62 * w, 0.44 * h], col2Right: L.col2 + 0.12 * w };
}
// largest standard scale at which every orthographic view (measured at scale `at`) fits its cell
export function fitScale(outlines, cell, at = 1) {
  const need = Math.min(...outlines.map(o => Math.min(cell[0] / Math.max(1e-6, (o[2] - o[0]) / at), cell[1] / Math.max(1e-6, (o[3] - o[1]) / at))));
  return SCALES.find(s => s <= need + 1e-9) ?? SCALES[SCALES.length - 1];
}
export function checkDrawingArgs(a) {
  const e = [];
  if (!a.document_id && !a.assembly_path) e.push('document_id (ensamble abierto) o assembly_path');
  if (!/^[^\\/:*?"<>|]{1,80}$/.test(a.name ?? '') || /\.slddrw$/i.test(a.name ?? '')) e.push('name: nombre simple sin extensión');
  if (a.size && !PAPER[a.size]) e.push('size: ' + Object.keys(PAPER).join('|'));
  return e;
}

async function call(worker, op, a, signal) { const r = await worker.call(op, a, { signal }); if (!r.ok) throw new Error(`${op}: ${r.error}`); return r.result; }

export async function assemblyDrawing(args, { worker, signal, root } = {}) {
  const errors = checkDrawingArgs(args);
  if (errors.length) return { ok: false, errors };
  const t0 = performance.now(), timings = {}, warnings = [], c = (op, a) => call(worker, op, a, signal);
  const timed = async (k, f) => { const t = performance.now(); try { return await f(); } finally { timings[k] = +((performance.now() - t) / 1000).toFixed(1); } };
  let asmId = args.document_id, openedAsm = false, drawingId = null, result = {};
  try {
    // the assembly: saved on disk (the drawing views read the file), open only to read mass and CM for the answer note
    await timed('assembly', async () => {
      if (!asmId) {
        // a managed part/assembly in the generated root is resumed; anything else opens with sw_open_project (backed up, never saved here)
        const inRoot = root && args.assembly_path.toLowerCase().startsWith((root + '\\').toLowerCase()) && !args.assembly_path.slice(root.length + 1).includes('\\');
        asmId = (inRoot ? await c('resume_document', { name: basename(args.assembly_path) }) : await c('open_project', { path: args.assembly_path })).document_id; openedAsm = true;
      }
      const ins = await c('inspect', { document_id: asmId });
      // v3.8: a PART gets the same sheet without BOM/balloons, with its model dimensions, center marks and hole callouts
      result.kind = ins.document_type === 'assembly' ? 'assembly' : ins.bodies ? 'part' : null;
      if (!result.kind) throw new Error('document_id/assembly_path no es un ensamble ni una pieza');
      if (ins.unsaved_changes && !openedAsm) warnings.push('El ensamble tiene cambios sin guardar: las vistas muestran la versión guardada en disco.');
      result.assembly = ins.path;
    });
    const [pw, ph] = args.width_mm && args.height_mm ? [args.width_mm, args.height_mm] : PAPER[args.size ?? 'A3'];
    const [w, h] = (args.orientation ?? 'landscape') === 'portrait' ? [Math.min(pw, ph), Math.max(pw, ph)] : [Math.max(pw, ph), Math.min(pw, ph)];
    const first = args.first_angle !== false, L = layout(w, h, first);
    await timed('sheet', async () => {
      const env = await c('environment', {});
      const nd = await c('drawing_new', { path: join(root, 'drawings', args.name + '.SLDDRW'), template: env.default_drawing_template, width_mm: w, height_mm: h });
      drawingId = nd.document_id; result.drawing = nd.path;
      await c('drawing_sheets', { document_id: drawingId, action: 'setup', name: nd.sheet, width_mm: w, height_mm: h, first_angle: first,
        ...(args.format_path ? { format_path: args.format_path } : {}), ...(args.format_from_drawing ? { format_from_drawing: args.format_from_drawing, ...(args.format_sheet ? { format_sheet: args.format_sheet } : {}) } : {}) });
      if (args.properties) await c('drawing_sheets', { document_id: drawingId, action: 'properties', values: args.properties });
    });
    const views = {};
    await timed('views', async () => {
      const add = async (key, orientation, pos, extra = {}) => { views[key] = (await c('drawing_sheets', { document_id: drawingId, action: 'add_view', model_path: result.assembly, view_orientation: orientation, position_mm: pos, scale: 1, ...extra })).view; };
      await add('front', 'front', L.front, { display: 'hidden_lines_removed' });
      await add('top', 'top', L.top, { display: 'hidden_lines_removed' });
      await add('side', L.sideOrientation, L.side, { display: 'hidden_lines_removed' });
      await add('iso', 'isometric', L.iso, { display: 'shaded', ...(args.exploded ? { exploded: true } : {}) });
      // one standard scale for all views, from the size of the orthographic views at 1:1
      const list = await c('drawing_views', { document_id: drawingId, action: 'list' });
      const vs = list.sheets.flatMap(s => s.views);
      const outl = ['front', 'top', 'side'].map(k => vs.find(v => v.name === views[k])?.outline_mm).filter(Boolean);
      const s = args.scale ?? fitScale(outl, L.cell);
      for (const [k, pos] of [['front', L.front], ['top', L.top], ['side', L.side], ['iso', L.iso]]) await c('drawing_views', { document_id: drawingId, action: 'set', sheet: list.active_sheet, view: views[k], scale: s, center_mm: pos });
      await c('drawing_views', { document_id: drawingId, action: 'fix_sheet_scale' });
      result.scale = scaleText(s); result.views = views; result.projection = first ? 'primer ángulo (ISO)' : 'tercer ángulo';
    });
    let bomBox = null;
    if (result.kind === 'part' && args.dimensions !== false) await timed('dimensions', async () => {
      // the IR parts are fully dimensioned sketches: their model dimensions make the drawing (one view each, auto-arranged)
      const an = await c('drawing_annotate', { document_id: drawingId, views: [views.front, views.top, views.side], dimensions: true, center_marks: true, hole_callouts: true, remove_repeated: true, auto_arrange: true });
      result.dimensions = { inserted: an.dimensions_gained ?? an.dimensions_inserted, per_view: an.views, hole_callouts: an.hole_callouts?.length ?? 0, repeated: an.repeated_dimensions };
      if (!(an.dimensions_gained ?? an.dimensions_inserted)) warnings.push('No se importaron cotas del modelo: si la pieza no viene de sw_part_build (croquis sin cotas), acótala con sw_drawing_annotate include_unmarked o a mano.');
    });
    if (result.kind === 'assembly' && args.bom !== false) await timed('bom', async () => {
      // top-right corner of the sheet, empty template columns (DESCRIPCION) removed, its real size measured
      const b = await c('bom', { document_id: drawingId, action: 'insert', view: views.iso, type: 'top_level', position_mm: [w - 10, h - 10], anchor: 'top_right', drop_empty_columns: true,
        columns: [{ title: 'MATERIAL', property: 'SW-Material' }, { title: 'MASA', property: 'SW-Mass' }] });
      result.bom = { columns: b.bom?.columns, rows: (b.bom?.rows ?? []).map(r => r.cells), dropped_columns: b.dropped_columns, size_mm: [b.width_mm, b.height_mm] };
      if (b.width_mm && b.height_mm) bomBox = { left: w - 10 - b.width_mm, bottom: h - 10 - b.height_mm };
      if (bomBox && bomBox.left < L.col2Right) warnings.push('La BOM es ancha y puede tocar la columna de vistas; revisa el PDF.');
      if (args.balloons !== false) {
        // isometric first; parts hidden there (inside or behind) get balloons in the front view, then the side view
        const perView = [];
        let g = await c('balloons', { document_id: drawingId, views: [views.iso] });
        perView.push(...(g.views ?? []));
        if (g.bom_items_without_balloon?.length) {
          // parts hidden in the isometric: by hand on the front, side or top view where an edge of them shows
          g = await c('balloons', { document_id: drawingId, views: [views.front, views.side, views.top], fill_missing: true, auto: false });
          perView.push(...(g.views ?? []).filter(v => v.view === '(manual)'));
        }
        let missing = g.bom_items_without_balloon ?? [];
        // v3.9: parts hidden in every view (inside the assembly) get a section view through the middle of the front view and
        // their balloons there (section:false skips it)
        if (missing.length && args.section !== false) {
          const listed = await c('drawing_views', { document_id: drawingId, action: 'list' });
          for (const direction of ['horizontal', 'vertical']) {
            let sec;
            try { sec = await c('drawing_views', { document_id: drawingId, action: 'section', sheet: listed.active_sheet, view: views.front, direction }); } catch (e) { warnings.push(`Corte ${direction}: ${e.message}`); continue; }
            g = await c('balloons', { document_id: drawingId, views: [sec.section.name], fill_missing: true, auto: false });
            perView.push(...(g.views ?? []).filter(v => v.view === '(manual)'));
            result.section = { view: sec.section.name, direction, placement: sec.placement };
            missing = g.bom_items_without_balloon ?? missing;
            break;
          }
        }
        result.balloons = { per_view: perView, items_without_balloon: missing, ...(g.manual_balloons?.length ? { manual: g.manual_balloons } : {}), ...(missing.length && g.fill_log?.length ? { fill_log: g.fill_log } : {}) };
        if (missing.length) warnings.push(`Elementos de la BOM sin globo: ${missing.join(', ')}. No se ven en ninguna vista (piezas internas)${result.section ? ' ni en el corte ' + result.section.view : ''}; agrega otra vista de corte (sw_drawing_views section con through_mm).`);
      }
    });
    if (args.answers !== false) await timed('answers', async () => {
      const part = result.kind === 'part';
      const ans = await answerSheet({ document_id: asmId, mass_units: args.mass_units ?? (part ? 'g' : undefined), length_units: args.length_units ?? (part ? 'mm' : undefined), decimals: args.decimals ?? (part ? 2 : undefined), ...(args.coordinate_systems ? { coordinate_systems: args.coordinate_systems } : {}), save_file: false }, { worker });
      // under the BOM, right-aligned so the longest line ends inside the sheet (character width ~0.62 of the text height)
      const hh = args.note_height_mm ?? 3.5, width = Math.max(...ans.lines.map(l => l.length)) * hh * 0.62;
      const pos = [Math.max(10, Math.min(bomBox ? bomBox.left : L.note[0], w - 10 - width)), bomBox ? bomBox.bottom - 12 : L.note[1]];
      await c('drawing_note', { document_id: drawingId, lines: ans.lines, position_mm: pos, height_mm: hh });
      result.answers = ans.lines; warnings.push(...ans.warnings);
    });
    await timed('save_pdf', async () => {
      await c('save', { document_id: drawingId }); result.saved = true;
      if (args.pdf !== false) result.pdf = (await c('export', { document_id: drawingId, name: `${args.name}_${Date.now().toString(36)}.pdf` })).path;
    });
    // what really ended up on the sheet
    const fin = await c('drawing_views', { document_id: drawingId, action: 'list' });
    const vs = fin.sheets.flatMap(s => s.views);
    result.check = { views: vs.length, balloons: vs.reduce((n, v) => n + (v.balloons ?? 0), 0), sheet_scale: fin.sheets.map(s => s.sheet_scale) };
    if (vs.length < 4) warnings.push(`Solo hay ${vs.length} vistas en la hoja`);
    if (fin.sheets.some(s => s.sheet_scale !== '1:1')) warnings.push('La escala de hoja no quedó 1:1');
    return { ok: true, ...result, ...(args.close === false ? { drawing_document_id: drawingId } : {}), warnings, timings_s: { ...timings, total: +((performance.now() - t0) / 1000).toFixed(1) },
      next: 'Revisa el PDF: que las vistas no se encimen con la BOM ni con el cajetín; mueve una con sw_drawing_views set center_mm si hace falta y vuelve a exportar.' };
  } catch (e) {
    return { ok: false, error: e.message, ...result, drawing_document_id: drawingId, warnings, timings_s: timings, note: drawingId ? 'El dibujo quedó abierto sin guardar lo último; ciérralo con sw_close_document (discard_changes) o corrígelo.' : undefined };
  } finally {
    if (openedAsm && asmId) try { await worker.call('close_document', { document_id: asmId, discard_changes: true }); } catch { }
    // saved BEFORE the PDF export, which marks the drawing as modified: closing it discards nothing new
    if (drawingId && args.close !== false && result.saved) try { await worker.call('close_document', { document_id: drawingId, discard_changes: true }); } catch { }
  }
}
