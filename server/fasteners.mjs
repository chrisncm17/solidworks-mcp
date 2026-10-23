// v3.8 fasteners: ISO hex bolt (ISO 4017), hex nut (ISO 4032) and plain washer (ISO 7089) as part-ir/1, plus the face
// conventions the "fastener" intent uses. Simplified solids: no thread, no chamfers (mass is the nominal solid, not the
// threaded one). Convention for every generated part: axis = part +Y, sketch on Top; bolt head from y=-k to 0 (underside at
// the origin, facing +Y), shank from 0 to L; washer and nut from y=0 (bottom, facing -Y) to their thickness (top, facing +Y).
const ISO = {
  //       s     k     m     d1    d2   h      (s across flats, k head height, m nut height, washer d1/d2/h)
  M3: [5.5, 2, 2.4, 3.2, 7, 0.5], M4: [7, 2.8, 3.2, 4.3, 9, 0.8], M5: [8, 3.5, 4.7, 5.3, 10, 1], M6: [10, 4, 5.2, 6.4, 12, 1.6],
  M8: [13, 5.3, 6.8, 8.4, 16, 1.6], M10: [16, 6.4, 8.4, 10.5, 20, 2], M12: [18, 7.5, 10.8, 13, 24, 2.5],
  M16: [24, 10, 14.8, 17, 30, 3], M20: [30, 12.5, 18, 21, 37, 3],
};
// ISO 10642 countersunk (avellanado) head, 90 deg: dk theoretical head diameter; k = (dk - d) / 2 (simplified: no hex socket)
const CSK = { M3: 6.72, M4: 8.96, M5: 11.2, M6: 13.44, M8: 17.92, M10: 22.4, M12: 26.88, M16: 33.6, M20: 40.32 };
export const FASTENER_SIZES = Object.keys(ISO);
export function isoSize(size) {
  const r = ISO[String(size ?? '').toUpperCase()];
  if (!r) return null;
  const [s, k, m, d1, d2, h] = r;
  return { d: Number(String(size).slice(1)), s, k, m, washer: { d1, d2, h } };
}
const HEX = [['s/sqrt(3)', 0], ['s/(2*sqrt(3))', 's/2'], ['-s/(2*sqrt(3))', 's/2'], ['-s/sqrt(3)', 0], ['-s/(2*sqrt(3))', '-s/2'], ['s/(2*sqrt(3))', '-s/2']];
const slug = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, '_').slice(0, 30);

// make: {type:'bolt'|'washer'|'nut', size:'M8', length_mm (bolt), material?} -> {errors, file, part, ir}
export function fastenerSpec(make) {
  const errors = [];
  if (!make || typeof make !== 'object') return { errors: ['make: {type, size, length_mm, material}'] };
  const iso = isoSize(make.size);
  if (!['bolt', 'washer', 'nut', 'countersunk'].includes(make.type)) errors.push('make.type: bolt|washer|nut|countersunk');
  if (!iso) errors.push(`make.size: ${FASTENER_SIZES.join('|')}`);
  if ((make.type === 'bolt' || make.type === 'countersunk') && !(Number.isFinite(make.length_mm) && make.length_mm > 0 && make.length_mm <= 500)) errors.push('make.length_mm: largo del vástago en mm (0 < L <= 500)');
  if (make.material !== undefined && !(typeof make.material === 'string' && make.material.trim())) errors.push('make.material: nombre de la biblioteca de SolidWorks');
  if (errors.length) return { errors };
  const size = String(make.size).toUpperCase(), mat = make.material ? '_' + slug(make.material) : '';
  const base = { bolt: `ISO4017_${size}x${+make.length_mm}`, countersunk: `ISO10642_${size}x${+make.length_mm}`, washer: `ISO7089_${size}`, nut: `ISO4032_${size}` }[make.type];
  const part = (base + mat).replace(/\./g, '_');
  const material = make.material ? { material: { name: make.material.trim() } } : {};
  let ir;
  if (make.type === 'bolt') ir = { ir: 'part-ir/1', part, params: { s: iso.s, k: iso.k, d: iso.d, L: +make.length_mm }, ...material,
    features: [
      { id: 'cabeza', op: 'extrude', sketch: { plane: 'top', entities: [{ poly: { points: HEX } }] }, depth: 'k', direction: '-Y' },
      { id: 'vastago', op: 'extrude', sketch: { plane: 'top', entities: [{ circle: { center: [0, 0], d: 'd' } }] }, depth: 'L', direction: '+Y' },
    ], expect: { bodies: 1, volume_mm3: 'sqrt(3)/2*s^2*k + pi*d^2/4*L' } };
  // countersunk: L is the overall length (ISO 10642 measures it from the head top). Head top (flat, facing -Y) at y=0, 90 deg cone
  // down to Ø d at y=k, shank to y=L. Revolved about the part Y axis (front plane: local x,y = X,Y).
  else if (make.type === 'countersunk') { const dk = CSK[size], k = (dk - iso.d) / 2;
    if (!(+make.length_mm > k)) return { errors: [`make.length_mm debe ser mayor que la cabeza (${k} mm)`] };
    ir = { ir: 'part-ir/1', part, params: { dk, d: iso.d, k, L: +make.length_mm }, ...material,
      features: [{ id: 'tornillo', op: 'revolve', sketch: { plane: 'front', entities: [{ poly: { points: [[0, 0], ['dk/2', 0], ['d/2', 'k'], ['d/2', 'L'], [0, 'L']] } }, { line: { from: [0, 0], to: [0, 'L'], construction: true } }] } }],
      expect: { bodies: 1, volume_mm3: 'pi*k/3*((dk/2)^2+(dk/2)*(d/2)+(d/2)^2) + pi*(d/2)^2*(L-k)' } }; }
  else if (make.type === 'washer') ir = { ir: 'part-ir/1', part, params: { d1: iso.washer.d1, d2: iso.washer.d2, h: iso.washer.h }, ...material,
    features: [{ id: 'arandela', op: 'extrude', sketch: { plane: 'top', entities: [{ circle: { center: [0, 0], d: 'd2' } }, { circle: { center: [0, 0], d: 'd1' } }] }, depth: 'h', direction: '+Y' }],
    expect: { bodies: 1, volume_mm3: 'pi/4*(d2^2-d1^2)*h' } };
  else ir = { ir: 'part-ir/1', part, params: { s: iso.s, d: iso.d, m: iso.m }, ...material,
    features: [{ id: 'tuerca', op: 'extrude', sketch: { plane: 'top', entities: [{ poly: { points: HEX } }, { circle: { center: [0, 0], d: 'd' } }] }, depth: 'm', direction: '+Y' }],
    expect: { bodies: 1, volume_mm3: 'sqrt(3)/2*s^2*m - pi*d^2/4*m' } };
  return { errors, part, file: part + '.SLDPRT', ir };
}

