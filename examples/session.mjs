// Shared helpers for the practice scripts. Features keep the SolidWorks default names (user rule): no `name` is sent,
// the real tree name comes back from each call, and failed attempts are DELETED (never left suppressed in the tree).
import { WorkerClient } from '../server/worker-client.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
// Errors that mean the CAD state is unknown (timeout, cancelled, broken worker): never retry over them.
const fatal = e => /UNKNOWN|timed? ?out|Invalid worker|cancel/i.test(e.message);
const fp = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 10);
const CACHE = new URL('../server/generated/direcciones.json', import.meta.url);
// part template: the default one set in SolidWorks (Tools > Options > Default Templates); SW_PART_TEMPLATE overrides it
export let TPL = process.env.SW_PART_TEMPLATE ?? null;
export const L = (a, b, c = false) => ({ kind: 'line', start_mm: a, end_mm: b, construction: c });
export const A = (c, s, e, cw) => ({ kind: 'arc', center_mm: c, start_mm: s, end_mm: e, clockwise: cw });
export const C = (c, r) => ({ kind: 'circle', center_mm: c, radius_mm: r });
export const r6 = v => Math.round(v * 1e6) / 1e6, P = (x, y) => [r6(x), r6(y)];
export const poly = pts => pts.map((p, i) => L(p, pts[(i + 1) % pts.length]));
export async function session(fileName) {
  const w = new WorkerClient({ timeoutMs: 600000 });
  const call = async (op, args) => { const r = await w.call(op, args); if (!r.ok) throw new Error(`${op}: ${r.error}`); return r.result; };
  if (!TPL) TPL = (await call('environment', {})).default_part_template;
  const id = (await call('create_part', { name: fileName, template: TPL })).document_id;
  const log = []; let vol = 0;
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  const seen = {}; const keyOf = (label, geom) => `${fileName}|${label}|${seen[label] = (seen[label] ?? 0) + 1}` + (geom === undefined ? '' : '|' + fp(geom));
  const remember = (key, v) => { cache[key] = v; fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1)); };
  const s = {
    w, call, id, log, get vol() { return vol; },
    inspect: () => call('inspect', { document_id: id }),
    del: name => call('delete_feature', { document_id: id, name }),
    sketch: async (plane, entities) => (await call('create_sketch', { document_id: id, plane_index: plane, entities })).sketch,
    // op = extrude | cut | revolve; returns {feature, inspection}; on failure the orphan sketch is deleted.
    feat: async (op, plane, entities, args) => {
      const sk = await s.sketch(plane, entities);
      try { return await call(op, { document_id: id, sketch: sk, ...args }); } catch (e) { if (fatal(e)) throw e; await s.del(sk); throw e; }
    },
    plane: async (plane_index, offset_mm, flip = false) => call('ref_plane', { document_id: id, plane_index, offset_mm, flip }),
    // Choose among n candidate ways of building a feature; tryFn(k) returns a result or null (cleaning up after itself).
    // The winner is remembered in direcciones.json and tried first next time, so a re-run creates no failed attempts
    // and the default SolidWorks names stay consecutive (Saliente-Extruir1, 2, 3...).
    pick: async (label, n, tryFn) => {
      const key = keyOf(label), first = cache[key];
      const order = [...Array(n).keys()].sort((a, b) => (b === first) - (a === first));
      for (const k of order) { const r = await tryFn(k); if (r) { remember(key, k); return r; } }
      throw new Error(label + ': no variant gave the expected geometry');
    },
    // Try each variant (a function returning a feature result) until ok(result); failed attempts are deleted entirely.
    attempt: (label, variants, ok) => s.pick(label, variants.length, async k => {
      let r; try { r = await variants[k](); } catch (e) { if (fatal(e) || /delete_feature/.test(e.message)) throw e; return null; }
      if (ok(r)) return r;
      await s.del(r.feature); return null;
    }),
    // Offset plane + feature, trying the 4 plane-side/direction combinations; a failed pair (feature and plane) is deleted.
    offsetFeat: (label, base, offset, op, entities, args, ok) => s.pick(label, 4, async k => {
      const pl = await s.plane(base, offset, k >= 2);
      let r = null; try { r = await s.feat(op, pl.plane_index, entities, { ...args, reverse: k % 2 === 1 }); } catch (e) { if (fatal(e) || /delete_feature/.test(e.message)) throw e; }
      if (r && ok(r)) return { ...r, plane_index: pl.plane_index };
      if (r) await s.del(r.feature);
      await s.del(pl.feature); return null;
    }),
    // Through-all cut in both directions; a side with nothing to cut is skipped.
    throughBoth: async (plane, entities) => {
      // Always both sides: a cache could skip material after an earlier feature changes (Codex review).
      const sides = [false, true], done = [];
      for (const reverse of sides) { try { await s.feat('cut', plane, entities, { end_condition: 'through_all', reverse }); done.push(reverse); } catch (e) { if (!/body intersection/.test(e.message)) throw e; } }
      if (!done.length) throw new Error('throughBoth: nothing was cut');
    },
    step: async (label, fn) => { await fn(); const i = await s.inspect(); log.push(`${label}: ${i.volume_mm3.toFixed(1)} (Δ ${(i.volume_mm3 - vol).toFixed(1)}, cuerpos ${i.bodies.length})`); vol = i.volume_mm3; },
    finish: async target => {
      const cmp = await call('compare_volume', { document_id: id, target_mm3: target, tolerance_percent: 1 });
      log.push(`RESULTADO: ${cmp.actual_mm3.toFixed(1)} vs ${target} → error ${cmp.signed_error_percent.toFixed(3)} % ${cmp.within_tolerance ? 'APROBADO' : 'no'}`);
      const i = await s.inspect(); const k = i.features.findIndex(f => f.type === 'OriginProfileFeature'); log.push('árbol: ' + i.features.slice(k + 1).map(f => f.name + (f.suppressed ? '(suprimida)' : '')).join(', '));
      if (cmp.within_tolerance) await call('save', { document_id: id });
      return cmp.within_tolerance;
    },
  };
  return s;
}
export const box = r => r.inspection.bodies[0].box_exact_mm; // tight box (v1.5)
