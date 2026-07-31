# State management

Every store here is renderer-agnostic: they subscribe through React's own
`useSyncExternalStore` and never touch a host environment. The out-of-React
surface matters more in a desktop app than on the web — an X event callback,
an ntk timer or a D-Bus signal handler can write to the store directly, and
every subscribed component under every `<window>` re-renders.

Versions below are what was tested; anything newer in the same major is
expected to behave the same.

## zustand {#zustand}

**Out of the box.** zustand@5.0.14.

A small unopinionated store: `create((set) => ({...}))` returns a hook that
components call with a selector. Subscription goes through
`useSyncExternalStore` imported from `react` itself, and the store is usable
outside React via `useStore.getState()` / `useStore.subscribe()`. The
default recommendation for app state: zero DOM, zero adapter.

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { create } from 'zustand';

const useStore = create((set) => ({
  n: 0,
  inc: () => set((s) => ({ n: s.n + 1 })),
}));

function App() {
  const n = useStore((s) => s.n);
  return (
    <window width={200} height={100} title="counter">
      <box style={{ padding: 8 }} onClick={() => useStore.getState().inc()}>
        <text>count: {n}</text>
      </box>
    </window>
  );
}

ReactX11.render(<App />);
```

Because the store is module-level rather than tree-level, several windows
share it for free.

- `zustand/middleware`'s `persist` defaults to `localStorage`; pass a
  `storage` backed by `node:fs` (`createJSONStorage(() => fileStorage)`).
- `zustand/traditional` (`createWithEqualityFn`) also works; the
  shallow-compare helper is pure.

## jotai {#jotai}

**Out of the box.** jotai@2.20.2.

Bottom-up atomic state: `atom(initial)` defines a unit of state,
`useAtom`/`useAtomValue`/`useSetAtom` read and write it, and derived atoms
recompute from their dependencies. Atoms are pure and the React bindings
import only `react`.

The explicit-store pattern is the right one for a desktop app: create the
store at startup, hand it to the tree, and let X event handlers or
background work call `store.set(...)`. One store shared by several
`<window>` trees keeps them in sync automatically.

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { atom, createStore, Provider, useAtomValue } from 'jotai';

const countAtom = atom(0);
const doubledAtom = atom((get) => get(countAtom) * 2);
const store = createStore();

function App() {
  const doubled = useAtomValue(doubledAtom);
  return (
    <window width={200} height={100} title="jotai">
      <text>doubled: {doubled}</text>
    </window>
  );
}

ReactX11.render(
  <Provider store={store}>
    <App />
  </Provider>,
);
setInterval(() => store.set(countAtom, (n) => n + 1), 1000);
```

- `jotai/utils`' `atomWithStorage` defaults to `localStorage`; supply a
  custom storage (sync or async).
- Async atoms suspend; wrap consumers in `<React.Suspense>` — react-x11
  renders fallbacks like any React 19 host — or use `loadable()`.

## valtio {#valtio}

**Out of the box.** valtio@2.3.2.

Proxy-based state: `proxy(obj)` returns an object you mutate directly;
`useSnapshot(state)` returns an immutable snapshot and tracks which
properties were read, re-rendering only when those change.

Mutation-from-anywhere maps well onto X event handlers and ntk callbacks.
`subscribe(state, cb)` is handy for pushing state into non-React things —
writing a selection to the X clipboard, updating a window title
imperatively.

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { proxy, useSnapshot } from 'valtio';

const state = proxy({ n: 0, log: [] });

function App() {
  const snap = useSnapshot(state);
  return (
    <window width={220} height={120} title="valtio">
      <box
        style={{ padding: 8 }}
        onClick={() => {
          state.n += 1;
          state.log.push(Date.now());
        }}
      >
        <text>clicked {snap.n} times</text>
      </box>
    </window>
  );
}

ReactX11.render(<App />);
```

- Valtio 2 no longer deep-clones snapshots the way v1 did in dev; read the
  v2 migration notes if you are coming from v1 examples.
- `valtio/utils`' `devtools()` targets the Redux DevTools browser extension.
  It is a no-op without one, and there is nothing to connect to under X11.

## XState {#xstate}

**Out of the box.** xstate@5.32.5, @xstate/react@6.1.0.

`createMachine` describes states, events, guards and actions; `createActor`
interprets one; `@xstate/react` provides `useMachine`, `useActor`,
`useActorRef` and `useSelector`. The interpreter has no environment coupling
and the React bindings subscribe via `useSyncExternalStore`.

Desktop chrome is where statecharts earn their keep: drag-resize state,
modal and focus flows, a connection lifecycle (`connecting → connected →
retrying`), long-running jobs with cancellation. An actor started at app
level can outlive any single `<window>` and drive several of them.

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { createMachine, createActor } from 'xstate';
import { useSelector } from '@xstate/react';

const toggle = createMachine({
  id: 'toggle',
  initial: 'off',
  states: {
    off: { on: { TOGGLE: 'on' } },
    on: { on: { TOGGLE: 'off' } },
  },
});
const actor = createActor(toggle).start();

function App() {
  const value = useSelector(actor, (s) => s.value);
  return (
    <window width={220} height={120} title="xstate">
      <box
        style={{ padding: 8 }}
        onClick={() => actor.send({ type: 'TOGGLE' })}
      >
        <text>state: {value}</text>
      </box>
    </window>
  );
}

ReactX11.render(<App />);
```

