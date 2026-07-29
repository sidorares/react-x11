// Font setup for the playground bundle. The browser has no fontconfig, so
// the demos run on a StaticFontSource loaded with DejaVu faces, installed as
// the process-wide default (setDefaultFontSource) before any demo code runs.
//
// react-x11 measures text through a yoga measure function that calls ntk's
// FontManager, so without this every <text> would lay out 0x0 — the same
// thing that happens in the headless smoke tests, where the mock app has no
// `fonts`.
//
// The faces are fetched as separate files rather than embedded in the
// bundle: 3.6 MB of base64 TTF was most of the bundle's parse cost, and the
// five files are cached independently and downloaded in parallel.
// `build-demo-bundles.mjs` copies them next to the bundle, so they resolve
// against `import.meta.url` and work under any base path.
import { StaticFontSource, setDefaultFontSource } from 'ntk';

import { FONT_FILES, FONT_ALIASES } from './demo-font-files.mjs';

async function fetchFont(file) {
  const url = new URL(`./fonts/${file}`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

let installed = null;

/**
 * Install the DejaVu faces as the default font source. `read(file)` is an
 * injection point so the node-side bundle check can supply the bytes from
 * disk, where `fetch` has no file:// support.
 */
export async function setupFonts({ read = fetchFont } = {}) {
  if (installed) return installed;
  const source = new StaticFontSource();
  const faces = await Promise.all(FONT_FILES.map((f) => read(f.file)));
  FONT_FILES.forEach((f, i) => source.add(faces[i], { family: f.family }));
  for (const [alias, family] of Object.entries(FONT_ALIASES))
    source.alias(alias, family);
  setDefaultFontSource(source);
  installed = source;
  return source;
}
