# Changelog

## 3.9.0 - 2026-10-22 (first public release)
- **Drawings:** section views through a model point (`sw_drawing_views action: section`), placed in a free area; `sw_assembly_drawing` adds a section with balloons when a part is hidden in every view; flat-pattern views (`sw_drawing_sheets add_view flat_pattern`).
- **DXF:** `sw_drawing_read dimensions` reads DXF dimensions exactly (definition points x DIMLFAC), finds views (frame and title block set apart, SECTION/DETAIL labels, scale per view) and `render` draws a DXF.
- **Exchange:** `sw_import_model` (STEP, IGES, Parasolid, ACIS; always reads a copy; imported assemblies keep their parts next to them), `sw_export_batch`.
- **Sheet metal:** `sketched_bend`, `hem`; `sw_save_body` saves one body of a multibody part as a new part.
- **Assemblies:** a mate point that misses a face by up to 0.5 mm snaps to the only nearby face (reported); otherwise the error lists the nearest faces with exact points. Faster batches: files opened once, no redraw during the batch, lazy face sampling (pegboard assembly phase 41 s -> 35 s).
- **Safety fixes:** features created already suppressed (sheet-metal flat pattern) are no longer taken for regressions; sheet-metal restores compare top-level features only.
- **Portability:** SolidWorks API and executable found through the registry; Python, pdftotext and recipes configurable; recipes bundled as files.

## 3.8 and earlier (private development)
One-call assemblies (`sw_assembly_build`) with intents, fasteners, kits, patterns, coordinate systems from CM values and full verification; part recipes (`sw_part_build`); one-call drawings; reading SolidWorks PDFs (dimension points, radii, angles, materials); exam-oriented flow with background SolidWorks start; safe-edit guard with verified rollback; backups for user files; 100+ tools.
