// v3.1 part IR ("part-ir/1") and its compiler (sw_part_build).
// A part is described once, with named parameters and expressions; the compiler checks it, turns it into the MCP's own guarded
// tools (create_part, create_sketch dimension:true, extrude, cut, ...), verifies every step and the result (bodies, volume, box,
// material), then makes the SolidWorks part EDITABLE: every parameter becomes a global variable and the dimensions that come
// unambiguously from a parameter expression get an equation, so changing "L" in SolidWorks (or with action edit) rebuilds it.
//  check - validate + resolve, list the steps; touches nothing.   build - create the part.   edit - change parameters of a built
//  part (global variables), rebuild and re-check the expectations recomputed with the new values.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const fileHash = f => createHash('sha256').update(readFileSync(f)).digest('hex');
export const IR_VERSION = 'part-ir/1';
const PLANES = { front: 0, top: 1, right: 2 };
const OPS = ['extrude', 'cut', 'revolve', 'fillet', 'chamfer', 'hole', 'linear_pattern', 'circular_pattern', 'mirror', 'plane', 'shell', 'sketch', 'sweep'];
const num = v => typeof v === 'number' && Number.isFinite(v);

// ---------- expressions: numbers, params, + - * / ^ ( ), pi, sqrt(), sin/cos/tan (degrees) ----------
function parse(src) {
  const toks = String(src).match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[-+*/^(),]|\S/g) ?? [];
  let i = 0; const ids = new Set();
  const peek = () => toks[i], take = () => toks[i++];
  const FN = { sqrt: Math.sqrt, sin: x => Math.sin(x * Math.PI / 180), cos: x => Math.cos(x * Math.PI / 180), tan: x => Math.tan(x * Math.PI / 180) };
  const SWFN = { sqrt: 'sqr', sin: 'sin', cos: 'cos', tan: 'tan' };
  const atom = () => {
    const t = take();
    if (t === undefined) throw new Error('expresión incompleta');
    if (t === '(') { const e = expr(); if (take() !== ')') throw new Error('falta ")"'); return { f: e.f, sw: `(${e.sw})` }; }
    if (t === '-') { const e = power(); return { f: v => -e.f(v), sw: `-${e.sw}` }; }
    if (/^\d/.test(t)) { const n = Number(t); return { f: () => n, sw: t }; }
    if (t === 'pi') return { f: () => Math.PI, sw: 'pi' };
    if (FN[t]) { if (take() !== '(') throw new Error(`${t} necesita "("`); const e = expr(); if (take() !== ')') throw new Error('falta ")"');
      // SolidWorks trig works in the document angle unit (degrees in MMGS); sqrt is "sqr"
      return { f: v => FN[t](e.f(v)), sw: `${SWFN[t]}(${e.sw})` }; }
    if (/^[A-Za-z_]/.test(t)) { ids.add(t); return { f: v => { if (!num(v[t])) throw new Error(`parámetro desconocido "${t}"`); return v[t]; }, sw: `"${t}"` }; }
    throw new Error(`símbolo no permitido "${t}"`);
  };
  const power = () => { const b = atom(); if (peek() === '^') { take(); const e = power(); return { f: v => Math.pow(b.f(v), e.f(v)), sw: `${b.sw}^${e.sw}` }; } return b; };
  const term = () => { let e = power(); while (peek() === '*' || peek() === '/') { const op = take(), l = e, r = power(); e = { f: op === '*' ? v => l.f(v) * r.f(v) : v => l.f(v) / r.f(v), sw: `${l.sw}${op}${r.sw}` }; } return e; };
  const expr = () => { let e = term(); while (peek() === '+' || peek() === '-') { const op = take(), l = e, r = term(); e = { f: op === '+' ? v => l.f(v) + r.f(v) : v => l.f(v) - r.f(v), sw: `${l.sw}${op}${r.sw}` }; } return e; };
  const e = expr(); if (i !== toks.length) throw new Error(`sobra "${toks.slice(i).join(' ')}"`);
  return { ...e, ids: [...ids] };
}
export function evalExpr(x, params) {
  if (num(x)) return x;
  if (typeof x !== 'string') throw new Error(`valor inválido ${JSON.stringify(x)}`);
  const v = parse(x).f(params); if (!num(v)) throw new Error(`"${x}" no da un número finito`);
  return v;
}
export const exprIds = x => num(x) ? [] : parse(x).ids;
export const exprSW = x => num(x) ? String(x) : parse(x).sw;
// Two expressions are the same function of the parameters iff they agree on several perturbed parameter sets (randomised
// identity test, deterministic seeds): "L", "(L)-(0)" and "0+L" share a fingerprint; "L-e" and "W" do not, even when equal now.
export function fingerprint(x, params) {
  const names = Object.keys(params), out = [];
  for (let k = 1; k <= 3; k++) {
    const p = {}; names.forEach((n, i) => { p[n] = params[n] * (1 + 0.1 * k * (1 + ((i * 7 + k * 13) % 11) / 11)) + 0.37 * k * (i + 1); });
    let v; try { v = evalExpr(x, p); } catch { return null; }
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out.join('|');
}

// ---------- resolve: IR -> numeric tool arguments + provenance for every number ----------
export function resolveIR(ir) {
  const errors = [], warnings = [], steps = [];
  if (ir?.ir !== IR_VERSION) errors.push(`ir: debe ser "${IR_VERSION}"`);
  if (!ir?.part || !/^[\p{L}\p{N}_ .-]{1,80}$/u.test(ir.part)) errors.push('part: nombre de archivo simple (sin ruta ni extensión)');
  if (ir?.units && ir.units !== 'mm') errors.push('units: por ahora solo "mm"');
  const params = {};
  for (const [k, v] of Object.entries(ir?.params ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(k) || ['pi', 'sqrt', 'sin', 'cos', 'tan'].includes(k)) errors.push(`params.${k}: nombre inválido`);
    else if (!num(v)) errors.push(`params.${k}: debe ser un número (las expresiones van en las operaciones)`);
    else params[k] = v;
  }
  const used = new Set(), ids = new Set();
  // E: evaluate an expression, remember where it came from (for linking SolidWorks dimensions later)
  const E = (x, where) => { try { exprIds(x).forEach(p => used.add(p)); const v = evalExpr(x, params); return v; } catch (e) { errors.push(`${where}: ${e.message}`); return NaN; } };
  const P2 = (p, where) => Array.isArray(p) && p.length === 2 ? [E(p[0], where + '[0]'), E(p[1], where + '[1]')] : (errors.push(`${where}: punto [x, y]`), [NaN, NaN]);
  const P3 = (p, where) => Array.isArray(p) && p.length === 3 ? p.map((c, k) => E(c, `${where}[${k}]`)) : (errors.push(`${where}: punto [x, y, z]`), [NaN, NaN, NaN]);
  const exprOf = x => num(x) ? String(x) : x;
  for (const [n, f] of (ir?.features ?? []).entries()) {
    const where = `features[${n}] ${f?.id ?? ''}`;
    if (!f?.id || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(f.id)) { errors.push(`${where}: id inválido`); continue; }
    if (ids.has(f.id)) errors.push(`${where}: id repetido`); ids.add(f.id);
    if (!OPS.includes(f.op)) { errors.push(`${where}: op debe ser ${OPS.join('|')}`); continue; }
    const step = { id: f.id, op: f.op, args: {}, sketch: null, refs: {}, candidates: [] };
    if (['extrude', 'cut', 'revolve', 'sketch'].includes(f.op)) {
      const sk = f.sketch; if (!sk || !Array.isArray(sk.entities) || !sk.entities.length) { errors.push(`${where}: falta sketch.entities`); continue; }
      const out = [], cand = [];
      const C = (expr, value, what) => { if (num(value) && Math.abs(value) > 1e-9) { const e = exprOf(expr); cand.push({ expr: e, signed: value < 0 ? `-(${e})` : e, value: Math.abs(value), negative: value < 0, what }); } };
      const pts = [];
      const pt = (p, w) => { if (!Array.isArray(p)) { errors.push(`${w}: falta el punto [x, y] (rect usa from y to; circle usa center)`); return [0, 0]; } const v = P2(p, w); C(p[0], v[0], `${w}.x`); C(p[1], v[1], `${w}.y`); if (Array.isArray(p) && p.length === 2) pts.push({ e: p.map(exprOf), v, w }); return v; };
      // v3.8 shorthands, expanded to plain entities first: rect {center, w, h} (drawings dimension rectangles by size),
      // polar {center, r, count, start_deg, total_deg, d} ("6x at 60 deg" holes) and grid {from, count:[nx,ny], step:[dx,dy], d}
      // ("5x at 120"): typing every hole by hand was where the 37-hole plate went wrong-prone
      const ents = [];
      for (const [k, ent] of sk.entities.entries()) {
        const w = `${where}.sketch.entities[${k}]`, kind = Object.keys(ent ?? {})[0], e = ent?.[kind] ?? {}, round = v => +v.toFixed(6);
        if (kind === 'rect' && Array.isArray(e.center) && e.w !== undefined && e.h !== undefined) {
          const [cx, cy] = e.center.map(exprOf), w2 = `(${exprOf(e.w)})/2`, h2 = `(${exprOf(e.h)})/2`;
          ents.push({ rect: { from: [`(${cx})-${w2}`, `(${cy})-${h2}`], to: [`(${cx})+${w2}`, `(${cy})+${h2}`] } });
        } else if (kind === 'polar') {
          const n = e.count, r = E(e.r, w + '.r'), a0 = e.start_deg !== undefined ? E(e.start_deg, w + '.start_deg') : 0, tot = e.total_deg !== undefined ? E(e.total_deg, w + '.total_deg') : 360;
          const c = (e.center ?? [0, 0]).map((v, i) => E(v, `${w}.center[${i}]`));
          if (!Number.isInteger(n) || n < 1 || n > 500) { errors.push(`${w}: polar.count entero de 1 a 500`); continue; }
          if ([e.r, e.start_deg, e.total_deg, ...(e.center ?? [])].some(v => v !== undefined && typeof v !== 'number')) warnings.push(`${w}: polar con parámetros calcula posiciones fijas; con edit los barrenos no se mueven`);
          const step = tot >= 360 ? 360 / n : n > 1 ? tot / (n - 1) : 0;
          for (let q = 0; q < n; q++) { const a = (a0 + step * q) * Math.PI / 180; ents.push({ circle: { center: [round(c[0] + r * Math.cos(a)), round(c[1] + r * Math.sin(a))], d: e.d } }); }
        } else if (kind === 'grid') {
          const [nx, ny] = e.count ?? [], [dx, dy] = (e.step ?? [0, 0]).map((v, i) => E(v, `${w}.step[${i}]`)), f0 = (e.from ?? [0, 0]).map((v, i) => E(v, `${w}.from[${i}]`));
          if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || nx * ny > 2000) { errors.push(`${w}: grid.count [nx, ny] enteros ≥ 1, máximo 2000 barrenos`); continue; }
          if ([...(e.step ?? []), ...(e.from ?? [])].some(v => typeof v !== 'number')) warnings.push(`${w}: grid con parámetros calcula posiciones fijas; con edit los barrenos no se mueven`);
          for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) ents.push({ circle: { center: [round(f0[0] + i * dx), round(f0[1] + j * dy)], d: e.d } });
        } else if (kind === 'steps') {
          // stepped shaft for revolve: segments [[diameter, length], ...] along +X from x0 (default 0); gives the half profile
          // above the axis plus the construction axis line. Pernos, rodillos, ejes: the drawing lists exactly these pairs.
          const segs = (e.segments ?? []).map((sg, q) => [E(sg[0], `${w}.segments[${q}][0]`), E(sg[1], `${w}.segments[${q}][1]`)]), x0 = e.x0 !== undefined ? E(e.x0, w + '.x0') : 0;
          if (!segs.length || segs.length > 100 || segs.some(([d, L]) => !(d > 0) || !(L > 0))) { errors.push(`${w}: steps.segments [[diámetro, largo], ...] positivos`); continue; }
          // v3.8 (Codex review): points stay expressions of the segment parameters (x accumulates as d/L text), so links survive
          const ex = v => typeof v === 'number' ? v : `(${v})`, add = (a, b) => typeof a === 'number' && typeof b === 'number' ? round(a + b) : `${ex(a)}+${ex(b)}`;
          const pe = [[e.x0 ?? 0, 0]], pv = [[x0, 0]]; let xe = e.x0 ?? 0, xv = x0;
          segs.forEach(([d, L], q) => { const de = e.segments[q][0], re = typeof de === 'number' ? round(d / 2) : `${ex(de)}/2`;
            pe.push([xe, re]); pv.push([xv, d / 2]); xv += L; xe = add(xe, e.segments[q][1]); pe.push([xe, re]); pv.push([xv, d / 2]); });
          pe.push([xe, 0]); pv.push([xv, 0]);
          ents.push({ poly: { points: pe.filter((p, q) => q === 0 || Math.abs(pv[q][0] - pv[q - 1][0]) > 1e-9 || Math.abs(pv[q][1] - pv[q - 1][1]) > 1e-9) } }, { line: { from: [e.x0 ?? 0, 0], to: [xe, 0], construction: true } });
        } else ents.push(ent);
      }
      for (const [k, ent] of ents.entries()) {
        const w = `${where}.sketch.entities[${k}]`, kind = Object.keys(ent ?? {})[0], e = ent?.[kind] ?? {};
        if ((kind === 'line' || kind === 'rect') && !(Array.isArray(e.from) && Array.isArray(e.to))) { errors.push(`${w}: ${kind} usa from: [x, y] y to: [x, y]`); continue; }
        if (kind === 'line') { const a = pt(e.from, w + '.from'), b = pt(e.to, w + '.to'); out.push({ kind: 'line', start_mm: a, end_mm: b, ...(e.construction ? { construction: true } : {}) });
          if (a[0] === b[0]) C(`(${exprOf(e.to[1])})-(${exprOf(e.from[1])})`, b[1] - a[1], w + '.length'); if (a[1] === b[1]) C(`(${exprOf(e.to[0])})-(${exprOf(e.from[0])})`, b[0] - a[0], w + '.length'); }
        else if (kind === 'rect') { const a = pt(e.from, w + '.from'), b = pt(e.to, w + '.to');
          const c = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; for (let q = 0; q < 4; q++) out.push({ kind: 'line', start_mm: c[q], end_mm: c[(q + 1) % 4] });
          C(`(${exprOf(e.to[0])})-(${exprOf(e.from[0])})`, b[0] - a[0], w + '.width'); C(`(${exprOf(e.to[1])})-(${exprOf(e.from[1])})`, b[1] - a[1], w + '.height'); }
        else if (kind === 'poly') { const ps = (e.points ?? []).map((p, q) => pt(p, `${w}.points[${q}]`)); if (ps.length < 3) errors.push(`${w}: poly necesita 3 puntos o más`); ps.forEach((p, q) => out.push({ kind: 'line', start_mm: p, end_mm: ps[(q + 1) % ps.length] })); }
        else if (kind === 'circle') { const c = pt(e.center, w + '.center'); if ((e.d === undefined) === (e.r === undefined)) errors.push(`${w}: circle con d o con r`);
          const r = e.d !== undefined ? E(e.d, w + '.d') / 2 : E(e.r, w + '.r'); out.push({ kind: 'circle', center_mm: c, radius_mm: r });
          C(e.d !== undefined ? exprOf(e.d) : `2*(${exprOf(e.r)})`, 2 * r, w + '.diameter'); }
        else if (kind === 'arc') { const c = pt(e.center, w + '.center'), a = pt(e.from, w + '.from'), b = pt(e.to, w + '.to'); out.push({ kind: 'arc', center_mm: c, start_mm: a, end_mm: b, clockwise: !!e.clockwise });
          C(`sqrt(((${exprOf(e.from[0])})-(${exprOf(e.center[0])}))^2+((${exprOf(e.from[1])})-(${exprOf(e.center[1])}))^2)`, Math.hypot(a[0] - c[0], a[1] - c[1]), w + '.radius'); }
        else if (kind === 'slot') { const a = pt(e.from, w + '.from'), b = pt(e.to, w + '.to'), wd = E(e.width, w + '.width'); out.push({ kind: 'slot', start_center_mm: a, end_center_mm: b, width_mm: wd });
          C(exprOf(e.width), wd, w + '.width'); C(`(${exprOf(e.width)})/2`, wd / 2, w + '.end_radius'); }
        else errors.push(`${w}: entidad ${kind} no soportada (line, rect, poly, circle, arc, slot)`);
      }
      // distances between any two points along the sketch axes (e.g. 40 between two hole centres = L - 2*e)
      const uniq = pts.filter((q, i) => pts.findIndex(r => r.v[0] === q.v[0] && r.v[1] === q.v[1]) === i).slice(0, 40);
      for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) for (const ax of [0, 1])
        C(`(${uniq[j].e[ax]})-(${uniq[i].e[ax]})`, uniq[j].v[ax] - uniq[i].v[ax], `${uniq[i].w}→${uniq[j].w}.${ax ? 'dy' : 'dx'}`);
      let target;
      if (sk.plane !== undefined) target = PLANES[sk.plane] !== undefined ? { plane_index: PLANES[sk.plane] } : ids.has(sk.plane) && (ir.features.find(x => x.id === sk.plane)?.op === 'plane') ? { plane_of: sk.plane } : (errors.push(`${where}: plane debe ser front|top|right o el id de un op plane anterior`), {});
      else if (sk.on_face_near) target = { face_near_mm: P3(sk.on_face_near, where + '.sketch.on_face_near') };
      else errors.push(`${where}: sketch.plane o sketch.on_face_near`);
      step.sketch = { target, entities: out, fillets: (sk.fillets ?? []).map((q, k) => ({ at_mm: P2(q.at, `${where}.fillets[${k}].at`), radius_mm: E(q.r, `${where}.fillets[${k}].r`) })) };
      step.candidates = cand;
      if (f.op === 'revolve') { step.args = { angle_deg: f.angle === undefined ? 360 : E(f.angle, where + '.angle'), ...(f.op === 'revolve' && f.cut ? { cut: true } : {}), ...(f.reverse ? { reverse: true } : {}) };
        if (!out.some(x => x.kind === 'line' && x.construction)) errors.push(`${where}: revolve necesita una line con construction:true como eje`); }
      else if (f.op === 'sketch') step.args = {};   // v3.8: a sketch alone (profile or path of a sweep)
      else {
        const end = f.end ?? (f.op === 'cut' && f.depth === undefined ? 'through_all_both' : 'blind');
        step.args = { end_condition: f.mid_plane ? 'mid_plane' : end, ...(f.depth !== undefined ? { depth_mm: E(f.depth, where + '.depth') } : {}), ...(f.direction ? { direction: f.direction } : {}), ...(f.reverse ? { reverse: true } : {}) };
        if (['blind', 'mid_plane'].includes(step.args.end_condition) && !(step.args.depth_mm > 0)) errors.push(`${where}: depth > 0 requerido`);
        if (f.depth !== undefined) step.feature_dims = [{ dim: 'D1', expr: exprOf(f.depth), value: step.args.depth_mm }];
      }
    } else if (f.op === 'sweep') {
      // v3.8 sweep (barrido): bent rods, wires, hooks. profile = id of a closed 'sketch' (or circular_diameter for a round bar),
      // path = id of an open 'sketch' that starts on the profile plane
      const sk = id => ir.features.slice(0, ir.features.indexOf(f)).find(x => x.id === id && x.op === 'sketch');
      if (!sk(f.path)) errors.push(`${where}: path debe ser el id de un op sketch anterior`);
      if ((f.profile === undefined) === (f.circular_diameter === undefined)) errors.push(`${where}: da profile (id de un op sketch) o circular_diameter`);
      else if (f.profile !== undefined && !sk(f.profile)) errors.push(`${where}: profile debe ser el id de un op sketch anterior`);
      if (f.cut && f.circular_diameter !== undefined) errors.push(`${where}: circular_diameter solo para agregar material`);
      if (f.circular_diameter !== undefined && !(E(f.circular_diameter, where + '.circular_diameter') > 0)) errors.push(`${where}: circular_diameter > 0`);
      step.refs = { profile: f.profile, path: f.path };
      step.args = { ...(f.circular_diameter !== undefined ? { circular_diameter_mm: E(f.circular_diameter, where + '.circular_diameter') } : {}), ...(f.cut ? { cut: true } : {}) };
    } else if (f.op === 'fillet' || f.op === 'chamfer') {
      if (!Array.isArray(f.edges) || !f.edges.length) errors.push(`${where}: edges [{near:[x,y,z]}]`);
      step.refs.edges = (f.edges ?? []).map((e, k) => P3(e.near, `${where}.edges[${k}].near`));
      if (f.op === 'fillet') { step.args = { radius_mm: E(f.radius, where + '.radius') }; step.feature_dims = [{ dim: 'D1', expr: exprOf(f.radius), value: step.args.radius_mm }]; }
      else step.args = { distance_mm: E(f.distance, where + '.distance'), angle_deg: f.angle !== undefined ? E(f.angle, where + '.angle') : 45 };   // v3.7: the chamfer op requires angle_deg; drawings say 1x45 -> 45 by default
    } else if (f.op === 'hole') {
      if (f.standard !== undefined && !['iso', 'ansi_metric'].includes(f.standard)) errors.push(`${where}: standard iso|ansi_metric`);
      step.args = { type: f.type ?? 'hole', size: String(f.size ?? ''), ...(f.standard ? { standard: f.standard } : {}), point_mm: P3(f.at, where + '.at'), ...(f.depth !== undefined ? { depth_mm: E(f.depth, where + '.depth') } : {}),
        ...(f.thread_depth !== undefined ? { thread_depth_mm: E(f.thread_depth, where + '.thread_depth') } : {}) };
      if (!f.size) errors.push(`${where}: size (p. ej. "M6" o "Ø6,0")`);
    } else if (f.op === 'linear_pattern' || f.op === 'circular_pattern' || f.op === 'mirror') {
      const of = Array.isArray(f.of) ? f.of : []; if (!of.length) errors.push(`${where}: of [ids de operaciones anteriores]`);
      for (const x of of) if (!ids.has(x) || x === f.id) errors.push(`${where}: "${x}" no es una operación anterior`);
      step.refs.of = of;
      if (f.op === 'mirror') step.args = PLANES[f.plane] !== undefined ? { plane_index: PLANES[f.plane] } : (step.refs.plane_of = f.plane, {});
      else if (f.op === 'linear_pattern') { step.args = { count: f.count, spacing_mm: E(f.spacing, where + '.spacing'), axis: f.axis, ...(f.reverse ? { reverse: true } : {}) }; if (!Number.isInteger(f.count) || f.count < 2) errors.push(`${where}: count entero ≥ 2`); }
      else { step.args = { count: f.count, angle_deg: f.angle === undefined ? 360 : E(f.angle, where + '.angle'), axis: f.axis, ...(f.reverse ? { reverse: true } : {}) }; if (!Number.isInteger(f.count) || f.count < 2) errors.push(`${where}: count entero ≥ 2`); }
      if (f.op !== 'mirror' && !['X', 'Y', 'Z'].includes(f.axis)) errors.push(`${where}: axis X|Y|Z`);
    } else if (f.op === 'plane') {
      if (PLANES[f.from] === undefined) errors.push(`${where}: from front|top|right`);
      step.args = { plane_index: PLANES[f.from], offset_mm: E(f.offset ?? 0, where + '.offset'), ...(f.flip ? { flip: true } : {}) };
      step.feature_dims = f.offset !== undefined ? [{ dim: 'D1', expr: exprOf(f.offset), value: step.args.offset_mm }] : [];
    } else if (f.op === 'shell') {
      step.args = { thickness_mm: E(f.thickness, where + '.thickness'), ...(f.outward ? { outward: true } : {}) };
      step.refs.faces = (f.remove_faces ?? []).map((p, k) => P3(p.near, `${where}.remove_faces[${k}].near`));
      step.feature_dims = [{ dim: 'D1', expr: exprOf(f.thickness), value: step.args.thickness_mm }];
    }
    steps.push(step);
  }
  for (const k of Object.keys(params)) if (!used.has(k)) warnings.push(`params.${k} no se usa en ninguna operación`);
  const expect = {};
  const X = ir?.expect ?? {};
  if (X.bodies !== undefined) expect.bodies = X.bodies;
  if (X.volume_mm3 !== undefined) expect.volume_mm3 = E(X.volume_mm3, 'expect.volume_mm3');
  // v3.8 mass_g: the mass the drawing gives (tolerance 0.5 percent, the exam rule); when it misses, the result says how much
  // volume is over or short and which operations have a volume of that size (where the drawing was probably misread)
  if (X.mass_g !== undefined) { expect.mass_g = E(X.mass_g, 'expect.mass_g'); if (!(expect.mass_g > 0)) errors.push('expect.mass_g: > 0'); }
  if (X.box_mm !== undefined) expect.box_mm = Array.isArray(X.box_mm) && X.box_mm.length === 3 ? X.box_mm.map((b, k) => E(b, `expect.box_mm[${k}]`)) : (errors.push('expect.box_mm: [x, y, z]'), null);
  // v3.7: 1e-5 relative (0.001 %): SolidWorks mass properties of many curved faces differ ~3e-5 per hole from the exact formula
  expect.tolerance_mm3 = X.tolerance_mm3 ?? Math.max(0.01, (expect.volume_mm3 ?? 0) * 1e-5);
  if (!steps.length) errors.push('features: no hay operaciones');
  // the first operation that makes geometry must add material (sketches and planes may come before it)
  const firstSolid = steps.find(st => !['sketch', 'plane'].includes(st.op));
  if (firstSolid && !(['extrude', 'revolve'].includes(firstSolid.op) || (firstSolid.op === 'sweep' && !firstSolid.args.cut)) || (firstSolid?.op === 'revolve' && firstSolid.args.cut)) errors.push('la primera operación sólida debe crear material (extrude, revolve o sweep)');
  return { errors, warnings, params, steps, expect, material: ir?.material ?? null };
}

