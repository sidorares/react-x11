# Data fetching

A react-x11 app is an ordinary Node process, so `fetch`, undici, `ky` and
`graphql-request` all work unmodified. What needs care is the _cache_ layer
on top, because every stale-while-revalidate library decides whether it is
"on a server" by looking for a global `window` — and in a react-x11 process
there isn't one.

That check is the whole story on this page. Get it wrong and nothing throws;
the app just stops refetching.

## TanStack Query {#tanstack-query}

**Adapter, ~12 lines.** @tanstack/react-query@5.101.4 (query-core 5.101.4).

Query and mutation cache for server state: `useQuery` deduplicates, caches,
retries and background-refetches; `useMutation` handles writes with
invalidation. The core is renderer-agnostic, and the environment coupling
lives in three small managers — `focusManager`, `onlineManager`,
`environmentManager` — all replaceable.

The trap is query-core's environment probe:

```js
// @tanstack/query-core src/utils.ts
export const isServer = typeof window === 'undefined' || 'Deno' in globalThis;
```

A react-x11 process has no `window`, so query-core decides it is doing SSR.
Concretely:

- `retry` defaults to **0** instead of 3;
- stale timers are never scheduled and `refetchInterval` is disabled;
- `gcTime` defaults to **Infinity** instead of 5 minutes — the cache never
  collects;
- the default `focusManager` setup wants
  `window.addEventListener('visibilitychange')`, so focus refetching is
  inert.

The escape hatch shipped in v5: `environmentManager.setIsServer()`,
re-exported from `@tanstack/react-query`. Pair it with react-x11's window
focus events, which fire on the X `FocusIn`/`FocusOut` the window manager
delivers.

```jsx
// query-x11.js — the whole adapter
import {
  environmentManager,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';

environmentManager.setIsServer(() => false); // we are a client, not SSR
focusManager.setEventListener(() => () => {}); // drop the visibilitychange probe
onlineManager.setEventListener(() => () => {}); // assume online (or probe for real)

export const windowFocusProps = {
  onFocus: () => focusManager.setFocused(true),
  onBlur: () => focusManager.setFocused(false),
};
```

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { windowFocusProps } from './query-x11.js';

const client = new QueryClient();

function Weather() {
  const { data, status } = useQuery({
    queryKey: ['weather'],
    queryFn: () => fetch('https://wttr.in/?format=3').then((r) => r.text()),
  });
  return <text>{status === 'pending' ? 'loading…' : data}</text>;
}

(await createRoot()).render(
  <window width={360} height={120} title="weather" {...windowFocusProps}>
    <QueryClientProvider client={client}>
      <Weather />
    </QueryClientProvider>
  </window>,
);
```

Focusing the window after being away now refetches stale queries, exactly
like refocusing a browser tab.

- **Call `setIsServer` before creating the `QueryClient`** — the managers
  are module singletons.
- With several app windows in one process, switching between two of your own
  windows fires blur-then-focus, which counts as a focus event and refetches
  stale queries. Same semantics as switching browser tabs; raise `staleTime`
  if that is too eager.
- `onlineManager` defaults to online under Node (there is no
  `navigator.onLine`). Wire it to NetworkManager over D-Bus if you want real
  offline handling.
- `@tanstack/react-query-devtools` is DOM-rendered and not usable.

## SWR {#swr}

**Adapter, 1 line — but read the dead end first.** swr@2.4.2.

Basic operation works unmodified: `useSWR` fetches on mount, caches, dedupes
and re-renders through `useSyncExternalStore`.

Focus and reconnect revalidation do not, and they fail silently. SWR
computes its environment once at import time, with no override:

```js
// swr/dist/_internal/config-context-*.mjs
const isWindowDefined = typeof window != 'undefined';
const IS_SERVER = !isWindowDefined || isLegacyDeno;
```

Revalidation event sources are registered only `if (!IS_SERVER)` —
_including_ a custom `initFocus`/`initReconnect` passed through the
cache-provider config. So the "wire your own focus events via the provider
option" approach from SWR's docs is dead code under Node: your `initFocus`
is never called, and swr ends up with zero registered listeners. Unlike
TanStack Query there is no `setIsServer`.

Two ways out. The simple one is to drive revalidation yourself with
`mutate`; a key filter of `() => true` revalidates every key in the cache,
so hang it off `<window onFocus>`:

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
import useSWR, { mutate } from 'swr';

const fetcher = (url) => fetch(url).then((r) => r.text());

function Weather() {
  const { data } = useSWR('https://wttr.in/?format=3', fetcher);
  return <text>{data ?? 'loading…'}</text>;
}

(await createRoot()).render(
  // the adapter is this one prop: revalidate everything on window focus
  <window
    width={360}
    height={120}
    title="weather"
    onFocus={() => mutate(() => true)}
  >
    <Weather />
  </window>,
);
```

The thorough one is to make `IS_SERVER` false, which turns swr's own
machinery back on. It has to happen **before the first import of swr**:

```js
// swr-env.js — imported first, before anything that imports swr
const listeners = new Map();
const target = {
  addEventListener: (t, fn) =>
    listeners.set(t, [...(listeners.get(t) ?? []), fn]),
  removeEventListener: (t, fn) =>
    listeners.set(
      t,
      (listeners.get(t) ?? []).filter((f) => f !== fn),
    ),
};
globalThis.window ??= target;
globalThis.document ??= target;

/** Call from your <window onFocus> handler. */
export const fireFocus = () =>
  (listeners.get('focus') ?? []).forEach((fn) => fn());
```

With that in place swr registers `visibilitychange`, `focus`, `online` and
`offline` listeners and `revalidateOnFocus` behaves. Two gotchas:

- Fire only `'focus'`. An `'offline'` event sets swr's internal online flag
  false and silently suppresses the deferred revalidation.
- `focusThrottleInterval` defaults to 5000 ms, so a focus that lands within
  five seconds of the last revalidation is dropped — which looks exactly
  like the shim not working. Lower it while you are testing the wiring.

- **`revalidateOnFocus` and `revalidateOnReconnect` are inert** unless you
  define the globals. Nothing warns you.
- The global `mutate` import targets the _default_ cache. If you mount a
  custom `provider` via `<SWRConfig>`, calls to the global `mutate` silently
  miss it — use `useSWRConfig().mutate` from inside the tree.
- Suspense mode throws
  `Fallback data is required when using Suspense in SSR.` because SWR
  believes it is on a server. Provide `fallbackData`, or avoid
  `suspense: true`.
- `preload()` is an SSR-gated no-op under Node.
- If you want focus revalidation with retries and cache GC done properly,
  prefer TanStack Query above — it ships a supported environment override.
