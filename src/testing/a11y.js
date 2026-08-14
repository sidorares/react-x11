// The assistive-technology spy: what a screen reader would be told, as an
// in-process event log — no D-Bus, no bus, no async gap between the app
// changing and the assertion seeing it.
//
// ## Why this exists next to the real bridge
//
// The AT-SPI bridge (src/atspi.js) consumes the renderer through a set of
// hook slots (src/a11y.js) and a pure semantic model. Everything an AT
// learns — focus moved, a state flipped, text changed, an announcement —
// crosses those hooks before it ever becomes D-Bus. So a spy that fills
// the same slots observes the same contract with none of the transport:
// it runs on the mock backend, on Node 20 where dbus-native is not
// installed, on macOS, and it is synchronous where the wire is not. The
// bridge's own wire behaviour is covered separately (test/atspi.test.js,
// against an in-process message bus); an application's tests should not
// pay D-Bus latency to check their own labels.
//
// Because the slots are the seam, the spy also keeps the renderer honest:
// a regression that stops a hook firing fails these tests exactly as it
// would silence a real screen reader.
//
// ## Two layers per entry
//
// Every log entry is a precise fact (`{ type: 'state', state: 'checked',
// on: true, node }`) plus a `summary` string ("state: checked"). Assert on
// the facts when exactness matters; assert on `transcript()` when the
// question is "what would a user have been told" — which is also the form
// that catches the omission tree-shaped assertions structurally miss: a
// control nobody named renders as "(no accessible name)" instead of
// passing because no assertion mentioned its name.
//
// The utterances follow react-x11's **own documented model** (name, role,
// the states worth speaking, a value as a percentage) — deliberately not
// an imitation of Orca, whose wording is presentation policy that shifts
// between releases and verbosity settings. See docs/accessibility.md.
//
// ```js
// const { at, getByRole } = await renderX11(h(App), { a11y: true });
// await userEvent.tab();
// assert.equal(at.focused().utterance, 'Save, button');
// await userEvent.key(XK_space);
// assert.ok(at.since().some((e) => e.type === 'state' && e.state === 'checked'));
// ```

import {
  hooks,
  ATSPI_ROLE_NICK,
  ATSPI_STATE,
  ATSPI_STATE_NICK,
  atspiRoleOf,
  a11yName,
  a11yStates,
  a11yValue,
  a11yParent,
  sceneChildrenOf,
  hasTextInterface,
  textStateOf,
  inPreedit,
  diffChars,
} from '../a11y.js';

/** The states a screen reader would speak, in speaking order, with the
 * words this library's model uses for them. Everything else stays quiet —
 * a reader that voiced every flag would be unusable. */
const SPOKEN_STATES = [
  ['checked', 'checked'],
  ['indeterminate', 'partially checked'],
  ['pressed', 'pressed'],
  ['expanded', 'expanded'],
  ['collapsed', 'collapsed'],
  ['selected', 'selected'],
];

/**
 * One utterance from its parts — the shared formatter behind the spy, and
 * behind `scripts/a11y-probe.mjs`, which feeds it values read over real
 * D-Bus so the two can never drift apart.
 *
 * @param {object} parts
 * @param {string} parts.name the accessible name ('' when there is none)
 * @param {string} [parts.role] the AT-SPI role name ("check box", "entry")
 * @param {string[]} [parts.states] state nicks ("checked", "sensitive", …)
 * @param {{now: number, min?: number, max?: number} | null} [parts.value]
 * @returns {string} e.g. `"Volume, slider, 30 percent"`, or
 *   `"(no accessible name)"` when there is nothing to say — which is the
 *   defect this string exists to make loud.
 */
