// Text correctness: the same paragraph set in every combination the style
// channel offers, plus the three rich-content elements next to each other so
// their metrics can be compared by eye.
//
// What to look for:
//   - wrapping at the column edge, not one word early or late
//   - `lineHeight` spacing the lines without clipping ascenders/descenders
//   - italic and bold actually resolving to different faces (they fall back
//     to the regular face when the font source has no such variant — that is
//     a font problem, not a layout one)
//   - the bidi line reading right-to-left with the Latin word left-to-right
//     inside it, and its punctuation on the correct end
//   - <tex>, <markdown> and <html> all sitting on the same left edge
import React, { useState } from 'react';
import { createStyles, Slider } from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 16, gap: 12 },
  head: { fontSize: 18, color: '#2d3436' },
  hint: { fontSize: 11, color: '#7f8c8d' },
  row: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  col: { flexGrow: 1, flexBasis: 0, minWidth: 0, gap: 8 },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dfe6e9',
    borderRadius: 4,
    padding: 12,
    gap: 6,
  },
  label: { fontSize: 10, color: '#b2bec3' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
});

const LOREM =
  'Typography is the craft of arranging type to make written language ' +
  'legible, readable and appealing when displayed. The arrangement ' +
  'involves selecting typefaces, point sizes, line lengths and the ' +
  'spaces between pairs of letters.';

// One paragraph per style axis, so a regression shows up as one wrong card
// rather than as a page that looks vaguely off.
const VARIANTS = [
  { label: 'regular 13', style: { fontSize: 13 } },
  { label: 'bold 13', style: { fontSize: 13, fontWeight: 700 } },
  { label: 'italic 13', style: { fontSize: 13, fontStyle: 'italic' } },
  {
    label: 'bold italic 13',
    style: { fontSize: 13, fontWeight: 700, fontStyle: 'italic' },
  },
  { label: 'monospace 12', style: { fontSize: 12, fontFamily: 'monospace' } },
  { label: 'lineHeight 1.8', style: { fontSize: 13, lineHeight: 1.8 } },
  // 0.75 rather than 0.9: the multiplier applies to the font's natural line
  // height, so a 10% reduction is about 1.5px per line and reads as a
  // rendering wobble rather than as a setting doing something.
  {
    label: 'lineHeight 0.75 (tight)',
    style: { fontSize: 13, lineHeight: 0.75 },
  },
  { label: 'centered', style: { fontSize: 13, textAlign: 'center' } },
  { label: 'right', style: { fontSize: 13, textAlign: 'right' } },
  { label: 'dim colour', style: { fontSize: 13, color: '#95a5a6' } },
];

// Bidi: Hebrew with an embedded Latin word. The Latin runs LTR inside an RTL
// paragraph, and the full stop belongs at the *left* end of the line.
const BIDI = 'הטקסט הזה נכתב בעברית עם המילה react באמצע.';

const MARKDOWN = `## Markdown

Inline **bold**, *italic*, \`code\`, and a [link](https://x.org).

- a bullet
- another, long enough to wrap when the column is narrow enough to make it
- \`nested code\`

> A block quote, which should indent and carry a rule.

| column | value |
| ------ | ----: |
| alpha  |    12 |
| beta   |   345 |

\`\`\`js
const answer = 42; // syntax highlighted
\`\`\`
`;

const HTML = `<h2>HTML</h2>
<p>Its own CSS cascade: <b>bold</b>, <i>italic</i>,
<span style="color:#e74c3c">coloured</span>, and
<code>inline code</code>.</p>
<ul><li>list marker</li><li>second item</li></ul>
<p style="border-left:3px solid #0984e3; padding-left:8px">
A bordered block, to check border painting and padding.</p>
`;

const TEX = String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}`;

export function TypographyPanel() {
  const [size, setSize] = useState(13);
  const [width, setWidth] = useState(100);

  return (
    <scrollview style={s.panel}>
      <text style={s.head}>Typography</text>
      <text style={s.hint}>
        Every style axis on the same paragraph. The sliders resize and re-column
        everything, which is the interesting case for layout: a width change
        invalidates every measure function at once.
      </text>

      <box style={s.controls}>
        <text style={s.hint}>size {String(size)}</text>
        <Slider
          value={size}
          min={8}
          max={28}
          onChange={(ev) => setSize(ev.value)}
          style={{ width: 120 }}
        />
        <text style={s.hint}>column {String(width)}%</text>
        <Slider
          value={width}
          min={40}
          max={100}
          onChange={(ev) => setWidth(ev.value)}
          style={{ width: 120 }}
        />
      </box>

      <box style={{ width: `${width}%`, gap: 12 }}>
        <box style={s.row}>
          <box style={s.col}>
            {VARIANTS.filter((_, i) => i % 2 === 0).map((v) => (
              <box key={v.label} style={s.card}>
                <text style={s.label}>{v.label}</text>
                <text
                  style={{ ...v.style, fontSize: v.style.fontSize + size - 13 }}
                >
                  {LOREM}
                </text>
              </box>
            ))}
          </box>
          <box style={s.col}>
            {VARIANTS.filter((_, i) => i % 2 === 1).map((v) => (
              <box key={v.label} style={s.card}>
                <text style={s.label}>{v.label}</text>
                <text
                  style={{ ...v.style, fontSize: v.style.fontSize + size - 13 }}
                >
                  {LOREM}
                </text>
              </box>
            ))}
          </box>
        </box>

        <box style={s.card}>
          <text style={s.label}>bidi — RTL paragraph with an LTR word</text>
          <text style={{ fontSize: size, textAlign: 'right' }}>{BIDI}</text>
        </box>

        <box style={s.card}>
          <text style={s.label}>
            inline spans — one &lt;text&gt;, many styles
          </text>
          {/* nested <text> are spans: one layout, several styles, so the
              baseline must stay continuous across them */}
          <text style={{ fontSize: size }}>
            A single text node with{' '}
            <text style={{ fontWeight: 700 }}>bold</text>,{' '}
            <text style={{ fontStyle: 'italic' }}>italic</text>,{' '}
            <text style={{ color: '#0984e3' }}>coloured</text> and{' '}
            <text style={{ fontFamily: 'monospace', fontSize: size - 1 }}>
              monospace
            </text>{' '}
            spans, which all share one baseline.
          </text>
        </box>

        <box style={s.row}>
          <box style={s.col}>
            <box style={s.card}>
              <text style={s.label}>&lt;markdown&gt;</text>
              <markdown style={{ flexShrink: 0 }}>{MARKDOWN}</markdown>
            </box>
          </box>
          <box style={s.col}>
            <box style={s.card}>
              <text style={s.label}>&lt;html&gt;</text>
              <html style={{ flexShrink: 0 }}>{HTML}</html>
            </box>
            <box style={s.card}>
              <text style={s.label}>&lt;tex&gt; displayMode</text>
              <tex displayMode size={size + 4}>
                {TEX}
              </tex>
              {/* <tex> cannot go *inside* <text> (only nested spans and
                  strings can), so an inline formula is a row instead. Its
                  baseline is not aligned with the surrounding text yet —
                  that is the open gap noted in NEXT_STEPS §1, and this row
                  is where you can see it. */}
              <box
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                <text style={{ fontSize: size }}>and inline:</text>
                <tex size={size}>{String.raw`e^{i\pi} + 1 = 0`}</tex>
                <text style={{ fontSize: size }}>on the same row.</text>
              </box>
            </box>
          </box>
        </box>
      </box>
    </scrollview>
  );
}
