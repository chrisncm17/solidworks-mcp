# Changelog

## 3.20.0 - 2026-11-20
- **Sketch dimensions in order:** `sw_create_sketch` with `dimension: true` left each dimension where Fully Define Sketch placed it, piled on the geometry and on each other. Now, like the tracks of a drawing, horizontal distances go in rows under the sketch and vertical ones in columns to its left, the shortest nearest and two in one row only when they do not overlap; radii and diameters go just outside their arc. Only the texts move; `dimension_order` in the result says how many, and `why_left` names any it could not place. Fully Define gives horizontal (11) and vertical (12) linear types, not plain linear (2); the first build missed that and moved only the radii.
- **`sw_surface` extrude up to a surface:** `end` `up_to_surface` or `offset_from_surface` stops at the face through `up_to_point_mm` (`offset_mm`, `offset_reverse`), instead of a depth to guess.
- **`sw_mirror` of bodies:** `body_points_mm` mirrors whole bodies, solid or surface (Mirror → Bodies), with `merge` or `knit`; before it mirrored features only.

## 3.19.0 - 2026-11-11
Practiced on a student part (a half-tube support, AISI 1020, 664.70 g on its drawing) built with nothing but the Surfaces tab; it came out at 664.701 g. Run in SolidWorks 2026 SP3.2.
- **`sw_surface`, the Surfaces tab:** extrude, revolve, planar, loft, sweep, offset, ruled, fill, trim, untrim, extend, knit, delete face, delete hole, replace face, thicken, thickened cut and cut with surface, one action per call; faces, edges and surface bodies are picked by a point on them.
- **Surfaces only:** `sw_surface` action `mode` with `on: true` makes the Features tab (extrude, cut, revolve, loft, sweep, shell, patterns, hole wizard, rib, draft, part_build...) refuse that document until it is turned off; sketches, reference geometry, fillet, material, mass and save still work.
- **It finds the gap before the knit does:** action `inspect` lists every surface body with its area and where its open edges are, so a face built the wrong way shows by its coordinates (a band extruded from z=-13 to z=+6 instead of to -32). A knit with `form_solid` that leaves no solid is an error with that list. The edge points were off by one edge length on reversed edges; now the point is checked to lie on its edge.
- **What the API needs, found by trying:** knit wants its surfaces selected with mark 1, and it ignores "try to form solid" when the feature is made, so it is turned on afterwards in the feature definition; trim takes the tool by its feature or body and the pieces by body; thickened cut wants mark 1.
- **Not solved:** a closed full-circle surface (a hole wall) does not trim through the API, not mutually and not as a target; the trim lists a WARNING when a target comes out whole. Make that hole with a thickened cut of a planar disk after the knit. Boundary surface, freeform and flatten are not in yet.
- **Health:** a part with surface bodies and no solid is no longer reported as "without solid bodies".

## 3.18.0 - 2026-11-01
- **A long call no longer brings the server down:** in the Claude desktop app a call past 60 s gets `Request timed out` and another server takes over: document ids are lost and a job of several steps stays half done (`sw_drawing_dim_organize` left a sheet with 1 dimension of 23, and no `late_results` ever reached a chat). Now any call past 50 s answers `running: true` and keeps going as a tracked job; other SolidWorks calls wait for it and its result arrives as `late_results` in the next response.
- **`sw_drawing_dim_organize` and `sw_drawing_dim_check`** are not stopped half way by a cancel, like the builds, and a step of any job is no longer failed at 150 s (the 30 min hard timeout stays).
- **`sw_resume_document` reaches the copies of `sw_copy_renamed`,** also one open with unsaved changes whose id was lost, so it can be checked and closed.

