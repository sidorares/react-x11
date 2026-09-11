// What flows down the tree: the theme and its tokens, the reading direction,
// the inherited text style and the `scale` zoom — and the walks that
// re-resolve a subtree when one of them moves.

import {
  applyLayoutStyle,
  textStyleFrom,
  DEFAULT_TEXT_STYLE,
  localTextStyleChanged,
  resolvedTextDelta,
  TEXT_REMEASURE,
} from '../styles.js';
import { Yoga } from '../yoga.js';
import { scaleOf } from '../scale.js';
import { baseTheme } from '../palette.js';
import { reportStyleError, STRICT_TOKENS } from '../errors.js';
import { DEV } from './util.js';

/**
 * The desktop switched between light and dark: every node that inherited its
 * palette rather than being given one has a different one now.
 *
 * `_themeChanged()` drops the cached theme and restyles the tokens; the
 * invalidate is for everything else, above all the window background, which
 * is read from the palette at paint time and belongs to no style object.
 *
 * Widgets do not need this — they read the palette through `useTheme()` and
 * React re-renders them. This is the other route: an app's own
 * `backgroundColor: '$background'`, and the window fill under it.
 */
export function appearanceChanged(app) {
  // A desktop change arrives whenever the user makes it, which can be while
  // the app is shutting down. An invalidate *schedules* a frame, so a repaint
  // started here would reach the connection a tick after it closed and throw
  // out of the frame clock, where nothing is waiting to catch it.
  if (!app || app.X?._closing) return;
  // A backend that renders native control bezels caches them by every
  // parameter that changes the pixels — except the desktop's accent, which
  // the toolkit reads for itself. The repaint below would blit the old
  // colour back out of that cache, so it is forgotten first.
  app.nativeBezels?.clear?.();
  for (const node of app._rootChildren ?? []) {
    if (node.destroyed) continue;
    node._themeChanged();
    node.root?.invalidate(true, null, 'theme');
  }
}

/**
 * Depth of the `_themeChanged` walk in progress, if any.
 *
 * That walk already visits every node in the subtree and re-resolves each
 * one, so a style swap it performs on the way down must not kick off a
 * second walk of the nodes it is about to reach anyway. Without the guard a
 * theme change over a tree of token-using nodes is quadratic in its depth.
 */
export let inThemeWalk = 0;

/**
 * A node's own `scale` prop as a factor: what it multiplies the scale it
 * inherits by (`Node.scale`). Absent means 1, which is every node in a tree
 * that never mentions it.
 *
 * A zero, a negative or a NaN is a mistake rather than a design — it would
 * lay the subtree out at nothing, or at infinity — and in development it
 * says so where the mistake is, rather than as a blank pane three frames
 * later. Production falls back to 1 for the same reason a bad token keeps
 * the property dropped: a GUI that carries on is worth more than one that
 * dies on a fraction somebody divided by.
 */
function scaleFactorOf(props, kind) {
  const own = props?.scale;
  if (own === undefined) return 1;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own;
  if (DEV) {
    throw new Error(
      `react-x11: <${kind} scale={${JSON.stringify(own)}}> — a subtree ` +
        'scale is a positive number, the factor this subtree is zoomed by ' +
        '(2 draws it twice the size, 0.5 half), and leaving it out means 1. ' +
        'See docs/scale.md, "A subtree of its own".',
    );
  }
  return 1;
}

