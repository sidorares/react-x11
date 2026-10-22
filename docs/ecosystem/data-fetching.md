# Data fetching

A react-x11 app is an ordinary Node process, so `fetch`, undici, `ky` and
`graphql-request` work unmodified. The _cache_ layer on top needs care:
stale-while-revalidate libraries decide whether they are "on a server" by
looking for a global `window`, and a react-x11 process has none. Get it
wrong and nothing throws; the app just stops refetching.

## TanStack Query {#tanstack-query}

**Adapter, ~12 lines.** @tanstack/react-query@5.101.4 (query-core 5.101.4).

`useQuery` deduplicates, caches, retries and background-refetches;
`useMutation` handles writes with invalidation. The environment coupling
lives in three replaceable managers — `focusManager`, `onlineManager`,
`environmentManager`. The trap is query-core's probe:

```js
// @tanstack/query-core src/utils.ts
export const isServer = typeof window === 'undefined' || 'Deno' in globalThis;
```

With no `window`, query-core decides it is doing SSR:

- `retry` defaults to **0** instead of 3;
- stale timers are never scheduled and `refetchInterval` is disabled;
- `gcTime` defaults to **Infinity** instead of 5 minutes — the cache never
  collects;
- the default `focusManager` setup wants
  `window.addEventListener('visibilitychange')`, so focus refetching is
  inert.

The fix is `environmentManager.setIsServer()`, re-exported from
`@tanstack/react-query`, paired with react-x11's window focus events:

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

Focusing the window now refetches stale queries, like refocusing a browser
tab.

- **Call `setIsServer` before creating the `QueryClient`** — the managers
  are module singletons.
- Switching between two of your own windows fires blur-then-focus, which
  refetches stale queries; raise `staleTime` if that is too eager.
- `onlineManager` defaults to online under Node (no `navigator.onLine`).
  Wire it to NetworkManager over D-Bus for real offline handling.
- `@tanstack/react-query-devtools` is DOM-rendered and not usable.

## SWR {#swr}

**Adapter, 1 line — but read the dead end first.** swr@2.4.2.

`useSWR` fetches on mount, caches, dedupes and re-renders unmodified. Focus
and reconnect revalidation fail silently: SWR computes its environment once
at import time, with no override:

```js
// swr/dist/_internal/config-context-*.mjs
const isWindowDefined = typeof window != 'undefined';
const IS_SERVER = !isWindowDefined || isLegacyDeno;
```

Revalidation event sources are registered only `if (!IS_SERVER)` —
_including_ a custom `initFocus`/`initReconnect` passed through the
cache-provider config, so the provider approach from SWR's docs is dead code
under Node and swr registers zero listeners. There is no `setIsServer`.

Two ways out. The simple one: drive revalidation with `mutate`, whose key
filter `() => true` revalidates every cached key, from `<window onFocus>`:

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

The thorough one: make `IS_SERVER` false, which turns swr's own machinery
back on. It has to happen **before the first import of swr**:

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

swr then registers `visibilitychange`, `focus`, `online` and `offline`
listeners and `revalidateOnFocus` behaves. Two gotchas:

- Fire only `'focus'`. An `'offline'` event sets swr's internal online flag
  false and silently suppresses the deferred revalidation.
- `focusThrottleInterval` defaults to 5000 ms, so a focus within five
  seconds of the last revalidation is dropped — which looks exactly like the
  shim not working. Lower it while testing the wiring.

Other caveats:

- **`revalidateOnFocus` and `revalidateOnReconnect` are inert** unless you
  define the globals. Nothing warns you.
- The global `mutate` targets the _default_ cache, so with a custom
  `provider` via `<SWRConfig>` it silently misses; use
  `useSWRConfig().mutate` from inside the tree.
- Suspense mode throws
  `Fallback data is required when using Suspense in SSR.` because SWR
  believes it is on a server. Provide `fallbackData`, or avoid
  `suspense: true`.
- `preload()` is an SSR-gated no-op under Node.
- For focus revalidation with retries and cache GC done properly, prefer
  TanStack Query — it ships a supported environment override.