// ---------- helpers on topology (meters) ----------
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function distToEdge(e, p) {
  if (e.circle) { const [cx, cy, cz, ax, ay, az, r] = e.circle; const v = [p[0] - cx, p[1] - cy, p[2] - cz], h = v[0] * ax + v[1] * ay + v[2] * az;
    const ip = [v[0] - h * ax, v[1] - h * ay, v[2] - h * az], n = Math.hypot(...ip); return Math.hypot(h, n - r); }
  if (e.start_m && e.end_m) { const a = e.start_m, b = e.end_m, ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2)) : 0; return d3(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]); }
  return Infinity;
}
function pickEdge(topo, pmm, where) {
  const p = pmm.map(v => v / 1000), ranked = (topo.edges ?? []).map(e => ({ e, d: distToEdge(e, p) })).sort((x, y) => x.d - y.d);
  if (!ranked.length || ranked[0].d > 0.5e-3) throw new Error(`${where}: ninguna arista pasa a menos de 0.5 mm de ${JSON.stringify(pmm)}`);
  if (ranked[1] && ranked[1].d - ranked[0].d < 0.05e-3) throw new Error(`${where}: el punto ${JSON.stringify(pmm)} queda igual de cerca de dos aristas; usa un punto sobre una sola`);
  return ranked[0].e.reference;
}
function pickPlanarFace(topo, pmm, where) {
  const p = pmm.map(v => v / 1000);
  const hits = (topo.faces ?? []).filter(f => f.plane && Array.isArray(f.box_m)).filter(f => {
    const [nx, ny, nz, px, py, pz] = f.plane; const dist = Math.abs((p[0] - px) * nx + (p[1] - py) * ny + (p[2] - pz) * nz);
    const b = f.box_m, t = 1e-6; return dist < 1e-6 && p[0] >= b[0] - t && p[0] <= b[3] + t && p[1] >= b[1] - t && p[1] <= b[4] + t && p[2] >= b[2] - t && p[2] <= b[5] + t;
  }).sort((a, b) => a.area_mm2 - b.area_mm2);
  if (!hits.length) throw new Error(`${where}: ninguna cara plana contiene ${JSON.stringify(pmm)}`);
  return hits[0].reference;
}

