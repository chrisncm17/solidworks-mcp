# Tools

112 tools. Generated from `server/tools.mjs` by `npm run tools` - do not edit by hand.

## Session and documents

### `sw_checkpoint`

Save current managed document as a NEW native backup with matching extension, without changing active filename. Includes edits; does not overwrite. Assembly/drawing referenced files are not duplicated (not Pack and Go). Resume with sw_resume_document.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |

### `sw_close_document`

Close a document opened in this MCP session. Refuses unsaved changes unless discard_changes=true (changes are lost; never saved).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `discard_changes` | boolean |  |  |

### `sw_configuration`

List the configurations of a managed part/assembly (action list) or activate one (action activate, name) and rebuild; e.g. an assembly configuration "Free" or "Low". Activation is unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `activate` | yes |  |
| `name` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_copy_renamed`

Copy a SAVED assembly, drawing or part plus every file it references into generated\copies\<folder_name>, adding prefix (default copia_) to every file name, and re-link the copies to each other on disk without opening anything. Use it to test on a copy while the user keeps the originals open (SolidWorks cannot open two files with the same name). Verifies every reference resolves inside the new folder; refuses existing folders, missing references and duplicate file names. Open the result with sw_open_project; component names carry the prefix.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `folder_name` | string | yes |  |
| `prefix` | string |  |  |

### `sw_create_assembly`

Create a native assembly from saved managed parts. Each component is placed with translation in mm and optional rotation around global Z in degrees, then FIXED. This is a static assembly, not an assembly with mechanical mates. References the managed part files; keep them with the assembly.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `template` | string | yes |  |
| `components` | array of object | yes |  |

### `sw_create_part`

Create and save an empty native SLDPRT using an existing absolute PRTDOT template. Returns document_id. Does not overwrite files.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `template` | string | yes |  |

### `sw_document_units`

Units saved IN the part/assembly for Calcular > Propiedades fisicas with "Utilizar configuraciones de documento": action get, or set mass_length (default in), mass (default lb), volume (default mm3), decimals (default 4). Switches the unit system to Custom but keeps the linear units and decimals of dimensions unchanged. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `get` \\| `set` | yes |  |
| `mass_length` | `mm` \\| `cm` \\| `m` \\| `in` \\| `ft` |  |  |
| `mass` | `mg` \\| `g` \\| `kg` \\| `lb` |  |  |
| `volume` | `mm3` \\| `cm3` \\| `m3` \\| `in3` \\| `ft3` |  |  |
| `decimals` | integer (>= 0, <= 8) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_environment` (read-only)

Discover installed part templates, material databases, thread profile types and exact sizes, and managed filenames. Does not open or modify documents.

### `sw_exam_ready`

Exam day check in one call, before anything else: MCP version and tool count (if this tool is missing from the chat, the app has an old MCP loaded: restart Claude Desktop), free RAM (under 3 GB SolidWorks crawls), the MCP own SolidWorks (sw_instance) and the generated folder. start:true also starts the MCP own SolidWorks minimized when it is not running (about a minute); without start nothing is opened. last_steps: the last builds, drawings and answer sheets recorded in generated/exam_state.json (to resume after a crash or a restart). prebuild ["M8x30","M6x20"]: builds those ISO bolts with their washer and nut WITHOUT material (about 35 s per size), so in the exam a plan with make or a tornilleria kit only copies them and sets the material.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `start` | boolean |  |  |
| `wait` | boolean |  | With start: false returns at once and SolidWorks starts in the background (read the drawing meanwhile; the first SolidWorks call waits for it). background_jobs shows it and background drawings. |
| `prebuild` | array of string |  |  |

### `sw_import_model`

v3.9 Import a STEP, IGES, Parasolid (x_t/x_b) or ACIS (sat) file as a NEW managed part (name .SLDPRT) or assembly (name .SLDASM, its parts are saved next to it). The source is COPIED to generated/imports and only the copy is read: the original is never opened or changed. Reports solid and surface bodies (surfaces only = no valid mass). Imported geometry has no feature history; assign the material before reading mass. Returns document_id.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `source` | string | yes |  |
| `name` | string | yes |  |

### `sw_instance`

One SolidWorks for the user, one for the MCP. status: which SolidWorks processes exist and which one the MCP uses. start: opens a SECOND SolidWorks only for the MCP, minimized (takes about a minute), so the user keeps working in theirs and files with the same name can be open in both; every chat then uses it. show / minimize: let the user watch it. use_shared: back to working in the user SolidWorks. stop: closes the MCP SolidWorks only if nothing is unsaved. cleanup_orphans: closes SolidWorks processes the MCP started earlier that are still alive after a crash (never the user one, never one with documents outside generated); include_unrecorded also takes ones started before this record existed. start does the recorded cleanup by itself. Nothing starts on its own.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `action` | `status` \\| `start` \\| `show` \\| `minimize` \\| `use_shared` \\| `stop` \\| `cleanup_orphans` |  |  |
| `include_unrecorded` | boolean |  |  |

### `sw_open_copy`

Copy a saved SLDPRT into the managed folder and open the copy for editing. Never overwrites an existing file. Rejects unsaved source documents. Returns document_id.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `source` | string | yes |  |
| `name` | string | yes |  |

### `sw_open_project`

Open a USER part, assembly or drawing in place (outside generated) after an AUTOMATIC BACKUP of the file and every referenced file into generated/backups/<timestamp>_<name> with a manifest. Refuses documents already open with unsaved changes. The returned document_id works with all tools; sw_save writes to the user files. Also refuses when any referenced document is open with unsaved changes, and when references are missing unless allow_missing_references=true. Backups record SHA-256 per file. Restore with sw_restore_backup.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `allow_missing_references` | boolean |  |  |

### `sw_restore_backup`

List backups made by sw_open_project (action=list) or restore one (action=restore, backup_name): copies every backed-up file back to its original path. Refuses while any of those documents is open; snapshots the current files first so a restore can itself be undone.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `action` | `list` \\| `restore` | yes |  |
| `backup_name` | string |  |  |

### `sw_resume_copy`

Reopen a named SLDPRT from the managed generated folder of this server. Does not adopt arbitrary user files. Returns a new session document_id.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

### `sw_resume_document`

Resume an existing managed native part, assembly or drawing by filename. Returns a new session document_id. Part editing tools cannot edit assemblies/drawings.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

### `sw_save`

allow_errors: save anyway, reporting the problems; default refuses to save a model with rebuild errors, invalid sketches, broken mates, missing components or a part without bodies. Rebuild and save only the managed document associated with document_id. Refuses detected feature/sketch errors including absorbed sketches. Returns saved path and inspection. Saves only managed documents or user files authorized by sw_open_project (which backed them up first); blocked after an interference check that altered the document. Assemblies: include_references=true also saves referenced parts/subassemblies marked modified (typically converted from an older SolidWorks version), backing up first any that live outside the managed folder; needed before sw_pack_and_go.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `include_references` | boolean |  |  |
| `allow_errors` | boolean |  |  |

### `sw_save_body`

v3.9 Save ONE solid body of a multibody managed part as a NEW managed part (Guardar cuerpo): pick it with point_mm (a point ON a face of that body, part coordinates) or body_index. The source part is not changed; the new part is opened (document_id) and its volume returned.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `point_mm` | array of number (>= -100000, <= 100000) (3) |  |  |
| `body_index` | integer (>= 0, <= 10000) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_session_health`

Why SolidWorks feels slow: RAM used by SolidWorks and free system RAM, open documents (visible, hidden, unsaved, owned by this MCP session, in use) and hints. action cleanup closes ONLY hidden, saved documents that no visible document uses (leftovers of MCP sessions that died); it never closes a visible or unsaved document. discard_orphans (only in the own SolidWorks of the MCP) also discards unsaved documents of the managed folder that no live chat registered (leftovers of a worker that died).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `action` | `report` \\| `cleanup` |  |  |
| `discard_orphans` | boolean |  |  |

### `sw_status` (read-only)

Check connection to an already-open SolidWorks in this Windows user session. Does not open or modify CAD documents.

## Part modeling

### `sw_chamfer`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Create an angle-distance chamfer on edges given by edge_points_mm (a point on each edge, fastest) or by inspected edge_references. Distance in mm and angle in degrees, strictly between 0 and 90. Tangent propagation defaults false.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `edge_references` | array of string |  |  |
| `edge_points_mm` | array of array of number (3) |  | v3.8 faster: one point ON each edge, world mm (no sw_topology needed); nearest edge within 0.5 mm, a tie is refused |
| `distance_mm` | number (> 0, <= 1000) | yes |  |
| `angle_deg` | number (> 0, < 90) | yes |  |
| `tangent_propagation` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_circular_pattern`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Circular pattern of named features: count instances equally spaced over angle_deg (default 360) around axis X, Y or Z (reference axis created from the default planes) or around axis_edge_reference (circular or linear edge from sw_topology). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `features` | array of string | yes |  |
| `count` | integer (>= 2, <= 360) | yes |  |
| `angle_deg` | number (> 0, <= 360) |  |  |
| `axis` | `X` \\| `Y` \\| `Z` |  |  |
| `axis_edge_reference` | string |  |  |
| `reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_create_cylinder`

Create and save a new native parametric cylinder. Dimensions are millimeters; template is an absolute existing .PRTDOT path. Use explicit user dimensions or clearly labeled demonstration values.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `template` | string | yes |  |
| `radius_mm` | number (> 0, <= 1000) | yes |  |
| `depth_mm` | number (> 0, <= 10000) | yes |  |

