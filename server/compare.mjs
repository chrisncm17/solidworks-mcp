// v1.9 assembly_diff: compares two read-only snapshots (worker op assembly_snapshot), taken one after the other so both
// assemblies may reference parts with the same names. Pure JS, no CAD state is changed.

const posOf = t => [t[9] * 1000, t[10] * 1000, t[11] * 1000];
// b expressed in the frame of a (SolidWorks ArrayData: rows 0-2 = component axes in world, 9-11 = translation in m)
export function relative(a, b) {
  if (!a) return b;
  const r = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[3 * i + j] += b[3 * i + k] * a[3 * j + k];
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[9 + j] += (b[9 + k] - a[9 + k]) * a[3 * j + k];
  return r;
}
export const distMm = (a, b) => Math.hypot(...posOf(a).map((v, k) => v - posOf(b)[k]));
export function angleDeg(a, b) {
  let tr = 0; for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += a[3 * i + k] * b[3 * i + k];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;
}
const r4 = v => Math.round(v * 1e4) / 1e4;

export function diffSnapshots(A, B, { tolerance_mm = 0.01, tolerance_deg = 0.01, relative_to_file } = {}) {
  const rel = relative_to_file?.toLowerCase();
  const frame = S => { if (!rel) return null; const f = S.components.find(c => c.file === rel && !c.suppressed); if (!f) throw new Error(`relative_to_file ${rel} not found in ${S.path}`); return f.transform; };
  const fa = frame(A), fb = frame(B);
  const details = [], onlyA = [], onlyB = [];
  const pair = (x, y) => {
    let dp = NaN, da = NaN;
    const comparable = !!(x.transform && y.transform) && x.loaded !== false && y.loaded !== false;
    if (x.transform && y.transform) { const rx = relative(fa, x.transform), ry = relative(fb, y.transform); dp = distMm(rx, ry); da = angleDeg(rx, ry); }
    const same = (comparable || (x.suppressed && y.suppressed)) && !(dp > tolerance_mm) && !(da > tolerance_deg) && x.configuration === y.configuration && x.suppressed === y.suppressed;
    details.push({ component: x.name, reference: y.name, file: x.file, position_diff_mm: r4(dp), rotation_diff_deg: r4(da), configuration: x.configuration === y.configuration ? x.configuration : `${x.configuration} ≠ ${y.configuration}`, suppressed: x.suppressed === y.suppressed ? x.suppressed : 'distinto', comparable, same });
  };
  for (const file of new Set([...A.components, ...B.components].map(c => c.file))) {
    const la = A.components.filter(c => c.file === file), lb = B.components.filter(c => c.file === file);
    for (const x of [...la]) { const y = lb.find(z => z.name === x.name); if (y) { pair(x, y); la.splice(la.indexOf(x), 1); lb.splice(lb.indexOf(y), 1); } }
    while (la.length && lb.length) {
      let best = Infinity, bx = la[0], by = lb[0];
      for (const x of la) for (const y of lb) if (x.transform && y.transform) { const d = distMm(relative(fa, x.transform), relative(fb, y.transform)); if (d < best) { best = d; bx = x; by = y; } }
      pair(bx, by); la.splice(la.indexOf(bx), 1); lb.splice(lb.indexOf(by), 1);
    }
    onlyA.push(...la.map(c => c.name)); onlyB.push(...lb.map(c => c.name));
  }
  // mate key = signature + rounded values (1e-6 m / rad), so a changed distance or angle is a difference
  const mkey = x => x.signature + (x.values_si?.length ? ' = ' + [...x.values_si].map(v => v.toFixed(6)).join(',') : '');
  const count = S => { const m = new Map(); for (const x of S.mates.filter(x => !x.suppressed)) m.set(mkey(x), (m.get(mkey(x)) || 0) + 1); return m; };
  const ca = count(A), cb = count(B);
  const mateDiff = [...new Set([...ca.keys(), ...cb.keys()])].map(k => ({ signature: k, document: ca.get(k) || 0, reference: cb.get(k) || 0 })).filter(x => x.document !== x.reference);
  const errA = A.mates.filter(m => m.error && !m.suppressed).length, errB = B.mates.filter(m => m.error && !m.suppressed).length;
  const dv = A.mass.volume_mm3 - B.mass.volume_mm3, volOk = Math.abs(dv) <= Math.max(1e-3, Math.abs(B.mass.volume_mm3) * 1e-6);
  const dm = A.mass.mass_g - B.mass.mass_g, dcm = Math.hypot(...A.mass.center_of_mass_mm.map((v, k) => v - B.mass.center_of_mass_mm[k]));
  const different = details.filter(d => !d.same).length;
  const massOk = Math.abs(dm) <= Math.max(1e-3, Math.abs(B.mass.mass_g) * 1e-6);
  const identical = !onlyA.length && !onlyB.length && !different && !mateDiff.length && !errA && !errB && massOk && volOk && (rel ? true : dcm <= tolerance_mm);
  return {
    verdict: identical ? 'iguales dentro de tolerancia' : 'diferentes',
    document: A.path, reference: B.path, configurations: [A.configuration, B.configuration], relative_to_file: rel ?? null, tolerance_mm, tolerance_deg,
    components: { document: A.components.length, reference: B.components.length, matched: details.length, different, only_in_document: onlyA, only_in_reference: onlyB, details: details.slice(0, 500) },
    mates: { document: A.mates.filter(m => !m.suppressed).length, reference: B.mates.filter(m => !m.suppressed).length, errors_document: errA, errors_reference: errB, signature_differences: mateDiff },
    mass: { document: A.mass, reference: B.mass, mass_diff_g: r4(dm), volume_diff_mm3: r4(dv), center_of_mass_diff_mm: r4(dcm) },
    note: 'Read-only. Mate signatures compare type and joined files, not the exact faces; equal signatures do not prove identical geometry. With relative_to_file the CM difference is reported but not used in the verdict (different origins).',
  };
}

// Runs the two snapshots through a WorkerClient-like object with call(op, args, options).
export async function assemblyDiff(worker, args, options) {
  const snap = async (path, configuration) => { const r = await worker.call('assembly_snapshot', { path, ...(configuration ? { configuration } : {}) }, options); if (!r.ok) throw new Error(`assembly_snapshot ${path}: ${r.error}`); return r.result; };
  const A = await snap(args.path, args.configuration);
  const B = await snap(args.reference_path, args.reference_configuration);
  return diffSnapshots(A, B, args);
}
