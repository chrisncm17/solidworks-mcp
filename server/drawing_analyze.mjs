// v3.6 sw_drawing_read action analyze: the whole drawing in ONE call, so reading a plan takes one look instead of ten.
// PDF: every page's text, ONE high-resolution render per page, the views found by their big uppercase labels (TUBO,
// TAPA SUPERIOR...) cropped from that render (grown to the strokes around them) with their own dimension candidates, and the
// key lines (mass, center of mass, interference, material, scale, notes). Photo/image: EXIF orientation, gray, auto-contrast,
// sharpening, plus overlapping zoomed tiles so small numbers are legible. Cached by file content AND analyzer code version;
// degraded results (a page whose text failed, a crop that could not be grown) are never cached.
// v3.6 review (Codex, high): code-versioned cache, current path on cache hits, multi-word labels, bounded concurrency,
// cancellation passed to every child process, output folders checked against junctions.
import { stat, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawingRead, drawingPython, groupDrawingLines, parseDimensionTokens } from './drawing_read.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'generated', 'drawing_read');
const cacheDir = path.join(outDir, 'cache');
const exec = promisify(execFile);
const KEY_LINE = /masa|mass|centro|center|interferenc|material|escala|scale|nota|note|unidad|units|origen|sistema de coordenadas|tolerancia|cantidad|^\s*[XYZ]\s*=\s*-?\d/i;
const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const LABEL_WORD = /^[A-ZÁÉÍÓÚÑÜ0-9-]+$/;

let codeVersion = null;
async function analyzerVersion() {
  if (codeVersion) return codeVersion;
  const h = createHash('sha1');
  for (const f of ['drawing_analyze.mjs', 'view_grow.py', 'image_enhance.py', 'drawing_read.mjs', 'drawing_read.py', 'render-pdf.ps1', 'render-pdf-many.ps1', 'contact_sheet.py']) { try { h.update(await readFile(path.join(root, f))); } catch { h.update(f); } }
  return codeVersion = h.digest('hex').slice(0, 12);
}
async function safeDir(dir) {
  await mkdir(dir, { recursive: true });
  if ((await realpath(dir)).toLowerCase() !== dir.toLowerCase()) throw new Error('Directorio de salida redirigido (junction): rechazado');
}
// run at most n async jobs at a time
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

// Labels of views: a line of uppercase words (TUBO, TAPA SUPERIOR) much taller than the median text. Each other word goes to the
// nearest label BELOW it (a view sits above its label): vertical gap + 0.8 x horizontal offset from the label centre.
export function detectViews(words, pageSize) {
  if (!words.length) return [];
  const h = words.map(w => w.bbox_mm[3] - w.bbox_mm[1]).sort((a, b) => a - b), med = h[Math.floor(h.length / 2)] || 2.5;
  const titleLines = groupDrawingLines(words).filter(l => l.words.length <= 4 && l.words.every(w => LABEL_WORD.test(w.text)) && l.words.some(w => /[A-ZÁÉÍÓÚÑÜ]{3,}/.test(w.text))
    && l.words.every(w => (w.bbox_mm[3] - w.bbox_mm[1]) >= 2.2 * med));
  if (!titleLines.length) return [];
  const titleWords = new Set(titleLines.flatMap(l => l.words));
  const groups = titleLines.map(l => ({ name: l.text, title_bbox: l.bbox_mm, words: [] }));
  for (const w of words) {
    if (titleWords.has(w)) continue;
    const [x, y] = center(w.bbox_mm); let best = null, bd = Infinity;
    for (const g of groups) {
      const b = g.title_bbox; if (b[1] < y) continue;
      const d = (b[1] - y) + 0.8 * Math.abs(x - (b[0] + b[2]) / 2); if (d < bd) { bd = d; best = g; }
    }
    if (best && bd <= 160) best.words.push(w);
  }
  return groups.map(g => {
    const all = [...g.words.map(w => w.bbox_mm), g.title_bbox];
    const r = [Math.min(...all.map(b => b[0])) - 12, Math.min(...all.map(b => b[1])) - 12, Math.max(...all.map(b => b[2])) + 12, Math.max(...all.map(b => b[3])) + 4];
    const region_mm = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(pageSize[0], r[2]), Math.min(pageSize[1], r[3])].map(v => +v.toFixed(1));
    return { name: g.name, region_mm, words: g.words };
  });
}