### `sw_create_sketch`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Create a 2D sketch from lines, arcs, circles and slots (start/end centers + width) on a reference plane (zero-based tree order: 0 Front, 1 Top, 2 Right, then planes made with sw_ref_plane) OR planar face reference. Coordinates are mm in local sketch XY, not world XY. Default fix_geometry=false leaves ordinary editable geometry; true adds fixed constraints, not driving dimensions. dimension=true instead FULLY DEFINES the sketch with relations and driving dimensions to the origin (SolidWorks Fully Define Sketch) without moving anything, so drawings get complete dimensions via sw_drawing_annotate and sw_set_dimension can change sizes later; if dimensioning fails (sketch moved or not fully defined) the new sketch is deleted and the error says so. Put the part origin at a corner or center of the profile for clean drawing dimensions (they are measured from the origin). dimension and fix_geometry are exclusive. fillets rounds corners and chamfers bevels them (distance, distance+distance2 or distance+angle_deg) at the point where two segments meet (local mm). Returns sketch_normal (world).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `plane_index` | integer (>= 0, <= 50) |  |  |
| `face_reference` | string |  |  |
| `face_point_mm` | array of number (3) |  | v3.8 faster: a point on the planar face (world mm), no sw_topology needed |
| `entities` | array of object or object or object or object | yes |  |
| `fix_geometry` | boolean |  |  |
| `dimension` | boolean |  |  |
| `fillets` | array of object |  |  |
| `chamfers` | array of object |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_cut`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Cut a solid using a closed sketch. mm units; blind requires depth_mm; through_all ignores depth. Prefer direction (+X..-Z) over reverse; start_offset_mm starts away from the sketch plane. Check intersection and expected volume; not saved automatically.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `depth_mm` | number (> 0, <= 10000) |  |  |
| `end_condition` | `blind` \\| `through_all` \\| `through_all_both` \\| `up_to_next` \\| `up_to_surface` \\| `offset_from_surface` | yes |  |
| `reverse` | boolean |  |  |
| `direction` | `+X` \\| `-X` \\| `+Y` \\| `-Y` \\| `+Z` \\| `-Z` |  | World axis the material goes toward (replaces reverse; must be perpendicular to the sketch). |
| `start_offset_mm` | number (>= -10000, <= 10000) |  | Start this many mm from the sketch plane, along the extrusion direction. |
| `depth2_mm` | number (> 0, <= 10000) |  |  |
| `draft_deg` | number (> 0, < 89) |  |  |
| `draft_outward` | boolean |  |  |
| `face_reference` | string |  |  |
| `offset_mm` | number (> 0, <= 10000) |  |  |
| `offset_reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_delete_feature`

Delete a named feature and its absorbed sketch from a managed part (for example a failed attempt), so the FeatureManager tree stays clean. Refused BEFORE deleting when other features depend on it (delete those first). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_delete_relation`

Delete one inspected sketch relation on a managed copy. Require its current index and type from sw_relations. Rebuild and inspect afterwards; not automatically saved.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `index` | integer (>= 0, <= 10000) | yes |  |
| `expected_type` | integer (>= 1, <= 100) | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_draft`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Draft (ángulo de salida, neutral plane): faces in face_references are tilted angle_deg about their edge on the neutral face. Default tilts the faces OUTWARD from the neutral face (part grows away from it); flip=true tilts them inward (measured in batchA-test). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `neutral_face_reference` | string | yes |  |
| `face_references` | array of string | yes |  |
| `angle_deg` | number (> 0, < 90) | yes |  |
| `flip` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_equations` (read-only)

Read equations and global variables from the ACTIVE document, including unsaved parts and active sketches. Requires exact expected_title from the user/current UI. Does not activate, rebuild, evaluate, edit or save. Uncommitted dialog text may be absent. API read status is not a full syntax diagnosis.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `expected_title` | string | yes |  |

### `sw_extrude`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Extrude a closed planar sketch as a solid boss. Length is mm. Default blind, merge=true. Prefer direction (+X..-Z) over reverse. start_offset_mm starts away from the sketch plane. Requires depth_mm. Changes remain unsaved; inspect and save afterwards.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `depth_mm` | number (> 0, <= 10000) |  |  |
| `end_condition` | `blind` \\| `mid_plane` \\| `through_all` \\| `through_all_both` \\| `up_to_next` \\| `up_to_surface` \\| `offset_from_surface` |  |  |
| `reverse` | boolean |  |  |
| `direction` | `+X` \\| `-X` \\| `+Y` \\| `-Y` \\| `+Z` \\| `-Z` |  | World axis the material goes toward (replaces reverse; must be perpendicular to the sketch). |
| `start_offset_mm` | number (>= -10000, <= 10000) |  | Start this many mm from the sketch plane, along the extrusion direction. |
| `depth2_mm` | number (> 0, <= 10000) |  |  |
| `draft_deg` | number (> 0, < 89) |  |  |
| `draft_outward` | boolean |  |  |
| `face_reference` | string |  |  |
| `offset_mm` | number (> 0, <= 10000) |  |  |
| `offset_reverse` | boolean |  |  |
| `merge` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_extrude_edit`

Change an EXISTING extrusion (boss or cut) without redrawing it: end_condition of direction 1 (blind, mid_plane, through_all), depth_mm and/or reverse. Example: a plate extruded mid-plane whose Alzado must be a face so a plane-based mate rests it on another part. Returns the definition before/after and the planar faces it now makes (check which side the material went). Guarded; compare volume before sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `end_condition` | `blind` \\| `mid_plane` \\| `through_all` |  |  |
| `depth_mm` | number (> 0, <= 10000) |  |  |
| `reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_fillet`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Create a constant-radius fillet on edges given by edge_points_mm (a point on each edge, fastest) or by inspected edge_references. radius_mm is mm. Tangent propagation defaults false. Refresh topology after edits.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `edge_references` | array of string |  |  |
| `edge_points_mm` | array of array of number (3) |  | v3.8 faster: one point ON each edge, world mm (no sw_topology needed); nearest edge within 0.5 mm, a tie is refused |
| `radius_mm` | number (> 0, <= 1000) | yes |  |
| `tangent_propagation` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_helix`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Helix (hélice) from a sketch with ONE circle (diameter and centre): pitch_mm and revolutions (height = pitch x revolutions). Use it as the path of sw_sweep (springs, threads). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes | Optional for new features: omit it to keep the SolidWorks default tree name (features are never renamed). Required when referring to an existing feature or sketch. |
| `pitch_mm` | number (> 0, <= 1000) | yes |  |
| `revolutions` | number (> 0, <= 1000) | yes |  |
| `clockwise` | boolean |  |  |
| `reverse` | boolean |  |  |
| `start_angle_deg` | number (>= 0, <= 360) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_hole_wizard`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Hole wizard (asistente para taladro), ISO: type hole (size like Ø6.0), counterbore/countersink/tap (size like M6). point_mm (world mm) must lie on the planar face where the hole starts; depth_mm for blind, omit for through all (tap: blind only). Taps are cut at the MAJOR diameter (M6 -> Ø6) down to the thread depth; SolidWorks picks it (2xD, deeper than a short drill: it can go through the part, a warning says so) unless thread_depth_mm is given (tap; verified, refused if not applied); the answer reports the real definition (drill and thread diameter/depth) and the removed volume; some tap depths (e.g. M6 x 12) give an invalid feature, which the MCP removes and reports. Unknown sizes are refused (in a blind hole SolidWorks would silently use Ø0.16; a through drill hole uses the nominal diameter). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `type` | `hole` \\| `counterbore` \\| `countersink` \\| `tap` | yes |  |
| `standard` | `iso` \\| `ansi_metric` |  | Hole standard (default iso). ansi_metric when the drawing says Ansi Metric (countersink = flat head 82 deg). |
| `size` | string | yes |  |
| `point_mm` | array of number (>= -10000, <= 10000) (3) | yes |  |
| `depth_mm` | number (> 0, <= 10000) |  |  |
| `thread_depth_mm` | number (> 0, <= 10000) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_linear_pattern`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Linear pattern of named features: count instances (including the seed) spaced spacing_mm along axis X, Y or Z or along a linear edge (axis_edge_reference). reverse flips the direction. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `features` | array of string | yes |  |
| `count` | integer (>= 2, <= 1000) | yes |  |
| `spacing_mm` | number (> 0, <= 10000) | yes |  |
| `axis` | `X` \\| `Y` \\| `Z` |  |  |
| `axis_edge_reference` | string |  |  |
| `reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_loft`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Loft (recubrir) through 2-10 closed profile sketches, in order (each on a different plane, e.g. sketches on sw_ref_plane planes). cut=true removes material (loft cut). merge defaults true. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `profiles` | array of string | yes |  |
| `cut` | boolean |  |  |
| `merge` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_mirror`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Mirror named features of a managed part about a reference plane (plane_index: 0 Front, 1 Top, 2 Right, then created planes). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `features` | array of string | yes |  |
| `plane_index` | integer (>= 0, <= 50) | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_move_body`

Mover/Copiar solido: fixes a part modeled on the wrong plane (origin or axes not as in the drawing) WITHOUT redrawing it. rotate_deg [x,y,z] turns the solid bodies about the part X, then Y, then Z axis (one Mover/Copiar each, right-hand rule) through rotate_about_mm (default the origin); translate_mm [dx,dy,dz] moves them after the rotation. Mass and volume do not change (checked); the result gives the center of mass before and after so it can be compared with the drawing (use sw_find_origin first to learn which rotation is needed). Adds Mover/Copiar features at the end of the tree; unsaved until sw_save. Parts only.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `rotate_deg` | array of number (>= -360, <= 360) (3) |  |  |
| `rotate_about_mm` | array of number (3) |  |  |
| `translate_mm` | array of number (>= -100000, <= 100000) (3) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_parameters`

Managed parts only. list is read-only; set_global creates/updates a unitless numeric global variable; link assigns a SolidWorks expression to a full dimension name; unlink preserves its current value; delete_global refuses referenced variables. Linear equations use document units (GetUnits returned), not SI. Changes evaluate, rebuild and verify through Guard.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `set_global` \\| `link` \\| `unlink` \\| `delete_global` | yes |  |
| `name` | string |  |  |
| `value` | number |  |  |
| `dimension` | string |  |  |
| `expression` | string |  |  |

### `sw_part_build`

Build an EDITABLE part from a part IR (part-ir/1): named params (numbers) and expressions (+ - * / ^ ( ) pi sqrt sin cos tan) in features extrude\|cut\|revolve (sketch on front\|top\|right, a previous plane id, or on_face_near [x,y,z]; entities line\|rect\|poly\|circle(d or r)\|arc\|slot, all in sketch mm), fillet\|chamfer (edges [{near:[x,y,z]}] world mm), hole (Hole Wizard: type, size, at, depth), linear_pattern\|circular_pattern\|mirror (of: previous ids), plane (from, offset), shell; material {name}; expect {bodies, volume_mm3, box_mm, tolerance_mm3} as expressions. check: validate and list steps (no SolidWorks). build: every sketch fully dimensioned, each step verified (adds/removes material), optional flex_test (sw_part_flex), then every param becomes a SolidWorks global variable and dimensions that ONE IR expression explains get an equation; returns checks and links (ambiguous ones are listed, not linked). edit (document_id, params): change globals, rebuild, re-check expect recomputed with the new values. Keeps default tree names; unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `reuse` | boolean |  | Build only when no identical IR was already built and saved in generated (then the existing part is returned with reused true). The built part is saved. |
| `action` | `check` \\| `build` \\| `edit` | yes |  |
| `ir` | object |  |  |
| `ir_path` | string |  |  |
| `document_id` | string |  |  |
| `params` | object |  |  |
| `template` | string |  |  |
| `link_parameters` | boolean |  |  |
| `flex_test` | boolean or object |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_part_flex`

