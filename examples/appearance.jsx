// Every value `useSystemAppearance()` reads, live — and a window that
// follows the desktop without being asked to.
//
//   npm run examples:appearance
//
// Start it, then change your desktop theme:
//
//   GNOME    Settings → Appearance → Dark / Light, and Accent colour
//   KDE      Settings → Colours
//   macOS    System Settings → Appearance, and Accessibility → Display
//
// Everything updates without a restart, and the log records what moved and
// when. Nothing here polls: the desktop announces the change, and a
// `SettingChanged` signal becomes a `setState`.
//
// **Note what this file does not contain.** There is no `<ThemeProvider>`,
// no palette, and no colour anywhere outside the pinned panel at the bottom.
// The window background, the text, the borders and every widget come from
// react-x11's built-in palette, and that palette is the desktop's — light on
// a light desktop, dark on a dark one. `$background` and friends resolve
// against it with nothing declared.
//
// The bottom panel is the override: `colorScheme="light"` pins a subtree to
// one scheme whatever the desktop says, and is also the complete opt-out —
// nothing under it asks the desktop anything.
//
// See docs/appearance.md.
import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  createRoot,
  createStyles,
  ProgressBar,
  Slider,
  ThemeProvider,
  systemAppearance,
  useSystemAppearance,
} from '../src/index.js';

