---
name: Drawings of parts and assemblies
description: One-call drawings (views, scale, BOM, balloons, answers, PDF), section views, flat patterns, DXF/PDF export.
---

# Drawings

- **One call:** `sw_assembly_drawing` with an open assembly or part: A3 (or other size), first or third angle, one standard scale that fits, BOM with material and mass, balloons, a note with the answers, sheet scale 1:1, saved and exported to PDF. A part gets its model dimensions, centre marks and hole callouts instead of a BOM.
- **Hidden parts** (a pin inside a body) get a **section view** automatically with their balloon (`section: false` turns it off).
- **Section by hand:** `sw_drawing_views {action: "section", sheet, view, direction: "horizontal" | "vertical", through_mm: [x, y, z]}` - the cut passes through a MODEL point (e.g. a hole centre) and the view is moved to a free place.
- **Title block:** `format_from_drawing` copies the sheet format of another drawing (opened read-only); `properties` fills title-block fields.
- **Sheet metal:** `sw_drawing_sheets {action: "add_view", flat_pattern: true}` adds the flat pattern with bend notes.
- **Check the PDF** (`sw_drawing_read render`): view overlaps and crowded balloons show up there. Move a view with `sw_drawing_views set center_mm`.
- **Export:** `sw_export` (PDF, DXF, DWG for drawings; STEP, IGES, Parasolid, STL for models) or `sw_export_batch` for several documents and formats at once.