/** Node's half of what flows down the tree, installed onto `Node.prototype` by node.js. */
export class NodeCascade {
  /**
   * Device pixels per logical pixel **for this node** — the display scale
   * `createRoot` resolved (src/scale.js), times every `scale` prop between
   * this node and its window. `this.style` and `this.abs` are already
   * device pixels; this is for the values that never pass through a style —
   * a paint constant like the caret's width, or an event coordinate on its
   * way back to logical. A registered element that draws with its own
   * constants multiplies them by this.
   *
   * The `scale` prop is CSS `zoom`, not a transform: it multiplies the
   * inherited factor, and the node's *own* style scales with it. So
   * everything downstream of the style funnel follows with no second
   * mechanism — yoga lays out the scaled numbers like any others, paint
   * reads the scaled style, the caret and the scrollbar read this getter,
   * and text is shaped at the size it will be drawn at rather than
   * rasterized once and stretched (docs/scale.md, "A subtree of its own").
   *
   * **A real X window is its own root.** `<window>` and `<popup>` geometry
   * is the server's, in the display's pixels — `scaleWindowGeometry` reads
   * `scaleOf(app)` directly and a WM sees no zoom — so the cascade stops
   * there and a menu opened from a zoomed card comes up at the app's own
   * size. Everything else inherits, including `<glarea>` and `<foreign>`,
   * whose boxes are laid out by the parent like any other child's.
   *
   * Cached per node, dropped by `_rescaleSubtree` — the same contract
   * `theme` and `direction` have, for the same reason.
   */
  get scale() {
    if (this._scaleCache !== undefined) return this._scaleCache;
    if (this.isWindow) return (this._scaleCache = scaleOf(this.app));
    const base = this.parent ? this.parent.scale : scaleOf(this.app);
    return (this._scaleCache = base * scaleFactorOf(this.props, this.kind));
  }

  /**
   * The effective scale of this node moved — its own `scale` prop changed,
   * or it was attached under an ancestor whose scale is not the one it
   * resolved against while detached.
   *
   * Everything below inherits, so the whole subtree is restyled; the early
   * out is the answer not having moved, which is what makes the call at
   * each of the attach sites free in the overwhelmingly common case of a
   * tree with no `scale` prop in it at all.
   *
   * `mounting` is `insertBefore` attaching a subtree that has never been in
   * the tree, and means the same thing it means to `_themeChanged`: resolve
   * everything, claim nothing (issue #402). A node that has never painted
   * has no stale pixels to cover, and where it lands is claimed by the
   * child-list protocol.
   */
  _rescaleSubtree(mounting = false) {
    if (!this._rescaleMoved()) return;
    // One claim for the whole walk: `_invalidateLayout` bounds the subtree
    // as it stands and queues the after-layout claim, so the per-node
    // repeats the recursion below would make are the same rect over again.
    if (!mounting) this._invalidateLayout('scale');
    this._rescaled(mounting);
  }

  /** Drop the cached scale and re-ask; true when the answer moved. The
   *  getter is the only place the rule lives, so a `<window>` — which
   *  resolves the display scale whatever it is written inside — answers
   *  false here and the walk stops at it. */
  _rescaleMoved() {
    const before = this._scaleCache;
    this._scaleCache = undefined;
    return this.scale !== before;
  }

  /** …the walk itself, for a node whose scale is already known to have
   *  moved. Restyle in the new unit, then carry it down: an ordinary
   *  descendant's scale is a product of this one, so it moved too. */
  _rescaled(mounting) {
    // both hold a size in device pixels at the old scale
    this._textBase = undefined;
    this._textScaled = null;
    const prevStyle = this.style;
    const style = this._syncStyle(this.props, mounting);
    if (this.yoga && style !== prevStyle) {
      applyLayoutStyle(this.yoga, style, prevStyle);
    }
    if (localTextStyleChanged(style, prevStyle)) this._textContentChanged();
    // its own claims are bounded, so this runs on a mount too — the same
    // rule `_themeChanged` follows
    this._retext();
    for (const child of this.children) {
      if (child._rescaleMoved()) child._rescaled(mounting);
    }
  }

  /**
   * The theme in force here: the nearest `theme` prop at or above this node,
   * with an inner one merged over the outer so a panel can restate a colour
   * or two without repeating a palette. Popups resolve through their place
   * in the *tree*, not their window, so a menu inherits the theme of the UI
   * that opened it even though it is a separate X window.
   *
   * **With no `theme` prop anywhere above, it is the desktop's palette.** So
   * `backgroundColor: '$background'` works in an app that never wrote a
   * `<ThemeProvider>`, and means "whatever this desktop's is" — which is the
   * same answer `useTheme()` gives the widgets, by the other route.
   *
   * A detached node has no ancestors yet and so cannot see a provider two
   * levels up; it still resolves, against the base, and `_themeChanged()` on
   * attach re-resolves it against the real one.
   */
  get theme() {
    if (this._theme !== undefined) return this._theme;
    const inherited = this.parent ? this.parent.theme : baseTheme();
    const own = this.props.theme;
    this._theme = own ? { ...inherited, ...own } : inherited;
    return this._theme;
  }

