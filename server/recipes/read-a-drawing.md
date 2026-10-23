---
name: Read a drawing and make a measurement sheet
description: sw_drawing_read (PDF, DXF, image) and sw_measure_sheet - every value with its source, nothing invented.
---

# Read a drawing

1. **`analyze`** first: the whole PDF (or a phone photo) in one call - views cropped by label with their dimension candidates, key lines (mass, CM, interferences, materials, notes). Cached by file content.
2. **`dimensions`** (PDF exported by SolidWorks, or DXF): for each dimension its direction, view and the two part points it measures; radii/diameters with centre; angles with vertex and rays; scale per view (voted by the dimensions); inches converted; an annotated PNG. On a DXF it is exact (definition points x DIMLFAC).
3. **`text`** / **`render`** (with `grid`, `region_mm`) to confirm a symbol or a zone by eye.
4. **`sw_measure_sheet action: validate`**: each measure with `source` (`pdf_text` with a tight `bbox_mm`, `vision`, `derived`, `note`) and `status` (`ok`, `uncertain`, `blurry`, `missing`, `contradictory`). Blurry or missing values are never filled in.
5. After modelling, **`sw_measure_sheet action: compare_model`** checks the model against the sheet (same kind of dimension, overall box, material).

Notes
- SolidWorks PDFs draw the Ø symbol and depth marks as lines, not text: a number beside a circle of that diameter is reported as a diameter (with a note).
- The title block scale can differ from the real view scale: trust the scale voted by the dimensions.
- A DWG must be exported to DXF first.
