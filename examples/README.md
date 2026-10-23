# Examples

Each script drives the worker directly (no MCP client needed), starts the MCP's own minimized SolidWorks, prints what it measured and closes everything it opened. Run from this folder after `npm run build`:

```powershell
node pegboard_one_call.mjs
```

| Script | What it shows |
|---|---|
| `pegboard_one_call.mjs` | 4 parts from recipes + 32-component assembly + circular pattern + answers + drawing in ONE `sw_assembly_build` call, timed per phase (`REUSE=1` reuses the parts). |
| `roller_conveyor.mjs` | Rollers, rails and plates with linear patterns; `PATRON=1 REV=1 REV2=1` exercises pattern direction checks. |
| `swivel_caster.mjs` | A swivel caster built from scratch. |
| `mcp_protocol_flow.mjs` | The real MCP protocol over stdio, like a chat client: start SolidWorks, read a drawing, build, background drawing. |
| `mate_point_snap.mjs` | A mate point 0.2 mm off a face snaps (warning); 2 mm off gives the nearest faces. |
| `section_views.mjs` | Section views through a hole, on a part and an assembly. |
| `auto_section_balloons.mjs` | A hidden pin gets a section view with its balloon automatically. |
| `import_export.mjs` | Batch export, then STEP/IGES/x_t import with identical mass and CM; assembly STEP round trip. |
| `sheet_metal.mjs` | Base flange, sketched bend, hem, flat-pattern drawing view, save body. |
| `dxf_sample_drawing.mjs` | Makes `drawings/support_plate` (PDF + DXF of the same drawing) used by the tests. |

`drawings/support_plate.pdf` / `.dxf` is a drawing made by this MCP: `sw_drawing_read action: dimensions` on both is a quick way to compare PDF and DXF reading.