// ---------- build ----------
async function call(worker, op, args, signal) {
  const r = await worker.call(op, args, { signal });
  if (!r.ok) { const e = new Error(`${op}: ${r.error}`); e.safe_edit = r.safe_edit; throw e; }
  return r.result;
}
const bodiesBox = ins => { const bx = (ins.bodies ?? []).map(b => b.box_exact_mm).filter(Boolean); if (!bx.length) return null;
  const lo = [0, 1, 2].map(i => Math.min(...bx.map(b => b[i]))), hi = [3, 4, 5].map(i => Math.max(...bx.map(b => b[i]))); return [0, 1, 2].map(i => +(hi[i] - lo[i]).toFixed(6)); };
function checkExpect(expect, ins, material) {
  const rows = [];
  if (expect.bodies !== undefined) rows.push({ check: 'bodies', expected: expect.bodies, model: ins.bodies.length, ok: ins.bodies.length === expect.bodies });
  if (expect.volume_mm3 !== undefined) rows.push({ check: 'volume_mm3', expected: +expect.volume_mm3.toFixed(4), model: +ins.volume_mm3.toFixed(4), ok: Math.abs(ins.volume_mm3 - expect.volume_mm3) <= expect.tolerance_mm3 });
  if (expect.mass_g !== undefined) rows.push({ check: 'mass_g', expected: expect.mass_g, model: num(ins.mass_g) ? +ins.mass_g.toFixed(4) : null, error_percent: num(ins.mass_g) ? +((ins.mass_g - expect.mass_g) / expect.mass_g * 100).toFixed(3) : null, ok: num(ins.mass_g) && Math.abs(ins.mass_g - expect.mass_g) <= 0.005 * expect.mass_g });
  if (expect.box_mm) { const b = bodiesBox(ins); rows.push({ check: 'box_mm', expected: expect.box_mm.map(v => +v.toFixed(4)), model: b, ok: !!b && b.every((v, i) => Math.abs(v - expect.box_mm[i]) <= 0.001) }); }
  if (material) rows.push({ check: 'material', expected: material, model: ins.material || null, ok: !!ins.material });
  const errs = (ins.features ?? []).filter(f => f.error_code && !f.is_warning).map(f => f.name);
  rows.push({ check: 'rebuild_errors', expected: 0, model: errs.length, ok: errs.length === 0, features: errs });
  return rows;
}