Managed parts only. Temporarily perturb driving sketch/feature dimensions by pct (default 0.05, fraction) or absolute delta_mm for lengths; angles use pct on radians. Records rebuild errors, lost sketch definition, bodies and volume. Equation/reference/read-only dimensions are reported without editing. Tests write all configurations, restore their individual original SI values and verify within 1e-12 SI, volume within 1e-6 relative. Geometry is checked in the active configuration. Does not save; Guard restores on failure.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `dimensions` | array of string |  |  |
| `pct` | number (> 0, < 1) |  |  |
| `delta_mm` | number (> 0, <= 100000) |  |  |
| `max_dimensions` | integer (>= 1, <= 500) |  |  |

### `sw_radius_dimension`

Add an explicit driving radius dimension to a current arc segment in a managed sketch. Radius in mm. Rebuild is checked; failed edits may remain unsaved.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `segment` | integer (>= 0, <= 10000) | yes |  |
| `radius_mm` | number (> 0, <= 1000) | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_ref_axis`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Reference axis from a cylindrical face, a linear edge, two planes (plane_index/feature_name) or two vertices (points). Use it for patterns or angled planes.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `references` | array of object | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_ref_plane`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Create a reference plane offset offset_mm from a plane (plane_index) or a planar face (face_reference); flip puts it on the other side. Returns its plane_index for sw_create_sketch and sw_mirror.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `plane_index` | integer (>= 0, <= 50) |  |  |
| `face_reference` | string |  |  |
| `offset_mm` | number (>= 0, <= 10000) | yes |  |
| `flip` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_ref_plane_advanced`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Reference plane from 1-3 references (plane_index, face_reference, edge_reference, point_mm vertex or feature_name of an axis/plane) each with a constraint: distance (value mm), angle (value deg, needs an edge/axis reference too), parallel, perpendicular, coincident, midplane; flip per reference. Returns plane_index.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `references` | array of object | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_relations` (read-only)

Read sketch constraints and status: 2 underdefined, 3 fully defined, 4 overdefined, 5 no solution, 6 invalid. Re-query before deleting a relation.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |

### `sw_revolve`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Revolve a closed sketch profile around the ONE construction line (construction=true) in the same sketch. angle_deg defaults 360. cut=true removes material (revolved cut). The profile must stay on one side of the axis. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `angle_deg` | number (> 0, <= 360) |  |  |
| `cut` | boolean |  |  |
| `reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_rib`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Rib (nervio) from an OPEN sketch: thickness_mm, two_sided (default true), flip_material if it grows away from the walls, normal_to_sketch to extrude perpendicular to the sketch. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes | Optional for new features: omit it to keep the SolidWorks default tree name (features are never renamed). Required when referring to an existing feature or sketch. |
| `thickness_mm` | number (> 0, <= 1000) | yes |  |
| `two_sided` | boolean |  |  |
| `flip_thickness` | boolean |  |  |
| `flip_material` | boolean |  |  |
| `normal_to_sketch` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_scale_uniform`

Uniformly scale a managed copy. This changes EVERY length including holes and thickness; use only when the user authorizes scaling rather than correction to fixed drawing dimensions.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `factor` | number (>= 0.01, <= 100) | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_set_dimension`

Set a named dimension on a managed copy and rebuild. value_si is meters for lengths and radians for angles (0 allowed, e.g. a mate distance). Also works on assembly mate dimensions such as D1@Distancia1. Changes are unsaved until sw_save. Invalid rebuilds are tool errors and may leave the copy modified.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `value_si` | number (>= 0, <= 1000) | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_set_material`

Assign a SolidWorks library material, written as in the drawing in Spanish or English (Hierro dúctil / Ductile Iron, Caucho / Rubber, AISI 304, Oro puro / Pure Gold, AISI 1020…), verified by library id; database defaults to SOLIDWORKS Materials. Part: active configuration. Assembly: component (its part file and referenced configuration change for every instance; save with include_references). A failed assignment keeps the previous material. Does not invent density or override mass.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `database` | string |  |  |
| `material` | string | yes |  |
| `component` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_sheet_metal`

Chapa metálica on a managed part. action base_flange: closed profile sketch (or open + depth_mm) → base flange with thickness_mm, bend_radius_mm (default = thickness), k_factor (default 0.5), reverse. action edge_flange: straight sheet edge given by edge_point_mm (a point ON the edge in part coordinates, not a corner), length_mm, angle_deg (default 90), position material_inside\|material_outside\|bend_outside, flip; the part must be folded. action flatten: flat true (default) unfolds via the Flat-Pattern feature, false folds back. action export_flat: SAVED part → new DXF/DWG of the flat pattern (geometry + bend lines) in generated. v3.9 action sketched_bend (Pliegue croquizado): sketch = a sketch with the bend line drawn on a flat face of the FOLDED sheet, fixed_point_mm = a point on the face that stays put, angle_deg (default 90), position material_inside (default) \| material_outside \| bend_outside, bend_radius_mm (default the sheet radius), flip. action hem (Dobladillo): edge_point_mm on a long straight sheet edge, hem_type closed (default) \| open \| teardrop \| rolled, position inside \| outside, length_mm (closed/open), gap_mm (open), angle_deg and bend_radius_mm (teardrop/rolled), flip. Both are removed again if they fail. Keeps default tree names; unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `base_flange` \\| `edge_flange` \\| `flatten` \\| `export_flat` \\| `sketched_bend` \\| `hem` | yes |  |
| `sketch` | string |  |  |
| `fixed_point_mm` | array of number (>= -10000, <= 10000) (3) |  |  |
| `hem_type` | `closed` \\| `open` \\| `teardrop` \\| `rolled` |  |  |
| `gap_mm` | number (> 0, <= 1000) |  |  |
| `thickness_mm` | number (> 0, <= 100) |  |  |
| `bend_radius_mm` | number (> 0, <= 1000) |  |  |
| `k_factor` | number (> 0, < 1) |  |  |
| `depth_mm` | number (> 0, <= 10000) |  |  |
| `reverse` | boolean |  |  |
| `edge_point_mm` | array of number (>= -10000, <= 10000) (3) |  |  |
| `length_mm` | number (> 0, <= 10000) |  |  |
| `angle_deg` | number (> 0, <= 360) |  |  |
| `position` | `material_inside` \\| `material_outside` \\| `bend_outside` \\| `inside` \\| `outside` |  |  |
| `flip` | boolean |  |  |
| `flat` | boolean |  |  |
| `name` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_shell`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Shell (vaciado): hollow the part to thickness_mm, removing the faces in face_references (from sw_topology; none = closed hollow). outward=true adds the wall outside. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `thickness_mm` | number (> 0, <= 1000) | yes |  |
| `face_references` | array of string |  |  |
| `outward` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_sketch` (read-only)

Read sketch segments, their current indexes, coordinates in meters and relation types. Re-query after each edit; indexes are not stable identifiers.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |

### `sw_sketch_plane`

Move an existing sketch onto another planar support (Editar plano de croquis) without redrawing it: face_of_sketch (the face/plane another sketch sits on), plane (reference plane name) or face_reference (sw_topology). Exactly one target. Use it when a sketch shows a ? warning because its support no longer exists (coplanar_from rebuilds that same plane before the sketch and checks the sketch did not move). A datum plane that comes later in the history is reordered before the sketch. Parts only, no 3D sketches. Guarded: compare volume against a rebuild without changes before saving.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `face_of_sketch` | string |  |  |
| `coplanar_from` | string |  | Datum plane parallel to the sketch: a new offset plane through the sketch current plane is inserted before the sketch (lost support) |
| `plane` | string |  |  |
| `face_reference` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_suppress_feature`

Suppress or unsuppress a named feature in the active configuration of a managed part and rebuild. Dependent features may also change. Create a checkpoint first when recovery is needed.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `suppressed` | boolean | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_sweep`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Sweep (barrido) a closed profile sketch along a path (open sketch or helix feature) that starts on the profile plane. circular_diameter_mm sweeps a round section without a profile sketch (boss only). cut=true removes material. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `profile` | string |  | Optional for new features: omit it to keep the SolidWorks default tree name (features are never renamed). Required when referring to an existing feature or sketch. |
| `path` | string | yes | Optional for new features: omit it to keep the SolidWorks default tree name (features are never renamed). Required when referring to an existing feature or sketch. |
| `circular_diameter_mm` | number (> 0, <= 1000) |  |  |
| `cut` | boolean |  |  |
| `merge` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_tangent`

Add a relation between two current sketch segment indexes; default is tangent. Select the same index twice for a single-entity horizontal or vertical constraint. Re-inspect first; failed constraints may leave unsaved changes. No arbitrary script execution.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes |  |
| `first` | integer (>= 0, <= 10000) | yes |  |
| `second` | integer (>= 0, <= 10000) | yes |  |
| `constraint` | `sgTANGENT` \\| `sgCONCENTRIC` \\| `sgCORADIAL` \\| `sgPARALLEL` \\| `sgPERPENDICULAR` \\| `sgSAMELENGTH` \\| `sgHORIZONTAL` \\| `sgVERTICAL` |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_thread`

