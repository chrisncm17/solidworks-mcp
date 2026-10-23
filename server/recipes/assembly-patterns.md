---
name: Assembly patterns that work
description: Mate order, explicit alignment, checks against the drawing and how to fix a part without rebuilding it.
---

# Assembly patterns that work

## Before assembling
- Work on copies (`sw_copy_renamed`, `sw_open_copy`) or let `sw_open_project` back up the user's files first.
- Check each part's mass against the drawing's table (mind the quantities) and the tree for warnings (`sw_inspect`, `sw_feature_info`).

## Mates
- Seat before axis: when two mates fix the same part, first the coincident with an explicit `align` (it decides the side), then the concentric without `align`.
- Three "wrong side" detectors: `moved_components`, an interference the drawing does not list, a CM off by tenths of a millimetre.
- Hole Wizard holes can resolve their centre ~0.2 mm from the nominal value: describe faces with `find` instead of hand-computed points (a point that misses by <= 0.5 mm is snapped to the only nearby face and reported in `warnings`).
- Mirror parts: a `parallel` mate with explicit `align` so both face the centre.

## Check against the drawing
- Interference list of the drawing = a test: an extra one means a misplaced part. Never save after an interference check.
- Coordinate systems of the drawing: deduce them from the CM values (`sw_find_origin`).
- Units: `sw_document_units` (e.g. lb, in, 4 decimals); check in Mass Properties, not the status bar.
- A part extruded with "mid plane" puts its plane at the middle of the thickness: plane mates then land half a thickness off.

## Fix a part without rebuilding it
1. `sw_feature_info` on the flagged feature and its sketch.
2. Minimal change (e.g. `sw_sketch_plane` when the support face is gone).
3. Compare against a rebuild without changes; if it is still not clean, rebuild the part from the drawing with `sw_part_build` and compare mass and CM.