// faces of a generated fastener, described for find (part coordinates, outward normals)
export function fastenerFaces(type, size) {
  const iso = isoSize(size);
  const cyl = d => ({ kind: 'cylinder', ...(d ? { diameter_mm: d } : {}) });
  if (type === 'bolt') return { shank: cyl(iso?.d), head: { kind: 'plane', normal: [0, 1, 0], offset_mm: 0 } };
  // countersunk: the head TOP is the face that goes flush with the plate (coincident ALIGNED with the plate top, not a seat)
  if (type === 'countersunk') return { shank: cyl(iso?.d), head: { kind: 'plane', normal: [0, -1, 0], offset_mm: 0 } };
  if (type === 'washer') return { bore: cyl(iso?.washer.d1), bottom: { kind: 'plane', normal: [0, -1, 0] }, top: { kind: 'plane', normal: [0, 1, 0] } };
  return { bore: cyl(iso?.d), bottom: { kind: 'plane', normal: [0, -1, 0] }, top: { kind: 'plane', normal: [0, 1, 0] } };
}

// built-in kits: tornilleria_M8x30 (tornillo+rondana+tuerca), tornillo_tuerca_M8x30, tornillo_rondana_M8x30, tornillo_M8x30.
// The use supplies at:{hole, head_side, nut_side} and optionally material.
export function builtinKit(name, material) {
  const m = /^(tornilleria|tornillo_tuerca|tornillo_rondana|tornillo)_(M\d+)x(\d+(?:\.\d+)?)$/i.exec(name ?? '');
  if (!m || !isoSize(m[2])) return null;
  const kind = m[1].toLowerCase(), size = m[2].toUpperCase(), L = Number(m[3]), mat = material ? { material } : {};
  const washer = kind === 'tornilleria' || kind === 'tornillo_rondana', nut = kind === 'tornilleria' || kind === 'tornillo_tuerca';
  const components = [{ id: 'T', make: { type: 'bolt', size, length_mm: L, ...mat } }];
  if (washer) components.push({ id: 'R', make: { type: 'washer', size, ...mat } });
  if (nut) components.push({ id: 'N', make: { type: 'nut', size, ...mat } });
  return { builtin: true, components, mates: [{ intent: 'fastener', size, bolt: 'T', ...(washer ? { washer: 'R' } : {}), ...(nut ? { nut: 'N', nut_side: '@nut_side' } : {}), hole: '@hole', head_side: '@head_side' }] };
}
