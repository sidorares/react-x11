// A task list showing useReducer, context-passed dispatch, component
// composition, list rendering, and the widget components — Checkbox rows in
// a <scrollview>, Buttons for the filters — with keyboard interaction
// throughout (Tab moves focus, Space/Enter toggles). Type a task and press
// Enter or click Add; Ctrl+C/V and middle-click PRIMARY paste work in the
// input. Run with: npm run examples:tasks  (needs an X server / DISPLAY)
// — or hot-reloadable with: npm run examples:tasks:hot  (edit this file
// while it runs; see tasks-hot.jsx)
import React, { useContext, useMemo, useReducer, useState } from 'react';
import { Button, Checkbox, createRoot } from '../src/index.js';
import { DispatchContext } from './tasks-context.js';

const initialState = {
  filter: 'all',
  tasks: [
    { id: 1, label: 'Write a React renderer', done: true },
    { id: 2, label: 'Lay out boxes with yoga', done: true },
    { id: 3, label: 'Paint through XRender', done: true },
    { id: 4, label: 'Dispatch synthetic events', done: true },
    { id: 5, label: 'Scroll with <scrollview>', done: true },
    { id: 6, label: 'Pop menus with <popup>', done: true },
    { id: 7, label: 'Ship a widget library', done: false },
    { id: 8, label: 'Add a <textinput> widget', done: false },
    { id: 9, label: 'Wire up the clipboard', done: false },
    { id: 10, label: 'Draw rounded focus rings', done: false },
    { id: 11, label: 'Build a window manager', done: false },
  ],
};

function reducer(state, action) {
  switch (action.type) {
    case 'toggle':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id ? { ...t, done: !t.done } : t,
        ),
      };
    case 'add': {
      const label = action.label.trim();
      if (!label) return state;
      const id = Math.max(0, ...state.tasks.map((t) => t.id)) + 1;
      return { ...state, tasks: [...state.tasks, { id, label, done: false }] };
    }
    case 'filter':
      return { ...state, filter: action.filter };
    default:
      return state;
  }
}

function AddTask() {
  const dispatch = useContext(DispatchContext);
  const [draft, setDraft] = useState('');
  const add = () => {
    dispatch({ type: 'add', label: draft });
    setDraft('');
  };
  return (
    <box flexDirection="row" gap={8} alignItems="center">
      <textinput
        autoFocus
        flexGrow={1}
        value={draft}
        placeholder="Add a task…"
        onChange={setDraft}
        onSubmit={add}
        padding={8}
        borderRadius={4}
        borderWidth={1}
        borderColor="#b2bec3"
        backgroundColor="white"
      />
      <Button primary label="Add" onPress={add} />
    </box>
  );
}

function TaskRow({ task }) {
  const dispatch = useContext(DispatchContext);
  const [hover, setHover] = useState(false);
  // Checkbox brings its own hover/focus/keyboard handling (click, Space or
  // Enter toggle) and passes the rest of the props through to its box, so
  // the row styling stays here
  return (
    <Checkbox
      checked={task.done}
      onChange={() => dispatch({ type: 'toggle', id: task.id })}
      padding={8}
      borderRadius={4}
      backgroundColor={hover ? '#eaf2f8' : 'white'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <text color={task.done ? '#95a5a6' : '#2d3436'}>{task.label}</text>
    </Checkbox>
  );
}

function FilterButton({ filter, current, label }) {
  const dispatch = useContext(DispatchContext);
  return (
    <Button
      primary={filter === current}
      label={label}
      onPress={() => dispatch({ type: 'filter', filter })}
    />
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const visible = useMemo(() => {
    if (state.filter === 'active') return state.tasks.filter((t) => !t.done);
    if (state.filter === 'done') return state.tasks.filter((t) => t.done);
    return state.tasks;
  }, [state]);

  const remaining = state.tasks.filter((t) => !t.done).length;

  return (
    <DispatchContext.Provider value={dispatch}>
      <window width={420} height={400} title="tasks" backgroundColor="#f5f6fa">
        <box flexGrow={1} padding={16} gap={12}>
          <text fontSize={20} color="#2d3436">
            Tasks
          </text>

          <AddTask />

          <box flexDirection="row" gap={8}>
            <FilterButton filter="all" current={state.filter} label="All" />
            <FilterButton
              filter="active"
              current={state.filter}
              label="Active"
            />
            <FilterButton filter="done" current={state.filter} label="Done" />
          </box>

          <scrollview
            flexGrow={1}
            backgroundColor="white"
            borderRadius={8}
            borderWidth={1}
            borderColor="#dfe6e9"
            padding={6}
            gap={2}
          >
            {visible.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </scrollview>

          <text color="#7f8c8d">
            {String(remaining)} remaining — click or Tab + Space to toggle,
            wheel to scroll
          </text>
        </box>
      </window>
    </DispatchContext.Provider>
  );
}

export default App;

// Skip the autorun under hot reload too: tasks-hot.jsx owns the root
// there, and this module re-evaluates on every reload.
if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}
