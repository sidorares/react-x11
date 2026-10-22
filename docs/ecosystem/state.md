# State management

Every store here subscribes through React's own `useSyncExternalStore` and
never touches a host environment. Their out-of-React surface matters more in
a desktop app than on the web: an X event callback, an ntk timer or a D-Bus
signal handler can write to the store directly, and every subscribed
component under every `<window>` re-renders.

Versions are the ones tested; newer releases in the same major are expected
to behave the same.

## zustand {#zustand}

**Out of the box.** zustand@5.0.14.

A small store: `create((set) => ({...}))` returns a hook that components
call with a selector, and `useStore.getState()` / `useStore.subscribe()`
work outside React. The default recommendation for app state.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(<App />);
```

The store is module-level, so several windows share it.

- `zustand/middleware`'s `persist` defaults to `localStorage`; pass a
  `storage` backed by `node:fs` (`createJSONStorage(() => fileStorage)`).
- `zustand/traditional` (`createWithEqualityFn`) also works; the
  shallow-compare helper is pure.

## jotai {#jotai}

**Out of the box.** jotai@2.20.2.

Atomic state: `atom(initial)` defines a unit, `useAtom`/`useAtomValue`/
`useSetAtom` read and write it, and derived atoms recompute from their
dependencies. In a desktop app use an explicit store: create it at startup,
hand it to `<Provider>`, and let X event handlers or background work call
`store.set(...)`. One store shared by several `<window>` trees keeps them in
sync.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
setInterval(() => store.set(countAtom, (n) => n + 1), 1000);
```

- `jotai/utils`' `atomWithStorage` defaults to `localStorage`; supply a
  custom storage (sync or async).
- Async atoms suspend; wrap consumers in `<React.Suspense>` (react-x11
  renders fallbacks like any React 19 host) or use `loadable()`.

## valtio {#valtio}

**Out of the box.** valtio@2.3.2.

Proxy-based state: `proxy(obj)` returns an object you mutate directly;
`useSnapshot(state)` returns an immutable snapshot and re-renders only when
the properties read change. Mutation from anywhere suits X event handlers
and ntk callbacks; `subscribe(state, cb)` pushes state into non-React things
— a selection onto the clipboard, a window title set imperatively.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(<App />);
```

- Valtio 2 no longer deep-clones snapshots in dev the way v1 did; read the
  v2 migration notes if you port v1 examples.
- `valtio/utils`' `devtools()` targets the Redux DevTools browser extension
  and is a no-op here.

## XState {#xstate}

**Out of the box.** xstate@5.32.5, @xstate/react@6.1.0.

`createMachine` describes states, events, guards and actions;
`createActor` interprets one; `@xstate/react` provides `useMachine`,
`useActor`, `useActorRef` and `useSelector`. Statecharts suit desktop
chrome: drag-resize, modal and focus flows, a connection lifecycle
(`connecting → connected → retrying`), cancellable jobs. An actor started at
app level can outlive any single `<window>` and drive several.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(<App />);
```

- `useMachine(machine)` inside a component gives a component-scoped actor;
  the external actor above is better for machines shared across windows.
- `@statelyai/inspect` connects over WebSocket to Stately's editor, which
  works from Node; the iframe inspector expects a browser.

## Redux {#redux}

**Out of the box — pin `react-redux@>=9`.** react-redux@9.3.0,
@reduxjs/toolkit@2.12.0, redux@5.0.1.

react-redux 9 no longer imports `react-dom`/`react-native` for
`unstable_batchedUpdates` and subscribes through `useSyncExternalStore`, so
it needs no shim. redux core and RTK, listener and observable middleware
included, are pure JS.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(
  <Provider store={store}>
    <window width={220} height={120} title="redux">
      <Counter />
    </window>
  </Provider>,
);
```

- **The version pin is the one thing you must know.** react-redux 8 imports
  `react-dom` unconditionally: npm refuses it with `ERESOLVE` on React 19,
  and behind `--legacy-peer-deps` the app fails at startup with
  `Cannot find module 'react-dom'`. Both are in the
  [negative-results register](../ecosystem.md#install-and-import-time).
- RTK's `devTools: true` (the default) looks for the Redux DevTools
  extension global and is harmless when absent; `@redux-devtools/cli` is a
  remote devtools server if you want inspection.
- RTK Query works, but `setupListeners()` wires
  `window.addEventListener('focus'|'online')`, absent under Node. Pass
  `setupListeners(dispatch, customHandler)` a handler wired to
  `<window onFocus>`, as in the
  [TanStack Query adapter](data-fetching.md#tanstack-query).

## Immer {#immer}

**Out of the box.** immer@11.1.15.

`produce(base, recipe)` runs a mutating recipe against a Proxy draft and
returns a structurally-shared immutable result; curried `produce(recipe)` is
a drop-in `setState` updater. It is already inside `@reduxjs/toolkit`'s
`createSlice` reducers and available as zustand middleware
(`zustand/middleware/immer`).

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(<App />);
```

Useful directly with `useState`/`useReducer` for the nested state desktop
apps accumulate — tree views, multi-pane layouts.

## MobX {#mobx}

**Adapter — no code, but `react-dom` must be installed.** mobx@6.16.1,
mobx-react-lite@4.1.1.

Observable state via `makeAutoObservable`/`observable`; `mobx-react-lite`'s
`observer()` re-renders a component when the observables it dereferences
change. mobx core is pure JS.

**Every build of mobx-react-lite does
`import { unstable_batchedUpdates } from "react-dom"`** at module load, to
install React's batcher as mobx's reaction scheduler. Without react-dom the
app fails at startup with `Cannot find module 'react-dom'`.

The fix is `npm install react-dom`. Its top-level entry is Node-safe (the
one SSR uses), react-x11 never renders through it, and React 19's
`unstable_batchedUpdates` batches correctly for any renderer. With it
present, `observer` subscribes through `use-sync-external-store` and
mutations from X event handlers or timers re-render the tree.

```jsx
// prerequisite: npm install react-dom  (satisfies mobx-react-lite's import;
// react-x11 does not render through it)
import React from 'react';
import { createRoot } from 'react-x11';
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

(await createRoot()).render(<App />);
```

- Without react-dom the failure is at import time, not render time, and the
  require stack names mobx-react-lite.
- `mobx-react` layers on mobx-react-lite, so the same applies. Prefer
  `-lite`.
- Do not import from `react-dom` yourself; it is a compatibility shim here,
  nothing more.
