// v3.9 sw_export_batch: several documents x several formats in one call, through the worker export operation (which never
// overwrites and writes only inside generated). A format that does not apply to a document (PDF of a part, STEP of a drawing)
// is skipped and reported instead of failing the whole batch.
const MODEL = ['step', 'stl', 'x_t', 'igs'], DRAWING = ['pdf', 'dxf', 'dwg'];

export async function exportBatch(args, { worker, signal } = {}) {
  const t0 = performance.now(), suffix = args.suffix ?? Date.now().toString(36), files = [], skipped = [], failed = [], used = new Set();
  for (const id of args.document_ids) {
    const ins = await worker.call('inspect', { document_id: id }, { signal });
    if (!ins.ok) { failed.push({ document_id: id, error: ins.error }); continue; }
    const r = ins.result, type = r.document_type ?? r.type ?? (/\.slddrw$/i.test(r.path ?? '') ? 'drawing' : 'model');
    const isDrawing = /draw/i.test(String(type)), title = String(r.title ?? r.path ?? id).split(/[\\/]/).pop().replace(/\s*-\s*Hoja.*$/i, '').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_.-]/gu, '_');
    for (const f of args.formats) {
      if ((isDrawing ? DRAWING : MODEL).indexOf(f) < 0) { skipped.push({ document_id: id, title, format: f, reason: isDrawing ? 'un dibujo solo exporta pdf, dxf o dwg' : 'una pieza o ensamble solo exporta step, stl, x_t o igs' }); continue; }
      // Codex review: two titles can clean up to the same name (A B / A_B): number the second one instead of failing
      let base = `${title}_${suffix}`; for (let k = 2; used.has((base + '.' + f).toLowerCase()); k++) base = `${title}_${suffix}_${k}`; used.add((base + '.' + f).toLowerCase());
      const e = await worker.call('export', { document_id: id, name: `${base}.${f}` }, { signal });
      if (e.ok) files.push({ document_id: id, title, format: f, path: e.result.path, bytes: e.result.bytes }); else failed.push({ document_id: id, title, format: f, error: e.error });
    }
  }
  return { ok: failed.length === 0 && files.length > 0, files, skipped, failed, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
}
