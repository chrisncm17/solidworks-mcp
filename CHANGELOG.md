# Changelog

## 3.14.0 - 2026-10-29
Found while building a 4-cylinder linear engine (68 mates); unit-tested, worker compiled for SolidWorks 2026 SP3.2.
- **Builds no longer lose the document:** `sw_part_build` / `sw_assembly_build` calls have no 150 s soft timeout (a long `assembly_batch` used to stop the build before saving); only the hard timeout stops them.
- **Final posture check:** after the mates, `sw_assembly_build` compares each placed component (`position_mm` / `transform`) with where it ended; parts flipped 180 deg or moved to the other side with 0 errors become a warning, or a failure with `expect.posture` (`true` or `{tolerance_mm, tolerance_deg}`).
- **Distance side:** plan `auto_expect` (`true` or `{tolerance_mm}`) adds `expect` to distance/coincident mates of the component that moves, so the other side is tried by itself; `flip` documented.
- **Color:** new tool `sw_appearance` (part rgb, or `parts [{component, rgb}]` in an assembly) and `appearance {rgb, specular}` in part IR.
- **Delivery:** `sw_pack_and_go deliver_to` (new folder in Downloads), `main_name`, `rename`, `zip` and `open_visible` (closes the managed source and opens the delivery isometric, maximized), checking every reference stays inside the folder.
- **Patterns:** a pattern or mirror that leaves extra loose bodies now stops with an explanation (do the short-step pattern first) unless `expect.bodies` allows them.
- **Clean names:** a reused part name becomes `Name_2`, `Name_3`... instead of a random suffix.
- **RAM:** assemblies with 20+ components warn when SolidWorks has under 3 GB free (`verification.free_ram_gb`).
## 3.12.0 - 2026-10-27
Found while redrawing a 2-sheet valve drawing to match a teacher's PDF; verified in SolidWorks 2026 SP3.2 on a backed-up drawing.
- **New tool `sw_drawing_edit`:** `list` every dimension of a sheet (value, view, text position, colour), `move_text`, `delete` near a sheet point (e.g. bogus 90 deg angulars shown as 1570.796), `move_view`, `title_text` (list or replace title-block texts such as "SHEET 1 OF 1"), `hide_construction` (hidden layer), `black` (B&W drawings) and `color` (`"#RRGGBB"`, e.g. royal-blue dimensions; with `texts`, only those notes, e.g. red part names).
- **`sw_drawing_dimension add`:** turns off the "Modify" value dialog while dimensioning (it blocked the worker) and deletes an angular dimension SolidWorks makes instead of a horizontal/vertical one (circles seen edge-on), with an explanation.

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
