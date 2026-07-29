// Gate for shareable playground links (src/lib/share.mjs). A share link has
// no server behind it — the snippet *is* the URL — so the codec is the whole
// feature, and a link that stops decoding breaks silently and permanently
// for anyone who already pasted it somewhere.
//
// Checks: every built-in demo round-trips byte for byte; the resulting URLs
// stay short enough to paste; malformed input is rejected rather than
// half-decoded; and the plain fallback (browsers without CompressionStream)
// round-trips too.
//
//   node scripts/check-share.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import { encodeShare, decodeShare, shareUrl } from '../src/lib/share.mjs';

const websiteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const demosDir = path.join(websiteDir, 'src', 'demos');

// Demo modules are browser ESM ({ export default {...} }, no imports).
function loadDemo(file) {
  const src = fs.readFileSync(file, 'utf8');
  return new Function(`${src.replace(/^export default/m, 'return')}`)();
}

// A URL people paste into chat clients and issue trackers. Browsers take
// far more than this, but an HTTP request line has to fit the front-end
// server's header buffer (8 KB is the usual default), so half of that is
// the point where a demo has grown too big to share rather than too big to
// load.
const MAX_URL = 4096;

const files = fs
  .readdirSync(demosDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();
assert.ok(files.length > 0, 'no demos found');

const location = {
  origin: 'https://sidorares.github.io',
  pathname: '/react-x11/playground',
};

let longest = 0;
for (const file of files) {
  const demo = loadDemo(path.join(demosDir, file));
  const encoded = await encodeShare(demo.code);
  assert.strictEqual(
    await decodeShare(encoded),
    demo.code,
    `${demo.id} did not round-trip`,
  );
  assert.match(encoded, /^[dp][A-Za-z0-9_-]+$/, `${demo.id} is not URL-safe`);

  const url = await shareUrl(demo.code, location);
  longest = Math.max(longest, url.length);
  assert.ok(
    url.length <= MAX_URL,
    `${demo.id}: share URL is ${url.length} chars, over ${MAX_URL}`,
  );
}

// The fallback path: browsers without CompressionStream get scheme 'p'.
{
  const source = "const x = '<box style={{ gap: 4 }} />';\n";
  const plain = 'p' + Buffer.from(source, 'utf8').toString('base64url');
  assert.strictEqual(await decodeShare(plain), source, 'plain scheme');
}

// Hostile or stale input must throw, not produce garbage: the caller falls
// back to the built-in demos and says the link was unreadable.
for (const bad of ['', 'd', 'x' + 'AAAA', 'dnot-valid-deflate', 'z123']) {
  await assert.rejects(
    () => decodeShare(bad),
    `decodeShare(${JSON.stringify(bad)}) should reject`,
  );
}
await assert.rejects(
  () => encodeShare('x'.repeat(70 * 1024)),
  /over the .* byte limit/,
  'oversized snippets are refused up front',
);

console.log(
  `share links ok (${files.length} demos round-trip, longest URL ${longest} chars)`,
);
