export default {
  id: 'tasks',
  title: 'Text input and scrolling',
  description:
    '<textinput> is a real editor: caret and selection through ntk text ' +
    'layout, word select, undo/redo, both X11 clipboards and a right-click ' +
    'menu. <scrollview> is a clipped viewport with a drawn scrollbar that ' +
    'the wheel scrolls by default — unless a handler calls preventDefault().',
  code: `import React, { useReducer, useState } from 'react';
import { createRoot } from 'react-x11';

function reduce(tasks, action) {
  switch (action.type) {
    case 'add':
      return [...tasks, { id: Date.now() + Math.random(), text: action.text, done: false }];
    case 'toggle':
      return tasks.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t));
    case 'remove':
      return tasks.filter((t) => t.id !== action.id);
    default:
      return tasks;
  }
}

const initial = [
  'ship the docs site',
  'measure the protocol cost',
  'try a non-Latin keyboard layout',
  'draw a cube over indirect GLX',
  'write the window manager example',
  'read the ICCCM, again',
].map((text, i) => ({ id: i, text, done: i === 0 }));

function Row({ task, dispatch }) {
  return (
    <box style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8,
      borderRadius: 6,
      ':hover': { backgroundColor: '#eef2f6' },
    }}>
      <box
        onClick={() => dispatch({ type: 'toggle', id: task.id })}
        style={{
          width: 16, height: 16, borderRadius: 4, borderWidth: 2,
          borderColor: task.done ? '#27ae60' : '#b9c2cc',
          backgroundColor: task.done ? '#27ae60' : '#ffffff',
          cursor: 'pointer',
        }}
      />
      <text style={{
        flexGrow: 1,
        color: task.done ? '#9aa5b1' : '#1f2933',
      }}>
        {task.text}
      </text>
      <box
        onClick={() => dispatch({ type: 'remove', id: task.id })}
        style={{ cursor: 'pointer', paddingLeft: 6, paddingRight: 6 }}
      >
        <text style={{ color: '#b9c2cc', ':hover': { color: '#c0392b' } }}>x</text>
      </box>
    </box>
  );
}

function App() {
  const [tasks, dispatch] = useReducer(reduce, initial);
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    dispatch({ type: 'add', text });
    setDraft('');
  };

  return (
    <window x={40} y={30} width={520} height={400} title="tasks"
            style={{ backgroundColor: '#ffffff', padding: 14, gap: 10 }}>

      <box style={{ flexDirection: 'row', gap: 8 }}>
        <textinput
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onSubmit={submit}
          placeholder="what needs doing?"
          style={{
            flexGrow: 1,
            borderWidth: 1, borderColor: '#d8dee4', borderRadius: 6,
            paddingLeft: 10, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
            ':focus': { borderColor: '#2980b9' },
          }}
        />
        <box
          onClick={submit}
          style={{
            justifyContent: 'center',
            paddingLeft: 14, paddingRight: 14,
            backgroundColor: '#2980b9', borderRadius: 6, cursor: 'pointer',
            ':hover': { backgroundColor: '#1f6693' },
          }}
        >
          <text style={{ color: '#ffffff' }}>Add</text>
        </box>
      </box>

      <scrollview style={{
        flexGrow: 1,
        borderWidth: 1, borderColor: '#eef2f6', borderRadius: 8,
        padding: 4,
      }}>
        {tasks.map((task) => (
          <Row key={task.id} task={task} dispatch={dispatch} />
        ))}
      </scrollview>

      <text style={{ fontSize: 12, color: '#9aa5b1' }}>
        {tasks.filter((t) => !t.done).length} left — try selecting text in the
        input, or right-clicking it
      </text>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