Keeps the SolidWorks default tree name (features are never renamed); the response returns it. Create a REAL modeled thread (method cut = removes the profile, default; extrude = adds the profile outward, SolidWorks Extruir rosca) on a circular cylindrical edge using an installed profile and exact size from sw_environment. Native library geometry; do not assume manufacturing suitability. depth_mm in mm, right_handed defaults true, reverse defaults false. Verify direction, feature errors and volume.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `edge_reference` | string | yes |  |
| `profile_type` | string | yes |  |
| `size` | string | yes |  |
| `depth_mm` | number (> 0, <= 1000) | yes |  |
| `right_handed` | boolean |  |  |
| `reverse` | boolean |  |  |
| `method` | `cut` \\| `extrude` |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

## Assemblies

### `sw_add_mate`

Add a mate (relación): coincident, concentric, distance (distance_mm), parallel, perpendicular, angle (angle_deg), symmetric (3 entities: 2 + plane), width (4 entities), screw (pitch_mm), tangent. Entities: {component, plane} (component reference plane such as Alzado/Planta/Vista lateral), {component, local_point_mm, kind face\|edge} = the face/edge of that component through a point in the PART coordinates (robust, preferred), {assembly_plane}, or {point_mm, kind} picked like a click at a world point (view dependent). align closest (default), aligned or anti_aligned; flip. Keeps SolidWorks default mate names. Returns error_code/is_warning of the new mate and moved_components (origin and axes after solving) so you can verify the side it chose; a failed mate is deleted, never left half-made.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `type` | `coincident` \\| `concentric` \\| `distance` \\| `parallel` \\| `perpendicular` \\| `angle` \\| `symmetric` \\| `width` \\| `screw` \\| `tangent` | yes |  |
| `entities` | array of object | yes |  |
| `align` | `closest` \\| `aligned` \\| `anti_aligned` |  |  |
| `flip` | boolean |  |  |
| `distance_mm` | number (>= 0, <= 10000) |  |  |
| `angle_deg` | number (>= 0, <= 360) |  |  |
| `angle_min_deg` | number (>= 0, <= 360) |  | Limit angle mate: with angle_max_deg the part moves only inside [min, max] (e.g. a valve 0 closed to 90 open); angle_deg is the start value |
| `angle_max_deg` | number (>= 0, <= 360) |  |  |
| `distance_min_mm` | number (>= 0, <= 10000) |  | Limit distance mate: with distance_max_mm the part slides only inside [min, max] |
| `distance_max_mm` | number (>= 0, <= 10000) |  |  |
| `pitch_mm` | number (> 0, <= 1000) |  |  |
| `lock_rotation` | boolean |  |  |
| `expect` | object |  | v3.11 where the moved component ORIGIN must end (assembly mm). If the mate lands on the other side it is retried flipped once; if still wrong it is deleted and the call fails with both positions. |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_assembly_batch`

Low-level batch used by sw_assembly_build: insert components [{id,path,fixed,position_mm\|transform,configuration}] and add mates [{name,type,entities (component = plan id),align,flip,distance_mm,angle_deg,...}] in ONE call with one safe-edit check. Prefer sw_assembly_build.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `components` | array of object |  |  |
| `mates` | array of object |  |  |
| `stop_on_error` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_assembly_build`

Batch assembly compiler. check validates without SolidWorks. build uses parts_dir plus plan, never overwrites generated/assemblies/<name>.SLDASM, inserts components and creates mates in order, then coordinate systems and units, saves, verifies mates/assembly_doctor/mass_check, and calls interference LAST (never saves afterwards). On mate failure returns zero-based index, plan name, error and previous moved_components; continue_on_error continues only while the worker outcome is known. Plan: {ir:"assembly-ir/1",name,components:[{id,file,fixed?,position_mm?,transform?,configuration?}],mates:[{name?,type,entities:[{component,plane}\|{assembly_plane}\|{component,local_point_mm,kind:"face"\|"edge"}],align?,flip?,distance_mm?,angle_deg?,pitch_mm?,lock_rotation?,suppressed?}],coordinate_systems?:[{name?,origin_mm,x_axis,y_axis}],units?:{mass_length,mass,volume,decimals},expect?:{mates?,mass?:{value,units:"g"\|"kg"\|"lb"},com?:[{coordinate_system,value:[x,y,z],length_units:"mm"\|"cm"\|"m"\|"in"}],interferences_mm3?:[]}}. Mate types: coincident/concentric/distance/parallel/perpendicular/angle/tangent/screw need 2 entities; symmetric 3, width 4. distance needs distance_mm, angle angle_deg, screw pitch_mm. Prefer align aligned/anti_aligned; closest warns. transform is rigid ArrayData 16 in SI and preserves exported orientation; position_mm must agree if both supplied. Coordinate system names are logical aliases mapped to new default tree names; expect can also use one-based #1, #2. Mass/CM tolerance defaults 0.5 percent (CM also 0.05 mm absolute); interference comparison is an unordered multiset within 1 percent or 0.05 mm3. Verdict pass means all requested numerical/health checks passed, not visual/material certification. No renaming. v3.8 tornilleria: component {id, make:{type:"bolt"\|"washer"\|"nut"\|"countersunk", size:"M3".."M20", length_mm (bolt; overall for countersunk), material}} generates the ISO 4017/7089/4032/10642 part (countersunk head goes flush with head_side) in generated (simplified: no thread) if missing; mate {intent:"fastener", bolt, washer?, nut?, nut_washer?, size?, hole:{component,find}, head_side:{component,find plane}, nut_side, repeat?} expands to seat (coincident anti_aligned) + coaxial (concentric) for each piece, with # and index # per repeat. Kits: plan.kits {name:{components, mates with "@slot"}} and mate {use:name, at:{hole, head_side, nut_side}, repeat, material}; save_kits writes plan.kits to generated/kits/<name>.json to reuse later; built-in kits tornilleria_M8x30 (bolt+washer+nut), tornillo_tuerca_M8x30, tornillo_rondana_M8x30, tornillo_M8x30. v3.8 patterns: plan.patterns [{kind:"circular"\|"linear", seeds:[component ids already mated], count (including the seeds), axis\|direction:{component id, local_point_mm, kind:"face"\|"edge"}, total_angle_deg\|spacing_mm, reverse}] run after the mates with sw_component_pattern: mate only the seeds (24 pegs = 4 seeds and one circular pattern instead of 48 mates; measured 49 s instead of 130 s). Interferences under 0.05 mm3 are round-off and only warn; a pattern instance outside the box of the components that existed before it fails (pattern_outside, try reverse). expect.symmetric ["x","y"] checks CM = 0 on the symmetry axes of a symmetric drawing (needs no reference values). check returns expanded counts.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `action` | `check` \\| `build` | yes |  |
| `plan` | object | yes |  |
| `parts_dir` | string |  |  |
| `continue_on_error` | boolean |  |  |
| `fix_unsupported` | boolean |  |  |
| `batch` | boolean |  |  |
| `auto_origins` | boolean |  |  |
| `save_kits` | boolean |  |  |
| `defer_rebuild` | boolean |  | One rebuild after the last mate instead of one per mate (every mate is still checked by name). Measured gain is small; default off. |
| `drawing` | object |  | v3.8: large build results come back summarized for the chat (verdict, answers, times, differences, warnings, a summary per verification); the complete result is in details_file. One call: after a passing build also make the assembly drawing (same options as sw_assembly_drawing, name optional). With answers the drawing runs in the background by default (background:false waits): mass and CM come back about 40 s earlier and sw_exam_ready shows the finished drawing. times gives the seconds of every part, the assembly, the answers and the drawing. plan.parts may list part-ir/1 parts to build first (reused when unchanged). |
| `reuse_parts` | boolean |  | plan.parts: reuse a part whose IR is unchanged (0 s). false builds every part again from zero. |
| `answers` | object |  | v3.8 one call: after the build also run sw_answer_sheet with these options (create, mass_units, length_units, decimals). |
| `tolerance_percent` | number (> 0, <= 50) |  |  |
| `keep_open` | boolean |  | v3.11: do not close hidden saved leftovers at the end (default: they are closed to keep SolidWorks fast) |

### `sw_assembly_diff` (read-only)

READ-ONLY: compare two SAVED assemblies (path = yours, reference_path = e.g. the original): components matched by file then nearest position, position (mm) and rotation (deg) differences, configuration and suppression, mate signatures (type + joined files) and values, mass, volume and center of mass, with a verdict. Each assembly is opened read-only and closed in turn, so both may use parts with the same names; refuses if another file with the same name is open (close it first). relative_to_file compares positions in the frame of a component present in both (for assemblies with different origins). configuration / reference_configuration pick configurations.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `reference_path` | string | yes |  |
| `tolerance_mm` | number (> 0, <= 100) |  |  |
| `tolerance_deg` | number (> 0, <= 90) |  |  |
| `relative_to_file` | string |  |  |
| `configuration` | string |  |  |
| `reference_configuration` | string |  |  |

### `sw_assembly_doctor` (read-only)

Read-only assembly diagnosis: missing references, mate errors, duplicate candidates and remaining component movements. Does not rebuild; a flipped valid mate needs a design reference.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `include_dofs` | boolean |  |  |
| `only_problems` | boolean |  |  |

### `sw_assembly_draft` (read-only)