// link SolidWorks dimensions to the IR parameters: only when ONE expression explains the value
async function linkParameters(worker, id, res, built, signal) {
  const linked = [], ambiguous = [], skipped = [];
  for (const [k, v] of Object.entries(res.params)) await call(worker, 'parameters', { document_id: id, action: 'set_global', name: k, value: v }, signal);
  const ins = await call(worker, 'inspect', { document_id: id }, signal);
  for (const b of built) {
    const st = res.steps.find(s => s.id === b.id);
    const pairs = [];
    if (b.sketch && st.candidates?.length) {
      const f = ins.features.find(x => x.name === b.sketch);
      for (const dm of f?.dimensions ?? []) {
        const mm = dm.value_si * 1000, m = st.candidates.filter(c => Math.abs(c.value - mm) < 1e-6 && exprIds(c.expr).length);
        const groups = new Map();
        for (const cd of m) { const fp = fingerprint(cd.signed, res.params); if (fp) groups.set(fp, [...(groups.get(fp) ?? []), cd]); }
        if (!m.length) skipped.push(`${dm.name}=${+mm.toFixed(4)} (constante o sin expresión del IR)`);
        else if (groups.size > 1) ambiguous.push(`${dm.name}=${+mm.toFixed(4)}: ${[...groups.values()].map(g => exprSW(g[0].signed)).join(' | ')}`);
        else { const best = [...groups.values()][0].map(cd => ({ cd, sw: exprSW(cd.signed) })).sort((a, b) => a.sw.length - b.sw.length)[0];
          pairs.push({ dimension: dm.name, expression: best.sw, from: best.cd.what }); }
      }
    }
    for (const fd of st.feature_dims ?? []) if (b.feature && exprIds(fd.expr).length) pairs.push({ dimension: `${fd.dim}@${b.feature}`, expression: exprSW(fd.expr), from: `${b.id}.${fd.dim}` });
    for (const p of pairs) {
      try { await call(worker, 'parameters', { document_id: id, action: 'link', dimension: p.dimension.split('@').slice(0, 2).join('@'), expression: p.expression }, signal); linked.push(p); }
      catch (e) { skipped.push(`${p.dimension}: ${e.message.slice(0, 160)}`); }
    }
  }
  return { linked, ambiguous, skipped };
}