  /**
   * Which way this node reads: `'ltr'` or `'rtl'`, never `'inherit'` — this
   * is the *resolved* answer, which is what everything outside yoga needs.
   *
   * Yoga resolves the same question for the layout on its own, and does it
   * inside WASM where nothing can read it back (the binding has no
   * `getComputedDirection`). So it is resolved a second time here, over the
   * same rule, for everything the box tree does not answer: which side a
   * scrollbar sits on, which physical edge a `borderStartWidth` paints, which
   * way a popup flips, and the base direction a paragraph of neutral
   * characters resolves against.
   *
   * The rule, nearest first:
   *
   * 1. `direction` in this node's own style — CSS's property, and the one
   *    thing that means "this subtree, whatever is around it".
   * 2. otherwise the enclosing element's, which is what makes it inherit.
   * 3. otherwise the palette's, which is seeded from the locale — so an app
   *    started in an RTL locale is mirrored without being asked, and
   *    `<ThemeProvider value={{ direction }}>` is how one with a language
   *    menu says otherwise. The provider plants the matching style property
   *    as it goes, so rule 1 is what actually carries a mid-tree swap and
   *    this clause is only ever read at the top of the tree.
   *
   * Cached like `theme` and dropped by the same walk, since the two now move
   * together.
   */
  get direction() {
    if (this._direction !== undefined) return this._direction;
    const own = this.style.direction;
    return (this._direction =
      own === 'ltr' || own === 'rtl'
        ? own
        : this.parent
          ? this.parent.direction
          : this.theme.direction === 'rtl'
            ? 'rtl'
            : 'ltr');
  }

  /**
   * The resolved direction moved — because this node's style named a new one,
   * or because the palette under the whole tree did. Everything below
   * inherits it, so the caches go with it, and the walk stops where a
   * subtree states a direction of its own: nothing under that node can have
   * changed.
   *
   * A node that never resolved one has nothing cached below it either —
   * `direction` fills every ancestor on the way up — which is the same
   * early-out the text cascade takes.
   */
  _redirectSubtree() {
    if (this._direction === undefined) return;
    const before = this._direction;
    this._direction = undefined;
    if (this.direction === before) return;
    this._directionMoved();
    for (const child of this.children) child._redirectSubtree();
  }

  /**
   * What a direction change costs this node. The default is a repaint: the
   * *layout* has already been dealt with by yoga, which was told about the
   * style property directly, so what is left here is everything painted from
   * the resolved side — the scrollbar, a logical border, an icon.
   *
   * `TextNode` overrides it: a paragraph's base direction is part of how it
   * is shaped, so its cached layouts have to go.
   */
  _directionMoved() {
    this.root?.invalidate(false, this, 'direction');
  }