export function utteranceOf({ name, role, states = [], value = null }) {
  const words = [];
  if (name) words.push(name);
  if (role && role !== 'filler') words.push(role);
  // an empty states array means "not told", not "insensitive"
  if (states.length > 0 && !states.includes('sensitive')) {
    words.push('unavailable');
  }
  for (const [state, said] of SPOKEN_STATES) {
    if (states.includes(state)) words.push(said);
  }
  if (value && typeof value.now === 'number') {
    const span = (value.max ?? 0) - (value.min ?? 0);
    words.push(
      span > 0
        ? `${Math.round(((value.now - (value.min ?? 0)) / span) * 100)} percent`
        : String(value.now),
    );
  }
  return words.length ? words.join(', ') : '(no accessible name)';
}

/** The set state nicks of a node, from the model's two uint32s. */
function stateNicksOf(node) {
  const [lo, hi] = a11yStates(node);
  const out = [];
  for (const bit of Object.values(ATSPI_STATE)) {
    const on = bit < 32 ? lo & (1 << bit) : hi & (1 << (bit - 32));
    if (on) out.push(ATSPI_STATE_NICK[bit]);
  }
  return out;
}

/** The utterance for a live node, through the same model the bridge
 * serves. */
export function nodeUtterance(node) {
  return utteranceOf({
    name: a11yName(node),
    role: ATSPI_ROLE_NICK[atspiRoleOf(node)],
    states: stateNicksOf(node),
    value: a11yValue(node),
  });
}

/** Internal kinds that are content, not accessibility objects — the same
 * exclusion the tree projection makes. */
const CONTENT_KINDS = new Set(['textchunk', 'svgchild']);

export class A11ySpy {
  constructor() {
    /** Every entry, oldest first. Each has `type`, `summary`, and usually
     * `node`; see the handlers below for the shapes. */
    this.log = [];
    this._sinceIndex = 0;
    this._snapshots = new WeakMap();
    this._toplevels = [];
    this._installed = null;
  }

  // ---- lifecycle -------------------------------------------------------

  install() {
    if (this._installed) return this;
    const occupied = Object.entries(hooks)
      .filter(([, slot]) => slot !== null)
      .map(([name]) => name);
    if (occupied.length > 0) {
      throw new Error(
        'react-x11/test: the a11y hook slots are already taken ' +
          `(${occupied.join(', ')}) — the AT-SPI bridge is live in this ` +
          'process. The spy and the bridge observe through the same seam, ' +
          'so run spy tests without AT_SPI_BUS_ADDRESS/REACT_X11_A11Y=1 ' +
          '(react-x11/test sets NO_AT_BRIDGE for exactly this reason).',
      );
    }
    const spy = this;
    const installed = {
      rootMounted(win) {
        if (!spy._toplevels.includes(win)) spy._toplevels.push(win);
        spy._snapshotTree(win);
      },
      rootUnmounted(win) {
        const at = spy._toplevels.indexOf(win);
        if (at !== -1) spy._toplevels.splice(at, 1);
      },
      attached(parent, child) {
        if (spy._live(parent)) spy._snapshotTree(child);
      },
      detach: null,
      propsChanged(node) {
        spy._diffNode(node);
      },
      textContent(chunk) {
        // the chunk's string is the content of its <text>, whose name — and
        // the name of any contents-named ancestor — may just have changed
        let text = chunk.parent;
        while (text && text.kind === 'text' && text.isSpan) text = text.parent;
        if (!text) return;
        for (let n = text; n; n = a11yParent(n)) {
          spy._diffNode(n);
          if (n.isWindow) break;
        }
      },
      textState(node) {
        spy._diffNode(node);
      },
      focus(previous, next) {
        // re-snapshot both ends so the FOCUSED bit never double-reports
        // through a later props diff
        if (previous && !previous.destroyed) spy._resnapshot(previous);
        if (next && !next.destroyed) {
          spy._resnapshot(next);
          const utterance = nodeUtterance(next);
          spy._push({
            type: 'focus',
            node: next,
            utterance,
            summary: `focus: ${utterance}`,
          });
        } else {
          spy._push({ type: 'blur', node: previous ?? null, summary: 'blur' });
        }
      },
      windowFocus(win, focused) {
        spy._resnapshot(win);
        spy._push({
          type: 'window',
          node: win,
          focused,
          summary: `window: ${focused ? 'active' : 'inactive'}`,
        });
      },
      commit: null,
      announce(text, opts) {
        spy._push({
          type: 'announce',
          text: String(text),
          assertive: Boolean(opts?.assertive),
          summary: `announce: ${text}`,
        });
        // an announcement the test observed *was* delivered
        return true;
      },
    };
    for (const [name, fn] of Object.entries(installed)) hooks[name] = fn;
    this._installed = installed;
    return this;
  }