## 3.17.0 - 2026-11-01
Found while organizing real student sheets of a drawing compendium, always on copies that were closed without saving; run in SolidWorks 2026 SP3.2.
- **`sw_drawing_dim_organize` asks the part what it needs:** it reads the faces of the part and keeps what someone needs to make it, axis by axis: N planes and centres take N-1 dimensions. A round is said once with its count (`4 X Ø10`, `2 X R3`, `R1 TYP`), a ring of holes by its pitch and the distance to the contour (with no contour by its pitch and count, unless a place of the ring is empty), one tooth says them all, a slanted face by its angle and the corner it had before its rounds, a tapered slot (the slot of a connecting rod) by the centres and radii of its ends, as drafted, not by the width between its walls. What no dimension says is drawn from the edges of a view; what cannot be followed is reported in `sufficiency`, and it never answers "enough" without having checked.
- **Dimensions that hang from something else:** one made on the sheet and attached to the line of a section or a view sketch says nothing about the part and goes.
- **Only what is needed, once:** the corners of a slanted face are read where it meets the planes its fillets run into, so a dimension to a corner its angle and its other corner already place goes (the 9.50 under the eye of a connecting rod); a length across a round already given as a diameter goes (a wheel's Ø521.20 said again in the top view); equal grooves take one width also when a face of the inside crosses one of them; how far free faces reach is not asked when that is the edge of a round already placed (no phantom 30 across a piston); a chamfer on a curved edge, whose face is no cone, is one dimension `1 X 45°`, not a length in one view and its 45° in another; holes all the way round a boss take their separation and count, and their radius only when a place is empty. A total no view can show that ends at the centre of a ring comes out of the chain instead of being asked for again until the guard runs out (an exhaust took 302 s and lost its 100).
- **A construction line where there is nothing to dimension from:** `sw_drawing_dimension` action `guided` draws one or more construction lines on the view, in black, from the end of an edge, dimensions on them, reads the value back and removes both if it is not the one expected (an angle is tried with its feet both ways, as the order decides whether it reads 30 or 330). Organize uses it for a corner a round took away (from the twin corner on the side of the view with room, so the extension line does not cross the part) and for an angle with a ray that follows no edge (it goes to the end of the edge it does follow, by its vertex, and the old one goes only once the sheet confirmed the new one). The lines are drawn with the views already in their places, because they widen the frame of their view.
- **The small step instead of the long one:** two long dimensions a hair apart (14 and 14.5) become the long one that places a real face and the step between them (0.5).
- **No dimension over another:** the check now sees lines that lie on each other, that run through an arrow, or that pass right beside each other, and what is really drawn: tails, text outside, a leader under its whole text with the blanks SolidWorks pads it with, the 1 mm gap of an extension line and the rays of an angle. The plan knows the shape of each view, searches the whole sheet in several orders, lets a placed dimension give way, and takes a last look at what stayed far. Angles, radii and diameters move too: a radius goes to the arc that is drawn, a diameter seen as a circle takes a leader that stops at the circle, and a radius in a hollow keeps its arrow inside.
- **Drafted like a certified drafter's sheets** (compared with an instructor's course sheets): a leader leaves its arc on a slant, not level or upright; the text of a leader shut in between the two extension lines of another dimension, where it would read as that one's value, costs as much as several tracks of detour, also when the linear dimension comes later, so it stays there only when there is no other place; stacked sizes a hair apart (14 and 14.5) share their foot, so the inner one keeps its text centred with its arrows out.
- **A crowded view says so:** when problems stay because one view carries almost every dimension, organize names that view, its scale and the next one up (`1:2` → `1:1`), as moving texts cannot make that room.
- **Sections stay hatched:** SolidWorks cuts the hatching around the dimensions on a section when they are inserted, and it stays cut after they move away (`GetFaceHatches` does not tell; only the PDF does). Organize and fix now redraw it. `drawing_dim_geometry` returns each section's `hatches`.
- **Views:** the views open room for their dimensions, also beside the front, and what is behind goes along; a view in line with the front goes back into line; a section with no room goes along its line and the isometric makes way, and dimensions leave the arrows and the name of the cut alone.
- Internal `drawing_part_sizes` and `drawing_dim_shapes`; `sw_drawing_dimension add` measures to a vertex (`ends`); `sw_drawing_views` takes `break_alignment`.

## 3.16.0 - 2026-10-31
From the SolidWorks training manual on advanced part modeling, compared with what the connector could do; every item run in SolidWorks 2026 SP3.2 on new parts, checked against the volume it should give.
- **New tools:** `sw_sketch_3d` (polyline with corner fillets, or spline through points), `sw_dome`, `sw_split_line` (by projection; refuses when no face was divided), `sw_draft_analysis` (read only: each face against the pull direction, positive / negative / requires_draft / straddle).
- **`sw_sweep`:** `guides`, `orientation` (keep_normal, twist_along_path...) and `twist_deg`, also for cuts.
- **`sw_loft`:** `guides`, `start_constraint` / `end_constraint` normal, `closed` (3 or more profiles; the closed loft itself was not run, only its refusal with 2).
- **`sw_fillet`:** `end_radii_mm` [a, b], variable radius on one edge; the end radii were read back from the end faces.
- **`sw_shell`:** `face_thickness`, walls with their own thickness. The API only honours them selected with mark 2 and without clearing the selection.
- Not covered: surfaces, mold core and cavity, flex, indent, split part, face fillet.

## 3.15.0 - 2026-10-30
- **Drawings:** `sw_drawing_dim_check` and `sw_drawing_dim_organize`: no repeated dimensions, shared among the views, section view with hatch when the part is hollow.
- **Hole patterns:** a pattern is its pitch, the distance to the contour and `NX` on the diameter, not every position (`arc_end` in `sw_drawing_dimension`).
- **Last touches:** a text touching a line is moved a step, read back and kept only if the sheet has fewer problems.

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