No SolidWorks: from an assembly drawing (PDF, via analyze) and the folder of parts, a plan skeleton for sw_assembly_build: components with file and count from the parts table (base component fixed), expect with total mass, every center of mass (coordinate system #n and units) and the interference list, expected_materials for sw_mass_check, and a check that the table masses x quantity add up to the total. Mates are left empty to write by intention; v3.8 adds hole_callouts (4x Ø8 on the drawing) and suggested_mates (a fastener intent with repeat when the table has tornillo/rondana/tuerca; faces marked ? are to be filled from the drawing).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `drawing` | string | yes |  |
| `parts_dir` | string |  |  |
| `name` | string |  |  |

### `sw_assembly_drawing`

Drawing of an assembly or of a PART in ONE call (a part gets no BOM or balloons but its model dimensions, center marks and hole callouts on the three views; dimensions:false skips them; its note defaults to g, mm, 2 decimals): new drawing generated/drawings/<name>.SLDDRW (never overwritten), sheet size (default A3 landscape) and title block from format_path or COPIED read-only from format_from_drawing, properties for the title block, front + top + side views in first angle (default, ISO) or third angle, a shaded isometric (exploded:true uses the assembly exploded view), ONE standard scale that fits (or scale), BOM with MATERIAL and MASA columns, balloons (v3.9: parts hidden in every view get a section view through the front view with their balloons; section:false skips it), a note with the answers (mass and every CM, as sw_answer_sheet with mass_units, length_units, decimals, coordinate_systems), sheet scale 1:1, save and PDF. Give document_id of an open saved assembly or assembly_path. Returns the PDF path, views, scale, BOM rows, answers and warnings; review the PDF for overlaps.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string |  |  |
| `assembly_path` | string |  |  |
| `name` | string | yes |  |
| `size` | `A4` \\| `A3` \\| `A2` \\| `A1` \\| `A0` \\| `letter` \\| `tabloid` |  |  |
| `width_mm` | number (>= 50, <= 5000) |  |  |
| `height_mm` | number (>= 50, <= 5000) |  |  |
| `orientation` | `landscape` \\| `portrait` |  |  |
| `first_angle` | boolean |  |  |
| `format_path` | string |  |  |
| `format_from_drawing` | string |  |  |
| `format_sheet` | string |  |  |
| `properties` | object |  |  |
| `exploded` | boolean |  |  |
| `scale` | number (> 0, <= 100) |  |  |
| `bom` | boolean |  |  |
| `balloons` | boolean |  |  |
| `section` | boolean |  |  |
| `dimensions` | boolean |  |  |
| `answers` | boolean |  |  |
| `mass_units` | `g` \\| `kg` \\| `lb` |  |  |
| `length_units` | `mm` \\| `cm` \\| `m` \\| `in` |  |  |
| `decimals` | integer (>= 0, <= 8) |  |  |
| `coordinate_systems` | array of string |  |  |
| `note_height_mm` | number (>= 1, <= 20) |  |  |
| `pdf` | boolean |  |  |
| `close` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_assembly_export` (read-only)

Read-only export of an open managed assembly as assembly-ir/1, also written to generated/assembly_ir/<name>.json. Components preserve instance ids, paths, configurations, fixed states and rigid Transform2 (ArrayData 16, SI). Mates follow tree order and use explicit alignment/flip plus component planes or unambiguous interior face/edge points in part mm. Unsupported references have kind:unsupported and a reason; warnings must be reviewed before build. Units use the document_units set shape; expect is empty.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |

### `sw_assembly_new`

Create and save a NEW empty assembly at an absolute .SLDASM path (folder must exist; never overwrites). Returns document_id for sw_insert_component / sw_add_mate / sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `template` | string | yes |  |

### `sw_assembly_repair`

Repair an assembly WITHOUT losing its intended pose. snapshot (name): store every component transform, center of mass, broken mates and constrained status of the good assembly. compare (name): current state vs that snapshot: moved/rotated components, added/missing components, CM shift, newly broken or fixed mates, components whose freedom changed. fix_mates: searches in rounds for mate changes that remove the errors, among broken mates AND mates flagged over-defined (the intruder is often the warned one): keep the mate first (flip dimension side, aligned, anti_aligned, closest), suppress it only with allow_suppress (reported as suppressed_mates). With reference=<snapshot> a solution is accepted only if every error is gone AND the pose matches that snapshot (always pass it when you have a good state); without it, only if nothing outside the changed mates moves. Everything is simulated first; apply=false (default) reports and leaves nothing changed. Then run sw_assembly_doctor to confirm the free movements.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `snapshot` \\| `compare` \\| `fix_mates` | yes |  |
| `name` | string |  |  |
| `apply` | boolean |  |  |
| `allow_suppress` | boolean |  |  |
| `mates` | array of string |  |  |
| `reference` | string |  |  |
| `tolerance_mm` | number (> 0, <= 10) |  |  |
| `tolerance_deg` | number (> 0, <= 10) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_collision`

Collision detection (detección de colisiones) on a managed assembly: drive an existing DISTANCE or ANGLE mate (create it first with sw_add_mate on the free degree of freedom) from its current value toward `to` (mm or degrees, ≥ 0) and stop at the FIRST CONTACT: a new interfering component pair (pairs already interfering at the start are ignored; components limits which pairs count) or the mechanical limit where the mates can no longer be solved. Coarse steps (step, default 1/20 of the travel) then bisection to tolerance (default 0.01); a contact thinner than one step can be skipped, so use a step smaller than the thinnest part that could collide. max_evaluations (default 300) caps the work. Returns result collision\|mechanical_limit\|no_contact, contact_value, the colliding pairs and the center of mass at contact; restores the start value unless stay_at_contact. Unsaved.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `mate` | string | yes |  |
| `to` | number (>= 0, <= 100000) | yes |  |
| `step` | number (> 0, <= 100000) |  |  |
| `tolerance` | number (>= 0.0001, <= 100) |  |  |
| `components` | array of string |  |  |
| `stay_at_contact` | boolean |  |  |
| `max_evaluations` | integer (>= 5, <= 5000) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_component_pattern`

Pattern TOP-LEVEL assembly components (patrón de componentes). kind linear: seeds, count (including the seed), spacing_mm, direction = a straight edge {component, local_point_mm (in that part coordinates), kind: edge}, reverse. kind circular: seeds, count, axis = a cylindrical face or straight/circular edge {component, local_point_mm, kind}, total_angle_deg (default 360, equal spacing), reverse. Verifies the number of new instances and that no mate broke, otherwise deletes the pattern. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `kind` | `linear` \\| `circular` | yes |  |
| `seeds` | array of string | yes |  |
| `count` | integer (>= 2, <= 500) | yes |  |
| `spacing_mm` | number (> 0, <= 100000) |  |  |
| `direction` | object |  |  |
| `axis` | object |  |  |
| `total_angle_deg` | number (> 0, <= 360) |  |  |
| `reverse` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_component_solving`

Make a TOP-LEVEL, resolved SUBASSEMBLY component flexible (its own mates solve in the top assembly, so its parts can move — e.g. a cylinder whose piston slides) or rigid again. Keeps and verifies suppression, visibility, configuration, BOM and envelope settings. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `component` | string | yes |  |
| `solving` | `flexible` \\| `rigid` | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_coordinate_system`

kind circle_center puts the origin at the centre of the circular edge (hole) through local_point_mm; axes {x,y} orients it freely (e.g. exam drawings with a rotated system). List, create or delete coordinate systems in a managed part or assembly. Set the drawing ORIGEN without moving the assembly; pass the returned default name to sw_mass_check coordinate_system. Origin: point_mm in model coordinates, or local_point_mm in a part; in assemblies also give component and kind vertex\|edge\|face (point in PART coordinates, on exactly one entity). Axes default to model X/Y/Z; flip_x/y/z reverse them (unsupported combinations fail verification and are removed). Numerical origins are NOT linked to geometry and do NOT follow moving components. Optional linked:true requires a vertex and creates an associative origin; axes are checked against model axes at creation. Origin and axes are verified after rebuild; failed creations are deleted, never suppressed. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `create` \\| `delete` | yes |  |
| `name` | string |  |  |
| `point_mm` | array of number (3) |  |  |
| `local_point_mm` | array of number (3) |  |  |
| `component` | string |  |  |
| `kind` | `vertex` \\| `edge` \\| `face` \\| `circle_center` |  |  |
| `linked` | boolean |  |  |
| `flip_x` | boolean |  |  |
| `flip_y` | boolean |  |  |
| `flip_z` | boolean |  |  |
| `axes` | object |  | Directions of the new X and Y axes in the document (assembly) frame; Z = X cross Y. Verified exactly after creation. Not with linked/flip_*. |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_delete_mate`

Delete assembly mates by exact name (from sw_mates list) and verify they are gone. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `names` | array of string | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_edit_mate`

Edit an existing assembly mate WITHOUT deleting it: distance_mm (distance mate), angle_deg (angle mate), flip_dimension (side of a distance/angle), align aligned\|anti_aligned\|closest (distance, angle, concentric, coincident, parallel), lock_rotation (concentric). Reverted automatically if the mate ends with an error; returns moved_components so you can check the result. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |
| `distance_mm` | number (>= 0, <= 100000) |  |  |
| `angle_deg` | number (>= 0, <= 360) |  |  |
| `flip_dimension` | boolean |  |  |
| `align` | `aligned` \\| `anti_aligned` \\| `closest` |  |  |
| `lock_rotation` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_explode`

Exploded view (vista explosionada) of the active configuration of a managed assembly. action create: steps [{components, direction X\|Y\|Z (assembly axes) or a straight edge / planar face {component, local_point_mm, kind}, distance_mm, reverse}] in order; replace=true rebuilds an existing one; each step is verified (its components must move exactly distance_mm) and a failure removes the whole exploded view; it is left collapsed unless keep_exploded. action list \| show \| collapse \| delete. Save the assembly before showing it in a drawing. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `create` \\| `list` \\| `show` \\| `collapse` \\| `delete` | yes |  |
| `steps` | array of object |  |  |
| `replace` | boolean |  |  |
| `keep_exploded` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_find_faces` (read-only)

Read-only: faces of an assembly component described like the drawing says, instead of a point: kind cylinder (diameter_mm, axis) or plane (normal outward, offset_mm), near_mm (PART coordinates) to rank, tol_mm (default 0.02). Descriptions instead of numbers (v3.11): extreme +z (top face), inclined, feature name, pick largest\|smallest\|outermost. Returns candidates with an interior local_point_mm on that face only. In sw_assembly_build plans use {component, find:{...}} or intents (insert/face_to_face/flush/coaxial).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `component` | string |  | Omit to search every component in one call |
| `kind` | `cylinder` \\| `plane` |  |  |
| `diameter_mm` | number (> 0) |  |  |
| `axis` | array of number (3) |  |  |
| `normal` | array of number (3) |  |  |
| `offset_mm` | number |  |  |
| `near_mm` | array of number (3) |  |  |
| `tol_mm` | number (> 0, <= 10) |  |  |
| `extreme` | `+x` \\| `-x` \\| `+y` \\| `-y` \\| `+z` \\| `-z` |  | v3.11 the outermost plane facing that part axis (+z = the top face) |
| `inclined` | boolean |  | v3.11 only faces NOT aligned with a part axis (chamfers, sloped faces, inclined holes) |
| `feature` | string |  | v3.11 only faces made by this feature (tree name) |
| `pick` | `largest` \\| `smallest` \\| `outermost` |  | v3.11 order the matches and take the first: by area, or largest diameter / farthest plane |

### `sw_find_origin`

The drawing gives a center of mass but not where its origin is nor how its axes point: tries every component origin and every hole/shaft axis point with the 24 axis-aligned orientations and ranks them by how well they reproduce center_of_mass (length_units, default in). Returns best, runner-up error and top 8; create:true makes that coordinate system and re-checks the CM (unsaved until sw_save); it refuses when the best error exceeds max_error (default 0.5 percent of the CM distance) or when another system ties (accept_ambiguous:true to create anyway). Several drawing CMs at once: center_of_mass [[x,y,z],[x,y,z]] (faces read once).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `center_of_mass` | array of number or array of number (3) | yes |  |
| `length_units` | `mm` \\| `cm` \\| `m` \\| `in` or array of `mm` \\| `cm` \\| `m` \\| `in` |  |  |
| `mass_units` | `g` \\| `kg` \\| `lb` |  |  |
| `holes` | boolean |  |  |
| `create` | boolean |  |  |
| `accept_ambiguous` | boolean |  |  |
| `max_error` | number (> 0) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_insert_component`

Insert a part or subassembly (absolute path) into an assembly with its ORIGIN at position_mm (default 0,0,0, no rotation; optional rigid transform ArrayData 16 in SI overrides position, configuration selects the referenced configuration); fixed=true fixes it (use for the base component). Returns the component name (e.g. Abrazadera-1).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `path` | string | yes |  |
| `position_mm` | array of number (>= -10000, <= 10000) (3) |  |  |
| `fixed` | boolean |  |  |
| `transform` | array of number (16) |  |  |
| `configuration` | string |  |  |
| `fit_box` | object |  | v3.11 place by the component box: along axis (assembly x\|y\|z) the component (with its rotation) spans from_mm..to_mm; its length must match (tolerance_mm, default 0.05) or nothing is inserted. Replaces that coordinate of position_mm/transform. |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_insert_components`

v3.11 several components in ONE call (no full tree per insert): items [{path, position_mm \| transform \| fit_box, fixed, configuration}]. Returns each component name, the assembly mass and center of mass. If one item fails, the ones this call inserted are removed. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `items` | array of object | yes |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_interference`

Detect interferences in a managed ASSEMBLY: count, total volume mm^3 and component pairs. The SolidWorks interference manager can move under-defined components, so every component transform is saved before and restored after. Never saves. If anything moved, the result says so: do not save; close without saving and resume. treat_coincidence defaults false; max_pairs limits the listed pairs (default 200). Each pair explains itself: kind (overlap = one part inside another, reproducible from the drawing; sliver or tiny = near-zero clearance or a part shifted hundredths of mm, fragile; fastener), thickness_mm, box_mm, center_mm. Do not change geometry or mates to chase fragile reference values. expected_count (the number the teacher gives) adds count_matches and count_hint with where to look.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `treat_coincidence` | boolean |  |  |
| `expected_count` | integer (>= 0, <= 1000) |  |  |
| `max_pairs` | integer (>= 1, <= 1000) |  |  |

### `sw_mass_override`

Override the mass (and optionally the center of mass, in mm in this document coordinates) of a part or assembly, ONLY when the drawing specifies it (e.g. a note "Ensamblaje 1: Masa 50 g, Centro de masa (15,20,25)"). Never to hide a modelling error. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `mass_g` | number (> 0, <= 1000000) | yes |  |
| `center_of_mass_mm` | array of number (>= -10000, <= 10000) (3) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_mates`

Managed ASSEMBLY mates. action=list returns every mate with type, components, suppressed state, error code and whether it references assembly-level geometry (planes, origin or assembly sketches such as layout sketches; these anchor components and block moving the whole assembly), plus fixed components and counts; only_problems filters to errors and assembly-geometry mates. action=suppress\|unsuppress changes the named mates (all names must exist or nothing changes), rebuilds and returns the problem summary. Changes are unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `suppress` \\| `unsuppress` | yes |  |
| `names` | array of string |  |  |
| `only_problems` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_move_component`

Place an UNDER-DEFINED assembly component: its origin at position_mm and rotation rotation_deg [rx,ry,rz] (world X then Y then Z), or axes = the component X,Y,Z unit axes in world coordinates (9 numbers, as in sw_inspect transforms). Use it to pre-orient a part before mating (so closest alignment picks the right side) or to drive a free degree of freedom. Reports held_by_mates when existing mates pull it back. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `component` | string | yes |  |
| `position_mm` | array of number (>= -100000, <= 100000) (3) | yes |  |
| `rotation_deg` | array of number (>= -360, <= 360) (3) |  |  |
| `axes` | array of number (>= -1, <= 1) (9) |  |  |
| `allow_fixed` | boolean |  | v3.11: move a FIXED top-level component (it is unfixed, placed and fixed again) |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_replace_component`

Replace a TOP-LEVEL component of a managed assembly with another file of the same kind (part→part, assembly→assembly), keeping and re-attaching its mates; all_instances replaces every instance of the old file; configuration picks one of the new file. Refuses when the old or new file has unsaved changes (SolidWorks may close it). Verifies exactly which instances changed; a partial replace blocks saving. Reports mates that could not re-attach (mates_with_new_errors). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `component` | string | yes |  |
| `new_path` | string | yes |  |
| `all_instances` | boolean |  |  |
| `configuration` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

## Drawings and reading drawings

### `sw_answer_sheet`

Exam answers ready to copy: total mass and the center of mass in EVERY coordinate system of the model (default all, in tree order Sistema de coordenadas1, 2...; or coordinate_systems), in mass_units (default lb) and length_units (default in), rounded half-up to decimals (default 4), as text lines plus the raw values. Warns when a part has no material, a mass override, is hidden or suppressed, or when there is no coordinate system (the CM would come from the model origin). set_document_units also sets the units of Propiedades fisicas in the document (unsaved until sw_save). Writes a copy to generated/answers. Read-only otherwise, except create: a list of systems to create first (origin point_mm in model coordinates, or component + local_point_mm + kind vertex\|edge\|face\|circle_center; axes {x, y} as the drawing shows them, e.g. {x:"+Y", y:"+Z"}; label as the drawing names it), then the answers come in exactly those (unsaved until sw_save).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `create` | array of object |  |  |
| `mass_units` | `g` \\| `kg` \\| `lb` |  |  |
| `length_units` | `mm` \\| `cm` \\| `m` \\| `in` |  |  |
| `decimals` | integer (>= 0, <= 8) |  |  |
| `coordinate_systems` | array of string |  |  |
| `include_model_origin` | boolean |  |  |
| `set_document_units` | boolean |  |  |
| `expected_materials` | array of object |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_balloons`

Automatic balloons (globos) with BOM item numbers on the assembly views of a managed drawing (views, default all assembly views of the active sheet), layout square\|circle\|top\|bottom\|left\|right. Skips views that already have balloons unless add_to_existing. Reports the balloons per view and BOM items left without a balloon; insert the BOM first (sw_bom) so numbers match. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `views` | array of string |  |  |
| `layout` | `square` \\| `circle` \\| `top` \\| `bottom` \\| `left` \\| `right` |  |  |
| `add_to_existing` | boolean |  |  |
| `auto` | boolean |  | false: no automatic balloons, only fill_missing |
| `fill_missing` | boolean |  | BOM items with no balloon anywhere on the sheet get one by hand on the first given view where an edge of that part is visible |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_bom`

Bill of materials (lista de materiales / BOM) on a managed DRAWING. action insert: on an assembly view (view, default the first assembly view) with type top_level\|parts_only\|indented, template (absolute .sldbomtbt, default SolidWorks bom-standard), position_mm [x,y] = its top-left corner on the sheet (default 20 mm inside the top-left corner; use_format_anchor=true uses the sheet format BOM anchor if it has one), and extra columns [{title, property}] linked to properties such as SW-Material, SW-Mass or the parts own custom properties. action read: every BOM of every sheet with its model, configuration, cells, item numbers and files. SW-Material / SW-Mass columns are written as values per row (instance configuration, mass per unit) because SolidWorks 2026 shows linked system properties as $PRP:; re-run after changing parts. A failure while adding columns removes the new BOM. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `insert` \\| `read` | yes |  |
| `view` | string |  |  |
| `type` | `top_level` \\| `parts_only` \\| `indented` |  |  |
| `template` | string |  |  |
| `position_mm` | array of number (>= -10000, <= 10000) (2) |  |  |
| `anchor` | `top_left` \\| `top_right` |  | top_right: position_mm is the top-right corner of the table (keeps a wide BOM inside the sheet) |
| `drop_empty_columns` | boolean |  |  |
| `use_format_anchor` | boolean |  |  |
| `columns` | array of object |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_create_drawing`

Create a native drawing with three standard orthographic views of a SAVED managed part/assembly using a DRWDOT template. Projection must be explicit. Does not add dimensions, tolerances or fill the title block; output needs drafting review.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `template` | string | yes |  |
| `model_name` | string | yes |  |
| `projection` | `first_angle` \\| `third_angle` | yes |  |

### `sw_drawing_annotate`

Add the MODEL dimensions to drawing views (Insert Model Items: dimensions marked for drawing; include_unmarked adds the rest) and optional automatic center marks on holes (center_marks, slot_center_marks) and hole callouts (hole_callouts: one per Hole Wizard feature per view where the hole is seen end-on; include_cut_holes adds plain cut holes). views limits it to named views of the active sheet (default all). By default keeps each model dimension in only its first view (remove_repeated) and applies SolidWorks auto-arrange spacing (auto_arrange). Reports dimensions gained per view and any dimension still repeated. Imported dimensions can overlap: export the PDF and review. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `dimensions` | boolean |  |  |
| `include_unmarked` | boolean |  |  |
| `center_marks` | boolean |  |  |
| `slot_center_marks` | boolean |  |  |
| `remove_repeated` | boolean |  |  |
| `auto_arrange` | boolean |  |  |
| `hole_callouts` | boolean |  |  |
| `include_cut_holes` | boolean |  |  |
| `views` | array of string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_drawing_dimension`

v3.10 Manual dimensions on a managed DRAWING view (Cota inteligente). action probe: the visible edges of sheet+view, each with an index, kind (line, circle, arc, curve), length or diameter, ends/centre in MODEL mm and on the SHEET mm (kind filters, max_edges limits). action add: edges = one index (length of a line, diameter/radius of a circle) or two (distance between lines, angle); type smart (default, SolidWorks picks), horizontal, vertical, diameter, radius, angle; position_mm = text position on the sheet (default 12 mm outside the edge). Returns the measured value (mm or deg). v3.11 action auto: for geometry without model dimensions (imported STEP/DXF), overall width and height from the outermost straight edges plus one diameter per distinct circle size (with its count). Indexes are valid until the view or model changes. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `probe` \\| `add` \\| `auto` | yes |  |
| `max_circles` | integer (>= 1, <= 100) |  | auto: at most this many distinct circle sizes (default 12) |
| `sheet` | string | yes |  |
| `view` | string | yes |  |
| `kind` | `line` \\| `circle` \\| `arc` \\| `curve` |  |  |
| `max_edges` | integer (>= 1, <= 1000) |  |  |
| `edges` | array of integer (>= 0, <= 100000) |  |  |
| `type` | `smart` \\| `horizontal` \\| `vertical` \\| `diameter` \\| `radius` \\| `angle` |  |  |
| `position_mm` | array of number (>= -5000, <= 5000) (2) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_drawing_new`

Low-level, used by sw_assembly_drawing: empty drawing from a DRWDOT template with a width_mm x height_mm sheet, saved at an absolute path inside generated/drawings (never overwritten).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `template` | string | yes |  |
| `width_mm` | number (>= 50, <= 5000) | yes |  |
| `height_mm` | number (>= 50, <= 5000) | yes |  |

### `sw_drawing_note`

Text notes on the active (or named) sheet of a managed drawing, not attached to a view: one note per line in lines, top-left at position_mm [x,y] from the sheet bottom-left, height_mm per line (default 3.5); each is read back. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `lines` | array of string | yes |  |
| `position_mm` | array of number (>= 0, <= 5000) (2) | yes |  |
| `height_mm` | number (>= 1, <= 20) |  |  |
| `sheet` | string |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_drawing_read` (read-only)

v3.8 action dimensions (PDF exported by SolidWorks, one page): for every linear dimension its direction (horizontal, vertical), its view (found from the geometry, no labels needed) and the TWO POINTS OF THE PART it measures (from_part_mm, to_part_mm from the lower-left corner of the view), checked against the scale of its view (voted by the dimensions; inches detected); radii and diameters with the centre of their circle in part mm (center_part_mm; a number next to a circle of that diameter is reported as a diameter even when the diameter symbol is drawn instead of written); angles with their vertex (vertex_part_mm) and the two ray directions; the title block material clean (materials[0].raw, ir_material); plus an annotated PNG with every dimension drawn in colour. Use it before modeling: it answers from where each dimension measures. START WITH action analyze (v3.6): the whole PDF in ONE call (all text, one render per page, every view found by its label cropped with its dimension candidates, key lines: mass, center of mass, interferences, materials, notes) or, for a phone photo, an enhanced image plus zoomed overlapping tiles (tiles 1-4 per side); cached by file content. DXF (v3.3): text gives texts, hole callouts inside block inserts (with the real Ø symbol) and DIMENSION entities whose value is RECOMPUTED from their definition points (dimensions[]). v3.9 DXF: dimensions gives the same records as for a PDF but EXACT (definition points, true value = sheet distance x DIMLFAC of its style, so a 1:4 view reads 150 and not 37.5), views found from the geometry (frame and title block set apart, SECCION/DETALLE labels, scale per view), and a PNG; render draws the DXF from its geometry (no page image). Prefer a DXF over a PDF when both exist. DWG must be exported to DXF first. Read objective drawing evidence without SolidWorks. info: pages, size, text/image presence; text: PDF words, estimated boxes in mm (top-left), dimension candidates requiring visual verification; render: PNG crop/zoom with optional coordinate grid. Never infers missing dimensions or physical scale.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `page` | integer (>= 1) |  |  |
| `action` | `info` \\| `text` \\| `render` \\| `analyze` \\| `dimensions` | yes |  |
| `tiles` | integer (>= 1, <= 4) |  |  |
| `crop` | boolean |  |  |
| `region_mm` | array of number (>= 0) (4) |  |  |
| `region_px` | array of number (>= 0) (4) |  |  |
| `width_px` | integer (>= 1, <= 3000) |  |  |
| `grid` | boolean |  |  |

### `sw_drawing_sheets`

Sheets of a managed DRAWING. action list. action add (new sheet) / setup (existing sheet): name, size A4\|A3\|A2\|A1\|A0\|letter\|tabloid or width_mm+height_mm, orientation landscape\|portrait, first_angle (default true, ISO), and the title block / sheet format from format_path (.slddrt) or COPIED from another drawing with format_from_drawing (+format_sheet) — that drawing is only opened read-only, never modified; the sheet scale stays 1:1. action activate: name. action properties: values {name: text} = drawing custom properties shown by title-block notes. action add_view: model_path (part/assembly), view_orientation isometric\|front\|top\|right\|back\|bottom\|left, position_mm [x,y] on the sheet, scale (decimal, 0.5 = 1:2), display shaded\|hidden_lines_removed\|hidden_greyed\|wireframe, exploded (assembly exploded view, re-linked so it really shows exploded), on sheet (default active). Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `add` \\| `setup` \\| `activate` \\| `properties` \\| `add_view` | yes |  |
| `name` | string |  |  |
| `size` | `A4` \\| `A3` \\| `A2` \\| `A1` \\| `A0` \\| `letter` \\| `tabloid` |  |  |
| `width_mm` | number (>= 50, <= 5000) |  |  |
| `height_mm` | number (>= 50, <= 5000) |  |  |
| `orientation` | `landscape` \\| `portrait` |  |  |
| `first_angle` | boolean |  |  |
| `format_path` | string |  |  |
| `format_from_drawing` | string |  |  |
| `format_sheet` | string |  |  |
| `values` | object |  |  |
| `sheet` | string |  |  |
| `model_path` | string |  |  |
| `view_orientation` | `isometric` \\| `front` \\| `top` \\| `right` \\| `back` \\| `bottom` \\| `left` |  |  |
| `position_mm` | array of number (>= -5000, <= 5000) (2) |  |  |
| `scale` | number (> 0, <= 100) |  |  |
| `display` | `shaded` \\| `hidden_lines_removed` \\| `hidden_greyed` \\| `wireframe` |  |  |
| `exploded` | boolean |  |  |
| `flat_pattern` | boolean |  | v3.9: add_view of the FLAT PATTERN of a sheet metal part (vista desplegada) with bend lines |
| `hide_bend_lines` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_drawing_views`

DRAWING sheets and views. action=list: every sheet (size mm, sheet scale) with its views (model, orientation, scale, display mode, exploded, outline mm, dimension/balloon/note counts). action=set: on one sheet+view change scale (decimal, e.g. 0.25 = 1:4), display (shaded = mode 3 with edges, hidden_lines_removed, hidden_greyed, wireframe) and/or center_mm [x,y] on the sheet; attached dimensions and notes move and scale with the view. action=fix_sheet_scale: set every sheet scale to 1:1 keeping each view scale (inserting views changes the sheet scale and shrinks frames/title blocks). action=section (v3.9): section view of sheet+view cut by a straight line, direction horizontal or vertical on the sheet, through_mm = a point in MODEL coordinates the cut passes through (e.g. a hole centre; default the middle of the view), label (default next free letter), position_mm of the new view on the sheet (default beside the parent), flip reverses the viewing direction. action=detail (v3.10): detail view (vista de detalle) of sheet+view: a circle of radius_mm (MODEL mm) around through_mm (MODEL point; default the middle of the view), magnified to scale (default twice the parent scale, e.g. 2 = 2:1), label (default next free letter), position_mm or the nearest free spot of the sheet. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `action` | `list` \\| `set` \\| `fix_sheet_scale` \\| `section` \\| `detail` | yes |  |
| `radius_mm` | number (> 0, <= 10000) |  |  |
| `through_mm` | array of number (>= -100000, <= 100000) (3) |  |  |
| `direction` | `horizontal` \\| `vertical` |  |  |
| `label` | string |  |  |
| `position_mm` | array of number (>= -5000, <= 5000) (2) |  |  |
| `flip` | boolean |  |  |
| `sheet` | string |  |  |
| `view` | string |  |  |
| `scale` | number (> 0, <= 100) |  |  |
| `display` | `shaded` \\| `hidden_lines_removed` \\| `hidden_greyed` \\| `wireframe` |  |  |
| `center_mm` | array of number (>= -5000, <= 5000) (2) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_measure_sheet`

Measurement sheet (ficha de medidas) of ONE part read from a drawing. Every entry needs its source: pdf_text (number read from the PDF text inside bbox_mm - re-checked against the PDF), vision (read on a sw_drawing_read render; bbox_mm/region_px is the evidence), derived (formula over other ids) or note. Never invent: unreadable = status blurry/missing WITHOUT value; values that disagree = contradictory with notes. SolidWorks draws the diameter/depth symbols as lines: take the number as pdf_text and set source.symbol to vision. validate: checks it, lists plan dimensions not used, writes generated\fichas\<part>.json/.md. compare_model (document_id of the part): matches each value against the model dimensions, body box (dims with overall x\|y\|z) and material.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string |  |  |
| `action` | `validate` \\| `compare_model` | yes |  |
| `sheet` | object | yes |  |
| `tolerance_mm` | number (> 0, <= 5) |  |  |
| `tolerance_deg` | number (> 0, <= 5) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

## Verification, export and delivery

### `sw_boundary`

v3.11 Recubrir por limite (Boundary boss/cut): like sw_loft but each profile influences the whole shape, giving smoother transitions; profiles = 2-10 closed sketches in order (different planes), guides = optional open sketches in the second direction that touch every profile; cut=true removes material; merge defaults true. Returns volume before/after. Unsaved until sw_save. EXPERIMENTAL: in SolidWorks 2026 SP3.2 the API returned null for profiles that sw_loft accepts (tested); if it fails, use sw_loft with the same sketches.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `profiles` | array of string | yes |  |
| `guides` | array of string |  |  |
| `cut` | boolean |  |  |
| `merge` | boolean |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_combine`

v3.10 Combinar bodies of a multibody managed part (Insertar > Operaciones > Combinar). operation add (merge into one), subtract (main body minus tool bodies) or common (keep only the shared volume). Pick bodies by a point ON one of their faces (main_point_mm, tool_points_mm, part mm) or by index (main_index, tool_indexes, order of sw_inspect bodies). subtract needs the main body; tools default to every other body. add/common default to all bodies. Returns bodies and volume before/after. Unsaved until sw_save.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `operation` | `add` \\| `subtract` \\| `common` | yes |  |
| `main_point_mm` | array of number (>= -100000, <= 100000) (3) |  |  |
| `main_index` | integer (>= 0, <= 10000) |  |  |
| `tool_points_mm` | array of array of number (>= -100000, <= 100000) (3) |  |  |
| `tool_indexes` | array of integer (>= 0, <= 10000) |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |

### `sw_compare_volume` (read-only)

Compare measured solid volume against a positive target in mm^3 with an explicitly supplied tolerance percent. Positive signed error means excess volume. Does not modify geometry or infer a permitted tolerance.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `target_mm3` | number (> 0, <= 1000000) | yes |  |
| `tolerance_percent` | number (>= 0, <= 100) | yes |  |

### `sw_export`

Export complete managed part/assembly to NEW STEP, STL, Parasolid or IGES, or drawing to PDF, DXF or DWG, in generated (sheet metal flat patterns: sw_sheet_metal export_flat). Uses current SolidWorks export preferences; STEP/Parasolid preferred for precise solids, STL is a mesh. Refuses overwrites.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |

### `sw_export_batch`

v3.9 Export several documents to several formats in ONE call: every document_id in document_ids to every format in formats (parts/assemblies: step, stl, x_t, igs; drawings: pdf, dxf, dwg; a format that does not apply to a document is skipped and reported). Files go to generated as <title>_<suffix>.<ext>, never overwritten.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_ids` | array of string | yes |  |
| `formats` | array of `step` \\| `stl` \\| `x_t` \\| `igs` \\| `pdf` \\| `dxf` \\| `dwg` | yes |  |
| `suffix` | string |  |  |

### `sw_feature_info` (read-only)

Read-only definition of one feature to understand a warning/error the API only reports as a code: type, error/warning, suppression, parents and children; extrusions: end conditions, depths, both directions, reverse, merge, thin, start (from), scope; sketches: what it sits on, status, segments, contours, construction count.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `name` | string | yes |  |

### `sw_geometry` (read-only)

Read faces, edges, circular radii and bounding boxes of a managed solid. Coordinates and radii are meters; face area is mm^2.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |

### `sw_inspect` (read-only)

Inspect managed document. Parts: volume mm^3, mass grams, material, mass override, body boxes meters, feature errors, sketch status including absorbed sketches, dimensions SI. Assemblies: components, fixed placements, volume and mass. Drawings: sheets and active sheet views. Missing material means mass uses default density.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |

### `sw_mass_check` (read-only)

READ-ONLY mass and center-of-mass verification of a part or assembly (exam check: masa y centro de masa X,Y,Z). Reports mass, volume, density and center of mass in length_units mm\|cm\|m\|in and mass_units g\|kg\|lb, optionally relative to a coordinate_system of the model; compares with reference {mass, volume_mm3, center_of_mass [x,y,z]} from the drawing with mass_tolerance_percent (default 0.5 = user rule: under 0.5 % is not corrected) and, per center-of-mass component, com_tolerance_percent of the drawing value (default 0.5) OR com_tolerance absolute (default 0.05 mm in length_units), whichever is larger; lists every part (material, density, count, mass per instance, overrides, hidden/suppressed/lightweight) and possible causes of a difference (unit mix-up, origin offset, swapped axes, missing/extra parts, density a part would need, hidden components). expected_materials [{part, material}] checks each part against the drawing table material (Spanish or English SolidWorks library name, e.g. Hierro dúctil = Ductile Iron; same library id or density). With no reference values (exam day) use it plus coordinate_system (sw_coordinate_system at the drawing ORIGIN). Never changes dimensions or materials to force a result.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `length_units` | `mm` \\| `cm` \\| `m` \\| `in` |  |  |
| `mass_units` | `g` \\| `kg` \\| `lb` |  |  |
| `coordinate_system` | string |  |  |
| `reference` | object |  |  |
| `mass_tolerance_percent` | number (> 0, <= 50) |  |  |
| `com_tolerance` | number (> 0, <= 1000) |  |  |
| `com_tolerance_percent` | number (> 0, <= 50) |  |  |
| `expected_materials` | array of object |  |  |

### `sw_pack_and_go`

Pack and Go a SAVED managed assembly or drawing into generated/packs/<folder_name> (flattened, includes referenced parts), then verify that every referenced file exists inside the package and optionally create <folder_name>.zip. Refuses existing destinations. Returns failures, missing references, sizes and how many stored last-saved paths still point elsewhere (informational; an isolated open loads from the package folder).

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `folder_name` | string | yes |  |
| `zip` | boolean |  |  |

### `sw_part_diff` (read-only)

Read-only comparison of a managed PART against an original .SLDPRT (absolute path, opened read-only through a temporary copy): volume, mass, material, solid body count, solid box mm, features added/removed, combine operations (add/subtract) and every changed dimension (SI). Use it to prove what changed versus measured originals. Does not modify either file.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `original_path` | string | yes |  |

### `sw_preview`

PNG preview(s) returned as images: a managed part/assembly in one or more standard views (views, default [iso]) or the whole current drawing sheet. v3.10 label_faces (parts): every visible face gets a number on the pictures and faces[] gives, per number, its kind (plane, cylinder...), area, diameter and point_mm, a point ON that face (part mm) to pass as face_point_mm / point_mm to other tools; hidden faces are not labelled. Changes the view orientation; writes uniquely named files.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `views` | array of `iso` \\| `front` \\| `back` \\| `left` \\| `right` \\| `top` \\| `bottom` \\| `trimetric` \\| `dimetric` |  |  |
| `label_faces` | boolean |  |  |
| `max_labels` | integer (>= 1, <= 150) |  |  |

### `sw_session_recipe` (read-only)

v3.11 Record what this session does and turn it into a recipe the next chat can follow (MCP resource solidworks://recipe/<id>). start {name}: from now on every successful call that changes something is noted (inspections and previews are left out; document ids become file names). status: steps so far. export {id?, name?, description?, notes?, overwrite?, keep_recording?}: writes recipes/<id>.md with the steps (JSON arguments ready to reuse) and what failed. stop: discard the recording.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `action` | `start` \\| `status` \\| `stop` \\| `export` | yes |  |
| `name` | string |  |  |
| `id` | string |  |  |
| `description` | string |  |  |
| `notes` | string |  |  |
| `overwrite` | boolean |  |  |
| `keep_recording` | boolean |  |  |
| `restart` | boolean |  |  |

### `sw_topology` (read-only)

Inspect faces and unique edges with short-lived selection references. Coordinates are meters, areas mm^2. References are document-specific and expire after changes or a new topology query. Use these references for fillets, chamfers, threads and face sketches.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |

### `sw_wrap`

v3.11 Envolver: wrap a closed sketch onto a face of the part. sketch = sketch on a plane parallel or tangent to the face; face_point_mm = a point ON the target face (part mm, e.g. from sw_find_faces or sw_preview label_faces); type emboss (raised, default), deboss (engraved) or scribe (split lines only, no depth); depth_mm for emboss/deboss; reverse flips the side; method analytical (cylinders, cones, extruded faces; default) or spline (any face). Returns volume before/after. Unsaved until sw_save. EXPERIMENTAL: in SolidWorks 2026 SP3.2 the API returned null for profiles that sw_loft accepts (tested); if it fails, use sw_loft with the same sketches.

| Option | Type / values | Required | Notes |
|---|---|---|---|
| `document_id` | string | yes |  |
| `sketch` | string | yes | Optional for new features: omit it to keep the SolidWorks default tree name (features are never renamed). Required when referring to an existing feature or sketch. |
| `face_point_mm` | array of number (>= -100000, <= 100000) (3) | yes |  |
| `type` | `emboss` \\| `deboss` \\| `scribe` |  |  |
| `depth_mm` | number (> 0, <= 1000) |  |  |
| `reverse` | boolean |  |  |
| `method` | `analytical` \\| `spline` |  |  |
| `keep_broken` | boolean |  | Keep the result even if it breaks other features/mates (default: it is undone automatically and verified). sw_save then refuses to save until fixed. |
