---
name: Assembly from a drawing (mass, center of mass, drawing)
description: Fastest path from an assembly drawing (PDF) to a verified assembly with mass, center of mass and its own drawing, in one sw_assembly_build call.
---

# Assembly from a drawing

Goal: build the assembly exactly as drawn and answer **mass** and **center of mass** (in every coordinate system the drawing marks), plus a drawing with BOM and balloons.

## 0. Start SolidWorks while you read
`sw_exam_ready {start: true, wait: false}` starts the MCP's own (minimized) SolidWorks in the background; the next CAD call waits for it. Never touch the user's own SolidWorks session.

## 1. Read the drawing
- `sw_drawing_read {action: "analyze"}`: every view cropped, dimension candidates, title block, notes (mass, CM, interferences, materials).
- `sw_drawing_read {action: "dimensions"}`: for every dimension, its view and the two PART points it measures (`from_part_mm`, `to_part_mm`), radii/diameters with their centre, angles with their vertex, the title-block material. Prefer a DXF when you have one: its dimensions are exact.
- `sw_assembly_draft`: skeleton of the plan (components, quantities, expected mass/CM, materials) from the PDF and the parts folder.

## 2. Write the plan (`assembly-ir/1`)
- Parts you do not have: put their part IR in `plan.parts` (see the *Part IR* recipe); unchanged parts are reused on the next run.
- One fixed base (`fixed: true`). "Up" is +Y; if the base is modelled with +Z up, give it `up: "+Z"`.
- Mates by **intent** when possible: `insert` (shaft in hole + seat), `face_to_face`, `flush`, `coaxial`, `fastener` (bolt + washer + nut in one line, `repeat: n`).
- Faces described as the drawing says: `{component, find: {kind: "cylinder", diameter_mm: 8}}` or `{component, find: {kind: "plane", normal: [0, 0, 1], offset_mm: 12}}`; add `near_mm` or `index` when several match.
- **Always an explicit `align`** on coincident faces (`anti_aligned` = touching, `aligned` = flush): with `closest` SolidWorks picks the side from the initial position.
- Repeated parts: mate ONE seed and use `plan.patterns` (linear or circular).
- `expect`: mass, CM per coordinate system, interferences (`interferences_mm3: []` when there must be none), `symmetric`, and `box_mm` on every part.

## 3. Build
`sw_assembly_build {action: "check"}` (no SolidWorks), then `{action: "build", reuse_parts: true, answers: {...}, drawing: {...}}`.
- Answers come back first; the drawing finishes in the background.
- On failure read the *suspects* (which mate moved which part, which interference is extra) and fix only that line.
- `auto_origins: true` finds the drawing's coordinate systems from its CM values (`sw_find_origin`) and creates them.

## 4. Deliver
`sw_answer_sheet` (mass and every CM, in the requested units and decimals), the drawing PDF, and `sw_pack_and_go` if the files must travel.
