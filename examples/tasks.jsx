// A task list showing useReducer, context-passed dispatch, component
// composition, list rendering, keyboard interaction (Tab to move focus,
// Space/Enter to toggle) and <textinput> — type a task and press Enter or
// click Add. Ctrl+C/V and middle-click PRIMARY paste work in the input.
// Run with: npm run examples:tasks  (needs an X server / DISPLAY)
import React, {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { createRoot } from '../src/index.js';

const DispatchContext = createContext(null);

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
      <box
        cursor="pointer"
        padding={8}
        paddingLeft={14}
        paddingRight={14}
        borderRadius={4}
        backgroundColor="#27ae60"
        onClick={add}
      >
        <text color="white">Add</text>
      </box>
    </box>
  );
}

function TaskRow({ task }) {
  const dispatch = useContext(DispatchContext);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const toggle = () => dispatch({ type: 'toggle', id: task.id });
  return (
    <box
      focusable
      cursor="pointer"
      flexDirection="row"
      alignItems="center"
      gap={8}
      padding={8}
      borderRadius={4}
      backgroundColor={hover || focused ? '#eaf2f8' : 'white'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={toggle}
      onKeyDown={(ev) => {
        if (ev.codepoint === 32 || ev.keysym === 0xff0d) toggle();
      }}
    >
      <text color={task.done ? '#27ae60' : '#b2bec3'}>
        {task.done ? '[x]' : '[ ]'}
      </text>
      <text color={task.done ? '#95a5a6' : '#2d3436'}>{task.label}</text>
    </box>
  );
}

function FilterButton({ filter, current, label }) {
  const dispatch = useContext(DispatchContext);
  const active = filter === current;
  return (
    <box
      cursor="pointer"
      padding={6}
      paddingLeft={12}
      paddingRight={12}
      borderRadius={4}
      backgroundColor={active ? '#2980b9' : '#dfe6e9'}
      onClick={() => dispatch({ type: 'filter', filter })}
    >
      <text color={active ? 'white' : '#2d3436'}>{label}</text>
    </box>
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

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