async function cached(input, extra, fn) {
  await safeDir(cacheDir);
  const key = createHash('sha1').update(await readFile(input)).update(JSON.stringify(extra)).update(await analyzerVersion()).digest('hex');
  const file = path.join(cacheDir, key + '.json');
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    if ((await Promise.all((hit._files || []).map(f => stat(f).then(() => 1, () => 0)))).every(Boolean)) return { ...hit, path: input, cached: true };
  } catch { }
  const res = await fn();
  if (!res.degraded) await writeFile(file, JSON.stringify(res));
  return { ...res, cached: false };
}

// v3.7: render many pages in ONE PowerShell call (render-pdf-many.ps1); returns [{page,path,width,height,width_mm,height_mm}]
async function renderMany(input, pages, width, signal) {
  const dir = path.join(outDir, 'many_' + createHash('sha1').update(input + pages + width + Date.now()).digest('hex').slice(0, 10));
  const { stdout } = await exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'render-pdf-many.ps1'), '-InputPath', input, '-OutputDir', dir, '-Pages', pages, '-Width', String(width)], { windowsHide: true, timeout: 600000, maxBuffer: 1 << 24, signal });
  return stdout.split(/\r?\n/).filter(l => l.startsWith('{')).map(l => JSON.parse(l));
}
const parsePages = (spec, n) => { if (!spec) return null; const s = new Set(); for (const part of String(spec).split(',')) { const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim()); if (!m) throw new Error('pages: usa "3" o "5-8,12"'); for (let i = +m[1]; i <= +(m[2] || m[1]); i++) if (i >= 1 && i <= n) s.add(i); } return s; };
async function enhance(imagePath, width, tiles, signal, crop = true) {
  const python = await drawingPython();
  return JSON.parse((await exec(python, ['-E', '-P', '-B', path.join(root, 'image_enhance.py'), JSON.stringify({ path: imagePath, out: outDir, width, tiles: tiles || 0, crop })], { windowsHide: true, timeout: 120000, maxBuffer: 1 << 24, signal })).stdout);
}

