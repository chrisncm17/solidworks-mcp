import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { builtinKit, fastenerFaces, fastenerSpec } from './fasteners.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const vector = v => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = v => typeof v === 'string' && v.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const simpleFile = v => text(v) && !/[\\/:*?"<>|\x00-\x1f]/.test(v) && !/[. ]$/.test(v);
const lengths = ['mm', 'cm', 'm', 'in'];
const masses = ['g', 'kg', 'lb'];
const mateCounts = { coincident: 2, concentric: 2, distance: 2, parallel: 2, perpendicular: 2, angle: 2, symmetric: 3, width: 4, screw: 2, tangent: 2 };

export function validAssemblyTransform(t) {
  if (!Array.isArray(t) || t.length !== 16 || !t.every(finite) || Math.abs(t[12] - 1) > 1e-6 || t.slice(13).some(x => Math.abs(x) > 1e-9)) return false;
  const dot = (i, j) => t.slice(i, i + 3).reduce((s, x, k) => s + x * t[j + k], 0);
  if ([0, 3, 6].some(i => Math.abs(dot(i, i) - 1) > 1e-6) || [[0, 3], [0, 6], [3, 6]].some(([i, j]) => Math.abs(dot(i, j)) > 1e-6)) return false;
  return Math.abs(t[0] * (t[4] * t[8] - t[5] * t[7]) - t[1] * (t[3] * t[8] - t[5] * t[6]) + t[2] * (t[3] * t[7] - t[4] * t[6]) - 1) <= 1e-6;
}


// v3.7 mates by intention (read off the drawing, no coordinates). Each expands to ordinary mates:
//  insert: {intent:'insert', shaft:{component, diameter_mm, ...find}, hole:{component, diameter_mm, ...find},
//           seat?:{a:{component, normal, ...find}, b:{component, normal, ...find}}}  -> concentric + coincident anti_aligned (seat to seat)
//  face_to_face: {intent, a, b} -> coincident anti_aligned (faces touching)   flush: -> coincident aligned (faces level)
//  coaxial: {intent, a, b} -> concentric only
// a/b/shaft/hole are {component, ...find fields} or a ready entity ({component, plane} / {assembly_plane} / {component, local_point_mm, kind}).
const findKeys = ['kind', 'diameter_mm', 'axis', 'normal', 'offset_mm', 'near_mm', 'index', 'tol_mm'];
function intentEntity(x, kind) {
  if (!object(x)) return x;
  if (x.plane || x.assembly_plane || x.local_point_mm || x.find || x.unsupported) return x;
  const find = Object.fromEntries(Object.entries(x).filter(([k]) => findKeys.includes(k)));
  if (kind && !find.kind) find.kind = kind;
  return { component: x.component, find };
}

// v3.7 repeats ("6 tornillos en los 6 barrenos", the drawing says (6x)):
//  component {id:'T', file, count:6}            -> T1..T6
//  mate {..., repeat:6} (or intent with repeat)  -> 6 copies; in component ids "#" becomes 1..6 ('T#' -> T1..T6),
//                                                   and find.index '#' becomes 0..5 (a different hole each time)
function subst(x, k) {
  if (Array.isArray(x)) return x.map(v => subst(v, k));
  if (object(x)) return Object.fromEntries(Object.entries(x).map(([key, v]) => [key, key === 'index' && v === '#' ? k - 1 : subst(v, k)]));
  return typeof x === 'string' ? x.replace(/#/g, String(k)) : x;
}
export function expandRepeats(plan) {
  if (!object(plan) || !Array.isArray(plan.components) || !Array.isArray(plan.mates)) return plan;
  const components = [];
  // v3.7 review: count/repeat must be integers >= 1 (0, negative or fractional used to pass silently as one item)
  const bad = v => v !== undefined && !(Number.isInteger(v) && v >= 1);
  for (const c of plan.components ?? []) {
    if (object(c) && bad(c.count)) components.push({ ...c, unsupported: `count debe ser entero >= 1 (${c.count})` });
    else if (object(c) && c.count > 1) for (let k = 1; k <= c.count; k++) { const { count, ...rest } = c; components.push({ ...rest, id: c.id + k }); }
    else if (object(c) && c.count === 1) { const { count, ...rest } = c; components.push(rest); }
    else components.push(c);
  }
  const mates = [];
  for (const m of plan.mates ?? []) {
    if (object(m) && bad(m.repeat)) mates.push({ ...m, invalid: `repeat debe ser entero >= 1 (${m.repeat})` });
    // v3.8: the copy number is appended AFTER the # substitution (it used to become "insert 11" instead of "insert #1")
    else if (object(m) && m.repeat !== undefined) for (let k = 1; k <= m.repeat; k++) { const { repeat, ...rest } = m; mates.push({ ...subst(rest, k), name: (m.name ? subst(m.name, k) : (m.intent ?? m.type)) + ' #' + k }); }
    else mates.push(m);
  }
  return { ...plan, components, mates };
}

// v3.8 kits: a set that repeats (tornillo+rondana+tuerca, rueda+balero+tapon) written once.
//  plan.kits: {perno_m8: {components:[{id,file|make}], mates:[... '@hole', '@head_side' ...]}}
//  mates: {use:'perno_m8', at:{hole:{component,find}, head_side:..., nut_side:...}, repeat:4, material?, prefix?}
//  Each copy k gets component ids <prefix><k>_<id>; '@slot' takes at[slot] ('#' and index '#' as in repeat). A kit not in
//  plan.kits comes from generated\kits\<name>.json (plan._loaded_kits, read by the build) or a built-in tornilleria_M8x30.
export const KIT_NAME = /^[A-Za-z0-9_-]{1,60}$/;
const ID_KEYS = new Set(['component', 'bolt', 'washer', 'nut', 'nut_washer']);
function renameIds(x, map) {
  if (Array.isArray(x)) return x.map(v => renameIds(v, map));
  if (!object(x)) return x;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ID_KEYS.has(k) && typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : renameIds(v, map)]));
}
function fillSlots(x, at) {
  if (typeof x === 'string' && x.startsWith('@')) { const s = x.slice(1); return Object.hasOwn(at, s) ? structuredClone(at[s]) : { unsupported: `falta at.${s}` }; }
  if (Array.isArray(x)) return x.map(v => fillSlots(v, at));
  return object(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillSlots(v, at)])) : x;
}
export function expandKits(plan) {
  if (!object(plan) || !Array.isArray(plan.mates) || !plan.mates.some(m => object(m) && m.use !== undefined)) return plan;
  const components = [...(Array.isArray(plan.components) ? plan.components : [])], mates = [];
  for (const u of plan.mates) {
    if (!object(u) || u.use === undefined) { mates.push(u); continue; }
    const fail = why => mates.push({ name: `use ${u.use}`, invalid: why });
    const kit = !text(u.use) || !KIT_NAME.test(u.use) ? null : (object(plan.kits) && plan.kits[u.use]) || plan._loaded_kits?.[u.use] || builtinKit(u.use, u.material);
    if (!object(kit)) { fail(`kit desconocido "${u.use}": defínelo en plan.kits, guárdalo en generated\\kits o usa uno integrado (tornilleria_M8x30, tornillo_tuerca_M8x30, tornillo_rondana_M8x30, tornillo_M8x30)`); continue; }
    const n = u.repeat ?? u.count ?? 1;
    if (!(Number.isInteger(n) && n >= 1)) { fail(`repeat debe ser entero >= 1 (${n})`); continue; }
    if (!Array.isArray(kit.components) || !kit.components.length || !Array.isArray(kit.mates)) { fail('el kit necesita components y mates'); continue; }
    if (kit.mates.some(m => object(m) && (m.repeat !== undefined || m.use !== undefined))) { fail('un kit no lleva repeat ni use dentro (repite el use)'); continue; }
    if (u.at !== undefined && !object(u.at)) { fail('at: objeto {hole, head_side, ...}'); continue; }
    const prefix = u.prefix ?? u.use;
    for (let k = 1; k <= n; k++) {
      const map = Object.fromEntries(kit.components.map(c => [c.id, `${prefix}${k}_${c.id}`]));
      for (const c of kit.components) {
        const cc = structuredClone(c); cc.id = map[c.id];
        if (u.material && object(cc.make) && cc.make.material === undefined) cc.make.material = u.material;
        components.push(cc);
      }
      const at = subst(u.at ?? {}, k);
      for (const m of kit.mates) {
        const mm = renameIds(fillSlots(structuredClone(m), at), map);
        mm.name = `${u.name ?? prefix} #${k}` + (m.name ? ` ${m.name}` : '');
        for (const f of ['suppressed', 'lock_rotation']) if (u[f] !== undefined && mm[f] === undefined) mm[f] = u[f];
        mates.push(mm);
      }
    }
  }
  return { ...plan, components, mates };
}