  /**
   * The text style this node inherits — **the enclosing element's**, and at
   * the top of the tree the palette's.
   *
   * The ink, the face and the size travel down the tree the way they do in
   * CSS: `<box style={{ color: theme.textMuted, fontSize: 12 }}>` is how a caption
   * block, a disabled row or a code panel is written, and it is what makes
   * `color` on a row reach the row's label without the row handing it over.
   * Only the properties in `INHERITED_TEXT_PROPS` travel; a style property on
   * the node itself still wins, the way it always has.
   *
   * Under the last element is the palette, and that floor is not a set of
   * constants either. The ink first: a `<text>` that never mentions a colour
   * has to be readable on the surface it is drawn on, and that surface
   * follows the desktop now. Black on `#1e2228` is invisible, which is the
   * whole bug. The face and the size for the same reason one step out — a
   * theme names `fontFamily` and `fontSize` because it is describing the type
   * this app sets, and the only way that can be true is if the text nobody
   * styled follows them.
   *
   * A detached node has no parent yet and so resolves against the floor;
   * `insertBefore` re-resolves the subtree against the real one.
   */
  get inheritedTextStyle() {
    if (this.parent) {
      const inherited = this.parent.resolvedTextStyle();
      // A **scale boundary** — this node's `scale` prop, or a `<popup>`
      // written inside a zoomed subtree, which goes back to the display's
      // own unit. What comes down the cascade is already device pixels at
      // the parent's scale (that is the point of resolving the theme's size
      // once, at the root), so re-expressing it here is the only place a
      // second multiply is right: a `fontSize: 14` theme inside a
      // `scale={2}` box is 28 logical, 28 device at 1x, and the descendants
      // below inherit that without compounding it again.
      const from = this.parent.scale;
      const to = this.scale;
      if (from === to) return inherited;
      const size = (inherited.size * to) / from;
      const cached = this._textScaled;
      if (cached?.from !== inherited || cached.style.size !== size) {
        this._textScaled = { from: inherited, style: { ...inherited, size } };
      }
      return this._textScaled.style;
    }
    const theme = this.theme;
    const color = theme.text;
    // A palette can reach a node as a bare `theme` **prop** rather than a
    // resolved one — `<box theme={{ text: 'red' }}>` merges and derives
    // nothing (styling.md) — so neither of these is guaranteed to be there.
    const family = theme.fontFamily ?? DEFAULT_TEXT_STYLE.family;
    // The theme thinks in logical pixels like every style does, and this is
    // the one door its font size enters the cascade by: a node's own
    // `fontSize` was scaled at the style funnel, and every descendant
    // inherits an already-resolved (device) size — so multiplying here,
    // exactly once at the root of the cascade, is what keeps text and
    // layout in the same unit without ever double-scaling (src/scale.js).
    const size = (theme.fontSize ?? DEFAULT_TEXT_STYLE.size) * this.scale;
    const base = this._textBase;
    if (base?.color !== color || base.family !== family || base.size !== size) {
      this._textBase = { ...DEFAULT_TEXT_STYLE, color, family, size };
    }
    return this._textBase;
  }

  /**
   * Re-resolve this node's text style and pay for what moved.
   *
   * The cache is dropped rather than patched, and the *values* decide what
   * happens next: a node that names its own `color` and face absorbs an
   * ancestor's change entirely, which is what lets `_retextSubtree` stop
   * walking there. Returns the cost so it can.
   *
   * A node with no cached resolution has never been asked, and neither has
   * anything below it — `inheritedTextStyle` fills every ancestor on the way
   * up, so an empty cache here proves an empty cache in the whole subtree.
   * That is the early-out that keeps a hover on one row from touching a
   * window's worth of nodes.
   */
  _retext() {
    const before = this._resolvedText;
    if (before === undefined) return 0;
    this._resolvedText = undefined;
    const cost = resolvedTextDelta(before, this.resolvedTextStyle());
    if (cost !== 0) this._textStyleMoved(cost);
    return cost;
  }

  /** …and everything under it, stopping wherever the answer did not change. */
  _retextSubtree() {
    if (this._retext() === 0) return;
    for (const child of this.children) child._retextSubtree();
  }

  /**
   * This node's resolved text style moved — because its own style did, or
   * because an ancestor's did and it inherited the change.
   *
   * `TEXT_REMEASURE` means a glyph can have moved and the box has to be
   * measured again; `TEXT_REPAINT` means only the ink or the glyph rounding
   * did, so the cached layout still has to go — the value rides on the spans
   * inside it — but nothing reflows. Keeping those apart is the whole reason
   * a `:hover { color }` costs a repaint rather than a layout pass.
   *
   * The default serves any element that draws text: re-measure if it has a
   * size of its own, repaint otherwise. Elements that draw no text override
   * it away.
   */
  _textStyleMoved(cost) {
    if (cost === TEXT_REMEASURE && this._measureFn) {
      this.invalidateMeasure('text');
    } else {
      this.root?.invalidate(false, this, 'text');
    }
  }

  /**
   * Whether this node's ancestry is complete, so a `$token` that does not
   * resolve is a mistake rather than a node that has not been placed yet.
   *
   * For a drawn node that is `root` — set by `_setRoot` when the subtree is
   * attached to the window that owns it, which is exactly when no further
   * `theme` prop can appear above it. React builds bottom-up, so having a
   * *parent* proves nothing: the parent may itself be floating.
   *
   * The exception is a `<popup>`, which is its own root from the moment it is
   * created and only learns where in the tree it was written when it is
   * attached. Until then its subtree would be judged against the base palette
   * alone, and a `$panel` from the provider two levels up would throw. Those
   * resolve provisionally instead, and `_themeChanged()` on attach re-resolves
   * them. Known tokens resolve either way, so only the *error* is ever
   * deferred, never the value.
   */
  get placed() {
    const owner = this.isWindow ? this : this.root;
    if (!owner) return false;
    return owner.isPopup ? owner.parent != null : true;
  }

