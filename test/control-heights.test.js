// A field is as tall as the button beside it.
//
// docs/styling.md promises this in so many words: a `<textinput>`'s box is
// its capitals rather than its line box, so padding it with the palette's
// `paddingY` gives "exactly the height a `<Button>` and a `<Select>` have,
// because all three are now the same sum". It was off by one.
//
// The cap band reached yoga as a float. A `<textinput>` is a leaf whose
// measure *is* the band, so that float went into its outer height and was
// rounded up there; a `<Button>`'s label is a trimmed `<text>` and lands on a
// whole pixel first. The two agree when the cap height's fraction is above a
// half and disagree by one when it is below, which is why this went unseen:
// **the face these tests have always used has a fraction of .562**, and the
// system faces a user actually sees do not. Arial is .028 and Helvetica
// likewise, so on XQuartz every field in every example was a pixel too tall.
//
// Hence the deliberately odd choice of face below. It is not about Fraktur;
// it is the one in the fixtures whose cap height lands on the wrong side of
// the half. Swap it for KaTeX_Main-Regular and these tests pass whether or
// not the bug is present, which is how it survived this long.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { renderX11, cleanup, screen } from '../src/testing/index.js';
import { Button } from '../src/index.js';

const require = createRequire(import.meta.url);
const fontsDir = path.join(
  path.dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
/** cap height 10.206 at 14px — fraction .206, below the half. */
const FONTS = {
  'sans-serif': path.join(fontsDir, 'KaTeX_Fraktur-Regular.ttf'),
};
/** cap height 9.562 — fraction .562, above it. Agrees either way. */
const FONTS_EVEN = {
  'sans-serif': path.join(fontsDir, 'KaTeX_Main-Regular.ttf'),
};

const h = React.createElement;

afterEach(cleanup);

/** The recipe docs/styling.md gives, and nothing else. */
const FIELD = {
  paddingTop: '$paddingY',
  paddingBottom: '$paddingY',
  paddingLeft: 10,
  paddingRight: 10,
  borderWidth: '$borderWidth',
  borderColor: '$border',
};

const row = () =>
  h(
    'box',
    { style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
    h('textinput', { placeholder: 'field', style: FIELD }),
    h(Button, null, 'Send'),
  );

test('a field padded with $paddingY is exactly a Button tall', async () => {
  await renderX11(row(), { width: 400, height: 120, fonts: FONTS });

  const field = screen.getByPlaceholder('field');
  const button = screen.getByRole('button');

  assert.equal(
    field.abs.height,
    button.abs.height,
    `field ${field.abs.height} vs button ${button.abs.height}`,
  );
});

test('and on a face whose cap height rounds the other way', async () => {
  await renderX11(row(), { width: 400, height: 120, fonts: FONTS_EVEN });

  const field = screen.getByPlaceholder('field');
  const button = screen.getByRole('button');
  assert.equal(field.abs.height, button.abs.height);
});

// Not tested here, though it was the obvious thing to write: that the band
// itself is a whole number. `contentBox()` rounds on the way out, so the
// assertion held while the float was still reaching yoga underneath it —
// green either way, and no use to anyone.
