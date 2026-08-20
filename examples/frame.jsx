// <Frame>: the same pane, in its own process or in yours — feel the
// difference.
//
// The pane (frame-mandelbrot.jsx) computes a Mandelbrot region in one
// synchronous pass: several hundred milliseconds of pure CPU per frame. The
// host runs a ticker — a dot stepping along a strip — that freezes whenever
// *this* process is busy. Run the pane framed and the dot never breaks
// stride while the fractal grinds; switch to inline and every recompute
// stops it dead. Same module both ways, which is the deal `<Frame>` offers:
// a component you already have, moved off your event loop.
//
// Also here: the theme crossing the process boundary (toggle dark and the
// pane follows — the bridge, docs/frame.md), a crash that stays in the pane
// (crash it framed: the fallback offers a restart; inline, an error
// boundary is all that stands between the pane and the whole app), and the
// pane printing which pid it computes in.
//
// What does not work, so it is not rediscovered: the pane's window is a
// real X child window, so host-drawn content cannot overlap it — an overlay
// belongs in a sibling <popup> (docs/embedding.md). And the process
// boundary contains failures, not intentions: the pane holds a
// full-privilege connection to the same X server (docs/security.md).
//
// Run with: npm run examples:frame     (needs an X server / DISPLAY)
import React, { useCallback, useEffect, useState } from 'react';

import { Button, Frame, ThemeProvider, createRoot } from '../src/index.js';
import FractalPane, { VIEWS } from './frame-mandelbrot.jsx';

const PANE = new URL('./frame-mandelbrot.jsx', import.meta.url);
const TICKS = 22;

/** The host's heartbeat: a dot stepping along a strip. It freezes exactly
 *  when this process's event loop does — the whole instrument. */
function Ticker() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <box style={{ flexDirection: 'row', gap: 2 }}>
      {Array.from({ length: TICKS }, (_, i) => (
        <box
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            backgroundColor: tick % TICKS === i ? '$accent' : '$surfaceActive',
          }}
        />
      ))}
    </box>
  );
}

/** Inline mode's seatbelt: an inline crash is the app's crash, and this
 *  boundary is all that catches it. Framed mode needs none — that is the
 *  comparison. */
class InlineBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <box style={{ flexGrow: 1, padding: 16, gap: 10 }}>
          <text style={{ color: '$danger' }}>
            {`inline crash reached the app: ${this.state.error.message}`}
          </text>
          <Button
            onPress={() =>
              this.props.onReset(() => this.setState({ error: null }))
            }
          >
            Recover
          </Button>
        </box>
      );
    }
    return this.props.children;
  }
}

/** `frameTransport`, `initialFramed` and `onStats` are the test seams:
 *  the pane spawn and the one number that proves it ran go behind them
 *  (test/frame-example.test.js). */
export function App({ frameTransport, initialFramed = true, onStats } = {}) {
  const [dark, setDark] = useState(false);
  const [framed, setFramed] = useState(initialFramed);
  const [viewIndex, setViewIndex] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [crash, setCrash] = useState(false);
  const [stats, setStats] = useState(null);

  const view = VIEWS[viewIndex];
  const paneProps = {
    view: { ...view, scale: view.scale / 2 ** zoom },
    iterations: 300 + zoom * 150,
    crash,
    onStats: useCallback(
      (s) => {
        setStats(s);
        onStats?.(s);
      },
      [onStats],
    ),
  };

  return (
    <ThemeProvider value={{}} colorScheme={dark ? 'dark' : 'light'}>
      <window
        title="frame — a pane in its own process"
        width={960}
        height={600}
        style={{ backgroundColor: '$background', flexDirection: 'row' }}
      >
        <box style={{ width: 270, padding: 14, gap: 10 }}>
          <text style={{ fontSize: 15, color: '$text' }}>
            the host stays responsive…
          </text>
          <Ticker />
          <text style={{ color: '$textMuted' }}>
            {stats
              ? `pane frame: ${stats.ms}ms, pid ${stats.pid}`
              : 'waiting for the first pane frame'}
          </text>
          <box style={{ height: 10 }} />
          <Button primary onPress={() => setFramed((f) => !f)}>
            {framed ? 'Run inline instead' : 'Run in its own process'}
          </Button>
          <Button onPress={() => setDark((d) => !d)}>
            {dark ? 'Light theme' : 'Dark theme'}
          </Button>
          <Button
            onPress={() => {
              setViewIndex((i) => (i + 1) % VIEWS.length);
              setZoom(0);
            }}
          >
            {`Next region (${view.name})`}
          </Button>
          <Button onPress={() => setZoom((z) => Math.min(z + 1, 6))}>
            Zoom in
          </Button>
          <Button onPress={() => setZoom((z) => Math.max(z - 1, 0))}>
            Zoom out
          </Button>
          <Button onPress={() => setCrash(true)}>Crash the pane</Button>
        </box>
        {framed ? (
          <Frame
            src={PANE}
            transport={frameTransport}
            props={paneProps}
            style={{ flexGrow: 1, backgroundColor: '$surface' }}
            fallback={({ error, restart }) => (
              <box style={{ flexGrow: 1, padding: 16, gap: 10 }}>
                <text style={{ color: '$danger' }}>
                  {`the pane is gone: ${error?.message ?? 'unknown'}`}
                </text>
                <text style={{ color: '$textMuted' }}>
                  …and the host never noticed, which is the point.
                </text>
                <Button
                  primary
                  onPress={() => {
                    setCrash(false);
                    restart();
                  }}
                >
                  Restart the pane
                </Button>
              </box>
            )}
            onStarted={({ pid }) => console.log(`pane started, pid ${pid}`)}
            onExit={({ code, signal, expected }) =>
              console.log(
                `pane exited (${signal ?? `code ${code}`}), ` +
                  (expected ? 'asked to' : 'crashed'),
              )
            }
          />
        ) : (
          <box style={{ flexGrow: 1, backgroundColor: '$surface' }}>
            <InlineBoundary onReset={(clear) => (setCrash(false), clear())}>
              <FractalPane {...paneProps} />
            </InlineBoundary>
          </box>
        )}
      </window>
    </ThemeProvider>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}