  /**
   * A `$token` this node's completed ancestry does not define.
   *
   * The default is `reportStyleError`: say so loudly, set `process.exitCode`,
   * and keep the property dropped. `REACT_X11_STRICT_TOKENS=1` makes it fatal
   * again, and then *where* the throw lands is the whole question — an error
   * boundary only catches what React invoked, on the fiber React thinks it
   * is working on.
   *
   * `mounting` is the attach walk, which runs inside `appendInitialChild`
   * while React is completing the nearest host *ancestor* — the `<window>`,
   * for a whole tree rendered at once. A throw there is attributed to the
   * window and sails past every boundary the app wrote inside it, which is
   * the bug this deferral exists for (#420). Stashed instead, and thrown
   * from `commitMount` on this node's own fiber, where the walk up finds a
   * boundary at any depth.
   *
   * Every other caller already has the right fiber (`commitUpdate`) or has
   * no React on the stack at all (`appearanceChanged`, from an X event) —
   * for those, throwing here is both the earliest and the only option, and
   * the second is the crash strict mode asked for.
   *
   * `commitMount` happens once per instance, so a node re-attached after it
   * has been and gone has nothing left to defer *to*; stashing there would
   * swallow the error instead of raising it late. Those throw at once, like
   * the keyed reorder they resemble.
   */
  _tokenProblem(problems, mounting, consequence = undefined) {
    if (!STRICT_TOKENS) {
      // every one of them: two misspellings in a style are two things to
      // fix, and a report that named only the first would send someone back
      // for a second run to find the second
      for (const message of problems) {
        reportStyleError(this, message, consequence);
      }
      return;
    }
    const error = new Error(problems[0]);
    if (mounting && this._tokenError === null) this._tokenError = error;
    else throw error;
  }

  /** The theme above or on this node changed: drop the caches and restyle
   * the subtree, since a token can appear at any depth.
   *
   * `mounting` is `insertBefore` attaching a subtree that has never been in
   * the tree: the walk still resolves every token — the nodes can see their
   * ancestors now — but it claims no damage (issue #402). A node that has
   * never painted has no stale pixels to cover, and the rect it is about to
   * occupy is claimed by the child-list/layout-diff protocol like any other
   * inserted child's; the unbounded claims below would turn every commit
   * that mounts a token-styled node into a full-window repaint — which is
   * every re-slice of a virtualized list whose rows follow the palette. A
   * live theme *swap* is the other caller and keeps them: it moves pixels
   * that are already on screen, anywhere in the subtree. */
  _themeChanged(mounting = false) {
    // This walk visits every node itself, so the per-node re-resolution below
    // is enough — a style swap it causes must not start a second walk of the
    // same subtree from halfway down.
    inThemeWalk++;
    try {
      this._theme = undefined;
      // The palette is the floor under the direction too, and this walk
      // already visits every node — so the cache is dropped here rather than
      // through `_redirectSubtree`, which would walk the same subtree again.
      const wasDirection = this._direction;
      this._direction = undefined;
      // A `<window>` with no `backgroundColor` of its own follows the palette,
      // and the server's copy of that colour has to follow with it — otherwise
      // the next resize fills the new area in the old scheme.
      if (this.isWindow) this._syncWindowBackground();
      if (this._usesTokens) {
        const before = this.style;
        this._syncStyle(this.props, mounting);
        // a token change reaches the node without React re-rendering it, so
        // the invalidation a commit would have done has to happen here too
        if (localTextStyleChanged(this.style, before)) {
          this._textContentChanged();
        }
        if (!mounting) this.root?.invalidate(true, null, 'theme');
      }
      // The palette is the floor under the cascade, so a theme swap moves the
      // resolved style of every node that named none of its own — and none of
      // that is in a style object, so nothing above would have noticed. A
      // swap that only changes `fontFamily` is the case that made this worth
      // having: nothing else about the node changes, and a cached layout
      // carries the face it was shaped with. `_retext` runs on a mount too —
      // its own claims are bounded — but cannot answer non-zero there: a
      // node that was never attached has never resolved a text style.
      if (this._retext() !== 0 && !mounting) {
        this.root?.invalidate(true, null, 'theme');
      }
      if (wasDirection !== undefined && this.direction !== wasDirection) {
        this._directionMoved();
      }
      for (const child of this.children) child._themeChanged(mounting);
    } finally {
      inThemeWalk--;
    }
  }