  /** Put the slots back. Idempotent, and careful not to evict somebody
   * else's handlers if the test already replaced them. */
  uninstall() {
    if (!this._installed) return;
    for (const [name, fn] of Object.entries(this._installed)) {
      if (hooks[name] === fn) hooks[name] = null;
    }
    this._installed = null;
  }

  // ---- the log ---------------------------------------------------------

  /** Everything recorded so far, oldest first. */
  events() {
    return [...this.log];
  }

  /** The `summary` line of every entry — the "what was the user told"
   * view, made for `assert.deepEqual`. */
  transcript() {
    return this.log.map((entry) => entry.summary);
  }

  /** Entries recorded since the previous `since()` (or `clear()`), so a
   * test reads one interaction's worth at a time. */
  since() {
    const fresh = this.log.slice(this._sinceIndex);
    this._sinceIndex = this.log.length;
    return fresh;
  }

  clear() {
    this.log.length = 0;
    this._sinceIndex = 0;
  }

  // ---- live queries ----------------------------------------------------

  /** The focused node as an AT would describe it, or null. With several
   * roots, the window that actually holds the X focus wins. */
  focused() {
    const win =
      this._toplevels.find((w) => w.events?.windowFocused) ??
      this._toplevels[0];
    const manager = win?.events?.focusManager ?? win?.events;
    const node = manager?.focused ?? null;
    if (!node || node.destroyed) return null;
    return this._describe(node);
  }

  /**
   * Every node the keyboard can reach, in Tab order — the same sequential
   * order the event manager cycles, focus scopes included. The one-line
   * audit this powers:
   *
   * ```js
   * for (const stop of at.focusables()) {
   *   assert.notEqual(stop.utterance, '(no accessible name)');
   * }
   * ```
   */
  focusables() {
    const out = [];
    for (const win of this._toplevels) {
      const manager = win.events;
      if (!manager?._tabbables) continue;
      for (const node of manager._tabbables()) out.push(this._describe(node));
    }
    return out;
  }

  _describe(node) {
    return {
      node,
      name: a11yName(node),
      role: ATSPI_ROLE_NICK[atspiRoleOf(node)],
      states: stateNicksOf(node),
      utterance: nodeUtterance(node),
    };
  }

  // ---- snapshots and diffing ------------------------------------------

  _push(entry) {
    this.log.push(entry);
  }

  _live(node) {
    let n = node;
    while (n?.parent) n = n.parent;
    return n ? this._toplevels.includes(n) : false;
  }

  _snap(node) {
    return {
      states: a11yStates(node),
      name: a11yName(node),
      value: a11yValue(node)?.now ?? null,
      text: hasTextInterface(node) ? textStateOf(node) : null,
    };
  }

  _resnapshot(node) {
    this._snapshots.set(node, this._snap(node));
  }

  _snapshotTree(node) {
    if (node.destroyed || CONTENT_KINDS.has(node.kind)) return;
    if (!this._snapshots.has(node)) this._resnapshot(node);
    for (const child of node.children ?? []) this._snapshotTree(child);
    // what an element drew is baselined with everything else, or the first
    // thing that happens to an item — the selection landing on it — reads
    // as a mount and says nothing
    for (const item of sceneChildrenOf(node)) this._snapshotTree(item);
  }