export async function partBuild(args, { worker, signal, root } = {}) {
  const ir = args.ir ?? (args.ir_path ? JSON.parse(readFileSync(args.ir_path, 'utf8')) : null);
  if (args.action === 'edit') {
    const res = resolveIR({ ...ir, params: { ...ir.params, ...args.params } });
    if (res.errors.length) return { ok: false, errors: res.errors };
    const id = args.document_id;
    for (const [k, v] of Object.entries(args.params ?? {})) await call(worker, 'parameters', { document_id: id, action: 'set_global', name: k, value: v }, signal);
    const ins = await call(worker, 'inspect', { document_id: id }, signal);
    const rows = checkExpect(res.expect, ins, res.material?.name);
    return { ok: rows.every(r => r.ok), params: res.params, checks: rows, note: 'Expectations recomputed from the IR with the new parameter values; unsaved until sw_save.' };
  }
  const res = resolveIR(ir);
  if (args.action === 'check' || res.errors.length) return { ok: res.errors.length === 0, errors: res.errors, warnings: res.warnings, params: res.params, expect: res.expect,
    steps: res.steps.map(s => ({ id: s.id, op: s.op, args: s.args, sketch: s.sketch && { target: s.sketch.target, entities: s.sketch.entities.length }, refs: s.refs })) };
  if (args.action !== 'build') throw new Error('action: check, build or edit');
  // v3.8 reuse: a part whose IR (without its name) was already built and saved, and whose file nobody changed since, is not built
  // again (a failed assembly used to rebuild every part, ~60 s and many tokens). The result says reused and gives the file name.
  const cacheDir = join(root ?? fileURLToPath(new URL('./generated', import.meta.url)), 'ir_cache');
  // the options that change the result are part of the key too (Codex review)
  const key = createHash('sha256').update(JSON.stringify({ ir: { ...ir, part: undefined }, link_parameters: args.link_parameters ?? true, template: args.template ?? null, flex_test: args.flex_test ?? null })).digest('hex').slice(0, 32);
  // rebuild: build again from zero (still saved and remembered for the next reuse)
  if (args.reuse && !args.rebuild) {
    try {
      const hit = JSON.parse(readFileSync(join(cacheDir, key + '.json'), 'utf8'));
      // saving an assembly re-saves its parts (date AND size change without any edit), so neither proves an edit: reuse while the
      // file exists and say when it changed since it was built (the assembly checks - box, mass, symmetry - still verify it)
      if (existsSync(hit.path)) {
        const changed = hit.sha256 ? fileHash(hit.path) !== hit.sha256 : statSync(hit.path).size !== hit.size;
        if (!changed) return { ok: true, reused: true, part: basename(hit.path), path: hit.path, document_id: null, features: [], checks: [], build_checks: hit.checks ?? [],
          note: 'Identical IR already built and saved, file unchanged since; nothing was rebuilt. build_checks are the checks of that build.' };
        // Codex review: the content changed (an assembly save re-saves its parts, but so does an edit): open it and prove it is
        // still the built part (same volume and material, IR expectations pass) before reusing it; otherwise rebuild it
        if (worker && hit.volume_mm3 !== undefined) {
          let rid = null;
          try {
            rid = (await call(worker, 'resume_document', { name: basename(hit.path) }, signal)).document_id;
            const ins = await call(worker, 'inspect', { document_id: rid }, signal);
            const rows = checkExpect(res.expect, ins, res.material?.name);
            const same = num(ins.volume_mm3) && Math.abs(ins.volume_mm3 - hit.volume_mm3) <= 1e-6 * Math.max(1, Math.abs(hit.volume_mm3)) && (ins.material ?? null) === (hit.material ?? null);
            if (same && rows.every(r => r.ok)) {
              writeFileSync(join(cacheDir, key + '.json'), JSON.stringify({ ...hit, size: statSync(hit.path).size, sha256: fileHash(hit.path) }));
              return { ok: true, reused: true, reverified: true, part: basename(hit.path), path: hit.path, document_id: null, features: [], checks: rows, build_checks: hit.checks ?? [],
                note: 'The file was saved again after its build (an assembly save does that); it was opened and verified: same volume and material, IR checks pass.' };
            }
          } catch { /* cannot verify: rebuild */ }
          finally { if (rid) try { await call(worker, 'close_document', { document_id: rid, discard_changes: true }, signal); } catch { } }
        }
      }
    } catch { /* no cache entry */ }
  }
  // v3.8 speed: every edit of this new part goes with light_guard (no rollback copy to disk per feature; see Guard.cs)
  { const base = worker; worker = { call: (op, a, o) => base.call(op, a && a.document_id ? { ...a, light_guard: true } : a, o) }; }
  // v3.8 speed: no SolidWorks idle gaps between the features (fast_hold); assembly_build already holds it (_held)
  const holdHere = !args._held && process.env.SW_MCP_PART_HOLD !== '0';
  if (holdHere) await worker.call('fast_hold', { on: true }).catch(() => null);
  try {
  const env = await call(worker, 'environment', {}, signal);
  const genDir = root ?? fileURLToPath(new URL('./generated', import.meta.url));
  const name = existsSync(join(genDir, `${ir.part}.SLDPRT`)) && args.reuse ? `${ir.part}_${Date.now().toString(36)}.SLDPRT` : `${ir.part}.SLDPRT`;
  const id = (await call(worker, 'create_part', { name, template: args.template ?? env.default_part_template }, signal)).document_id;
  const built = [], planeIdx = {}, log = [];
  let vol = 0;
  try {
    for (const st of res.steps) {
      const rec = { id: st.id, op: st.op }, t0 = performance.now();
      if (st.sketch) {
        const t = st.sketch.target, sa = { document_id: id, entities: st.sketch.entities, dimension: true, ...(st.sketch.fillets.length ? { fillets: st.sketch.fillets } : {}) };
        if (t.plane_index !== undefined) sa.plane_index = t.plane_index; else if (t.plane_of) sa.plane_index = planeIdx[t.plane_of];
        else sa.face_point_mm = t.face_near_mm;   // v3.8 speed: the worker finds the planar face by the point (no topology listing)
        let s; try { s = await call(worker, 'create_sketch', sa, signal); }
        catch (e) { if (st.op !== 'sketch') throw e; s = await call(worker, 'create_sketch', { ...sa, dimension: false }, signal); rec.note = 'sin cotas automáticas: ' + e.message; }
        // an open path for a sweep may stay under-defined; every other sketch must be fully defined
        if (s.status !== 3 && st.op !== 'sketch') throw new Error(`${st.id}: el croquis ${s.sketch} no quedó totalmente definido (estado ${s.status})`);
        rec.sketch = s.sketch;
        if (st.op === 'sketch') { if (s.status !== 3) rec.note = [rec.note, `croquis no totalmente definido (estado ${s.status})`].filter(Boolean).join('; '); rec.s = +((performance.now() - t0) / 1000).toFixed(2); built.push(rec); continue; }
        const r = await call(worker, st.op === 'revolve' ? 'revolve' : st.op, { document_id: id, sketch: s.sketch, ...st.args }, signal);
        rec.feature = r.feature; rec.volume_mm3 = r.inspection.volume_mm3;
      } else if (st.op === 'sweep') {
        const sk = x => built.find(b => b.id === x)?.sketch;
        const r = await call(worker, 'sweep', { document_id: id, path: sk(st.refs.path), ...(st.refs.profile ? { profile: sk(st.refs.profile) } : {}), ...st.args }, signal);
        rec.feature = r.feature; rec.volume_mm3 = r.inspection.volume_mm3;
      } else if (st.op === 'fillet' || st.op === 'chamfer') {
        // v3.8 speed: the worker picks each edge by its point (no topology listing); same 0.5 mm / tie rules as pickEdge
        const r = await call(worker, st.op, { document_id: id, edge_points_mm: st.refs.edges, ...st.args }, signal);
        rec.feature = r.feature; rec.volume_mm3 = r.inspection.volume_mm3;
      } else if (st.op === 'shell') {
        const topo = st.refs.faces.length ? await call(worker, 'topology', { document_id: id }, signal) : null;
        const r = await call(worker, 'shell', { document_id: id, ...st.args, ...(topo ? { face_references: st.refs.faces.map((p, k) => pickPlanarFace(topo, p, `${st.id}.remove_faces[${k}]`)) } : {}) }, signal);
        rec.feature = r.feature; rec.volume_mm3 = r.inspection.volume_mm3;
      } else if (st.op === 'hole') {
        const r = await call(worker, 'hole_wizard', { document_id: id, ...st.args }, signal); rec.feature = r.feature; rec.volume_mm3 = r.inspection?.volume_mm3;
      } else if (st.op === 'plane') {
        const r = await call(worker, 'ref_plane', { document_id: id, ...st.args }, signal); rec.feature = r.feature; planeIdx[st.id] = r.plane_index;
      } else {
        const of = st.refs.of.map(x => built.find(b => b.id === x)?.feature);
        const extra = st.op === 'mirror' && st.refs.plane_of ? { plane_index: planeIdx[st.refs.plane_of] } : {};
        const r = await call(worker, st.op, { document_id: id, features: of, ...st.args, ...extra }, signal); rec.feature = r.feature; rec.volume_mm3 = r.inspection.volume_mm3;
      }
      // material must go the right way: adding ops add volume, removing ops remove it
      if (num(rec.volume_mm3)) {
        const dv = rec.volume_mm3 - vol, adds = st.op === 'extrude' || (st.op === 'sweep' && !st.args.cut) || (st.op === 'revolve' && !st.args.cut) || st.op === 'linear_pattern' || st.op === 'circular_pattern' || st.op === 'mirror';
        const removes = st.op === 'cut' || (st.op === 'sweep' && st.args.cut) || (st.op === 'revolve' && st.args.cut) || st.op === 'hole' || st.op === 'shell' || st.op === 'fillet' || st.op === 'chamfer';
        rec.volume_change_mm3 = +dv.toFixed(4);
        if (adds && dv <= 1e-9 && st.op === 'extrude') throw new Error(`${st.id}: la extrusión no agregó material`);
        if (st.op === 'cut' && dv >= -1e-9) throw new Error(`${st.id}: el corte no quitó material (¿no toca la pieza o va al lado contrario?)`);
        if (st.op === 'hole' && dv >= -1e-9) throw new Error(`${st.id}: el taladro no quitó material`);
        if (removes && st.op !== 'fillet' && dv > 1e-9) log.push(`${st.id}: agregó material siendo una operación que quita`);
        vol = rec.volume_mm3;
      }
      rec.s = +((performance.now() - t0) / 1000).toFixed(2);
      built.push(rec);
    }
    const tm = performance.now();
    if (res.material?.name) await call(worker, 'set_material', { document_id: id, database: res.material.database ?? 'SOLIDWORKS Materials', material: res.material.name }, signal);
    // flex BEFORE linking: once a dimension has an equation, part_flex (rightly) leaves it alone
    let flex = null;
    if (args.flex_test) flex = await call(worker, 'part_flex', { document_id: id, ...(typeof args.flex_test === 'object' ? args.flex_test : {}) }, signal);
    const links = args.link_parameters === false ? null : await linkParameters(worker, id, res, built, signal);
    // one full rebuild at the end (each feature only rebuilt what changed): any rebuild error still stops the part here
    const ins = await call(worker, 'verify_rebuild', { document_id: id }, signal);
    const rows = checkExpect(res.expect, ins, res.material?.name);
    const ok = rows.every(r => r.ok) && (!flex || !(flex.summary?.fragile?.length));
    const finish_s = +((performance.now() - tm) / 1000).toFixed(2);
    // reuse: save now and remember this IR -> file (only a part that passed every check)
    if (args.reuse && ok) {
      await call(worker, 'save', { document_id: id }, signal);
      const p = ins.path || join(root ?? fileURLToPath(new URL('./generated', import.meta.url)), name);
      if (p && existsSync(p)) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(join(cacheDir, key + '.json'), JSON.stringify({ path: p, size: statSync(p).size, sha256: fileHash(p), checks: rows, volume_mm3: ins.volume_mm3, material: ins.material ?? null })); }
    }
    const mrow = rows.find(r => r.check === 'mass_g' && !r.ok && r.model);
    const mass_hint = mrow && num(ins.density_kg_m3) && ins.density_kg_m3 > 0 ? (() => { const dv = (mrow.model - mrow.expected) / (ins.density_kg_m3 * 1e-6);
      return { volume_delta_mm3: +dv.toFixed(1), meaning: dv > 0 ? 'sobra material' : 'falta material', suspects: built.filter(f => num(f.volume_change_mm3) && Math.abs(f.volume_change_mm3) > 0).map(f => ({ id: f.id, op: f.op, volume_change_mm3: f.volume_change_mm3, ratio: +(Math.abs(dv) / Math.abs(f.volume_change_mm3)).toFixed(3) })).filter(f => f.ratio >= 0.02 && f.ratio <= 1.2).sort((a, b) => { const m = f => Math.sign(f.volume_change_mm3) === Math.sign(dv) ? 0 : 1, k = f => Math.abs(Math.log(f.ratio * 5)); return m(a) - m(b) || k(a) - k(b); }).slice(0, 5),
        note: 'Operaciones cuyo volumen es del orden de la diferencia: revisa en el plano sus cotas (desde dónde se mide, plano medio o un lado, radio interior o exterior).' }; })() : null;
    return { ok, document_id: id, part: name, ...(args.reuse && ok && ins.path ? { path: ins.path } : {}), saved: !!(args.reuse && ok), ...(mass_hint ? { mass_hint } : {}), features: built, checks: rows, finish_s, parameters: links, flex, warnings: [...res.warnings, ...log],
      note: 'Unsaved until sw_save. Every parameter is a SolidWorks global variable; linked dimensions follow it (edit with action edit or in SolidWorks Equations).' };
  } catch (e) {
    return { ok: false, document_id: id, part: name, failed_at: built.length < res.steps.length ? res.steps[built.length].id : null, error: e.message, safe_edit: e.safe_edit, features: built,
      note: 'The part is open and unsaved with the steps that succeeded (an IR build is not rolled back step by step: light_guard). Fix the IR and build again with another part name (the unchanged parts are reused), or close it with discard_changes.' };
  }
  } finally { if (holdHere) worker.call('fast_hold', { on: false }).catch(() => null); }
}
