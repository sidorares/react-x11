# Container queries: what the window queries already answer, and what a per-node one would cost

_Research document, 2026-09-06. Written against the `master` checkout at c9ce902
(react-x11 2.6.1; `src/nodes.js` @ 12,354 lines, `src/styles.js` @ 1,694). The
one measurement is a yoga-only spike (§7), run in-process on one machine (Apple
M1 Pro, node 26); nothing here was run against an X server, because nothing
here needs one. file:line references are to that checkout and will drift._

_Implemented after this was written, along the lines of §5 and §8:
[styling.md](../styling.md#container-queries) is the reference and
`examples/container-queries.jsx` the demonstration._

---

## 0. TL;DR

**Feasible, and most of the machinery already exists.** A window size query
(`'@width >= 600'`, [styling.md](../styling.md#window-size-queries)) and a
container query differ in exactly one structural way: a window's size is an
_input_ to layout and a container's size is an _output_ of it. So a container
query cannot be resolved where the window queries are resolved — before the
pass — but has to be resolved _after_ a pass, and the tree laid out once more
if any answer changed. That loop is not new either: it is what `realize()`
already runs for an auto-sized window that carries `@width` blocks
(`nodes.js:9480-9503`, the "measure, re-resolve, measure once more" rule).
Everything else — the grammar, the per-window registry, per-node
re-resolution, pushing a style diff into yoga, the layout diff that turns a
reflow into damage — is reusable as it stands.

Findings, compressed:

1. **The cost is bounded and small.** After a pass, reading the size of 300
   registered containers costs 0.04 ms; a second yoga pass costs in proportion
   to the subtrees whose style actually changed — 0.46 ms when one card's
   block flips, 3.0 ms when all 300 do (≈ 1.7× a window-resize pass), on a
   3,600-node tree. Frames where no answer crosses a threshold — every scroll
   notch, every hover, most resize frames — pay the reads and nothing else
   (§6).

2. **The cycle is the real design question, and it is a detection problem
   here rather than a prevention one.** CSS makes a container query safe by
   _containment_: `container-type: inline-size` computes the container's
   inline size as if it had no content, so nothing a descendant does can move
   it. Yoga has no containment. It does have three constructions where a
   node's size is already independent of its subtree (an explicit size, a
   flex item with its content floor off, a scroller) and one clean signal
   when a design is unsatisfiable: the second look disagrees with the first.
   Settle once, pin the answer, and warn naming the node (§3).

3. **On targeting** (§4): the recommendation is CSS's rule — the **nearest
   ancestor that declares itself a container**, with an optional **name** to
   skip past nearer ones — as one grammar, `'@container [name] width >= 400'`,
   with the declaration a _style property_ (`container: true | 'sidebar'`).
   **Direct parent** is rejected as a grammar (one wrapper `<box>` changes the
   answer silently, which is the exact failure that made CSS abandon element
   queries), though `container: true` on the parent spells the same thing
   explicitly. **Self** queries are possible only paint-only and are deferred.
   Making **scrollers implicit containers** is rejected in favour of
   documenting them as the ideal thing to declare one on. And a general
   `onLayout` on any `<box>` — today only a scroller has `onViewport` — is the
   React-side seam that should ship first regardless.

## 1. What exists: the window size queries

The pieces, because the design below is mostly "the same, later":

- **Grammar and resolution** (`styles.js`). `SIZE_QUERY` (`:479`) parses
  `@width|@height op number`; `parseQuery` (`:498`) memoizes per key;
  `resolveQueries(style, { size, supports })` (`:561`) merges every matching
  block in declaration order over the base and returns the base itself when
  nothing matches, so the identity fast path survives. `validateStyle`
  (`:602`) makes a malformed key an error at `createStyles` time, and a query
  block — unlike a state block — may carry layout properties, because it is
  only ever re-evaluated inside a layout pass a resize already required.
- **Per-node registration** (`nodes.js`). `_syncStyle` (`:1975`) registers a
  node with its window's `_sizeQueryNodes` when `styleHasSizeQueries`
  (`:2000-2007`) and folds the matching blocks into `_baseStyle` _before_ the
  state blocks (`:2036-2042`), so a `:hover` inside the wide layout still
  wins over the wide layout. `_registerSizeQueries` (`:2391`) is the recursive
  hook `insertBefore` runs so a subtree attached after a resize matches
  against the size the window is now.
- **Per-node re-resolution.** `_sizeQueriesChanged` (`:2708`) is the whole of
  it: `_syncStyle` again, `localTextStyleChanged` for the node-local text
  props, and `applyLayoutStyle(yoga, style, before)` (`styles.js:1543`) to
  push only the layout properties that moved into yoga — which dirties the
  yoga node, so the next pass re-lays out that subtree and nothing else.
- **The window's trigger.** `_resolveSizeQueries(deviceW, deviceH)`
  (`:10987`) divides by the scale, compares with the last `querySize`,
  re-resolves every registered node and marks the content floors dirty
  (`_floorsDirty`). It runs from `flush()` before `_layoutRoot` (`:11385`),
  and twice inside `realize()`'s auto-size `measure()` loop (`:9488`,
  `:9503`) — the second time _after_ a measurement, re-measuring once if the
  answer moved. That second call is a container query in everything but name:
  it resolves blocks against a size the layout produced.
- **Damage.** `_absolutizeChildren` (`:11416`) runs once after whatever
  layout passes the frame needed, and `_assignAbs` (`:3719`) claims the old
  and new rect of every node the pass moved through `layoutDiffSink`. Any
  number of yoga passes before that walk cost nothing in damage terms.

One property of the current path is worth naming because the container path
must not inherit it: every registered node re-runs `_syncStyle` whenever the
window's logical size changes at all (`:11002`), not only when one of _its_
blocks changed answer. At window-resize frequency that is fine. A container's
size can move on far more frames than a window's, so the container path has
to gate the re-sync on an answer actually flipping (§5).

## 2. What is different about a container

Four things, and only the first is structural:

1. **Input versus output.** The window's size is known before the pass; a
   container's size is what the pass produces. Resolution moves to _after_
   `_layoutRoot`, and a changed answer costs one more pass.
2. **A target.** Which ancestor. The window query has one implicit target per
   tree; a container query needs a rule for finding its container (§4) and a
   cache for the answer, dropped when the tree above the node changes — the
   shape `direction` already has (`:2482`, resolved nearest-first through
   `parent`, cached, invalidated by `_redirectSubtree`).
3. **Many registries.** One `_sizeQueryNodes` per window becomes a set of
   dependents per window, each with a pointer to the container(s) it asks
   about, and a remembered last answer per block.
4. **The cycle** (§3). A window cannot be moved by the styles inside it; a
   container can.

## 3. The cycle

CSS's answer is `container-type: inline-size`: size containment on that axis,
so the container is sized as if empty and no descendant's style can feed back
into the size the descendants are querying. Yoga has no containment. What it
has instead are the three constructions under which a node's size on an axis
is _already_ independent of its subtree:

- an explicit `width` / `height`;
- a flex item whose size the parent distributes, with its **content floor
  off** — `minWidth: 0` plus a fixed `flexBasis` (or `flex: 1`, which expands
  to basis `0`). The automatic minimum is the one route by which content
  feeds back into a flex item's size, and `minWidth: 0` is its documented
  switch ([elements.md](../elements.md#a-floor-the-content-decides));
- a **scroller**: `overflow: 'scroll'` implies `minWidth: 0`,
  `minHeight: 0` and — when it grows — `flexBasis: 0`
  (`styles.js:1343`, `resolveComputedStyle`). Content overflows a scroller
  rather than growing it, which is containment in everything but name. It is
  the natural container, and the docs should say so.

Where none of those hold, the design can be unsatisfiable. The spike's last
section (§7) shows the shape: a card at 230 px whose block, below 250, sets a
`flexBasis` that makes it 310, whose block above 250 sets one that makes it
230 — and so on for as many passes as one is willing to run. No number of
passes settles it, and no size satisfies it.

Three ways to live with that:

| option                                                                                                                  | verdict                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(i) Settle once, pin, warn.** Re-lay out once; if a second look disagrees, keep the answer and say so in development. | **Recommended.** Mirrors `realize()`'s rule. CSS makes the bad case impossible; this makes it _visible_, with the container, the dependent and the axis named. The common responsive pattern (less content when narrow) is monotone and settles on the first re-layout, so a warning means a genuine design contradiction. |
| **(ii) Paint-only container blocks**, like state blocks.                                                                | No cycle can form, but the main use case — a column becoming a row, a sidebar folding away — is layout. Rejected as the default; it is the right rule for _self_ queries (§4 D).                                                                                                                                           |
| **(iii) A development-time check that the queried axis is pinned** by one of the three constructions above.             | Rejected: it is a heuristic (a parent with an explicit width pins a child's row too, invisibly to a per-node check), it would refuse designs that settle, and the runtime detection in (i) is exact.                                                                                                                       |

The pinning rule in (i) needs one refinement, or it strobes. Take a frame
that starts with blocks resolved as B₀ and lays out to size S₁. Resolving
against S₁ gives B₁. If B₁ = B₀, done — the common case, and no extra pass.
Otherwise apply B₁ and lay out again, to S₂; resolve to B₂. If B₂ = B₁,
settled at one extra pass. If not, the design oscillates — and _leaving it
there_ means the next frame's first pass starts from B₁/S₂, finds B₂, applies
it, gets S₁, finds B₁ again, and every frame that runs layout flips the block.
The fix is to remember the pair (S₂, B₁) on the dependent and hold B₁ while
the first pass keeps producing S₂; the query re-evaluates when the container's
size moves for some _other_ reason. A few lines, and the warning fires once.

Nested containers need the cap stated correctly too. If an outer container's
dependent flips, the second pass can legitimately move an _inner_ container
past one of its own thresholds — a cascade, not an oscillation. So the loop
runs up to a small fixed number of passes (three is enough for any nesting
seen in the examples), and "oscillation" is defined as a dependent returning
to an answer it already held _this frame_, which is exact where "changed on
the second look" would pin a cascade wrongly.

## 4. Targeting the container

The question this document was asked. Each row is a way for a style to say
_which_ box it is asking about.

| how it reads                                                   | setup                                  | survives a wrapper `<box>`?     | lookup                                                             | cycle exposure                                            | CSS transfer                                          |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| **A. nearest declared ancestor** — `'@container width >= 400'` | `container: true` on the ancestor      | yes                             | walk `parent` to the first declaring node; cached like `direction` | as §3                                                     | `@container (min-width: 400px)`                       |
| **B. named** — `'@container sidebar width >= 400'`             | `container: 'sidebar'` on the ancestor | yes                             | same walk, filtered by name; skips past nearer containers          | as §3                                                     | `container-name` / `@container sidebar (…)`           |
| **C. direct parent** — `'@parent width >= 400'`                | none                                   | **no**                          | one property read                                                  | as §3                                                     | none — this is the element-query proposal CSS dropped |
| **D. self** — `'@self width >= 400'`                           | none                                   | n/a                             | none                                                               | the self-cycle — safe only if the block is **paint-only** | none                                                  |
| **E. nearest scroller, implicitly**                            | none                                   | yes, unless the wrapper scrolls | walk `parent` to the first `overflow: 'scroll'`                    | none — a scroller's size is content-independent           | none                                                  |
| **F. React-side** — `onLayout` + context, `useContainerSize()` | a component around the subtree         | yes                             | none in the renderer                                               | none (it is a state update)                               | `ResizeObserver` + a hook                             |
| **G. by kind or role** — `'@container [role=list] …'`          | none                                   | yes                             | walk with a predicate                                              | as §3                                                     | relational selectors                                  |

**Recommendation: A and B as one grammar; F beside them as the seam; D
deferred; C, E and G rejected.** The reasons, one per row:

- **A** is CSS's default and the one that survives composition. A component
  that adapts to where it is put must not have its answer changed by the
  consumer wrapping it in a `<box>` for a border, and an explicit declaration
  on the container is the only thing that guarantees that.
- **B** exists for the case A gets wrong: a component that is itself a
  container for its own rows (a card sizing its columns) would otherwise
  capture every unnamed query inside it, including the ones its children
  meant for the page. A name lets a query reach past. The one decision B
  forces is what an **unmatched name** does. CSS's rule is that the query
  simply does not apply, and that is the right one here too — it is what lets
  the same component render inside and outside the `sidebar` — even though it
  means a typo in a name is not an error. Worth a line in the debugging
  guide; not worth making the component unusable outside its context.
  An **unnamed** query with no declared container above it, on the other
  hand, should be a development-time **error**: CSS silently falls back to
  the viewport there, but this codebase already has a spelling for the window
  (`'@width'`), so the fallback would only ever hide a forgotten declaration.
- **C** reads as the least setup, and it is the closest to "adapt to the slot
  I was put in" — which is the point of the feature. But the parent of a
  reusable component is whatever its consumer rendered, and the moment that
  consumer adds a wrapper for padding or a border the query is asking a
  different box a question with a different answer, with nothing in the
  program having changed its mind. CSS went through exactly this — element
  queries were proposed for a decade and never shipped, and container
  queries shipped with a required declaration. A with `container: true` on
  the parent is C spelled so that it cannot drift.
- **D** is the one shape CSS cannot offer at all, because of the self-cycle,
  and this codebase _could_: the paint-only restriction state blocks already
  live under (`STATE_PROPS`, `styles.js:429`) is exactly the restriction that
  makes a self query safe. The use cases are thin — a card muting its title
  when narrow, a border that drops at a small size — so it is a possible
  later addition, not part of this design.
- **E** is tempting because the scroller is the one place a cycle cannot
  form (§3). But _implicit_ containers mean the presence of a scroller
  between a node and its intended container changes which box answers, with
  no declaration anywhere to point at. Explicit wins; the docs should
  recommend declaring `container` on the scroller.
- **F** is not a competitor but the seam ("decide it, then leave a way out",
  AGENTS.md). Decisions that are not styles — how many columns to
  virtualize, which component to render at all — need a size in React, and
  today only a scroller offers one (`onViewport`, `nodes.js:6216`, fired from
  layout via `setImmediate`). Generalizing it to `onLayout` on any `<box>` is
  small: `_assignAbs` already detects the size change; it lacks only the
  deferred notification. What F cannot do is what makes the renderer-native
  query worth having: its answer lands a **frame late**. A size change
  reaches React after the commit that caused it, React re-renders, a second
  commit re-lays out — one frame drawn at the wrong layout on every threshold
  crossing during a drag. A renderer query resolves inside the same flush and
  is never seen wrong.
- **G** is a relational selector, which styling.md's "Decided" section rules
  out for the whole style system: inheritance and node state, no matching
  against other nodes.

**Where the declaration lives.** As a **style property**, not an element
prop. AGENTS.md draws the line — props carry element semantics, `style`
carries the CSS-like vocabulary — and `container` is CSS vocabulary
(`container-type`/`container-name`). It also has to be settable from _inside_
a query block (a box that becomes a container only in the wide layout), which
only a style property can be. It joins `STYLE_PROPS` beside `cursor` and
`hitSlop` as a property that is neither yoga nor paint, and DevTools' style
editor lists it for free through `STYLE_PROP_NAMES`.

**Units.** A threshold is in logical pixels like every other length in the
block, and it should be divided out by the **dependent's** `scale`, not the
container's: the author wrote `'@container width >= 400'` next to their own
`width: 400`, and the two numbers must mean the same thing. The two scales
differ only when the dependent adds a `scale` of its own under the container,
which is rare and then reads as CSS's rule that query lengths resolve in the
querying element's context.

## 5. Mechanism, at the hook points

`styles.js`:

- `CONTAINER_QUERY = /^@container(?:\s+([A-Za-z_][\w-]*))?\s+(width|height)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/`,
  parsed into `{ kind: 'container', name, axis, op, value }` by `parseQuery`;
  `sizeMatches` is reused unchanged. `validateStyle`'s message grows a third
  example. `styleHasContainerQueries` joins the two existing `hasQueryOfKind`
  predicates, and `resolveQueries` takes a third option, `containers`: a map
  from name (`''` for unnamed) to the container's logical size, built per
  dependent by the node. `resolveQueries` is public through `react-x11/style`;
  widening its options object is the shape it already has.
- `container` joins `STYLE_PROPS`, validated as `true | string`.

`nodes.js`, on `Node`:

- `_syncStyle` records `_containerQueried` and the set of names the style asks
  about, and registers the node with `root._containerQueryNodes`, exactly as
  `_queried` does today (`:2000-2007`). `_registerSizeQueries` (`:2391`)
  re-registers it on insert.
- `_containerFor(name)`: walk `parent` to the first node whose `style.container`
  matches (`true` for unnamed, the string for named), cached on the node and
  dropped when the node is inserted and when any ancestor's `container` value
  changes (a subtree walk from the changed node, the way `_redirectSubtree`
  (`:2506`) drops `direction`). Containers are declared rarely and changed
  more rarely, so the walk is not a hot path.
- Per dependent, the last boolean answer of each block, so that a re-sync runs
  only when one flips (§1's caveat). `_sizeQueriesChanged` (`:2708`) is then
  the re-sync as it stands.

`nodes.js`, on `WindowNode`, in `flush()`:

- `_resolveContainerQueries()` runs **after** the layout passes (`_layoutRoot`
  or `_applyContentFloors`, `:11385-11392`) and **before**
  `_absolutizeChildren(0, 0)` (`:11416`). For each dependent it reads its
  containers' `yoga.getComputedWidth()`/`Height()` — yoga's computed values,
  not `abs`, which is still the previous frame's — divides by the dependent's
  scale, evaluates each block, and calls `_sizeQueriesChanged()` on the
  dependents whose answer set changed. Their yoga nodes are dirty now; the
  same style route a prop change takes marks their content floors stale
  (`_floorsStale` / `_floorsDirty`, `:2350`), and one more layout step runs.
  Then the §3 loop: re-read, pin what returned to an earlier answer, stop at
  the cap. `_absolutizeChildren` runs once, against the final layout, so the
  damage claims are right by construction.
- The same call goes inside `realize()`'s `measure()` loop (`:9480-9503`),
  under the same cap, so an auto-sized window's natural size accounts for the
  container blocks its content will resolve to.
- Windows are boundaries, as for every other walk (`!child.isWindow`): a
  `<popup>` inside a container is a root of its own and asks its own window.
- `yoga.hasNewLayout()` is **not** the way to find containers that moved: it
  is the scroller's witness, "consumed here and nowhere else" (`:6089`), and
  reading it for 3,600 nodes costs seven times what reading the registered
  containers does (§6). The container pass keeps its own last-size
  bookkeeping and never calls `markLayoutSeen`.

One pre-existing quirk the new blocks would inherit, and the same PR should
fix: `flattenStyle` (`styles.js:663`) merges a **state** block that appears in
two entries of a style array but **replaces** a query block
(`isState(key) && into[key]`), so `[{ '@width >= 600': { a } }, { '@width >= 600': { b } }]`
keeps only `b`. Query keys should merge the same way.

## 6. Cost

The spike (§7) builds 3,613 yoga nodes — 12 sections of 25 cards of 11 leaves,
the shape of a card gallery — lays it out, then changes one layout property on
some of the cards and times the second pass. Medians of 7, in-process,
Apple M1 Pro:

| case                                           | second pass | nodes yoga re-laid out |
| ---------------------------------------------- | ----------: | ---------------------: |
| nothing changed                                |    0.005 ms |                      1 |
| 1 card flipped a block                         |     0.46 ms |                     93 |
| 3 cards (1%)                                   |     0.65 ms |                    297 |
| 30 cards (10%)                                 |      2.1 ms |                  2,007 |
| all 300 cards                                  |      3.0 ms |                  3,613 |
| the window resized by 100 px (for scale)       |      1.8 ms |                  3,613 |
| **reading** width of 300 registered containers |    0.044 ms |                        |
| reading width + height of all 3,613 nodes      |     0.82 ms |                        |
| `hasNewLayout()` over all 3,613 nodes          |     0.33 ms |                        |

What this says: yoga's second pass is incremental — it re-lays out the dirtied
subtrees and reuses the cached layout of everything else — so the extra pass
costs in proportion to how much of the design actually changed, and even the
worst case (every card flips at once, which is a threshold crossing during a
resize, not a steady state) is under twice the resize pass it follows. The
counts are larger than the flipped subtrees alone because a card sits in a
wrapping row: a card that grows taller re-stretches every card on its line,
which is yoga doing exactly what the layout asks and what a real design pays
too.
Reading the containers is negligible **if** it reads the registered
containers directly and not a whole-tree flag walk.

What it does not measure, and where the real cost is:

- The JS half of a flip: `_syncStyle` on each dependent whose answer moved —
  flatten, tokens, scale, `_retarget` — and the incremental content floors
  for those nodes. This is the same per-node cost the window path pays today
  for _every_ registered node on every resize; here it is paid per _flipped_
  node, which is what the answer gating buys.
- The content floors are the expensive half of any relayout — three extra
  passes were 21 of a 44 ms frame on 3,600 nodes before they were made
  incremental (`_applyContentFloors`, `nodes.js:9257`). A container flip
  re-measures only the flipped nodes' extents, but a flip that changes a
  row's main-axis items does re-run the width pass for that row.

Frames where no block crosses a threshold — every scroll notch, every hover,
every resize frame between two breakpoints — pay the reads: tens of
microseconds at hundreds of containers.

## 7. The spike

Reproduced so the numbers can be re-run: save it at the repo root and run it
with `node`; it needs only `src/yoga.js`.

```js
import { loadLayout, Yoga } from './src/yoga.js';
await loadLayout();
const all = [],
  cards = [];
const node = (parent, i, setup) => {
  const n = Yoga.Node.create();
  setup?.(n);
  parent?.insertChild(n, i);
  all.push(n);
  return n;
};
const root = node(null, 0, (n) => {
  n.setWidth(1200);
  n.setHeight(800);
});
for (let s = 0; s < 12; s++) {
  const sec = node(root, s, (n) => {
    n.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    n.setFlexWrap(Yoga.WRAP_WRAP);
    n.setGap(Yoga.GUTTER_ALL, 8);
    n.setPadding(Yoga.EDGE_ALL, 8);
  });
  for (let c = 0; c < 25; c++) {
    const card = node(sec, c, (n) => {
      n.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
      n.setFlexWrap(Yoga.WRAP_WRAP);
      n.setGap(Yoga.GUTTER_ALL, 4);
      n.setPadding(Yoga.EDGE_ALL, 6);
      n.setFlexGrow(1);
      n.setFlexBasis(200);
      n.setMinWidth(0);
    });
    cards.push(card);
    for (let l = 0; l < 11; l++)
      node(card, l, (n) => {
        n.setWidth(40);
        n.setHeight(20);
      });
  }
}
let width = 1200;
const layout = () => root.calculateLayout(width, 800, Yoga.DIRECTION_LTR);
const time = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
const trial = (name, prep) => {
  const xs = [];
  let touched;
  for (let i = 0; i < 7; i++) {
    prep(i);
    all.forEach((n) => n.markLayoutSeen());
    xs.push(time(layout));
    touched = all.filter((n) => n.hasNewLayout()).length;
  }
  console.log(name, median(xs).toFixed(3), 'ms', touched, 'nodes re-laid out');
};
const flip = (card, i) =>
  card.setFlexDirection(
    i & 1 ? Yoga.FLEX_DIRECTION_ROW : Yoga.FLEX_DIRECTION_COLUMN,
  );
layout();
trial('nothing changed', () => {});
trial('1 card', (i) => flip(cards[7], i));
trial('3 cards', (i) => {
  for (let k = 0; k < 300; k += 100) flip(cards[k], i);
});
trial('30 cards', (i) => {
  for (let k = 0; k < 300; k += 10) flip(cards[k], i);
});
trial('all cards', (i) => cards.forEach((c) => flip(c, i)));
trial('window resized', (i) => {
  width = i & 1 ? 1100 : 1200;
  root.setWidth(width);
});
const reads = (name, fn) =>
  console.log(
    name,
    median(Array.from({ length: 7 }, () => time(fn))).toFixed(3),
    'ms',
  );
reads('read 300 containers', () => cards.forEach((c) => c.getComputedWidth()));
reads('read all nodes w+h', () =>
  all.forEach((n) => n.getComputedWidth() + n.getComputedHeight()),
);
reads(
  'hasNewLayout over all',
  () => all.filter((n) => n.hasNewLayout()).length,
);

// pass 1: queried 230 -> now 310 / pass 2: queried 310 -> now 230 / …
// the cycle (§3): a block that moves the axis it queries never settles
const c = cards[0];
c.setFlexBasis(200);
layout();
for (let i = 0; i < 4; i++) {
  const w = c.getComputedWidth();
  c.setFlexBasis(w < 250 ? 300 : 200);
  layout();
  console.log(`pass ${i + 1}: queried ${w} -> now ${c.getComputedWidth()}`);
}
```

## 8. Decisions the implementing PR has to make, and the suggested answer

| question                                    | suggested answer                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spelling                                    | `'@container width >= 400'`, `'@container sidebar width >= 400'`; declaration `container: true` or `container: 'sidebar'` in style. Same operators and unit as `'@width'`.      |
| unnamed query, no container above           | development-time error naming the node, pointing at `container` and at `'@width'` for the window.                                                                               |
| named query, no such container above        | the block does not apply. Component reuse across contexts wins over catching a typo.                                                                                            |
| a block that never settles                  | pinned at the answer it first held this frame, one development warning naming container, dependent and axis; re-evaluated when the container moves for another reason (§3).     |
| how many extra passes                       | a fixed small cap (3); "oscillation" is a dependent returning to an answer it already held this frame, so a nested cascade is not mistaken for one.                             |
| scale                                       | thresholds divided by the dependent's `scale`.                                                                                                                                  |
| window boundaries                           | a window/popup never depends on a container in another window.                                                                                                                  |
| `display: 'none'` container                 | nothing inside it is laid out or shown; nothing to decide.                                                                                                                      |
| transitions                                 | a flipped block's paint properties transition through `_retarget` exactly as a window query's do today.                                                                         |
| nested state block inside a container block | already allowed inside a window block (`validateStyle` recurses); same behaviour.                                                                                               |
| types                                       | a `ContainerQuery` template-literal type beside `SizeQuery` (`style.d.ts:362`); `container` typed as `true` or a string in `StyleProperties`; one line in `test/types/api.tsx`. |
| docs                                        | a section after "Window size queries" in styling.md; the "Next" list there drops its container-queries line; a scroller is named as the natural container.                      |
| the seam                                    | `onLayout` on any `<box>` (generalizing `_reportViewport`'s trigger to `_assignAbs`), shipped first and on its own — useful with or without the query.                          |

Tests, in the shape of `test/size-queries.test.js`: a container crossing a
threshold under a window resize changes a dependent's style **and** its `abs`;
a `_layoutPasses` count that grows by one only on the frame an answer flips;
a wrapper `<box>` inserted between container and dependent changing nothing;
a named query reaching past a nearer unnamed container; an unnamed query with
no container throwing; a flattened array merging two blocks under the same
query key; and the oscillating design warning once and holding still across
frames.

## 9. Verdict

Container queries are feasible on this renderer at moderate size — on the
order of 60 lines in `styles.js`, 150 in `nodes.js`, the declaration and type
test, a doc section and a test file — and with no new primitive: the
after-layout resolve-and-relayout loop is the one `realize()` already runs,
made general and gated on answers actually flipping. The one thing CSS has
that yoga does not, containment, is replaced by exact runtime detection of
the only failure containment prevents, at a cost of one development warning
where CSS would have made the design unwritable. The targeting grammar should
be CSS's — nearest declared ancestor, optional name — for the reason CSS
arrived at it: it is the only rule under which a component's answer does not
depend on how its consumer chose to wrap it.
