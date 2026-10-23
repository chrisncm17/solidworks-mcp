# Contributing

Thanks for helping. The project is easy to change: every file is plain source (JavaScript, C#, Python, PowerShell), nothing is generated except the worker exe.

## Set up
See [docs/INSTALL.md](docs/INSTALL.md): `npm install`, `npm run build`, `npm test`.

## Rules that keep it safe
- Never edit a user's original file without the automatic backup (`sw_open_project`); new results go to `server/generated`.
- Every editing worker operation runs through `Guarded()` (health check, rollback). Do not bypass it.
- Keep SolidWorks' default feature names (no renaming in the tree).
- A new tool needs: schema + description with units, an offline test in `server/tests.mjs` when possible, and an example script that proves it in SolidWorks.
- Run `npm run tools` so `docs/TOOLS.md` matches the code.

## Ideas welcome
Toolbox fasteners, origin at datum intersections with chamfered corners, reading GD&T and hole symbols, mechanism drag studies, drawing editing (moving views, avoiding balloon overlap), other languages for SolidWorks plane/view names.

## Releasing a new version
1. Update `CHANGELOG.md` (newest on top) and the version in `package.json` (semantic versioning: new tools = minor, fixes = patch, breaking schema changes = major).
2. `npm test`, run the examples you touched.
3. Commit, then tag and push:
   ```powershell
   git tag v3.10.0
   git push origin main --tags
   ```
4. On GitHub: Releases -> Draft a new release -> pick the tag -> paste the changelog section.
