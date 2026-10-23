---
name: Part IR cookbook
description: Ready-to-copy part-ir/1 templates (plates, hole patterns, shafts, sweeps, sheet metal) for sw_part_build, tested in SolidWorks.
---

# Part IR cookbook

`sw_part_build {action: "check"}` validates without SolidWorks; `{action: "build", reuse: true}` builds and verifies (bodies, box, volume or mass). Conventions: `front` sketch x,y -> X,Y (extrude +Z); `top` x,y -> X,-Z (extrude +/-Y); "up" in assemblies is +Y. Values can be expressions of `params`.

```js
// plate with a grid of holes
{ id: 'plate', op: 'extrude', sketch: { plane: 'front', entities: [{ rect: { center: [0, 40], w: 580, h: 80 } }] }, depth: 16, direction: '+Z' },
{ id: 'holes', op: 'cut', sketch: { plane: 'front', entities: [{ grid: { from: [-240, 20], count: [5, 1], step: [120, 0], d: 25.2 } }] }, end: 'through_all_both' }

// holes on a circle ("6X at 60 deg")
{ polar: { r: 20, count: 6, start_deg: 0, d: 9 } }

// rounded corners and chamfers: pick edges by a point on them
{ id: 'R12', op: 'fillet', edges: [{ near: [68, 2, 41] }, { near: [-68, 2, 41] }], radius: 12 },
{ id: 'c1', op: 'chamfer', edges: [{ near: [4, 0, 24] }], distance: 1 }

// shaft / pin / roller: revolve stepped diameters
{ id: 'shaft', op: 'revolve', sketch: { plane: 'front', entities: [{ steps: { x0: -40, segments: [[16, 20], [22, 40], [16, 20]] } }] } }

// tapped hole with the Hole Wizard
{ id: 'M10', op: 'hole', type: 'tap', size: 'M10', at: [0, 0, 0], depth: 59, thread_depth: 50 }

// bent bar: sweep a profile along a path
{ id: 'profile', op: 'sketch', sketch: { plane: 'top', entities: [{ poly: { points: HEXAGON } }] } },
{ id: 'path', op: 'sketch', sketch: { plane: 'front', entities: [{ line: { from: [0, 0], to: [0, 69] } }, { arc: { center: [4, 69], from: [0, 69], to: [4, 73], clockwise: true } }] } },
{ id: 'bar', op: 'sweep', profile: 'profile', path: 'path' }
```

- `expect: { bodies: 1, box_mm: [x, y, z], mass_g: 1136.03 }`: when the mass is off by more than 0.5 %, `mass_hint` says how much volume is missing or extra and which feature to check.
- Generated fasteners in assemblies: `{ id: 'B', make: { type: 'bolt', size: 'M10', length_mm: 25, material: 'AISI 1020' }, count: 10 }` (also `washer`, `nut`, `countersunk`); always give the material.
- Sheet metal: `sw_sheet_metal` base_flange, edge_flange, sketched_bend, hem, flatten, export_flat; flat pattern views with `sw_drawing_sheets add_view flat_pattern: true`.
