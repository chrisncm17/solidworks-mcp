# Architecture

```
server/
  server.mjs            MCP server (stdio): tool list, argument validation, dispatch, MCP resources (recipes)
  tools.mjs             the 106 tool schemas (Ajv, strict) + cross-argument checks (argumentError)
  worker-client.mjs     starts Worker-equations.exe, one JSON line per call, serial queue, timeouts = unknown outcome
  part_ir.mjs           part-ir/1 compiler: recipe -> sketches/features -> verified part (sw_part_build)
  assembly_build.mjs    assembly-ir/1: parts, intents, fasteners, kits, patterns, origins, verification (sw_assembly_build)
  assembly_drawing.mjs  one-call drawing: sheet, views, scale, BOM, balloons, section for hidden parts, answers, PDF
  answers.mjs           mass / CM answer lines in the requested units
  drawing_read.mjs      PDF / image / DXF reading (info, text, render, analyze, dimensions)
  dims_geometry.mjs     "from where does each dimension measure" on SolidWorks PDFs (+ pdf_lines.py, dims_overlay.py)
  dxf.mjs, dxf_geometry.mjs   DXF parser, geometry by line type, views, exact dimensions, picture (dxf_render.py)
  drawing_analyze.mjs   whole-PDF / photo analysis (render-pdf*.ps1, image_enhance.py, view_grow.py, contact_sheet.py)
  measure_sheet.mjs     measurement sheet validation and model comparison
  find_origin.mjs       drawing coordinate systems deduced from CM values
  fasteners.mjs         ISO bolt / washer / nut recipes
  exam_ready.mjs        background SolidWorks start, warm-up, readiness report
  export_batch.mjs      documents x formats export
  compact.mjs           large results summarized for the chat (full JSON in generated/build_reports)
  recipes.mjs + recipes/*.md   MCP resources: how-to guides for agents
  build.ps1             compiles worker/*.cs into Worker-equations.exe
  worker/*.cs           the C# worker (one partial class Worker, one file per area)
  tests.mjs             offline tests (schemas, compilers, readers, worker protocol with fakes)
  generated/            everything the MCP creates (ignored by git)
```

## The worker
`Worker.cs` reads `{operation, arguments}` lines and writes `{ok, result | error}`. It attaches to SolidWorks through COM (`SldWorks.Application`), runs on an STA thread and holds a named mutex so two MCP clients never edit at once. Each area is a `TryXxx(op, args, doc, out result)` in its own file (`Modeling.cs`, `Assembly2.cs`, `Drawings.cs`, `SheetMetal.cs`, ...).

## Safe edits (`Guard.cs`, `Health.cs`)
Every editing call on a document goes through `Guarded()`:
1. a health snapshot before (feature errors, broken sketches, suppressed features, mates, components, volume);
2. the edit;
3. a rebuild and a second snapshot; anything that got worse is a **regression** and the document is restored (from a copy or by reopening from disk) and the restore is verified;
4. if the restore cannot be verified, saving that document is blocked until it is closed and reopened.
Documents created by the MCP in this session use a light version (no copy) for speed.

## Files
The MCP only edits documents it created in `server/generated`, copies it made, or user files opened with `sw_open_project`, which first copies the file and every reference to `generated/backups/<time>_<name>` with SHA-256 hashes (`sw_restore_backup` puts them back). Imports always read a copy.

## Adding a tool
1. Schema in `server/tools.mjs`: `tool('name', 'precise description with units and limits', {properties}, [required])`; cross-argument rules in `argumentError`.
2. Implementation: a C# `TryXxx` in `server/worker/` (any new `.cs` file there is compiled automatically) or a JS module routed in `server.mjs` for high-level tools.
3. `npm run build`, `npm test`, a script in `examples/` that proves it in SolidWorks, then `npm run tools` to refresh `docs/TOOLS.md`.