  /**
   * Recompute what an AT knows about a node and log the exact difference —
   * the same snapshot-and-diff the bridge turns into D-Bus events, so any
   * prop change produces the right entries with no per-prop wiring. A node
   * seen for the first time only takes a baseline: a mount is not a
   * change.
   */
  _diffNode(node) {
    if (node.destroyed || CONTENT_KINDS.has(node.kind)) return;
    const before = this._snapshots.get(node);
    const now = this._snap(node);
    this._snapshots.set(node, now);
    if (!before) return;

    if (now.name !== before.name) {
      this._push({
        type: 'name',
        node,
        name: now.name,
        summary: `name: ${now.name}`,
      });
    }
    if (now.value !== before.value && now.value !== null) {
      this._push({
        type: 'value',
        node,
        value: now.value,
        summary: `value: ${now.value}`,
      });
    }
    for (const half of [0, 1]) {
      let changed = (before.states[half] ^ now.states[half]) >>> 0;
      while (changed !== 0) {
        const low = changed & -changed;
        const bit = 31 - Math.clz32(low) + half * 32;
        const on = Boolean(now.states[half] & low);
        const nick = ATSPI_STATE_NICK[bit];
        this._push({
          type: 'state',
          node,
          state: nick,
          on,
          summary: `state: ${on ? '' : 'not '}${nick}`,
        });
        changed = (changed ^ low) >>> 0;
      }
    }
    if (before.text && now.text) {
      const diff = diffChars(before.text.chars, now.text.chars);
      // A composition's own churn is not an edit. A preedit appearing,
      // growing or being abandoned is one `preedit` entry rather than the
      // insert and delete it technically is on screen — and what the
      // sequence finally *commits* stays an ordinary insert, because that
      // is the character the user typed. The bridge draws the same line
      // with the `:system` detail suffix; this is the same rule, spoken.
      const wasComposing = before.text.preedit?.text ?? '';
      const isComposing = now.text.preedit?.text ?? '';
      if (
        diff &&
        diff.removed.length > 0 &&
        !inPreedit(before.text, diff.offset, diff.removed.length)
      ) {
        this._push({
          type: 'text-delete',
          node,
          text: diff.removed.join(''),
          offset: diff.offset,
          summary: `delete: ${JSON.stringify(diff.removed.join(''))}`,
        });
      }
      if (isComposing !== wasComposing) {
        this._push({
          type: 'preedit',
          node,
          text: isComposing,
          offset: now.text.preedit?.offset ?? before.text.preedit?.offset ?? 0,
          summary: isComposing
            ? `preedit: ${JSON.stringify(isComposing)}`
            : 'preedit: cleared',
        });
      }
      if (
        diff &&
        diff.inserted.length > 0 &&
        !inPreedit(now.text, diff.offset, diff.inserted.length)
      ) {
        this._push({
          type: 'text-insert',
          node,
          text: diff.inserted.join(''),
          offset: diff.offset,
          summary: `insert: ${JSON.stringify(diff.inserted.join(''))}`,
        });
      }
      if (!diff && now.text.caret !== before.text.caret) {
        // a caret move without an edit — arrows, Home/End, a click
        this._push({
          type: 'caret',
          node,
          offset: now.text.caret,
          summary: `caret: ${now.text.caret}`,
        });
      }
      const [s0, e0] = before.text.selection;
      const [s1, e1] = now.text.selection;
      if ((s0 !== s1 || e0 !== e1) && s1 !== e1) {
        this._push({
          type: 'selection',
          node,
          start: s1,
          end: e1,
          summary: `selection: ${s1}..${e1}`,
        });
      }
    }

    // An element that draws its own children reports them through the one
    // notification it makes about itself (#304), so they are diffed here
    // rather than through a feed of their own — a scene item is a node to
    // everything above.
    for (const item of sceneChildrenOf(node)) this._diffNode(item);
  }
}

/**
 * Install a fresh spy on the a11y hook slots and return it. Prefer
 * `renderX11(element, { a11y: true })`, which installs before the mount —
 * so the initial tree is baselined — and uninstalls in `cleanup()`.
 */
export function installA11ySpy() {
  return new A11ySpy().install();
}