// v3.8 components {id, make:{type:'bolt'|'washer'|'nut', size, length_mm, material}} -> generated ISO part (file filled in)
function applyMake(plan) {
  if (!object(plan) || !Array.isArray(plan.components) || !plan.components.some(c => object(c) && c.make !== undefined)) return plan;
  return { ...plan, components: plan.components.map(c => {
    if (!object(c) || c.make === undefined) return c;
    const s = fastenerSpec(c.make);
    if (s.errors.length) return { ...c, unsupported: s.errors.join('; ') };
    if (c.file !== undefined && c.file !== s.file) return { ...c, unsupported: `file ${c.file} no coincide con make (${s.file}); quita file` };
    return { ...c, file: s.file };
  }) };
}

// v3.8 fastener: tornilleria en UNA linea. {intent:'fastener', bolt, washer?, nut?, nut_washer?, size?, hole, head_side, nut_side}
//  -> rondana: asiento contra head_side + coaxial; tornillo: cabeza contra la rondana (o head_side) + coaxial;
//     rondana de tuerca: contra nut_side + coaxial; tuerca: contra nut_side (o su rondana) + coaxial.
// bolt/washer/nut are component ids (generated parts: faces known) or {component, shank|head|bore|bottom|top: find fields}.
// Faces touching: coincident anti_aligned (the side follows the outward normals); coaxial: concentric 'closest' AFTER the seat,
// so its direction follows the seat instead of contradicting it.
function expandFastener(m, comps, x) {
  const n = m.name ?? 'fastener', out = [], warnings = [];
  const bad = why => [{ name: n, invalid: why }];
  if (!m.bolt) return bad('fastener: falta bolt (tornillo)');
  if (!m.hole) return bad('fastener: falta hole (barreno: {component, find:{kind:"cylinder", diameter_mm, index}})');
  if (!m.head_side) return bad('fastener: falta head_side (cara donde apoya la cabeza o la rondana)');
  if ((m.nut || m.nut_washer) && !m.nut_side) return bad('fastener: con nut falta nut_side (cara donde apoya la tuerca)');
  const part = (spec, type) => {
    const id = typeof spec === 'string' ? spec : spec?.component, c = comps.find(q => object(q) && q.id === id);
    const size = m.size ?? c?.make?.size, faces = fastenerFaces(type === 'bolt' && c?.make?.type === 'countersunk' ? 'countersunk' : type, size);
    if (!c?.make && !object(spec)) warnings.push(`${n}: ${id} no es tornilleria generada (make); se asume su eje en +Y con la cara de apoyo en el origen. Si no, da sus caras: {component, ${type === 'bolt' ? 'shank, head' : 'bore, bottom, top'}}`);
    if (type === 'washer' && !size && !spec?.bore) warnings.push(`${n}: la rondana ${id} tiene dos cilindros; da size (M8) o bore`);
    return which => object(spec) && spec[which] ? intentEntity({ component: id, ...spec[which] }, faces[which]?.kind) : { component: id, find: { ...faces[which] } };
  };
  const seat = (what, a, b) => ({ name: `${n} (${what} asiento)`, type: 'coincident', align: 'anti_aligned', _intent: true, ...(x.suppressed !== undefined ? { suppressed: x.suppressed } : {}), entities: [a, b] });
  // align left out = closest in the build (an explicit closest is refused by check)
  const axis = (what, a, b) => ({ name: `${n} (${what} coaxial)`, type: 'concentric', ...(m.align ? { align: m.align } : {}), _intent: true, ...x, entities: [a, b] });
  const hole = intentEntity(m.hole, 'cylinder'), headSide = intentEntity(m.head_side, 'plane');
  let boltSeat = headSide;
  if (m.washer) { const W = part(m.washer, 'washer'); out.push(seat('rondana', W('bottom'), headSide), axis('rondana', W('bore'), hole)); boltSeat = W('top'); }
  const B = part(m.bolt, 'bolt');
  // v3.8 countersunk (ISO 10642): its head top goes FLUSH with the plate face (coincident aligned), it does not sit on it
  const csk = comps.find(q => object(q) && q.id === (typeof m.bolt === 'string' ? m.bolt : m.bolt?.component))?.make?.type === 'countersunk';
  out.push(csk ? { ...seat('tornillo', B('head'), boltSeat), name: `${n} (tornillo al ras)`, align: 'aligned' } : seat('tornillo', B('head'), boltSeat), axis('tornillo', B('shank'), hole));
  if (m.nut || m.nut_washer) {
    let nutSeat = intentEntity(m.nut_side, 'plane');
    if (m.nut_washer) { const NW = part(m.nut_washer, 'washer'); out.push(seat('rondana de tuerca', NW('bottom'), nutSeat), axis('rondana de tuerca', NW('bore'), hole)); nutSeat = NW('top'); }
    if (m.nut) { const N = part(m.nut, 'nut'); out.push(seat('tuerca', N('bottom'), nutSeat), axis('tuerca', N('bore'), hole)); }
  }
  if (warnings.length) out[0]._warnings = warnings;
  return out;
}