const s = createStyles({
  root: {
    flexGrow: 1,
    padding: 16,
    gap: 12,
    backgroundColor: '$background',
    transition: { backgroundColor: 180 },
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heading: { fontSize: 17, color: '$text' },
  badge: {
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: '$radiusSmall',
    backgroundColor: '$surfaceHover',
    borderWidth: 1,
    borderColor: '$border',
    transition: { backgroundColor: 180, borderColor: 180 },
  },
  badgeText: { color: '$text', fontSize: 12 },
  card: {
    padding: 12,
    gap: 7,
    borderRadius: '$radius',
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surfaceHover',
    transition: { backgroundColor: 180, borderColor: 180 },
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { width: 108, color: '$dim' },
  value: { width: 108, color: '$text' },
  domain: { color: '$dim', fontSize: 11 },
  swatch: {
    width: 13,
    height: 13,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '$border',
  },
  sectionLabel: { color: '$dim', fontSize: 12 },
  logLine: { color: '$text', fontSize: 12 },
  logTime: { color: '$dim', fontSize: 12, width: 62 },
});

/** The five fields the hook returns, and what each one may be. */
const FIELDS = [
  ['colorScheme', "'light' | 'dark' | 'no-preference'"],
  ['accent', "'#rrggbb' | null"],
  ['contrast', "'normal' | 'high'"],
  ['reducedMotion', 'true | false'],
  ['source', "'portal' | 'xsettings' | 'macos' | 'cache' | null"],
];

const show = (v) => (v === null ? 'null' : String(v));

/** One field: name, current value, an accent swatch, and the whole domain. */
function Field({ name, value, domain }) {
  return (
    <box style={s.row}>
      <text style={s.name}>{name}</text>
      <text style={s.value}>{show(value)}</text>
      {name === 'accent' && typeof value === 'string' ? (
        <box style={[s.swatch, { backgroundColor: value }]} />
      ) : (
        <box style={{ width: 13 }} />
      )}
      <text style={s.domain}>{domain}</text>
    </box>
  );
}

/**
 * What changed and when. The point of the example: after flipping the desktop
 * theme there is a record of it, so a manual test does not come down to
 * "I think it went dark".
 */
function useChangeLog(appearance) {
  const [log, setLog] = useState([]);
  const previous = useRef(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = appearance;
    const at = new Date().toLocaleTimeString();

    if (!before) {
      // Whether the very first frame came off the remembered answer or from
      // nothing at all — `source: 'cache'` on every run but the first.
      setLog([
        { at, lines: [`first render — source ${show(appearance.source)}`] },
      ]);
      return;
    }
    const lines = FIELDS.filter(([f]) => before[f] !== appearance[f]).map(
      ([f]) => `${f} ${show(before[f])} → ${show(appearance[f])}`,
    );
    if (lines.length) setLog((l) => [{ at, lines }, ...l].slice(0, 10));
  }, [appearance]);

  return log;
}

/** The same three widgets, so the pinned panel below is a fair comparison. */
function Controls({ appearance, level, setLevel }) {
  const brand = appearance.accent ?? '#2980b9';
  return (
    <>
      <box style={s.row}>
        <Button primary label="Primary" />
        <Button label="Secondary" />
        {/* The desktop's accent is taken deliberately, never adopted on its
            own: an app in dark mode did not ask for its buttons to change
            colour. And it is null on most desktops, so there is a fallback. */}
        <Button
          label={
            appearance.accent ? 'Desktop accent' : 'Accent fallback (null)'
          }
          style={{ backgroundColor: brand, borderColor: brand }}
        />
      </box>
      <box style={s.row}>
        {/* Read-outs, so they are disabled: they mirror the desktop and
            there is nothing here that could change it back. */}
        <Checkbox
          disabled
          checked={appearance.colorScheme === 'dark'}
          label="dark"
        />
        <Checkbox
          disabled
          checked={appearance.contrast === 'high'}
          label="high contrast"
        />
        <Checkbox disabled checked={appearance.reducedMotion} label="motion" />
      </box>
      <box style={s.row}>
        <Slider
          value={level}
          onChange={(e) => setLevel(e.value)}
          style={{ width: 190 }}
        />
        <ProgressBar value={level / 100} style={{ width: 130 }} />
      </box>
    </>
  );
}

function App() {
  // The whole public surface of the hook, in one line.
  const appearance = useSystemAppearance();
  const log = useChangeLog(appearance);
  const [level, setLevel] = useState(65);

  return (
    // No `backgroundColor`, and that is the point: a window with none takes
    // the palette's, which is the desktop's.
    <window width={560} height={660} title="system appearance">
      <box style={s.root}>
        <box style={s.headerRow}>
          <text style={s.heading}>useSystemAppearance()</text>
          <box style={s.badge}>
            <text style={s.badgeText}>{show(appearance.source)}</text>
          </box>
        </box>

        <box style={s.card}>
          {FIELDS.map(([name, domain]) => (
            <Field
              key={name}
              name={name}
              value={appearance[name]}
              domain={domain}
            />
          ))}
        </box>

        <text style={s.sectionLabel}>
          Changes since start — newest first. Flip your desktop theme now.
        </text>
        {/* The card owns the height and the border, so an empty log reads as
            an empty box rather than as a gap; the scroll box inside takes
            over once there are more entries than fit. */}
        <box style={[s.card, { height: 104, padding: 0 }]}>
          <box style={{ overflow: 'scroll', flexGrow: 1 }}>
            <box style={{ padding: 12, gap: 4 }}>
              {log.length === 0 ? (
                <text style={s.logLine}>…</text>
              ) : (
                log.map((entry, i) =>
                  entry.lines.map((line, j) => (
                    <box key={`${i}-${j}`} style={s.row}>
                      <text style={s.logTime}>{j === 0 ? entry.at : ''}</text>
                      <text style={s.logLine}>{line}</text>
                    </box>
                  )),
                )
              )}
            </box>
          </box>
        </box>

        <box style={s.card}>
          <text style={s.sectionLabel}>
            Following the desktop — no ThemeProvider, no palette, nothing said
          </text>
          <Controls appearance={appearance} level={level} setLevel={setLevel} />
        </box>

        {/* The override. `colorScheme="light"` pins this subtree whatever the
            desktop reports, and is also the complete opt-out: nothing under
            here asks the desktop anything. */}
        <ThemeProvider colorScheme="light" style={{ flexGrow: 0 }}>
          <box style={s.card}>
            <text style={s.sectionLabel}>
              {'Pinned — <ThemeProvider colorScheme="light">'}
            </text>
            <Controls
              appearance={appearance}
              level={level}
              setLevel={setLevel}
            />
          </box>
        </ThemeProvider>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // Resolved alongside the connection so the very first frame is already
  // right on the *first ever* run, where there is nothing remembered from a
  // previous one. Every run after that is served from the cache in 0.1 ms
  // before this resolves, and the await costs nothing.
  const [root] = await Promise.all([createRoot(), systemAppearance()]);
  root.render(<App />);
}