export async function analyzeDrawing(args, { signal } = {}) {
  const input = args.path, width = args.width_px || 1400, t0 = Date.now();
  await safeDir(outDir);
  if (/\.pdf$/i.test(input)) return cached(input, { width, pages: args.pages || null, tiles: args.tiles || 0, crop: args.crop !== false }, async () => {
    const info = await drawingRead({ path: input, action: 'info' }, { signal });
    let degraded = false;
    // Long or scanned PDFs (a slide deck of exercises): contact sheets first, so the right pages can be picked in one look
    let contact_sheets = [];
    const raster = info.pages.filter(p => p.kind === 'raster').map(p => p.page);
    if (info.pages.length > 6 || raster.length) {
      const thumbs = await renderMany(input, 'all', 520, signal);
      const python = await drawingPython();
      contact_sheets = JSON.parse((await exec(python, ['-E', '-P', '-B', path.join(root, 'contact_sheet.py'), JSON.stringify({ pages: thumbs.map(t => ({ page: t.page, path: t.path })), out: outDir, cols: 4, rows: 3, cell_w: 520 })], { windowsHide: true, timeout: 300000, signal })).stdout).sheets;
    }
    const want = parsePages(args.pages, info.pages.length) ?? (info.pages.length <= 6 ? new Set(info.pages.map(p => p.page)) : new Set());
    const detail = info.pages.filter(p => want.has(p.page));
    const rasterDetail = detail.filter(p => p.kind === 'raster').map(p => p.page);
    const rasterRenders = rasterDetail.length ? Object.fromEntries((await renderMany(input, rasterDetail.join(','), 2000, signal)).map(r => [r.page, r])) : {};
    const pages = await pool(detail, 2, async p => {
      if (p.kind === 'raster') {
        const r = rasterRenders[p.page]; if (!r) { degraded = true; return { page: p.page, kind: p.kind, error: 'no se pudo renderizar' }; }
        const e = await enhance(r.path, width, args.tiles, signal, args.crop !== false);
        return { page: p.page, kind: p.kind, size_mm: [r.width_mm, r.height_mm], full_render: r.path, enhanced: e.enhanced, uncropped: e.uncropped ?? null, tiles: e.tiles, views: [], key_lines: [], other_text: [],
          note: 'Página escaneada (sin texto): leer enhanced y tiles a ojo; las cotas no se pueden recalcular del PDF.' };
      }
      const [text, full] = await Promise.all([
        drawingRead({ path: input, action: 'text', page: p.page }, { signal }).catch(e => ({ words: [], error: e.message })),
        drawingRead({ path: input, action: 'render', page: p.page, width_px: 3000 }, { signal })]);
      if (text.error && p.has_vector_text !== false) degraded = true;
      const size = [full.region_mm[2] - full.region_mm[0], full.region_mm[3] - full.region_mm[1]], k = full.px_per_mm;
      const views = detectViews(text.words || [], size);
      let regionsPx = views.map(v => [Math.floor(v.region_mm[0] * k), Math.floor(v.region_mm[1] * k), Math.min(full.width_px, Math.ceil(v.region_mm[2] * k)), Math.min(full.height_px, Math.ceil(v.region_mm[3] * k))]);
      if (views.length) try {
        const python = await drawingPython();
        const g = JSON.parse((await exec(python, ['-E', '-P', '-B', path.join(root, 'view_grow.py'), JSON.stringify({ image: full.path, regions_px: regionsPx })], { windowsHide: true, timeout: 120000, signal })).stdout);
        regionsPx = g.regions_px; views.forEach((v, i) => { v.region_mm = regionsPx[i].map(x => +(x / k).toFixed(1)); });
      } catch (e) { if (signal?.aborted) throw e; degraded = true; }
      const crops = await pool(views, 4, (v, i) => drawingRead({ path: full.path, action: 'render', width_px: width, region_px: regionsPx[i] }, { signal }));
      const used = new Set(views.flatMap(v => v.words)), lines = groupDrawingLines(text.words || []);
      // a page without view labels (slides, mixed scans) also gets the enhanced image and zoomed tiles
      const extra = views.length ? {} : await enhance(full.path, width, args.tiles, signal, args.crop !== false).then(e => ({ enhanced: e.enhanced, tiles: e.tiles })).catch(() => ({}));
      return { ...extra,
        page: p.page, kind: p.kind, size_mm: size.map(v => +v.toFixed(1)), full_render: full.path,
        key_lines: lines.filter(l => KEY_LINE.test(l.text)).map(l => ({ text: l.text, bbox_mm: l.bbox_mm })),
        views: views.map((v, i) => ({ name: v.name, region_mm: v.region_mm, image: crops[i].path, dimension_candidates: parseDimensionTokens(v.words).map(({ words, ...c }) => c) })),
        other_text: lines.filter(l => !l.words.some(w => used.has(w)) && !KEY_LINE.test(l.text) && !views.some(v => v.name === l.text)).map(l => l.text).slice(0, 80),
        text_error: text.error,
      };
    });
    return { path: input, kind: 'pdf', page_count: info.pages.length, contact_sheets, pages, degraded, seconds: +((Date.now() - t0) / 1000).toFixed(1),
      _files: [...contact_sheets.map(s => s.path), ...pages.flatMap(p => [p.full_render, p.enhanced, p.uncropped, ...(p.tiles || []).map(t => t.image), ...(p.views || []).map(v => v.image)]).filter(Boolean)],
      how_to_use: 'Mira primero cada views[].image (una por pieza) y sus dimension_candidates; key_lines trae masa, CM, interferencias y materiales. SolidWorks dibuja Ø y profundidad como líneas: confirma esos símbolos en la imagen. Si una vista no se detectó (etiqueta pequeña o rara), usa full_render o action render con region_mm.' };
  });
  if (!/\.(png|jpe?g|tiff?|bmp)$/i.test(input)) throw new Error('analyze admite PDF o imagen');
  return cached(input, { width, tiles: args.tiles || 0, crop: args.crop !== false }, async () => {
    const python = await drawingPython();
    const r = JSON.parse((await exec(python, ['-E', '-P', '-B', path.join(root, 'image_enhance.py'), JSON.stringify({ path: input, out: outDir, width, tiles: args.tiles || 0, crop: args.crop !== false })], { windowsHide: true, timeout: 120000, maxBuffer: 1 << 24, signal })).stdout);
    return { ...r, kind: 'image', degraded: false, seconds: +((Date.now() - t0) / 1000).toFixed(1), _files: [r.enhanced, r.uncropped, ...r.tiles.map(t => t.image)].filter(Boolean),
      how_to_use: 'enhanced es la foto enderezada (EXIF), en gris y con contraste; tiles son acercamientos con traslape para leer números chicos. Si la foto está chueca o en perspectiva, pide otra de frente y con buena luz.' };
  });
}
