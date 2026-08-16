// A bench for where text sits inside a control, on a **real** X server.
//
//   npm run labs:text-baseline
//   LAB_FONT="Hiragino Sans" npm run labs:text-baseline
//   LAB_SHOT=/tmp/bench.png npm run labs:text-baseline   # capture and exit
//
// The in-process server is not a good enough witness for this. It renders
// with whatever font file a test hands it, while a real run resolves
// `sans-serif` through fontconfig — and on macOS that answer depends on which
// `fc-match` is first on `PATH`:
//
//   /opt/homebrew/bin/fc-match sans-serif   ->  Hiragino Sans   (a CJK face)
//   /opt/X11/bin/fc-match sans-serif        ->  Verdana
//
// The CJK face carries a 0.5em line gap where Verdana carries 0.03em, and
// that is the whole of the bug this bench exists for: anything that positions
// text by `ascent` rather than by the line's own baseline lands half a line
// gap low — invisible on a Latin face, three pixels low on this one. See
// issue #86 for the font-resolution half.
//
// Each row draws a control with a **red hairline through the middle of its
// padding box**. If the text is centred the way the palette promises, the
// capitals straddle that line evenly. Read the terminal for the numbers.
import { fileURLToPath } from 'node:url';

import React, { useEffect, useRef, useState } from 'react';

import { Button, createRoot } from '../../src/index.js';

const SAMPLES = ['XXXXXMMM', 'message #general', 'Hxg', '3'];

/** A control with a guide through the centre of its padding box. */
function Specimen({ label, children, height }) {
  return (
    <box style={{ gap: 2 }}>
      <text style={{ fontSize: 10, color: '$textMuted' }}>{label}</text>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {children}
        <box style={{ width: 90, height, justifyContent: 'center' }}>
          <box style={{ height: 1, backgroundColor: '#ff4d4d' }} />
        </box>
      </box>
    </box>
  );
}

const field = {
  width: 220,
  paddingStart: 10,
  paddingEnd: 10,
  paddingTop: '$paddingY',
  paddingBottom: '$paddingY',
  borderWidth: '$borderWidth',
  borderColor: '$border',
  borderRadius: '$radius',
  backgroundColor: '$surface',
};

const badge = {
  fontSize: 10,
  color: '$accentText',
  backgroundColor: '$accent',
  paddingStart: 5,
  paddingEnd: 5,
  paddingTop: 1,
  paddingBottom: 1,
  borderRadius: 8,
};

/** Set once the field is mounted, so the capture below can reach its window
 *  and read geometry a frame later — `abs` is 0 until layout has run. */
export let benchField = null;

export function BenchPanel({ onNodes }) {
  const fieldRef = useRef(null);
  const [report, setReport] = useState('');

  useEffect(() => {
    const node = fieldRef.current;
    if (!node) return;
    benchField = node;
    const style = node.resolvedTextStyle();
    const font = node.app?.fonts?.match?.(style.family, {});
    const m = font?.metrics?.(style.size);
    const layout = node.app?.fonts?.layout?.(
      [{ text: 'XXXXXMMM', ...style }],
      style,
    );
    const line = layout?.lines?.[0];
    if (!m || !line) return;
    const lines = [
      `family asked for : ${style.family}`,
      `size             : ${style.size}`,
      `capHeight        : ${m.capHeight?.toFixed(3) ?? 'MISSING'}`,
      `ascent / descent : ${m.ascent.toFixed(3)} / ${m.descent.toFixed(3)}`,
      `line.baseline    : ${line.baseline.toFixed(3)}`,
      `baseline-ascent  : ${(line.baseline - line.ascent).toFixed(3)}   <- the drop`,
      `line gap         : ${(layout.height - line.ascent - line.descent).toFixed(3)}`,
    ];

    console.log(`\n${lines.join('\n')}\n`);
    setReport(lines.slice(0, 6).join('\n'));
    onNodes?.(node);
  }, [onNodes]);

  return (
    <box style={{ flexGrow: 1, padding: 14, gap: 12 }}>
      <text style={{ fontSize: 16, color: '$text' }}>
        Where does the text sit?
      </text>
      <text style={{ fontSize: 11, color: '$textMuted' }}>
        The red hairline is the middle of each control. Capitals should straddle
        it.
      </text>

      {SAMPLES.map((sample, i) => (
        <Specimen key={sample} label={`<textinput> "${sample}"`} height={36}>
          <textinput
            ref={i === 0 ? fieldRef : undefined}
            defaultValue={sample}
            style={field}
          />
        </Specimen>
      ))}

      <Specimen label="<Button> for comparison" height={36}>
        <Button>XXXXXMMM</Button>
      </Specimen>

      {/* Three ways to draw a count. The first is the obvious one and the
          one that rides low: padding round a `<text>` gives it the line box,
          leading and all. The second trims to the capitals. The third stops
          depending on font metrics at all — a fixed pill, centred with flex —
          which is what examples/chat.jsx now does. */}
      <Specimen label="badge: padded text / trimmed / fixed pill" height={18}>
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <text style={badge}>3</text>
          <text style={{ ...badge, textBoxTrim: 'cap-alphabetic' }}>3</text>
          <box
            style={{
              minWidth: 16,
              height: 16,
              paddingStart: 5,
              paddingEnd: 5,
              borderRadius: 8,
              backgroundColor: '$accent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <text
              style={{
                fontSize: 10,
                color: '$accentText',
                textBoxTrim: 'cap-alphabetic',
              }}
            >
              3
            </text>
          </box>
        </box>
      </Specimen>

      <text style={{ fontSize: 10, color: '$textMuted' }}>{report}</text>
    </box>
  );
}

export function App() {
  return (
    <window
      width={420}
      height={520}
      title="text baseline bench"
      style={{ backgroundColor: '$background' }}
    >
      <BenchPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);

  // Capture and exit, so this can be iterated on without a human at the
  // screen — the whole reason it is a file rather than a paragraph.
  const shot = process.env.LAB_SHOT;
  if (shot) {
    const { captureWindow, toPng } = await import(
      fileURLToPath(new URL('../../scripts/capture.js', import.meta.url))
    );
    const { writeFileSync } = await import('node:fs');
    const { PNG } = await import('pngjs');
    setTimeout(async () => {
      const { benchField } = await import('./text-baseline.jsx');
      const box = benchField.contentBox();

      console.log(
        `field abs        : y=${benchField.abs.y} h=${benchField.abs.height}\n` +
          `content box      : ${box.y} .. ${box.y + box.height}\n`,
      );
      // `window` lives on the WindowNode, not on every node — walk up.
      let owner = benchField;
      while (owner && !owner.isWindow) owner = owner.parent;
      const capture = await captureWindow(owner.window);
      writeFileSync(shot, PNG.sync.write(toPng(capture)));

      console.log(`wrote ${shot}`);
      process.exit(0);
    }, 900);
  }
}