export function expandIntents(plan) {
  plan = applyMake(expandRepeats(expandKits(plan)));
  if (!object(plan) || !Array.isArray(plan.mates)) return plan;
  const mates = [];
  for (const m of plan.mates) {
    if (!object(m) || !m.intent || m.invalid) { mates.push(m); continue; }
    const n = m.name ?? m.intent;
    // v3.7 review: suppressed / lock_rotation of the intent go to every mate it produces
    const x = Object.fromEntries(['suppressed', 'lock_rotation'].filter(k => m[k] !== undefined).map(k => [k, m[k]]));
    if (m.intent === 'fastener') mates.push(...expandFastener(m, plan.components ?? [], x));
    else if (m.intent === 'insert') {
      mates.push({ name: n + ' (concéntrica)', type: 'concentric', align: m.align ?? 'aligned', ...x, entities: [intentEntity(m.shaft, 'cylinder'), intentEntity(m.hole, 'cylinder')] });
      if (m.seat) mates.push({ name: n + ' (asiento)', type: 'coincident', align: 'anti_aligned', ...(m.suppressed !== undefined ? { suppressed: m.suppressed } : {}), entities: [intentEntity(m.seat.a, 'plane'), intentEntity(m.seat.b, 'plane')] });
    } else if (m.intent === 'face_to_face' || m.intent === 'flush') {
      mates.push({ name: n, type: 'coincident', align: m.intent === 'flush' ? 'aligned' : 'anti_aligned', ...x, entities: [intentEntity(m.a, 'plane'), intentEntity(m.b, 'plane')] });
    } else if (m.intent === 'coaxial') {
      mates.push({ name: n, type: 'concentric', align: m.align ?? 'aligned', ...x, entities: [intentEntity(m.a, 'cylinder'), intentEntity(m.b, 'cylinder')] });
    } else mates.push({ ...m, type: 'unsupported_intent:' + m.intent });
  }
  return { ...plan, mates };
}
export function checkAssemblyPlan(plan) {
  plan = expandIntents(plan);
  const errors = [], warnings = [];
  if (!object(plan)) return { ok: false, errors: ['plan: objeto assembly-ir/1 requerido'], warnings };
  if (plan.ir !== 'assembly-ir/1') errors.push('ir: debe ser assembly-ir/1');
  if (!simpleFile(plan.name) || plan.name.length > 120 || /\.(sldasm|sldprt)$/i.test(plan.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(plan.name)) errors.push('name: nombre simple sin extensión');
  const components = Array.isArray(plan.components) ? plan.components : [];
  const mates = Array.isArray(plan.mates) ? plan.mates : [];
  if (!components.length) errors.push('components: necesita al menos un componente');
  if (!Array.isArray(plan.mates)) errors.push('mates: debe ser un array');
  const ids = new Set();
  components.forEach((c, i) => {
    const w = `components[${i}]`;
    if (!object(c)) { errors.push(`${w}: objeto requerido`); return; }
    if (!text(c.id) || ids.has(c.id)) errors.push(`${w}.id: ausente o repetido`);
    ids.add(c.id);
    if (c.unsupported) errors.push(`${w}: unsupported: ${c.unsupported}`);
    else if (!simpleFile(c.file) || !/\.sld(prt|asm)$/i.test(c.file)) errors.push(`${w}.file: nombre de archivo SLDPRT/SLDASM sin ruta (o make para tornilleria)`);
    if (c.fixed !== undefined && typeof c.fixed !== 'boolean') errors.push(`${w}.fixed: boolean requerido`);
    if (c.position_mm !== undefined && !vector(c.position_mm)) errors.push(`${w}.position_mm: vector de 3 números finitos`);
    if (c.transform !== undefined && !validAssemblyTransform(c.transform)) errors.push(`${w}.transform: rotación rígida ArrayData 16 (SI) requerida`);
    if (c.transform && vector(c.position_mm) && c.position_mm.some((v, k) => Math.abs(v - c.transform[9 + k] * 1000) > 1e-6)) errors.push(`${w}: position_mm contradice transform`);
    if (c.configuration !== undefined && !text(c.configuration)) errors.push(`${w}.configuration: nombre requerido`);
  });
  mates.forEach((m, i) => {
    const w = `mates[${i}] ${m?.name ?? ''}`;
    if (!object(m)) { errors.push(`${w}: objeto requerido`); return; }
    if (m.invalid) { errors.push(`${w}: ${m.invalid}`); return; }
    if (!Object.hasOwn(mateCounts, m.type)) errors.push(`${w}.type: no soportado (${m.type}, ${m.type_number ?? ''})`);
    if (!Array.isArray(m.entities) || m.entities.length !== mateCounts[m.type]) errors.push(`${w}.entities: ${mateCounts[m.type] ?? '2–4'} entidades requeridas`);
    if (Array.isArray(m._warnings)) warnings.push(...m._warnings);
    // fastener coaxials are 'closest' on purpose: created after their seat, they follow it
    if (m.align === undefined || m.align === 'closest') { if (!(m._intent && m.type === 'concentric')) warnings.push(`${w}: usar align explícito aligned/anti_aligned; closest depende de la posición inicial`); }
    else if (!['aligned', 'anti_aligned'].includes(m.align)) errors.push(`${w}.align: aligned|anti_aligned|closest`);
    for (const flag of ['flip', 'suppressed', 'lock_rotation']) if (m[flag] !== undefined && typeof m[flag] !== 'boolean') errors.push(`${w}.${flag}: boolean requerido`);
    for (const [type, field, max] of [['distance', 'distance_mm', 10000], ['angle', 'angle_deg', 360], ['screw', 'pitch_mm', 1000]]) {
      if ((m.type === type || m[field] !== undefined) && (!finite(m[field]) || m[field] < 0 || m[field] > max || (type === 'screw' && m[field] === 0))) errors.push(`${w}.${field}: valor válido requerido para ${type}`);
    }
    for (const [j, e] of (Array.isArray(m.entities) ? m.entities : []).entries()) {
      const ew = `${w}.entities[${j}]`;
      if (!object(e)) { errors.push(`${ew}: objeto requerido`); continue; }
      if (e.unsupported || e.kind === 'unsupported') { errors.push(`${ew}: unsupported: ${e.reason ?? e.unsupported}`); continue; }
      if (e.component !== undefined && !ids.has(e.component)) errors.push(`${ew}: componente inexistente ${e.component}`);
      const plane = text(e.component) && text(e.plane) && e.local_point_mm === undefined && e.assembly_plane === undefined;
      const assembly = text(e.assembly_plane) && e.component === undefined && e.plane === undefined && e.local_point_mm === undefined;
      const geom = text(e.component) && vector(e.local_point_mm) && ['face', 'edge'].includes(e.kind) && e.plane === undefined && e.assembly_plane === undefined;
      const find = text(e.component) && object(e.find) && e.local_point_mm === undefined && e.plane === undefined && e.assembly_plane === undefined;
      if (find) {
        const f = e.find, kind = f.kind ?? (f.diameter_mm !== undefined ? 'cylinder' : 'plane');
        if (!['cylinder', 'plane'].includes(kind)) errors.push(`${ew}.find.kind: cylinder|plane`);
        if (kind === 'cylinder' && f.diameter_mm !== undefined && !(finite(f.diameter_mm) && f.diameter_mm > 0)) errors.push(`${ew}.find.diameter_mm: > 0`);
        for (const k of ['normal', 'axis', 'near_mm']) if (f[k] !== undefined && !vector(f[k])) errors.push(`${ew}.find.${k}: vector de 3 números`);
        if (f.index !== undefined && !(Number.isInteger(f.index) && f.index >= 0)) errors.push(`${ew}.find.index: entero >= 0`);
        if (kind === 'plane' && f.normal === undefined && f.offset_mm === undefined) warnings.push(`${ew}: find de plano sin normal ni offset_mm; probablemente será ambiguo`);
      }
      if (!(plane || assembly || geom || find) || e.point_mm !== undefined) errors.push(`${ew}: {component,plane}, {assembly_plane}, {component,local_point_mm,kind:face|edge} o {component,find:{kind,diameter_mm|normal,...}}`);
    }
  });
  const systems = plan.coordinate_systems ?? [];
  if (!Array.isArray(systems)) errors.push('coordinate_systems: array requerido');
  const csNames = new Set();
  for (const [i, cs] of (Array.isArray(systems) ? systems : []).entries()) {
    const w = `coordinate_systems[${i}]`;
    if (!object(cs) || !vector(cs.origin_mm) || !vector(cs.x_axis) || !vector(cs.y_axis)) { errors.push(`${w}: origin_mm, x_axis, y_axis de 3 números`); continue; }
    if (cs.name !== undefined && (!text(cs.name) || csNames.has(cs.name) || /^#\d+$/.test(cs.name))) errors.push(`${w}.name: alias único (reservado #n)`);
    if (cs.name) csNames.add(cs.name);
    const dot = cs.x_axis.reduce((s, v, j) => s + v * cs.y_axis[j], 0);
    if (Math.abs(Math.hypot(...cs.x_axis) - 1) > 1e-6 || Math.abs(Math.hypot(...cs.y_axis) - 1) > 1e-6 || Math.abs(dot) > 1e-6) errors.push(`${w}: ejes unitarios y perpendiculares requeridos`);
  }
  if (plan.units !== undefined) {
    const u = plan.units;
    if (!object(u) || !['mm', 'cm', 'm', 'in', 'ft'].includes(u.mass_length) || !['mg', ...masses].includes(u.mass) || !['mm3', 'cm3', 'm3', 'in3', 'ft3'].includes(u.volume) || !Number.isInteger(u.decimals) || u.decimals < 0 || u.decimals > 8) errors.push('units: mass_length, mass, volume y decimals (0–8) requeridos');
  }
  const ex = plan.expect ?? {};
  if (!object(ex)) errors.push('expect: objeto requerido');
  if (ex.mates !== undefined && (!Number.isInteger(ex.mates) || ex.mates < 0)) errors.push('expect.mates: entero >= 0');
  if (ex.mass !== undefined && (!object(ex.mass) || !finite(ex.mass.value) || ex.mass.value <= 0 || !masses.includes(ex.mass.units))) errors.push('expect.mass: {value positivo, units:g|kg|lb}');
  if (ex.com !== undefined && !Array.isArray(ex.com)) errors.push('expect.com: array requerido');
  for (const [i, cm] of (Array.isArray(ex.com) ? ex.com : []).entries()) {
    if (!object(cm) || !vector(cm.value) || !lengths.includes(cm.length_units)) { errors.push(`expect.com[${i}]: value y length_units requeridos`); continue; }
    const n = /^#[1-9]\d*$/.test(cm.coordinate_system) ? Number(cm.coordinate_system.slice(1)) : 0;
    if (!csNames.has(cm.coordinate_system) && !(n >= 1 && n <= systems.length) && !(plan.auto_origins && n >= 1 && n <= ex.com.length && !systems.length)) errors.push(`expect.com[${i}]: coordinate_system desconocido ${cm.coordinate_system}`);
  }
  if (ex.interferences_mm3 !== undefined && (!Array.isArray(ex.interferences_mm3) || ex.interferences_mm3.some(v => !finite(v) || v < 0))) errors.push('expect.interferences_mm3: array de volúmenes >= 0');
  // v3.8 (Codex review): symmetric and patterns are validated here, not after the components and mates were built
  if (ex.symmetric !== undefined && (!Array.isArray(ex.symmetric) || !ex.symmetric.length || ex.symmetric.some(a => !['x', 'y', 'z'].includes(a)) || new Set(ex.symmetric).size !== ex.symmetric.length)) errors.push('expect.symmetric: ["x","y","z"] sin repetir');
  if (plan.patterns !== undefined && !Array.isArray(plan.patterns)) errors.push('patterns: array requerido');
  for (const [i, p] of (Array.isArray(plan.patterns) ? plan.patterns : []).entries()) {
    const w = `patterns[${i}]`, ref = p?.[p?.kind === 'circular' ? 'axis' : 'direction'];
    if (!object(p) || !['linear', 'circular'].includes(p.kind)) { errors.push(`${w}: kind linear|circular`); continue; }
    if (!Array.isArray(p.seeds) || !p.seeds.length || p.seeds.some(s => !ids.has(s)) || new Set(p.seeds).size !== p.seeds.length) errors.push(`${w}: seeds = array de ids de components sin repetir (${Array.isArray(p.seeds) ? p.seeds.filter(s => !ids.has(s)).join(', ') || 'vacío o repetido' : 'no es array'})`);
    for (const k of ['inside', 'reverse', 'flip']) if (p[k] !== undefined && typeof p[k] !== 'boolean') errors.push(`${w}.${k}: boolean`);
    if (p.kind === 'linear' && object(ref) && ref.kind !== 'edge') errors.push(`${w}: direction.kind debe ser edge (arista recta) en un patrón lineal`);
    if (!Number.isInteger(p.count) || p.count < 2 || p.count > 500) errors.push(`${w}: count entero de 2 a 500 (incluye las semillas)`);
    if (!object(ref) || !ids.has(ref.component) || !vector(ref.local_point_mm) || !['face', 'edge'].includes(ref.kind)) errors.push(`${w}: ${p.kind === 'circular' ? 'axis' : 'direction'} {component, local_point_mm, kind:face|edge} requerido`);
    if (p.kind === 'linear' && !(finite(p.spacing_mm) && p.spacing_mm > 0)) errors.push(`${w}: spacing_mm > 0 requerido`);
    if (p.kind === 'circular' && p.total_angle_deg !== undefined && !(finite(p.total_angle_deg) && p.total_angle_deg > 0 && p.total_angle_deg <= 360)) errors.push(`${w}: total_angle_deg de 0 a 360`);
  }
  if (Array.isArray(plan.warnings)) warnings.push(...plan.warnings);
  return { ok: !errors.length, errors, warnings };
}

// Maximum bipartite matching preserves multiplicity, including overlapping tolerance intervals.
export function compareInterferences(actual, expected) {
  if (![actual, expected].every(v => Array.isArray(v) && v.every(x => finite(x) && x >= 0))) throw new Error('Interferencias: volúmenes finitos >= 0 requeridos');
  const matched = new Map();
  function match(e, visited) {
    for (let a = 0; a < actual.length; a++) {
      if (visited.has(a) || Math.abs(actual[a] - expected[e]) > Math.max(0.05, expected[e] * 0.01) + 1e-12) continue;
      visited.add(a);
      if (!matched.has(a) || match(matched.get(a), visited)) { matched.set(a, e); return true; }
    }
    return false;
  }
  expected.forEach((_, e) => match(e, new Set()));
  const used = new Set(matched.values());
  return [
    ...expected.flatMap((value, index) => used.has(index) ? [] : [{ quantity: 'interference_missing_mm3', index, expected: value }]),
    ...actual.flatMap((value, index) => matched.has(index) ? [] : [{ quantity: 'interference_extra_mm3', index, actual: value }]),
  ];
}

// v3.7: a mate that cannot be reproduced (an entity exported as "unsupported", e.g. a circle of assembly-level geometry) and that
// touches ONE component only just anchors that component: drop the mate, insert that component FIXED at its exported transform.
// The geometry is identical; the replacement is reported. Mates between two components are never replaced (they would fail).
export function replaceUnsupportedMates(plan) {
  const out = structuredClone(plan), replaced = [];
  out.mates = (plan.mates || []).filter(m => {
    const ents = m.entities || [];
    const bad = ents.filter(e => e && e.kind === 'unsupported');
    if (!bad.length) return true;
    // v3.7 review: only a proven, ACTIVE anchor to the assembly itself (owner "assembly", from sw_assembly_ir export). A
    // reference of unknown owner may be the second part of a mate between two parts; a suppressed mate never fixes anything.
    if (m.suppressed || !bad.every(e => e.owner === 'assembly')) return true;
    const comps = [...new Set(ents.filter(e => e && e.component).map(e => e.component))];
    const c = comps.length === 1 ? out.components.find(x => x.id === comps[0]) : null;
    if (!c || !c.transform) return true;
    c.fixed = true; replaced.push({ mate: m.name ?? m.type, component: c.id, reason: ents.find(e => e.kind === 'unsupported').reason });
    return false;
  });
  // a component fixed at its exact place makes its mates to the assembly planes/origin redundant (SolidWorks breaks them)
  const fixedNow = new Set(replaced.map(r => r.component));
  out.mates = out.mates.filter(m => {
    const comps = [...new Set((m.entities || []).filter(e => e && e.component).map(e => e.component))];
    if (comps.length === 1 && fixedNow.has(comps[0]) && (m.entities || []).every(e => e.component || e.assembly_plane)) {
      replaced.push({ mate: m.name ?? m.type, component: comps[0], reason: 'redundante: une la pieza fija solo con el ensamble' }); return false;
    }
    return true;
  });
  return { plan: out, replaced };
}

// v3.7 crash recovery: if the MCP's OWN SolidWorks (sw_instance dedicated) dies during a build, restart it (minimized) and run
// the plan once more under a new name. Never in shared mode: the user's SolidWorks is never restarted.
const CRASH = /RPC_E_|0x800706BA|0x80010108|desconect|disconnected|is not running|no est[aá] corriendo|still starting|servidor RPC/i;
// v3.8 one call for the whole exam: plan.parts (part-ir/1 list) are built first with reuse (an unchanged part costs 0 s),
// then the assembly, then optionally the drawing (args.drawing = sw_assembly_drawing options) and the answers
// (args.answers = sw_answer_sheet options, e.g. create). Each chat round trip costs more than the machine time it saves.
export async function assemblyBuild(args, ctx = {}) {
  const t0 = performance.now();
  let parts = null;
  // fast_hold: no SolidWorks idle gaps until the answers are out; released (not awaited) at the end, queued behind a
  // background drawing, so any deferred redraw happens there and never delays mass and CM
  const hold = on => args.action === 'build' && ctx.worker ? ctx.worker.call('fast_hold', { on }).catch(() => null) : null;
  // SW_MCP_PART_HOLD=0: hold only from the assembly on (A/B measurement of the hold during the parts)
  if (process.env.SW_MCP_PART_HOLD !== '0') await hold(true);
  try {
  if (Array.isArray(args.plan?.parts) && args.plan.parts.length) {
    const { partBuild } = await import('./part_ir.mjs');
    const plan = { ...args.plan, components: (args.plan.components ?? []).map(c => ({ ...c })) };
    parts = []; const built = new Map();
    for (const ir of args.plan.parts) {
      if (args.action !== 'build') { const ck = await partBuild({ action: 'check', ir }, ctx); parts.push({ part: ir?.part, ok: ck.ok, errors: ck.errors }); continue; }
      const tp = performance.now(), b = await partBuild({ action: 'build', ir, reuse: true, rebuild: args.reuse_parts === false, link_parameters: false, _held: true }, ctx);
      parts.push({ part: ir.part, s: +((performance.now() - tp) / 1000).toFixed(1), file: b.part, ok: b.ok, reused: !!b.reused, failed: (b.checks ?? []).filter(r => !r.ok), ...(b.error ? { error: b.error, failed_at: b.failed_at } : {}), ...(b.mass_hint ? { mass_hint: b.mass_hint } : {}) });
      if (b.document_id) try { await ctx.worker.call('close_document', { document_id: b.document_id, discard_changes: true }); } catch { }
      if (!b.ok) { hold(false); return { ok: false, verdict: 'fail', phase: 'parts', parts, note: 'Una pieza no pasó sus revisiones; corrige su IR (las demás se reusan en la siguiente llamada).' }; }
      built.set((ir.part + '.SLDPRT').toLowerCase(), { file: b.part, path: b.path });
    }
    if (parts.some(p => !p.ok)) { hold(false); return { ok: false, verdict: 'fail', phase: 'parts', parts }; }
    // v3.8 (Codex review): one pass over the ORIGINAL names (A->B and B->A swaps cannot chain); the built files are taken from
    // generated by their real path, never from a same-named file in parts_dir
    const genFiles = {};
    for (const c of plan.components) { const hit = built.get(String(c.file).toLowerCase()); if (hit) { c.file = hit.file; if (hit.path) genFiles[hit.file.toLowerCase()] = hit.path; } }
    delete plan.parts; args = { ...args, plan, generated_parts: genFiles };
  }
  } catch (e) { hold(false); throw e; }
  const tparts = performance.now(), ta = performance.now();
  if (process.env.SW_MCP_PART_HOLD === '0') await hold(true);
  let r;
  try { r = await assemblyBuildRetry(args, ctx); } catch (e) { hold(false); throw e; }
  if (parts) r.parts = parts;
  // v3.8: where the time went, in seconds (parts one by one, assembly, answers, drawing)
  const times = { parts_s: parts ? +((tparts - t0) / 1000).toFixed(1) : 0, assembly_s: +((performance.now() - ta) / 1000).toFixed(1) };
  if (args.action === 'build' && r.document_id && (args.drawing || args.answers)) {
    if (r.ok !== true) r.deliverables = 'No se hizo ni plano ni respuestas: el ensamble no pasó (corrige primero lo de arriba).';
    else {
      // answers first: the coordinate systems it creates must be saved and appear in the drawing
      const tq = performance.now();
      if (args.answers) { const { answerSheet } = await import('./answers.mjs');
        try { r.answers = await answerSheet({ ...args.answers, document_id: r.document_id }, ctx);
          if (r.answers?.created_systems?.length) { const sv = await ctx.worker.call('save', { document_id: r.document_id }); r.answers.systems_saved = !!sv.ok; if (!sv.ok) r.answers.ok = false; }
        } catch (e) { r.answers = { ok: false, error: e.message }; } }
      if (args.answers) times.answers_s = +((performance.now() - tq) / 1000).toFixed(1);
      if (args.drawing && r.answers?.ok !== false) { const { assemblyDrawing } = await import('./assembly_drawing.mjs');
        const { background, ...dopt } = args.drawing, name = dopt.name ?? 'Plano_' + args.plan.name, td = performance.now();
        const job = assemblyDrawing({ ...dopt, document_id: r.document_id, name }, ctx).then(x => x, e => ({ ok: false, error: e.message }))
          .then(x => { x.s = +((performance.now() - td) / 1000).toFixed(1); return x; });
        // background (default when answers are asked too): mass and CM (8 of 10 points) come back ~40 s earlier; the drawing
        // finishes on its own and sw_exam_ready (or any later SolidWorks call, which waits behind it) shows it
        if (background ?? !!args.answers) { trackJob('plano ' + name, job); r.drawing = { pending: true, name, note: 'El plano se está haciendo en segundo plano (~40 s). sw_exam_ready dice cuando termina y dónde quedó; cualquier llamada a SolidWorks espera a que acabe.' }; }
        else { r.drawing = await job; times.drawing_s = r.drawing.s; } }
      const bad = [['answers', r.answers], ['drawing', r.drawing]].filter(([, x]) => x && x.ok === false);
      if (bad.length) { r.assembly_ok = true; r.ok = false; r.verdict = 'fail'; r.phase = bad[0][0]; r.deliverables = `El ensamble pasó, pero falló: ${bad.map(([k, x]) => `${k} (${x.error ?? 'ver detalle'})`).join('; ')}.`; }
    }
  }
  hold(false);
  r.times = times;
  r.total_s = +((performance.now() - t0) / 1000).toFixed(1);
  return r;
}
// v3.8 background jobs (drawing after the answers, SolidWorks start while the chat reads the drawing): kept here until shown
const JOBS = new Map();
export function trackJob(label, promise) {
  const j = { label, started: new Date().toISOString(), done: false, result: null };
  j.promise = promise.then(x => { j.done = true; j.result = x; return x; }, e => { j.done = true; j.result = { ok: false, error: e.message }; });
  JOBS.set(label, j); return j;
}
export function backgroundJobs() { return [...JOBS.values()].map(({ promise, ...j }) => j); }
export async function waitBackground() { await Promise.all([...JOBS.values()].map(j => j.promise)); return backgroundJobs(); }
async function assemblyBuildRetry(args, ctx = {}) {
  const first = await assemblyBuildOnce(args, ctx);
  if (first.ok || args.action !== 'build' || args.retry_on_crash === false || !first.failures?.some(f => CRASH.test(f.error ?? ''))) return first;
  let mode = null; try { const s = await ctx.worker.call('instance', { action: 'status' }); mode = s.ok ? s.result.mode : null; } catch { }
  if (mode !== 'dedicated') return { ...first, recovery: 'SolidWorks se cayó; no se reinicia porque es el del usuario (modo shared).' };
  let st; try { st = await ctx.worker.call('instance', { action: 'start' }); } catch (e) { st = { ok: false, error: e.message }; }
  if (!st.ok) return { ...first, recovery: 'No se pudo reiniciar el SolidWorks del MCP: ' + st.error };
  const again = await assemblyBuildOnce({ ...args, plan: { ...args.plan, name: args.plan.name + '_r2' } }, ctx);
  return { ...again, recovery: `SolidWorks del MCP se cayó en el primer intento (${first.failures.find(f => CRASH.test(f.error ?? '')).error.slice(0, 120)}); se reinició (PID ${st.result.pid}) y se volvió a armar como ${args.plan.name}_r2.`, first_attempt: { failures: first.failures, timings_ms: first.timings_ms } };
}

// v3.8 kits on disk: generated\kits\<name>.json, read for every use not defined in the plan; save_kits writes plan.kits there
// (never replaces a different kit with the same name).
export function loadKits(plan, root) {
  if (!object(plan) || !Array.isArray(plan.mates) || !root) return plan;
  const loaded = {};
  for (const u of plan.mates) {
    if (!object(u) || !text(u.use) || !KIT_NAME.test(u.use) || (object(plan.kits) && plan.kits[u.use]) || loaded[u.use]) continue;
    const f = join(root, 'kits', u.use + '.json');
    if (existsSync(f)) loaded[u.use] = JSON.parse(readFileSync(f, 'utf8'));
  }
  return Object.keys(loaded).length ? { ...plan, _loaded_kits: loaded } : plan;
}
export function saveKits(plan, root) {
  const saved = [], refused = [];
  if (!object(plan?.kits)) return { saved, refused };
  const dir = join(root, 'kits'); mkdirSync(dir, { recursive: true });
  for (const [name, kit] of Object.entries(plan.kits)) {
    if (!KIT_NAME.test(name) || !object(kit) || !Array.isArray(kit.components) || !Array.isArray(kit.mates)) { refused.push({ name, reason: 'nombre (letras, números, _ o -) y components/mates requeridos' }); continue; }
    const f = join(dir, name + '.json'), body = JSON.stringify(kit, null, 1);
    if (existsSync(f) && readFileSync(f, 'utf8') !== body) { refused.push({ name, reason: `ya existe un kit distinto en ${f}; usa otro nombre` }); continue; }
    writeFileSync(f, body); saved.push(f);
  }
  return { saved, refused };
}

// v3.8: generate the ISO bolts/washers/nuts (components with make) that are not yet in generated, saved and closed.
// The geometry is built ONCE without material (ISO4017_M8x30.SLDPRT, ~12 s); a material version is a copy of it with the
// material set (a few seconds), so pre-built bases (sw_exam_ready prebuild) make every material fast.
export async function makeFasteners(plan, { worker, signal, root }) {
  const { partBuild } = await import('./part_ir.mjs');
  const made = [], seen = new Set();
  const ok = async (op, a, what) => { const r = await worker.call(op, a, { signal }); if (!r.ok) throw new Error(`${op} ${what}: ${r.error}`); return r.result; };
  for (const c of plan.components) {
    if (!object(c.make) || seen.has(c.file)) continue; seen.add(c.file);
    if (existsSync(join(root, c.file))) { made.push({ file: c.file, existing: true }); continue; }
    const t = performance.now();
    const { material, ...geom } = c.make, base = fastenerSpec(geom);
    if (!existsSync(join(root, base.file))) {
      const r = await partBuild({ action: 'build', ir: base.ir, link_parameters: false }, { worker, signal, root });
      if (!r.ok) throw new Error(`tornilleria ${base.file}: ${r.error ?? JSON.stringify(r.checks?.filter(x => !x.ok) ?? r.errors)}`);
      await ok('save', { document_id: r.document_id }, base.file); await ok('close_document', { document_id: r.document_id }, base.file);
      made.push({ file: base.file, built: true, s: +((performance.now() - t) / 1000).toFixed(1) });
    }
    if (material) {
      const t2 = performance.now();
      const id = (await ok('open_copy', { source: join(root, base.file), name: c.file }, c.file)).document_id;
      let saved = false;
      try {
        await ok('set_material', { document_id: id, database: 'SOLIDWORKS Materials', material }, c.file);
        await ok('save', { document_id: id }, c.file); saved = true;
      } finally {
        await worker.call('close_document', { document_id: id, discard_changes: true }, { signal });
        // never leave a copy WITHOUT its material under the material name (the next plan would reuse it)
        if (!saved) try { unlinkSync(join(root, c.file)); } catch { }
      }
      made.push({ file: c.file, copied_from: base.file, material, s: +((performance.now() - t2) / 1000).toFixed(1) });
    }
  }
  return made;
}

async function assemblyBuildOnce(args, { worker, signal, root } = {}) {
  let replacedMates = [], kitsSaved = null;
  if (args.plan && root) args = { ...args, plan: loadKits(args.plan, root) };
  if (args.save_kits && args.plan && root) kitsSaved = saveKits(args.plan, root);
  if (args.plan) args = { ...args, plan: expandIntents(args.auto_origins && typeof args.plan === "object" && args.plan ? { ...args.plan, auto_origins: true } : args.plan) };
  if (args.plan && args.fix_unsupported !== false) { const r = replaceUnsupportedMates(args.plan); args = { ...args, plan: r.plan }; replacedMates = r.replaced; }
  // v3.8 up: a part modeled with "up" along +Z (sketched on Alzado) makes every drawing view wrong (SolidWorks draws with +Y up).
  // component.up "+Z" etc. turns that (fixed) component so its up axis becomes the assembly +Y; the mates carry the rest.
  // Rows = where the component X, Y, Z axes go (same layout as the transforms sw_inspect returns).
  const UP = { '+Y': [1, 0, 0, 0, 1, 0, 0, 0, 1], '-Y': [1, 0, 0, 0, -1, 0, 0, 0, -1], '+Z': [1, 0, 0, 0, 0, -1, 0, 1, 0], '-Z': [1, 0, 0, 0, 0, 1, 0, -1, 0], '+X': [0, 1, 0, -1, 0, 0, 0, 0, 1], '-X': [0, -1, 0, 1, 0, 0, 0, 0, 1] };
  if (object(args.plan) && Array.isArray(args.plan.components) && args.plan.components.some(c => object(c) && c.up !== undefined)) {
    const bad = args.plan.components.filter(c => object(c) && c.up !== undefined && (!UP[c.up] || c.transform));
    if (bad.length) return { ok: false, verdict: 'fail', errors: bad.map(c => `${c.id}: up debe ser +X|-X|+Y|-Y|+Z|-Z y no va junto con transform`) };
    args = { ...args, plan: { ...args.plan, components: args.plan.components.map(c => object(c) && c.up !== undefined ? (({ up, ...rest }) => ({ ...rest, transform: [...UP[up], ...(vector(rest.position_mm) ? rest.position_mm.map(v => v / 1000) : [0, 0, 0]), 1, 0, 0, 0] }))(c) : c) } };
  }
  const checked = checkAssemblyPlan(args.plan);
  if (replacedMates.length) checked.warnings = [...(checked.warnings || []), ...replacedMates.map(r => `${r.mate}: no reproducible (${r.reason}); ${r.component} se fija en su posición exportada`)];
  if (!['check', 'build'].includes(args.action)) checked.errors.push('action: check|build');
  if (args.tolerance_percent !== undefined && (!finite(args.tolerance_percent) || args.tolerance_percent <= 0 || args.tolerance_percent > 50)) checked.errors.push('tolerance_percent: > 0 y <= 50');
  const expanded = object(args.plan) && Array.isArray(args.plan.components) && Array.isArray(args.plan.mates) ? { components: args.plan.components.length, mates: args.plan.mates.length, fasteners: [...new Set(args.plan.components.filter(c => object(c?.make)).map(c => c.file))] } : null;
  // v3.8: generated fasteners without material weigh with 1000 kg/m3 and change the mass silently (0.2 percent on the roller
  // conveyor); refuse before building unless the plan says allow_no_material: true
  if (object(args.plan) && Array.isArray(args.plan.components) && args.plan.allow_no_material !== true) {
    const bare = [...new Set(args.plan.components.filter(c => object(c?.make) && !c.make.material).map(c => c.file ?? c.id))];
    if (bare.length) checked.errors.push(`tornillería sin material (pesaría con 1000 kg/m3): ${bare.join(', ')}; da make.material (o material en el kit), o allow_no_material: true`);
  }
  if (checked.errors.length || args.action === 'check') return { ...checked, ok: !checked.errors.length, verdict: checked.errors.length ? 'fail' : 'checked', expanded, ...(kitsSaved ? { kits: kitsSaved } : {}) };
  const plan = args.plan, differences = [], suspects = [], timings = {}, moved = [], failures = [], components = new Map(), systems = new Map(), verification = { mass_checks: [] };
  const started = performance.now(); let phase = 'prepare', document_id, output, currentMate;
  const call = async (op, a) => {
    if (signal?.aborted) throw Object.assign(new Error('Solicitud cancelada'), { outcome_unknown: true });
    let r;
    try { r = await worker.call(op, a, { signal }); }
    catch (e) { e.outcome_unknown = true; throw e; }
    if (!r.ok) throw Object.assign(new Error(`${op}: ${r.error}`), { safe_edit: r.safe_edit, outcome_unknown: r.safe_edit?.save_blocked === true || r.safe_edit?.rollback_verified === false });
    return r.result;
  };
  const timed = async (name, f) => { phase = name; const t = performance.now(); try { return await f(); } finally { timings[name] = (timings[name] ?? 0) + performance.now() - t; } };
  const docCall = (op, a = {}) => call(op, { ...a, document_id });
  let fasteners = [];
  const report = () => ({ ok: !differences.length && !failures.length, verdict: differences.length || failures.length ? 'fail' : 'pass', document_id, path: output, timings_ms: { ...timings, total: performance.now() - started }, differences, suspects, failures, warnings: checked.warnings, verification, moved_components: moved, components: Object.fromEntries(components), coordinate_systems: Object.fromEntries(systems), expanded, ...(fasteners.length ? { fasteners } : {}), ...(kitsSaved ? { kits: kitsSaved } : {}) });
  try {
    let files;
    if (plan.components.some(c => object(c.make))) await timed('fasteners', async () => {
      if (!root || !isAbsolute(root)) throw new Error('root: carpeta generated absoluta requerida');
      if (existsSync(join(resolve(root, 'assemblies'), plan.name + '.SLDASM'))) throw new Error(`Nunca se sobrescribe: ${plan.name}.SLDASM`);
      fasteners = await makeFasteners(plan, { worker, signal, root });
    });
    await timed('prepare', async () => {
      if (!isAbsolute(args.parts_dir ?? '') || !statSync(args.parts_dir).isDirectory()) throw new Error('parts_dir: carpeta absoluta existente requerida');
      if (!root || !isAbsolute(root)) throw new Error('root: carpeta generated absoluta requerida');
      const parts = realpathSync(args.parts_dir), gen = realpathSync(root);
      files = plan.components.map(c => {
        // generated fasteners live in generated, whatever parts_dir is
        const g = args.generated_parts?.[String(c.file).toLowerCase()], base = object(c.make) || g ? gen : parts;
        const path = realpathSync(g ?? join(base, c.file)), rel = relative(base, path);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !statSync(path).isFile()) throw new Error(`Componente fuera de parts_dir: ${c.file}`);
        return path;
      });
      const folder = resolve(root, 'assemblies'); mkdirSync(folder, { recursive: true });
      // v3.7 review: the output folder must really be root\assemblies (no junction redirecting the new assembly elsewhere)
      if (realpathSync(folder).toLowerCase() !== join(realpathSync(root), 'assemblies').toLowerCase()) throw new Error('assemblies redirigida (junction): rechazado');
      output = join(folder, plan.name + '.SLDASM');
      if (existsSync(output)) throw new Error(`Nunca se sobrescribe: ${output}`);
    });
    await timed('assembly_new', async () => {
      const env = await call('environment', {});
      if (!text(env.default_assembly_template)) throw new Error('environment.default_assembly_template no disponible');
      const created = await call('assembly_new', { path: output, template: env.default_assembly_template });
      if (!text(created.document_id)) throw new Error('assembly_new no devolvió document_id');
      document_id = created.document_id;
    });
    if (args.batch !== false) {
      // v3.7: everything in ONE worker call (assembly_batch): one safe-edit check instead of two per item, no mass inspection per item
      await timed('batch', async () => {
        const comps = plan.components.map((c, i) => ({ id: c.id, path: files[i], fixed: c.fixed ?? false, ...(c.position_mm ? { position_mm: c.position_mm } : {}), ...(c.transform ? { transform: c.transform } : {}), ...(c.configuration ? { configuration: c.configuration } : {}) }));
        const ms = plan.mates.map(m => { const a = { type: m.type, align: m.align ?? 'closest', flip: m.flip ?? false, entities: m.entities.map(e => ({ ...e })) }; if (m.name) a.name = m.name; for (const k of ['distance_mm', 'angle_deg', 'pitch_mm', 'lock_rotation', 'suppressed']) if (m[k] !== undefined) a[k] = m[k]; return a; });
        // stop_on_error: the worker throws at the first failure, so the safe edit rolls the whole batch back (no partial assembly)
        // v3.8 defer_rebuild: one rebuild after the last mate instead of one per mate; every mate is still checked by name
        const r = await docCall('assembly_batch', { components: comps, mates: ms, stop_on_error: !args.continue_on_error, ...(args.defer_rebuild ? { defer_rebuild: true } : {}) });
        for (const c of r.components) components.set(c.id, c.component);
        for (const m of r.mates) { moved.push({ index: m.index, name: m.name, moved_components: m.moved_components ?? [] }); if (m.snapped?.length) (checked.warnings ??= []).push(...m.snapped.map(s => `${m.name ?? 'mate ' + m.index}: ${s}`)); }
        timings.components = r.timings_ms.components; timings.mates = r.timings_ms.mates; timings.mates_preflight = r.timings_ms.preflight; verification.find_ms = r.timings_ms.find_ms; verification.mate_ms = r.mates.map(m => m.ms);
        // continue_on_error: a failed insert/mate may have left something behind that nobody verified
        for (const f of r.failures) failures.push({ index: f.index ?? null, name: f.name ?? f.id ?? null, error: f.error, stage: f.stage, outcome_unknown: true });
        if (r.failures.length && !args.continue_on_error) throw new Error(r.failures[0].stage + ' ' + (r.failures[0].name ?? r.failures[0].id) + ': ' + r.failures[0].error);
      });
    } else {
      await timed('components', async () => {
        for (const [i, c] of plan.components.entries()) {
          const r = await docCall('insert_component', { path: files[i], fixed: c.fixed ?? false, ...(c.position_mm ? { position_mm: c.position_mm } : {}), ...(c.transform ? { transform: c.transform } : {}), ...(c.configuration ? { configuration: c.configuration } : {}) });
          if (!text(r.component) || [...components.values()].includes(r.component)) throw new Error(`insert_component: nombre real inválido para ${c.id}`);
          components.set(c.id, r.component);
          if (r.fixed_position !== (c.fixed ?? false)) throw new Error(`insert_component: fixed no coincide para ${c.id}`);
        }
      });
      await timed('mates', async () => {
        for (const [index, m] of plan.mates.entries()) {
          currentMate = { index, name: m.name ?? null };
          try {
            const a = { type: m.type, align: m.align ?? 'closest', flip: m.flip ?? false, entities: m.entities.map(e => e.component ? { ...e, component: components.get(e.component) } : { ...e }) };
            // v3.7 review: {component, find} resolved by the worker with the same rules as the batch path
            for (const [j, e] of a.entities.entries()) if (e.find) a.entities[j] = await docCall('find_faces', { component: e.component, find: e.find, resolve: true });
            for (const k of ['distance_mm', 'angle_deg', 'pitch_mm', 'lock_rotation']) if (m[k] !== undefined) a[k] = m[k];
            const r = await docCall('add_mate', a);
            moved.push({ ...currentMate, moved_components: r.moved_components ?? [] });
            if (r.snapped?.length) (checked.warnings ??= []).push(...r.snapped.map(s => `${m.name ?? 'mate ' + index}: ${s}`));
            if (r.error_code && !r.is_warning) throw new Error(`Mate creado con error ${r.error_code}`);
            if (m.suppressed) {
              if (!text(r.mate)) throw new Error('add_mate no devolvió el nombre necesario para suprimir');
              await docCall('mates', { action: 'suppress', names: [r.mate] });
            }
          } catch (e) {
            failures.push({ ...currentMate, error: e.message, safe_edit: e.safe_edit, outcome_unknown: !!e.outcome_unknown });
            if (!args.continue_on_error || e.outcome_unknown || signal?.aborted) throw e;
          }
        }
        currentMate = undefined;
      });
    }
    // v3.8 patterns: mate only the seeds and let a component pattern place the copies (24 pegs = 4 seeds x 2 mates + 1 pattern
    // instead of 48 mates). plan.patterns: [{kind:'circular'|'linear', seeds:[ids], count, axis|direction:{component:id,
    // local_point_mm, kind}, total_angle_deg | spacing_mm, reverse}]
    if ((plan.patterns ?? []).length) await timed('patterns', async () => {
      const real = id => { const n = components.get(id); if (!n) throw new Error(`patrón: componente desconocido ${id}`); return n; };
      verification.patterns = [];
      // a linear pattern that goes the wrong way builds fine and touches nothing (rollers outside the frame passed as "pass"):
      // every new instance origin must lie inside the box of the component origins that existed before the pattern
      const origins = async () => new Map(((await docCall('inspect', {})).components ?? []).filter(c => c.transform).map(c => [c.name, c.transform.slice(9, 12).map(v => v * 1000)]));
      for (const p of plan.patterns) {
        const a = { kind: p.kind, seeds: p.seeds.map(real), count: p.count };
        for (const k of ['spacing_mm', 'total_angle_deg', 'reverse']) if (p[k] !== undefined) a[k] = p[k];
        for (const k of ['axis', 'direction']) if (p[k]) a[k] = { ...p[k], component: real(p[k].component) };
        const before = await origins();
        verification.patterns.push(await docCall('component_pattern', a));
        const lo = [0, 1, 2].map(k => Math.min(...[...before.values()].map(o => o[k])) - 1), hi = [0, 1, 2].map(k => Math.max(...[...before.values()].map(o => o[k])) + 1);
        // circular copies turn around the axis: a box of origins rejects good ones (pegs at r 58 when the bolts sit at r 65 on a
        // hexagon); use the sphere around the origins instead (a wrong axis still throws copies far away)
        const cen = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2), dist = o => Math.hypot(...o.map((v, k) => v - cen[k])), Rmax = Math.max(...[...before.values()].map(dist)) + 1;
        // Codex review: a sphere around the origins rejects correct circular copies (seed far from the other parts); circular
        // patterns are checked by symmetry/mass/interference instead, this test is only for LINEAR patterns built the wrong way
        const out = o => p.kind === 'circular' ? false : o.some((v, k) => v < lo[k] || v > hi[k]);
        const outside = [...(await origins())].filter(([n, o]) => !before.has(n) && out(o)).map(([n, o]) => `${n} (${o.map(v => v.toFixed(1)).join(', ')})`);
        // origins-only box (Codex review: it can reject a pattern meant to extend the set): inside:false switches it off
        if (outside.length && p.inside !== false) differences.push({ quantity: 'pattern_outside', pattern: p.seeds.join('+'), outside: outside.slice(0, 6), hint: p.kind === 'linear' ? 'las copias salieron fuera del ensamble: repite con reverse:true' : 'revisa el eje y el ángulo del patrón' });
      }
    });
    await timed('coordinate_systems', async () => {
      for (const [i, cs] of (plan.coordinate_systems ?? []).entries()) {
        const r = await docCall('coordinate_system', { action: 'create', point_mm: cs.origin_mm, axes: { x: cs.x_axis, y: cs.y_axis } });
        if (!text(r.coordinate_system) || r.verified !== true) throw new Error(`Sistema #${i + 1} no verificado`);
        systems.set(`#${i + 1}`, r.coordinate_system); if (cs.name) systems.set(cs.name, r.coordinate_system);
      }
    });
    // v3.7 auto_origins: the drawing gives each CM but not where its origin is -> find_origin for all of them at once and create
    // the systems (#1, #2... in the order of expect.com), so one call builds, places the origins and verifies.
    if ((args.auto_origins ?? plan.auto_origins) && plan.expect?.com?.length && !(plan.coordinate_systems ?? []).length) await timed('auto_origins', async () => {
      const { findOrigin } = await import('./find_origin.mjs');
      // v3.7 review: units of EACH CM (not the first one for all)
      const units = plan.expect.com.map(c => c.length_units ?? 'in');
      const r = await findOrigin({ document_id, center_of_mass: plan.expect.com.map(c => c.value), length_units: units, create: true, accept_ambiguous: true, mass_units: plan.expect.mass?.units }, { worker: { call: (op, a) => worker.call(op, a, { signal }) } });
      verification.auto_origins = r.results.map(x => ({ source: x.best.source, point_mm: x.best.point_mm, x_axis: x.best.x_axis, y_axis: x.best.y_axis, error: x.best.error, runner_up_error: x.runner_up_error, coordinate_system: x.created?.coordinate_system }));
      r.results.forEach((x, i) => { if (x.created?.coordinate_system) systems.set(plan.expect.com[i].coordinate_system, x.created.coordinate_system); });
      r.results.forEach((x, i) => { if (x.runner_up_error !== null && x.runner_up_error - x.best.error < 0.001) checked.warnings.push(`Origen ${i + 1}: el segundo candidato está muy cerca (${x.runner_up_error}); confirma con el plano dónde está dibujado`); });
    });
    if (plan.units) await timed('units', () => docCall('document_units', { action: 'set', ...Object.fromEntries(['mass_length', 'mass', 'volume', 'decimals'].map(k => [k, plan.units[k]])) }));
    await timed('save', () => docCall('save', { include_references: true }));
    const verify = async (name, f) => {
      try { await timed(name, f); } catch (e) { if (e.outcome_unknown || signal?.aborted) throw e; differences.push({ quantity: name, error: e.message }); }
    };
    await verify('verify_mates', async () => {
      const r = await docCall('mates', { action: 'list' }), expected = plan.expect?.mates ?? plan.mates.length;
      verification.mates = r;
      if (r.mate_count !== expected) differences.push({ quantity: 'mates', expected, actual: r.mate_count });
      if (!finite(r.errors) || r.errors > 0) differences.push({ quantity: 'mate_errors', actual: r.errors ?? null });
      const suppressed = plan.mates.filter(m => m.suppressed).length;
      if (r.suppressed !== suppressed) differences.push({ quantity: 'suppressed_mates', expected: suppressed, actual: r.suppressed ?? null });
      if (r.warnings) checked.warnings.push(`mates: ${r.warnings} avisos`);
    });
    await verify('assembly_doctor', async () => {
      const r = await docCall('assembly_doctor', { include_dofs: true, only_problems: true }), s = r.summary;
      verification.assembly_doctor = r;
      if (!s || !s.complete || s.missing_entries > 0 || s.mate_errors > 0 || s.over_defined > 0 || s.whats_wrong_count > 0) differences.push({ quantity: 'assembly_doctor', summary: s ?? null, read_errors: r.read_errors });
      if (s?.free_components) checked.warnings.push(`assembly_doctor: ${s.free_components} componentes con libertad de movimiento`);
    });
    const pct = args.tolerance_percent ?? 0.5;
    const compare = (quantity, actual, expected, absolute = 0) => {
      const tolerance = Math.max(absolute, Math.abs(expected) * pct / 100);
      if (!finite(actual) || Math.abs(actual - expected) > tolerance) differences.push({ quantity, expected, actual: actual ?? null, tolerance });
    };
    await verify('mass_check', async () => {
      const ex = plan.expect ?? {}, mass = ex.mass;
      const requests = ex.com?.length ? ex.com : [null];
      for (const cm of requests) {
        const coordinate_system = cm ? systems.get(cm.coordinate_system) : undefined;
        if (cm && !coordinate_system) throw new Error(`Sistema no creado: ${cm.coordinate_system}`);
        const tm0 = performance.now();
        const r = await docCall('mass_check', { mass_units: mass?.units ?? 'g', length_units: cm?.length_units ?? 'mm', mass_tolerance_percent: pct, com_tolerance_percent: pct, ...(coordinate_system ? { coordinate_system } : {}) });
        r.call_ms = Math.round(performance.now() - tm0);
        verification.mass_checks.push(r);
        if (!finite(r.mass) || !vector(r.center_of_mass)) differences.push({ quantity: 'mass_check', error: 'Masa/CM no finitos' });
        if (r.units?.mass !== (mass?.units ?? 'g') || r.units?.length !== (cm?.length_units ?? 'mm')) differences.push({ quantity: 'mass_check_units', actual: r.units ?? null });
        if (mass) compare('mass', r.mass, mass.value);
        if (cm) {
          if (r.coordinate_system !== coordinate_system) differences.push({ quantity: 'coordinate_system', expected: coordinate_system, actual: r.coordinate_system });
          cm.value.forEach((v, k) => compare(`com.${cm.coordinate_system}.${'xyz'[k]}`, r.center_of_mass?.[k], v, 0.05 / ({ mm: 1, cm: 10, m: 1000, in: 25.4 }[cm.length_units])));
        }
        const unknown = r.exam_check?.blockers?.filter(b => /UNKNOWN|add up|OVERRIDE/i.test(b)) ?? [];
        if (unknown.length) differences.push({ quantity: 'mass_provenance', blockers: unknown });
        if (r.warnings?.length) checked.warnings.push(...r.warnings);
      }
      // v3.8 symmetric: without the teacher's numbers, a symmetric drawing still says CM = 0 on its symmetry axes (assembly
      // axes, mm); a pattern built the wrong way or a part on the wrong side shows up here. Its own reading (Codex review: it
      // used to be skipped whenever expect.com was given)
      if ((ex.symmetric ?? []).length) {
        const tg = performance.now(), g = await docCall('mass_check', { mass_units: 'g', length_units: 'mm' }); verification.symmetric_ms = Math.round(performance.now() - tg); verification.symmetric_split = g.split_ms;
        for (const ax of ex.symmetric) { const k = 'xyz'.indexOf(ax), v = g.center_of_mass?.[k];
          if (!(Math.abs(v) <= 0.05)) differences.push({ quantity: `symmetric.${ax}`, expected: 0, actual: v ?? null, hint: 'el ensamble del plano es simétrico en este eje: alguna pieza o patrón quedó del lado equivocado' }); }
      }
    });
    // v3.7: if mass/CM differ, ask mass_check with the drawing values for its causes (units, origin, axes, missing part, density)
    if (differences.some(d => d.quantity === 'mass' || String(d.quantity).startsWith('com.'))) try {
      const ex = plan.expect ?? {}, cm = ex.com?.[0];
      const r = await docCall('mass_check', { mass_units: ex.mass?.units ?? 'g', length_units: cm?.length_units ?? 'mm', ...(cm ? { coordinate_system: systems.get(cm.coordinate_system) } : {}),
        reference: { ...(ex.mass ? { mass: ex.mass.value } : {}), ...(cm ? { center_of_mass: cm.value } : {}) } });
      suspects.push({ mass_or_com: true, causes: r.comparison?.causes ?? r.causes ?? [], notes: r.notes ?? [] });
    } catch (e) { suspects.push({ mass_or_com: true, error: e.message }); }
    // This must be the last CAD call. Detection can move components and block subsequent saving.
    await verify('interference', async () => {
      const r = await docCall('interference', { max_pairs: 1000 });
      verification.interference = r;
      if (r.pairs_truncated || !Array.isArray(r.pairs) || r.pairs.length !== r.interference_count) differences.push({ quantity: 'interference', error: 'Resultado incompleto; no se puede comparar el multiconjunto' });
      else if (plan.expect?.interferences_mm3 !== undefined) {
        // v3.8: overlaps under 0.05 mm3 (the comparison tolerance) are round-off, e.g. a 60 degree pattern on holes typed to 4
        // decimals left 0.002 mm3 per peg; they are reported as a warning, not as a failed build
        const noise = r.pairs.filter(p => p.volume_mm3 < 0.05 && !plan.expect.interferences_mm3.some(v => v < 0.05));
        if (noise.length) checked.warnings.push(`${noise.length} interferencias menores a 0.05 mm3 (redondeo numérico, máx ${Math.max(...noise.map(p => p.volume_mm3)).toFixed(4)} mm3) no cuentan`);
        // indices of the filtered list are mapped back to r.pairs, so the suspects below look at the right pair (Codex review)
        const kept = r.pairs.map((p, i) => ({ p, i })).filter(x => !noise.includes(x.p));
        differences.push(...compareInterferences(kept.map(x => x.p.volume_mm3), plan.expect.interferences_mm3).map(d => d.quantity === 'interference_extra_mm3' ? { ...d, index: kept[d.index].i } : d));
      }
      if (r.save_blocked || r.components_repositioned_and_restored > 0 || r.components_not_restored?.length) differences.push({ quantity: 'interference_state', save_blocked: r.save_blocked, restored: r.components_repositioned_and_restored, not_restored: r.components_not_restored });
      // v3.7 suspects: which mates join the two parts of an unexpected interference (wrong side / thickness), or why one is missing
      const idOf = new Map([...components].map(([id, name]) => [name, id]));
      for (const d of differences.filter(x => x.quantity === 'interference_extra_mm3')) {
        const pair = (r.pairs[d.index]?.components ?? []).map(n => idOf.get(n) ?? n);
        const mates = plan.mates.map((m, i) => ({ i, m, comps: new Set((m.entities ?? []).map(e => e.component).filter(Boolean)) })).filter(x => pair.every(p => x.comps.has(p)) || pair.some(p => x.comps.has(p)) && x.comps.size === 1);
        suspects.push({ interference_mm3: d.actual, components: pair, mates: mates.map(x => ({ index: x.i, name: x.m.name ?? null, type: x.m.type, align: x.m.align ?? 'closest' })),
          hint: mates.length ? 'Revisa el lado (align) de estas relaciones o si una pieza tiene su plano a la mitad del espesor (plano medio).' : 'Ninguna relación las une directamente: revisa la cadena de relaciones de cada una.' });
      }
      for (const d of differences.filter(x => x.quantity === 'interference_missing_mm3')) suspects.push({ interference_mm3: d.expected, hint: 'El plano espera esta interferencia y no aparece: alguna pieza no llega a tocar (distancia, espesor o lado).' });
    });
    return report();
  } catch (e) {
    if (!failures.some(f => f.index === currentMate?.index && f.error === e.message)) failures.push({ phase, ...currentMate, error: e.message, outcome_unknown: !!e.outcome_unknown, safe_edit: e.safe_edit });
    return report();
  }
}
