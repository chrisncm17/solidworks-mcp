// MCP resources: short guides ("recipes") that tell an agent how to use this server for a task. Every *.md file in
// server/recipes (or in SW_MCP_RECIPES_DIR) is one resource: solidworks://recipe/<file name without .md>; its front matter
// gives the name and description. Add a file to add a recipe. Only files of that folder can be read through here.
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.env.SW_MCP_RECIPES_DIR ?? fileURLToPath(new URL('./recipes/', import.meta.url));
const ID = /^[a-z0-9-]+$/;

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), out = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = /^(\w+):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, ''); }
  return out;
}

export function recipes() {
  let files = [];
  // regular files only, physically inside the folder: a symbolic link named like a recipe is never followed
  let real; try { real = realpathSync(DIR); files = readdirSync(DIR).filter(f => f.endsWith('.md') && ID.test(f.slice(0, -3)) && lstatSync(join(DIR, f)).isFile() && dirname(realpathSync(join(DIR, f))) === real).sort(); } catch { return []; }
  return files.map(f => { const fm = frontMatter(readFileSync(join(DIR, f), 'utf8')); return { id: f.slice(0, -3), file: f, name: fm.name ?? f.slice(0, -3), description: fm.description ?? '' }; });
}

export const resourceList = () => recipes().map(r => ({ uri: `solidworks://recipe/${r.id}`, name: r.name, description: r.description, mimeType: 'text/markdown' }));

export async function readRecipe(uri) {
  const m = /^solidworks:\/\/recipe\/([a-z0-9-]+)$/.exec(String(uri));
  const r = m && recipes().find(x => x.id === m[1]);
  if (!r) throw new Error(`Unknown recipe: ${uri}`);
  const text = await readFile(join(DIR, r.file), 'utf8');
  return { contents: [{ uri, mimeType: 'text/markdown', text }] };
}
