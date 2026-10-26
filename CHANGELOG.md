# Changelog

## 3.11.0 - 2026-10-25
Found while modelling a 51-file jet engine; every item verified in SolidWorks 2026 SP3.2 (`examples/v311_improvements.mjs`).
- **Assemblies:** `sw_insert_components` inserts many parts in one call (rolls back all on a failure); `fit_box` places a part by where its body must span on an axis (exact body extremes, not the loose part box); `sw_add_mate expect` checks where a component must end and retries with the other side; `sw_move_component allow_fixed` moves a fixed part and fixes it again; `sw_find_faces` by description (`extreme: "+y"`, `inclined`, `feature`, `pick: largest|smallest|outermost`), also in `sw_assembly_build` plans; plan files may live in subfolders.
- **Replace component:** no longer reverted by the guard; mates broken by a different part are re-created on the face at the same local point (`remated`).
- **Pack and Go / save:** documents flagged modified only by a rebuild (references and the reopened main assembly) are saved first when their health is clean and no interference check blocked them (`references_saved_first`).
- **Interference:** a bolt in a tapped hole is reported as `thread_engagement` (expected) and is left out of `expect.interferences_mm3`.
- **Long calls:** cancel or timeout no longer kills the worker; the late result is delivered with the next call (`late_results`); builds keep running after the client gives up.
- **Responses:** big inspections are compacted to top-level components with a `details_file`.
- **New tools:** `sw_wrap` (emboss, deboss, scribe), `sw_boundary` (experimental: SolidWorks 2026 SP3.2 returned null even for profiles a loft accepts - use `sw_loft`), `sw_session_recipe` (records a session and exports it as a recipe).
- **Drawings:** `sw_drawing_dimension action: auto` (overall width, height and one diameter per hole size).
- `sw_instance show` finds the SolidWorks window and brings it to the front; `sw_assembly_build` closes hidden documents before the interference check (`keep_open` to skip).
- `install.ps1`: one-line install and registration in Claude Desktop, Claude Code and Codex.

## 3.10.0 - 2026-10-24
- `sw_preview` (PNG of standard views, labelled), `sw_combine` (add, subtract, common), `sw_drawing_dimension` (manual dimensions) and detail views in drawings.

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
