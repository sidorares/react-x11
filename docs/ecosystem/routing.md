# Routing

There is no URL bar and no `history` object, so both routers here run on
their first-party in-memory location. What does not survive is `<Link>`,
which renders an `<a>` host in both; navigate from a `<box onClick>`
instead. These libraries give you matching, not a back stack — build stack
or tab navigation on top if you need it.

## wouter {#wouter}

**Out of the box — with `wouter/memory-location`.** wouter@3.10.0.

A 2 kB router: `<Router>`, `<Route>`, `<Switch>`, `useLocation`, pattern
params, and a pluggable location hook with a non-browser one shipped.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
import { Router, Route, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const { hook, navigate } = memoryLocation({ path: '/' });

// the react-x11 replacement for <Link>
const NavText = ({ href, children }) => (
  <box style={{ height: 20 }} onClick={() => navigate(href)}>
    <text style={{ color: '#08c' }}>{children}</text>
  </box>
);

const App = () => (
  <window width={400} height={300} title="routed">
    <box style={{ flexGrow: 1, flexDirection: 'column' }}>
      <Router hook={hook}>
        <box style={{ flexDirection: 'row', gap: 8, height: 20 }}>
          <NavText href="/">home</NavText>
          <NavText href="/about">about</NavText>
        </box>
        <Switch>
          <Route path="/">
            <text>home page</text>
          </Route>
          <Route path="/about">
            <text>about page</text>
          </Route>
          <Route>
            <text>not found</text>
          </Route>
        </Switch>
      </Router>
    </box>
  </window>
);

(await createRoot()).render(<App />);
```

- **Always mount the memory hook at the top.** A `<Route>` outside a
  `<Router hook={...}>` falls back to `useBrowserLocation` and crashes
  immediately with `ReferenceError: location is not defined`.
- **`<Link>` does not work**: it renders an `<a>`. `<Link asChild>` avoids
  the `<a>` but does not navigate, because its click guard checks
  `event.button !== 0` and react-x11's `MouseEvent.button` is the X button
  number, `1` for left.
- `useLocation()[1]` is the same `navigate` from inside components; the
  module-level one is handier with a single router.
- `useHashLocation` and `useBrowserLocation` are browser-only. Everything
  else — matching, params, nesting, `useRoute` — is pure.
- `memoryLocation({ record: true })` keeps a `history` array, which is the
  raw material for a back stack and handy to assert on in tests.

## react-router {#react-router}

**Out of the box — `MemoryRouter`, and none of the DOM components.**
react-router 7.18.2.

The router core — `useRoutes`, `useNavigate`, `useParams`, `useLocation`,
loaders, actions — is DOM-free. Import from `react-router`, not
`react-router-dom`, whose browser entry points are what fails.

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
import {
  MemoryRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
} from 'react-router';

function Home() {
  const navigate = useNavigate();
  return (
    <box style={{ flexDirection: 'column' }}>
      <text>home page</text>
      <box style={{ height: 20 }} onClick={() => navigate('/about')}>
        <text>go to about</text>
      </box>
    </box>
  );
}

function About() {
  const loc = useLocation();
  return <text>{`about page (${loc.pathname})`}</text>;
}

(await createRoot()).render(
  <window width={300} height={200} title="routed">
    <box style={{ flexGrow: 1 }}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<text>not found</text>} />
        </Routes>
      </MemoryRouter>
    </box>
  </window>,
);
```

- **`BrowserRouter` and `HashRouter` fail** — `createBrowserHistory` needs
  `window.history`. The error is
  `react-x11: uncaught error ReferenceError: document is not defined` at
  `getUrlBasedHistory`; `render()` does not throw, react-x11 logs it and the
  window count stays 0.
- **`<Link>`, `<NavLink>` and `<Form>` all render `<a>`/`<form>` hosts** and
  cannot work. Use `useNavigate()` on a `<box onClick>`.
- A `<Link>` with a bare string child hits the raw-text error before the
  element error: `react-x11: raw text "go" must be wrapped in a <text>
element`. Both are in the
  [register](../ecosystem.md#render-time).
- Without loaders and actions, wouter is the much smaller dependency.
