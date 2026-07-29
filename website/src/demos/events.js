export default {
  id: 'events',
  title: 'Synthetic events',
  description:
    'Events are synthesised from X11 input and dispatched over the drawn ' +
    'tree with capture and bubble phases, the way the DOM does it — hit ' +
    'testing front to back, hover enter/leave diffing, click counting in ' +
    'ev.detail, focus and Tab traversal. Click and type on the window.',
  code: `import React, { useReducer } from 'react';
import { createRoot } from 'react-x11';

function log(lines, line) {
  return [line, ...lines].slice(0, 12);
}

function App() {
  const [lines, add] = useReducer(log, []);

  return (
    <window x={30} y={30} width={560} height={400} title="events"
            style={{ backgroundColor: '#f4f6f8', padding: 14, gap: 12 }}>

      {/* capture runs outside-in, bubble inside-out — same as the DOM */}
      <box
        onClickCapture={() => add('capture  outer')}
        onClick={() => add('bubble   outer')}
        style={{
          padding: 18, borderRadius: 10,
          backgroundColor: '#dfe7ee', alignItems: 'center', gap: 10,
        }}
      >
        <text style={{ fontSize: 12, color: '#52606d' }}>outer box</text>
        <box
          focusable
          onClick={(ev) => add('bubble   inner (detail ' + ev.detail + ')')}
          onMouseEnter={() => add('mouseenter inner')}
          onMouseLeave={() => add('mouseleave inner')}
          onFocus={() => add('focus    inner')}
          onBlur={() => add('blur     inner')}
          onKeyDown={(ev) => add('keydown  ' + (ev.key || ev.keysym))}
          onWheel={() => add('wheel')}
          style={{
            paddingLeft: 22, paddingRight: 22, paddingTop: 14, paddingBottom: 14,
            backgroundColor: '#2980b9', borderRadius: 8, cursor: 'pointer',
            ':hover': { backgroundColor: '#1f6693' },
            ':focus': { borderColor: '#ffb703' },
            borderWidth: 2, borderColor: '#2980b9',
          }}
        >
          <text style={{ color: '#ffffff' }}>
            click me, double-click me, then type
          </text>
        </box>
      </box>

      <box style={{
        flexGrow: 1, backgroundColor: '#11161c', borderRadius: 8, padding: 10,
      }}>
        {lines.length === 0 ? (
          <text style={{ fontFamily: 'monospace', fontSize: 12, color: '#5c6773' }}>
            waiting for input…
          </text>
        ) : (
          lines.map((line, i) => (
            <text key={i} style={{
              fontFamily: 'monospace', fontSize: 12,
              color: i === 0 ? '#7ee787' : '#8b98a5',
            }}>
              {line}
            </text>
          ))
        )}
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