  /**
   * The text style this node resolves to, in the shape `app.fonts.layout`
   * takes as its base: `{ family, size, weight, style, variations,
   * textRendering, color }`. `<text>`, `<textinput>` and the document views
   * draw with exactly this, and an element that draws text of its own is
   * asking the same question they are.
   *
   * Two things are folded in that `this.style` does not carry. The palette
   * is under it — `text`, `fontFamily` and `fontSize` are the ink, the face
   * and the size of everything that named none of its own (styling.md) — so
   * an element reading its own style alone is one whose app can say
   * `<ThemeProvider value={{ fontFamily: 'Inter' }}>` and watch it reach
   * every built-in label and stop at this one. And the bag is spelled ntk's
   * way rather than the style vocabulary's (`family`, not `fontFamily`;
   * `variations`, not `fontVariationSettings`), which is a mapping worth
   * having in one place instead of vendored per element.
   *
   * **Cached**, and the cache is the cascade's spine: asking here fills every
   * ancestor's on the way up, which is what lets an invalidation walk stop at
   * a node that never resolved (`_retext`). Everything that can move the
   * answer drops it — a style swap (`_retarget`), an animation tick, a theme
   * change, an attach — so an element may keep reading it at paint time.
   */
  resolvedTextStyle() {
    return (this._resolvedText ??= textStyleFrom(
      this.style,
      this.inheritedTextStyle,
    ));
  }
}

/** WindowNode's half of what flows down the tree, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowCascade {
  /**
   * The smallest size this window's content can be drawn at: GTK's
   * `minimum` to the `natural` below, and what an `'auto'` `minWidth` or
   * `minHeight` resolves to.
   *
   * One layout pass **with no space on offer at all**, which is the whole
   * trick — every node comes out at the smallest size its own style allows,
   * text measures at its longest word, and a wrapping row wraps at every
   * item. `contentSpan` then reads how far that reached, recovering a node
   * the pass squashed by looking inside it.
   *
   * What it deliberately does *not* do is second-guess that layout. A node
   * that said how small it can be — `minWidth: 0`, or an `overflow` that
   * clips — is taken at its word and its content stops counting. That is
   * CSS's `min-width: 0`, Qt's `QScrollArea` and GTK's `min-content-width`,
   * and a scroll container gets it here for free.
   *
   * `forWidth` is the width the height is measured for, and there has to be
   * one: a paragraph's minimum height is a height *for a width*. GTK asks
   * for its minimum height at its minimum width, which for a paragraph is
   * the width it is tallest at — an honest answer to a question nobody
   * asked, since the window is not at its minimum width. `WM_NORMAL_HINTS`
   * holds two independent numbers and cannot express the dependency either
   * way, so the floor is measured at the width the window will actually
   * have and re-sent as that changes.
   */
  /**
   * The direction to lay this window's tree out in, as yoga spells it.
   *
   * `calculateLayout`'s third argument is the direction the *owner* imposes,
   * and a window has no owner — so the root reads its own resolved value and
   * hands it down. A `direction` on a `<box>` inside is then yoga's business
   * rather than ours: it carries the property on its own node and everything
   * under it inherits from there.
   */
  get _rootDirection() {
    return this.direction === 'rtl' ? Yoga.DIRECTION_RTL : Yoga.DIRECTION_LTR;
  }

  /**
   * The root's direction is an argument to `calculateLayout` rather than a
   * property on a yoga node, so nothing in the box tree is dirty when it
   * moves and the layout pass has to be asked for. That is only reachable
   * from the palette — a `direction` written in the window's own style goes
   * through `applyLayoutStyle`, which dirties the node the ordinary way.
   */
  _directionMoved() {
    this.invalidate(true, null, 'direction');
  }

  /** Like a `<box>`: a window fills and never letters, so it is the top of
   * the cascade rather than a reader of it. */
  _textStyleMoved() {}
}
