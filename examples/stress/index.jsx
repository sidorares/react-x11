// The stress app: one window, six panels, built to be poked at by hand.
//
//   npm run examples:stress            the app, with the frame log
//   npm run examples:stress -- --quiet the app, log only frames over 50kpx
//   REACT_X11_DEBUG_LAYOUT=1 npm run examples:stress   node outlines too
//
// Every panel prints nothing on its own; the frame log comes from
// ./perf.js, which wraps the root window's `flush()` and reports the region
// each frame repainted. The log lives in the terminal rather than in the
// window on purpose — a HUD inside the window would claim damage every frame
// and so change the very number it was reporting. See perf.js.
//
// Panels:
//   Typography  every text style axis on the same paragraph
//   Charts      SVG geometry recomputed from sliders
//   Data        a windowed 50k-row table and a live ticker
//   Controls    every component, in awkward nestings
//   Damage      a cell grid with a known number of changes per commit
//   Mixed       all of the above at once, for the worst case
import React, { useEffect, useRef, useState } from 'react';
import { createRoot, createStyles, Tabs } from '../../src/index.js';

import { watchFrames } from './perf.js';
import { TypographyPanel } from './typography.jsx';
import { ChartsPanel } from './charts.jsx';
import { DataPanel } from './data.jsx';
import { ControlsPanel } from './controls.jsx';
import { DamagePanel } from './damage.jsx';
import { MixedPanel } from './mixed.jsx';

const PALETTE = {
  background: '#f5f6fa',
  surface: '#ffffff',
  text: '#2d3436',
  textMuted: '#7f8c8d',
  edge: '#dfe6e9',
};

const s = createStyles({
  window: { backgroundColor: '$background' },
  shell: { flexGrow: 1, minHeight: 0 },
  tabs: { backgroundColor: '$surface' },
});

// `content` is a function rather than an element so a panel is built only
// while its tab is selected — six panels' worth of tables and documents built
// eagerly would make the first frame pay for all of them. Tabs owns the panel
// box too: giving it `items` without `content` leaves it rendering an empty
// `flexGrow: 1` panel next to the strip, which reads as a mysterious gap
// between the tabs and whatever you put below them.
const SECTIONS = [
  { id: 'typography', label: 'Typography', content: () => <TypographyPanel /> },
  { id: 'charts', label: 'Charts', content: () => <ChartsPanel /> },
  { id: 'data', label: 'Data', content: () => <DataPanel /> },
  { id: 'controls', label: 'Controls', content: () => <ControlsPanel /> },
  { id: 'damage', label: 'Damage', content: () => <DamagePanel /> },
  { id: 'mixed', label: 'Mixed', content: () => <MixedPanel /> },
];

// `width`/`height` are props rather than constants so the headless smoke
// check (scripts/check-stress.jsx) can size the window to its own server.
function App({ onRoot, width = 1100, height = 760, section: initial }) {
  const [section, setSection] = useState(initial ?? 'typography');
  const shell = useRef(null);

  // A ref on a drawn node is the node itself; `node.root` is the WindowNode
  // that owns the frame loop. (A ref on <window> would hand back ntk's
  // window instead — getPublicInstance returns that for window nodes.)
  useEffect(() => {
    const root = shell.current?.root;
    if (root) onRoot?.(root);
  }, [onRoot]);

  return (
    <window
      title="react-x11 stress"
      width={width}
      height={height}
      minWidth={640}
      minHeight={480}
      theme={PALETTE}
      style={s.window}
    >
      <box ref={shell} style={s.shell}>
        <Tabs
          items={SECTIONS}
          value={section}
          onChange={setSection}
          style={s.tabs}
        />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const quiet = process.argv.includes('--quiet') ? 50_000 : 0;
  const root = await createRoot();

  let watcher = null;
  root.render(
    <App
      onRoot={(node) => {
        if (watcher) return;
        watcher = watchFrames(node, { quiet });
        process.stdout.write(
          `\n  frame  damage rect                area      paint\n` +
            `  ${'-'.repeat(56)}\n`,
        );
      }}
    />,
  );

  // The summary is the only thing worth reading after the fact, so print it
  // on the way out rather than periodically.
  const bye = () => {
    if (watcher) {
      process.stdout.write(`\n  ${watcher.report()}\n\n`);
      watcher.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