- `useMachine(machine)` inside a component works too and gives you a
  component-scoped actor; the external-actor pattern above is better for
  machines shared across windows.
- `@statelyai/inspect` connects over WebSocket to Stately's editor. The
  transport works from Node; the iframe inspector expects a browser.

## Redux {#redux}

**Out of the box — pin `react-redux@>=9`.** react-redux@9.3.0,
@reduxjs/toolkit@2.12.0, redux@5.0.1.

react-redux 9 dropped the `react-dom`/`react-native` imports it used for
`unstable_batchedUpdates` and subscribes through React's own
`useSyncExternalStore`, so it is renderer-agnostic and needs no shim here.
redux core and RTK are pure JS throughout, listener and observable
middleware included.

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { Provider, useSelector, useDispatch } from 'react-redux';

const counter = createSlice({
  name: 'counter',
  initialState: { n: 0 },
  reducers: {
    inc: (s) => {
      s.n += 1;
    }, // immer draft — mutation is fine
  },
});
const store = configureStore({ reducer: { counter: counter.reducer } });

function Counter() {
  const n = useSelector((s) => s.counter.n);
  const dispatch = useDispatch();
  return (
    <box style={{ padding: 8 }} onClick={() => dispatch(counter.actions.inc())}>
      <text>count: {n}</text>
    </box>
  );
}

ReactX11.render(
  <Provider store={store}>
    <window width={220} height={120} title="redux">
      <Counter />
    </window>
  </Provider>,
);
```

- **The version pin is the one thing you must know.** react-redux 8 imports
  `react-dom` unconditionally, and the failure is a module-resolution error
  at startup, not a runtime warning. Both of its failure modes — the npm
  `ERESOLVE` on React 19 and the `Cannot find module 'react-dom'` behind
  `--legacy-peer-deps` — are in the
  [negative-results register](../ecosystem.md#install-and-import-time).
- RTK's `devTools: true` (the default) looks for the Redux DevTools
  extension global; harmless when absent. `@redux-devtools/cli` is a remote
  devtools server if you want inspection.
- RTK Query works, but `setupListeners()` wires
  `window.addEventListener('focus'|'online')`, which are absent under Node.
  Pass a custom handler to `setupListeners(dispatch, customHandler)` wired
  to `<window onFocus>`, the same way as the
  [TanStack Query adapter](data-fetching.md#tanstack-query).

## Immer {#immer}

**Out of the box.** immer@11.1.15.

`produce(base, recipe)` runs a mutating recipe against a Proxy draft and
returns a structurally-shared immutable result. Curried `produce(recipe)` is
a drop-in `setState` updater. Pure JS, no environment assumptions — and it
is already inside `@reduxjs/toolkit`'s `createSlice` reducers and available
as zustand middleware (`zustand/middleware/immer`).

```jsx
import React from 'react';
import ReactX11 from 'react-x11';
import { produce } from 'immer';

function App() {
  const [state, setState] = React.useState({
    items: [{ label: 'a', done: false }],
  });
  const toggle = (i) =>
    setState(
      produce((draft) => {
        draft.items[i].done = !draft.items[i].done;
      }),
    );
  return (
    <window width={260} height={160} title="todo">
      {state.items.map((it, i) => (
        <box key={it.label} style={{ padding: 4 }} onClick={() => toggle(i)}>
          <text>
            {it.done ? '[x] ' : '[ ] '}
            {it.label}
          </text>
        </box>
      ))}
    </window>
  );
}

ReactX11.render(<App />);
```

Nothing to adapt. Useful directly with `useState`/`useReducer` for the
nested state desktop apps accumulate — tree views, multi-pane layouts.

## MobX {#mobx}

**Adapter — no code, but `react-dom` must be installed.** mobx@6.16.1,
mobx-react-lite@4.1.1.

Observable state via `makeAutoObservable`/`observable`, with
`mobx-react-lite`'s `observer()` HOC re-rendering components when the
observables they dereference change. mobx core is pure JS.

The wrinkle: **every build of mobx-react-lite unconditionally does
`import { unstable_batchedUpdates } from "react-dom"`** at module load, to
install React's batcher as mobx's reaction scheduler. In a react-x11 app
react-dom is not otherwise present, so the import fails at startup with
`Cannot find module 'react-dom'`.

The fix is `npm install react-dom`. Its top-level entry is Node-safe (it is
the same entry SSR uses), react-x11 never renders through it, and React 19's
`unstable_batchedUpdates` is a thin wrapper that batches correctly for any
renderer. With react-dom present, `observer` subscribes through
`use-sync-external-store` and mutations from X event handlers or timers
re-render the tree.

```jsx
// prerequisite: npm install react-dom  (satisfies mobx-react-lite's import;
// react-x11 does not render through it)
import React from 'react';
import ReactX11 from 'react-x11';
import { makeAutoObservable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';

const store = makeAutoObservable({ n: 0 });

const App = observer(function App() {
  return (
    <window width={220} height={120} title="mobx">
      <box
        style={{ padding: 8 }}
        onClick={() =>
          runInAction(() => {
            store.n += 1;
          })
        }
      >
        <text>count: {store.n}</text>
      </box>
    </window>
  );
});

ReactX11.render(<App />);
```

- Without react-dom the app fails at import time, not render time; the error
  names mobx-react-lite in its require stack.
- `mobx-react` (the bigger sibling) layers on mobx-react-lite, so the same
  note applies. Prefer `-lite`.
- Do not import from `react-dom` yourself. It is a compatibility shim here,
  nothing more.
