# Testing

`react-x11/test` renders your app through a **real X11 protocol connection
to a real X server, in this process** — no `$DISPLAY`, no Xvfb, no native
dependency, works on macOS. So a test can read pixels back with `GetImage`
and inject input through the server's own grab and focus machinery, which
means a passing test has exercised the path a user actually takes.

That server is node-x11's `lib/xserver`, written in JavaScript. It arrives
with ntk, so there is nothing new to install.

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderX11,
  cleanup,
  screen,
  userEvent,
  expectPixel,
} from 'react-x11/test';

afterEach(cleanup);

test('adding a task', async () => {
  const { ctx } = await renderX11(<Tasks />, {
    fonts: { 'sans-serif': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
  });

  await userEvent.type(screen.getByRole('textbox'), 'buy milk\n');

  screen.getByText('buy milk');
  await expectPixel(ctx, 12, 40, '#2980b9', { tolerance: 8 });
});
```

The vocabulary is Testing Library's, because that is the one React
developers already have. It is not Testing Library — there is no document
for it to query — but `getByRole` / `userEvent.click` / `waitFor` mean here
what they mean there.

## `renderX11(element, options)`

Mounts the tree and returns a handle **plus the queries bound to it**, so
`const { getByText } = await renderX11(<App />)` reads the familiar way.

| option            |                                                                       |
| ----------------- | --------------------------------------------------------------------- |
| `width`, `height` | the window (default 640×480)                                          |
| `screen`          | the display (defaults comfortably larger than the window — see below) |
| `backend`         | `'xserver'` (default) or `'mock'`                                     |
| `fonts`           | `{ family: '/path/to.ttf' }` — **required for text pixels**           |
| `wrap`            | wrap in a `<window>`; default true unless the element is one          |
| `app`             | render into a connection you already have                             |

| on the result         |                                                                       |
| --------------------- | --------------------------------------------------------------------- |
| `ctx`                 | the window's 2d context — what the pixel helpers read                 |
| `window`              | the live ntk `Window`                                                 |
| `windowNode`          | the `WindowNode`: the paint, layout and event root                    |
| `server`, `app`       | the X server and the connection, for anything this API does not cover |
| `rerender`, `unmount` | re-render into the same root; take it down                            |

**`fonts` is not optional for pixel assertions involving text.** Family
resolution otherwise shells out to `fc-match`, which gives a different answer
on every machine and no answer at all in a container — see the `sans-serif`
note in [AGENTS.md](../AGENTS.md).

**The screen is bigger than the window on purpose**, because on a real
display it is. A press "outside the application" is what dismisses a menu,
and it needs somewhere to land.

## Queries

`getBy*` (exactly one, or throw), `queryBy*` (one or null — the way to
assert absence), `getAllBy*`, and `findBy*` (retried until it appears).
Four of each: `ByText`, `ByRole`, `ByTestName`, `ByPlaceholder`.

```js
getByText(/guestbook/); // substring, case-insensitive
getByText('Save', { exact: true });
getByRole('button', { name: 'Save' });
getByTestName('name-field'); // matches a `data-testname` prop
getByPlaceholder('Your name');
```

- `screen` is the same queries bound to the most recent render, **popups
  included** — a `<popup>` is a child node of the window that opened it, so a
  menu or a dialog is queryable without any special casing.
- `within(node)` scopes them to a subtree.
- `all(predicate?)` is the escape hatch: every node under the root, in paint
  order, matched on anything — `screen.all((n) => n.kind === 'gauge')`.
  `node.kind` is the element name, which is how an element with no text and
  no role of its own is still reachable.
- A miss prints the tree it searched, rather than leaving you with
  `undefined is not an object`.

**About roles.** `roleOf` answers from the same model the AT-SPI bridge
publishes ([accessibility.md](accessibility.md)): an explicit `role` prop
if there is one, else the element's own semantics — `textinput` and
`textarea` report `textbox`, `window` and `popup` `window`, `image` `img`,
`text` `text`; kinds with no accessibility meaning (`box`, `canvas`)
answer their kind. The widgets name themselves — `Button` is `button`,
`Checkbox` `checkbox`, `Switch` `switch`, `Radio` `radio`, `Select`
`combobox` (its options `option`), `Slider` `slider`, `Tabs` `tablist`/
`tab`/`tabpanel`, `Dialog` `dialog` — so what a
test selects by is exactly what a screen reader hears.

**And the bridge itself.** Importing `react-x11/test` sets `NO_AT_BRIDGE`,
so a test run on a desktop never registers phantom applications with the
live screen-reader registry. Tests that exercise the bridge deliberately
point `AT_SPI_BUS_ADDRESS` at an in-process bus instead — see
[accessibility.md](accessibility.md#testing-and-verifying).

## Components

The queries above see what a user sees. Sometimes a test needs the React
side instead — _which component_ made this node, with what props and state —
and this is the layer for it. Prefer the user-visible queries when either
would do; reach here when the question is genuinely about a component.

```js
const row = screen.getByComponent('TaskRow'); // also RegExp or predicate
within(row).getByText('buy milk'); // scoped to that instance

ownerChainOf(node); // ['Label', 'TaskRow', 'App'] — who wrote the JSX
sourceOf(node); // { file, line, column } of the JSX that made it
```

`getByComponent` returns, per rendered instance, the topmost host nodes of
its output — the container `within()` wants next. Ownership is React's JSX
owner (_who wrote the element_), so content passed as children belongs to
the component whose JSX it appears in, and a miss lists the component names
that are in the tree. All of this reads debug info development React records
on every fiber (`_debugOwner`, `_debugStack` — the same data
[click-to-component](click-to-component.md) navigates by), so it costs no
setup and no dependency, and returns nothing in production builds.

### `inspect(node)` and `setHook`

```js
const c = await inspect(screen.getByText('buy milk'));
c.name; // 'TaskRow' — the nearest mounted component
c.props; // its live props object (treat as read-only)
c.hooks; // [{ id, name: 'State', value, editable, source, subHooks }]

await c.setHook(0, 41); // set a useState/useReducer value…
await c.setHook(1, ['filter', 'text'], 'milk'); // …or a path inside one
```

This drives the **React DevTools backend in-process**: the same
react-debug-tools inspection and the same override path the DevTools app
uses, minus its WebSocket — nothing listens on anything, and `ws` is never
loaded ([devtools.md](devtools.md) has the wiring). It needs the
`react-devtools-core` package in your devDependencies; the queries above
work without it.

What to know before leaning on it:

- **Reading hooks re-runs the component.** That is how react-debug-tools
  recovers hook names: the render function is invoked once under a stub
  dispatcher, output discarded, `console` muted. A render-counting test
  will see it.
- **Values:** `props` and editable hook values are the live objects;
  everything else is DevTools' copy — primitives exact, deep objects as
  the same previews the DevTools panel shows.
- **Only `useState`/`useReducer` are settable** (`editable: true`; a
  reducer is bypassed, not driven — no action runs). Hooks are addressed
  by their `id`, an index the Rules of Hooks fix for the life of the
  component. Anything else — an Effect, a Memo, a `useContext` value —
  `setHook` refuses by name; for context, wrap a provider.
- **Nearest component is tree ancestry** (what the DevTools panel would
  select), where `getByComponent`/`ownerChainOf` are JSX ownership; the
  two differ for content passed as children.
- `setHook` resolves after React re-rendered and repainted (it is
  `act`-wrapped), so a query straight after it sees the result.

## Driving it

`userEvent` is the layer to reach for: each call injects input **and**
flushes what it caused, so it is async and there is nothing to remember.
`fireEvent` is the synchronous half, for when a test needs one side of a
gesture — wrap it in `act()` yourself.

```js
await userEvent.click(getByRole('button'));
await userEvent.click(node, { modifiers: ['Shift'], button: 3 });
await userEvent.hover(node);
await userEvent.type(input, 'héllo\n'); // \n is Return
await userEvent.tab({ shift: true });
await userEvent.key(XK_ESCAPE); // react-x11/keysyms
await userEvent.key(XK_DEAD_ACUTE); // then type 'e' for é — events.md#composition
await userEvent.wheel(list, { deltaY: 3 }); // three notches, as buttons 4-7
await userEvent.wheel(list, { deltaY: 0.25, smooth: true }); // a touchpad
await userEvent.clickOutside(); // dismisses a menu — see below
```

Two things this buys that emitting on the ntk window never could:

**Grabs are real.** A `<popup grab>` is dismissed by a real press outside
it. But note _where_ outside: react-x11's popups grab with **owner events**,
so a press on one of the client's own windows is delivered normally — that is
what keeps submenus and the owner window working. Only a press somewhere the
client does not own reaches the grab holder. `userEvent.clickOutside()` is
how a test says that; clicking another widget and expecting the menu to close
is testing the wrong thing.

**Focus is real**, so `trapFocus`, `autoFocus` and Tab traversal are
exercised rather than simulated. Deciding which window gets the keyboard is a
window manager's job and there is no window manager, so `renderX11` plays the
part with one `SetInputFocus` at mount — otherwise keys would go to whatever
the pointer happened to be over, which is a rule nobody should have to learn.

**A smooth scroll is the one exception**, and says so. Whole notches go
through the server as the button presses X really uses, but a touchpad's
fraction of a notch is XI2, and the in-process server has no XInput — there
are no valuators to inject. `{ smooth: true }` therefore delivers the `wheel`
event ntk would have derived from them, straight to the window. Everything
above it is still the real path: the dispatch, the chain, the default action.

**Typing works for text the layout does not have.** `userEvent.type(input,
'héllo')` binds a spare keycode for `é` on both the server's keymap and the
client's cache, so a test can type real text without owning a keymap.

**Drags are real too.** Because the pointer events are genuine, a
drag-and-drop gesture is just three of them — with a real 4px threshold, so
move before releasing:

```js
await act(async () => {
  fireEvent.mouseDown(card);
  fireEvent.mouseMove(card, { dx: 8 }); // past the threshold, still on the card
  fireEvent.mouseMove(bin);
  fireEvent.mouseUp(bin);
});
```

`onDragStart`, `onDrop` and `onDragEnd` all run, and `e.items` carries the
payload by reference. A drop from _another application_ needs a second X
connection playing the foreign source — see
[drag-and-drop.md](drag-and-drop.md).

## What a screen reader would hear

`renderX11(element, { a11y: true })` adds `at` to the result: the
assistive-technology spy, an in-process log of the same semantic feed the
AT-SPI bridge serves to Orca — focus, state changes, text edits,
announcements — observed at the hook seam, before any D-Bus. Synchronous,
bus-free, and it runs wherever the suite runs.

```js
const { at } = await renderX11(<App />, { a11y: true });
await userEvent.tab();
assert.equal(at.focused().utterance, 'Save, button');
await userEvent.key(XK_SPACE);
assert.ok(at.since().some((e) => e.type === 'state' && e.state === 'checked'));
```

A composition is in there as itself: a dead key logs one `preedit` entry
(`preedit: "´"`) and no insertion, and the letter that finishes it logs
`preedit: cleared` and one `insert: "é"` — the same line the bridge draws
with `:system`, which is how a test catches a screen reader that would echo
a half-typed accent.

A [registered element](extending.md#text-a-screen-reader-can-read) that
reports its own text is observed through the same seam, so a package
shipping an editor or a document view can assert what it says with no bus
and no desktop — `test/a11y-custom-text.test.js` is the worked pair.

`at.events()` / `at.since()` are precise facts, `at.transcript()` the
one-line summaries, `at.focusables()` every keyboard stop in Tab order with
its utterance — a nameless control reads `"(no accessible name)"`, which
turns the most-missed accessibility bug into a one-line audit. The four
canonical tests (focus order, keyboard trap, nothing nameless, states
announced) live in `test/a11y-spy.test.js`, written to be copied; the model
behind the wording is [accessibility.md](accessibility.md)'s own, not an
imitation of Orca's.

## `act`, and the three clocks

`act(fn)` flushes everything between a state update and a pixel. There are
three separate clocks in the way, and a wrapper that drives only the first
stays flaky on pixel assertions:

1. **React's** — `React.act` with `IS_REACT_ACT_ENVIRONMENT` set.
2. **The wire** — events the injection produced are not in the tree yet.
   The server writes them asynchronously, so a round trip on its own can
   overtake them and `act` would return before the pointer move had been
   dispatched at all, which looks exactly like a hover that does not work.
3. **ntk's frame clock** — painting is scheduled through
   `requestAnimationFrame`, paced behind the display's vertical blank (or a
   server round trip where there is no Present extension). Synthetic input can
   leave a frame scheduled and never run, so `act` runs the frame directly
   rather than waiting for it, then round-trips so the server has actually
   processed the drawing.

`waitFor(fn)` retries until `fn` stops throwing, `act`-ing between attempts —
so waiting also _advances_. Reach for it whenever the thing you are asserting
arrives through more than one of those stages (a `Button`'s hover is React
state, so its repaint is an event, a re-render and a frame).

## Pixels

```js
await expectPixel(ctx, 10, 10, '#2980b9', { tolerance: 8 });
await waitForPixel(ctx, 10, 10, '#c0392b', { timeout: 2000 });
const [r, g, b] = await pixelAt(ctx, 10, 10);
const n = await countPixels(ctx, { width: 80, height: 40 }, '#c0392b');
await toPNG(ctx, '/tmp/shot.png', { width: 320, height: 240 });
```

A pixel proves the tree, the layout, the clip, the paint order, the colour
parsing and the wire encoding at once — and it is the only assertion that
catches the class of bug where everything commits correctly and nothing
reaches the screen. Two details it demands: the readback is **BGRA**, which
the helpers handle, and antialiasing means every comparison takes a
**tolerance**.

`toPNG` is also how a pull request gets a screenshot rendered by its own
code, which this repo asks for ([AGENTS.md](../AGENTS.md), "Pull requests").

## Animations

```js
const clock = withFrameClock(); // install it BEFORE the render
await rerender(<Fading on />);
clock.advance(100);
await act(); // part way
clock.advance(200);
await act(); // arrived
clock.restore();
```

Install it **before** the render. Every timestamp in the tree has to come
from the same clock: mixing a real start time with a frozen `now` gives a
transition that never progresses, which is a confusing way to spend an hour.

## The mock backend

`backend: 'mock'` swaps the server for a fake 2d context that records draw
operations. No server, no connection, much faster, and no pixels — good for
asserting on layout and on the node tree, which is most tests. Input
injection is not available and says so.

A batch records as the fills it stands for: `ctx.fillRects([[x, y, w, h], …])`
leaves one `fillRect` operation per rectangle, because the only difference
between them is a request count and there is no server here to send it to. So
an assertion on what a drawing painted holds whether or not it batched.

## Testing Library itself

It does not work here and no shim will fix it: its queries are built on a
document. The five failure modes are recorded in the
[negative-results register](ecosystem.md#render-time). This page is the
replacement, not a workaround for it.
