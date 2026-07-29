export default {
  id: 'layout',
  title: 'Box layout',
  description:
    'Layout is yoga — the same flexbox engine React Native uses. Every <box> ' +
    'is one yoga node, laid out in the renderer and painted into the window; ' +
    'none of these are X windows. Try changing flexDirection, gap or flexGrow.',
  code: `import React, { useState } from 'react';
import { createRoot } from 'react-x11';

const COLORS = ['#2980b9', '#27ae60', '#e67e22', '#8e44ad'];

function Panel({ label, grow, color }) {
  return (
    <box style={{
      flexGrow: grow,
      flexBasis: 0,
      backgroundColor: color,
      borderRadius: 8,
      padding: 12,
      justifyContent: 'flex-end',
    }}>
      <text style={{ color: '#ffffff', fontSize: 13 }}>{label}</text>
    </box>
  );
}

function App() {
  const [row, setRow] = useState(true);

  return (
    <window x={40} y={30} width={560} height={380} title="box layout"
            style={{ backgroundColor: '#eef1f4', padding: 14 }}>

      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                    marginBottom: 12 }}>
        <box
          onClick={() => setRow(!row)}
          style={{
            paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6,
            backgroundColor: '#1c4e80', borderRadius: 6, cursor: 'pointer',
            ':hover': { backgroundColor: '#153c63' },
          }}
        >
          <text style={{ color: '#ffffff', fontSize: 13 }}>toggle direction</text>
        </box>
        <text style={{ fontSize: 13, color: '#52606d' }}>
          flexDirection: {row ? 'row' : 'column'}
        </text>
      </box>

      {/* the flex container: children share the space by flexGrow */}
      <box style={{
        flexGrow: 1,
        flexDirection: row ? 'row' : 'column',
        gap: 10,
      }}>
        <Panel label="flexGrow 1" grow={1} color={COLORS[0]} />
        <Panel label="flexGrow 2" grow={2} color={COLORS[1]} />
        <Panel label="flexGrow 1" grow={1} color={COLORS[2]} />
      </box>

      {/* absolute positioning works too, relative to the nearest ancestor */}
      <box style={{
        position: 'absolute', right: 18, top: 16,
        width: 74, height: 26, borderRadius: 13,
        backgroundColor: '#00000022',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <text style={{ fontSize: 11, color: '#334' }}>absolute</text>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
