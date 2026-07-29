export default {
  id: 'counter',
  title: 'Hello, counter',
  description:
    'The whole idea in twenty lines: a component with state, flexbox layout, ' +
    'and a :hover block that repaints without a React render. The <window> is ' +
    'a real X11 window — everything inside it is drawn into that window.',
  code: `import React, { useState } from 'react';
import { createRoot } from 'react-x11';

function Counter() {
  const [n, setN] = useState(0);

  return (
    <window
      x={60} y={40} width={420} height={220}
      title="counter"
      style={{ backgroundColor: '#f4f6f8' }}
    >
      <box style={{
        flexGrow: 1, alignItems: 'center',
        justifyContent: 'center', gap: 14,
      }}>
        <text style={{ fontSize: 42, color: '#1c4e80' }}>{String(n)}</text>

        <box style={{ flexDirection: 'row', gap: 8 }}>
          <box
            onClick={() => setN(n - 1)}
            style={{
              paddingLeft: 16, paddingRight: 16,
              paddingTop: 8, paddingBottom: 8,
              backgroundColor: '#e2e8ee',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 120,
              ':hover': { backgroundColor: '#cbd5df' },
            }}
          >
            <text>-1</text>
          </box>

          <box
            onClick={() => setN(n + 1)}
            style={{
              paddingLeft: 16, paddingRight: 16,
              paddingTop: 8, paddingBottom: 8,
              backgroundColor: '#2980b9',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 120,
              ':hover': { backgroundColor: '#1f6693' },
            }}
          >
            <text style={{ color: '#ffffff' }}>+1</text>
          </box>
        </box>

        <text style={{ fontSize: 12, color: '#7b8794' }}>
          click a button — or edit this code and press Run
        </text>
      </box>
    </window>
  );
}

const root = await createRoot();   // connects through DISPLAY
root.render(<Counter />);
console.log('mounted');
`,
};
