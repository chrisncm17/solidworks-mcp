// v3.19 surfaces-only mode: when the user says "superficies", a part is made with the Surfaces tab only (and sketches,
// reference geometry and curves). sw_surface {action:'mode', on:true} turns it on for one document; from then on every tool of
// the Features tab refuses that document until it is turned off.
export const FEATURE_TAB = new Set([
  'extrude', 'extrude_edit', 'cut', 'create_cylinder', 'revolve', 'loft', 'sweep', 'boundary', 'shell', 'chamfer',
  'linear_pattern', 'circular_pattern', 'mirror', 'hole_wizard', 'rib', 'draft', 'dome', 'wrap', 'combine', 'thread',
  'part_build', 'part_flex', 'sheet_metal', 'scale_uniform', 'move_body',
]);
const surfacesOnly = new Set();
const reply = (ok, body) => ({ isError: !ok, content: [{ type: 'text', text: JSON.stringify(ok ? { ok, result: body } : { ok, error: body }) }] });

// returns a response when the call is decided here (mode switch or refused), null when it goes on to SolidWorks
export function surfacesModeCall(operation, args) {
  if (operation === 'surface' && args.action === 'mode') {
    if (typeof args.on !== 'boolean') return reply(false, 'mode needs on: true or false');
    if (args.on) surfacesOnly.add(args.document_id); else surfacesOnly.delete(args.document_id);
    return reply(true, { document_id: args.document_id, surfaces_only: args.on, refused_tools: args.on ? [...FEATURE_TAB].map(o => 'sw_' + o) : [] });
  }
  if (args?.document_id && surfacesOnly.has(args.document_id) && FEATURE_TAB.has(operation))
    return reply(false, `sw_${operation} is in the Features tab and this part is surfaces-only: use sw_surface (extrude, revolve, planar, loft, sweep, trim, knit, thicken, cut_with_surface...). Turn it off with sw_surface {action:"mode", on:false} only if the user asks.`);
  return null;
}
export function surfacesOnlyDocuments() { return [...surfacesOnly]; }
