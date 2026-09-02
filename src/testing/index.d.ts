/**
 * `react-x11/test` — render, query, drive and assert on a react-x11 tree,
 * against a real X server running in this process. No `$DISPLAY`, no xvfb.
 */

import type { ReactNode } from 'react';
import type { DrawnNode, NtkApp, NtkWindow } from '../types/nodes.js';
import type { ModifierName } from '../keysyms.js';

export * from '../keysyms.js';

/** node-x11's in-process X server. Typed loosely — it is not our API. */
export interface TestServer {
  width: number;
  height: number;
  keymap: {
    minKeycode: number;
    maxKeycode: number;
    syms: number[][];
    modifiers: number[][];
    keycodeForKeysym(keysym: number): number;
  };
  injectPointerMove(x: number, y: number): void;
  injectButton(button: number, isPress: boolean): void;
  injectKey(keycode: number, isPress: boolean): void;
  [key: string]: unknown;
}

/** ntk's 2d context. Pixel helpers take it; `renderX11` hands it back. */
export type TestContext2D = unknown;

export interface RenderX11Options {
  /** Window size (default 640×480). */
  width?: number;
  height?: number;
  /**
   * Screen size. Defaults to comfortably larger than the window, because on
   * a real display it is — and because a press "outside the application",
   * which is what dismisses a menu, needs somewhere to land.
   */
  screen?: { width: number; height: number };
  /**
   * `'xserver'` (default) runs a real in-process X server and real pixels.
   * `'mock'` swaps in a fake 2d context that logs draw operations: faster,
   * no server, and no pixel assertions or input injection.
   */
  backend?: 'xserver' | 'mock';
  /**
   * Font family → font file. **Required for pixel assertions involving
   * text**: family resolution otherwise shells out to `fc-match`, which is a
   * different answer on every machine and no answer at all in a container.
   */
  fonts?: Record<string, string>;
  /**
   * Wrap the element in a `<window>`. Defaults to true unless the element
   * *is* a `<window>`; pass `false` when a component renders one itself.
   */
  wrap?: boolean;
  title?: string;
  /** Render into a connection you already have. */
  app?: NtkApp;
  /**
   * Install the assistive-technology spy before the mount and hand it back
   * as `at`: an in-process log of everything a screen reader would have
   * been told — focus, state changes, text edits, announcements — with no
   * D-Bus anywhere. See docs/accessibility.md.
   */
  a11y?: boolean;
  /**
   * Pin the display scale — device pixels per logical pixel (docs/scale.md).
   * The headless harnesses resolve to exactly 1 on their own, so every
   * geometry assertion means its numbers literally; `2` renders the tree
   * the way a retina panel does, which is the only way to catch an element
   * that compares a logical event coordinate with its device `abs`.
   */
  scale?: 'auto' | number;
}

/** One recorded assistive-technology fact, plus its one-line `summary`. */
export interface A11ySpyEvent {
  type:
    | 'focus'
    | 'blur'
    | 'state'
    | 'name'
    | 'value'
    | 'text-insert'
    | 'text-delete'
    | 'preedit'
    | 'caret'
    | 'selection'
    | 'announce'
    | 'window';
  /** The transcript line — `"focus: Save, button"`, `"state: checked"`. */
  summary: string;
  node?: DrawnNode | null;
  /** For `focus`. */
  utterance?: string;
  /** For `state`: the AT-SPI state nick, and whether it turned on. */
  state?: string;
  on?: boolean;
  /** For `name` / `announce` / `text-*` / `preedit` — on a `preedit` this
   * is what the composition now shows, `''` when it was abandoned or has
   * just committed. */
  name?: string;
  text?: string;
  assertive?: boolean;
  /** For `value`. */
  value?: number;
  /** For `text-*` / `caret` / `preedit`. */
  offset?: number;
  /** For `selection`. */
  start?: number;
  end?: number;
  /** For `window`. */
  focused?: boolean;
}

/** A focusable (or focused) node as an AT would describe it. */
export interface A11yDescription {
  node: DrawnNode;
  name: string;
  /** The AT-SPI role name — `"check box"`, `"entry"`. */
  role: string;
  /** The set state nicks — `"focusable"`, `"checked"`, `"sensitive"`, … */
  states: string[];
  /** `"(no accessible name)"` when there is nothing to say. */
  utterance: string;
}

/**
 * The in-process assistive-technology spy: the same semantic feed the
 * AT-SPI bridge serves, observed at the hook seam with no bus. Assert on
 * `events()`/`since()` for exact facts, on `transcript()` for "what would
 * a user have been told".
 */
export interface A11ySpy {
  /** Every entry recorded so far, oldest first. */
  events(): A11ySpyEvent[];
  /** Entries since the previous `since()` (or `clear()`). */
  since(): A11ySpyEvent[];
  /** The `summary` of every entry — made for `assert.deepEqual`. */
  transcript(): string[];
  clear(): void;
  /** The focused node as an AT would describe it, or null. */
  focused(): A11yDescription | null;
  /** Every keyboard-reachable node, in Tab order, focus scopes included. */
  focusables(): A11yDescription[];
  /** Put the hook slots back; `cleanup()` does this for you. */
  uninstall(): void;
}

export interface Queries {
  getByText(text: string | RegExp, options?: TextMatchOptions): DrawnNode;
  getAllByText(text: string | RegExp, options?: TextMatchOptions): DrawnNode[];
  queryByText(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode | null;
  queryAllByText(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode[];
  findByText(
    text: string | RegExp,
    options?: TextMatchOptions & WaitOptions,
  ): Promise<DrawnNode>;

  getByRole(role: string, options?: RoleOptions): DrawnNode;
  getAllByRole(role: string, options?: RoleOptions): DrawnNode[];
  queryByRole(role: string, options?: RoleOptions): DrawnNode | null;
  queryAllByRole(role: string, options?: RoleOptions): DrawnNode[];
  findByRole(
    role: string,
    options?: RoleOptions & WaitOptions,
  ): Promise<DrawnNode>;

  getByTestName(name: string): DrawnNode;
  getAllByTestName(name: string): DrawnNode[];
  queryByTestName(name: string): DrawnNode | null;
  queryAllByTestName(name: string): DrawnNode[];
  findByTestName(name: string, options?: WaitOptions): Promise<DrawnNode>;

  getByComponent(component: ComponentMatch): DrawnNode;
  getAllByComponent(component: ComponentMatch): DrawnNode[];
  queryByComponent(component: ComponentMatch): DrawnNode | null;
  queryAllByComponent(component: ComponentMatch): DrawnNode[];
  findByComponent(
    component: ComponentMatch,
    options?: WaitOptions,
  ): Promise<DrawnNode>;

  getByPlaceholder(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode;
  getAllByPlaceholder(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode[];
  queryByPlaceholder(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode | null;
  queryAllByPlaceholder(
    text: string | RegExp,
    options?: TextMatchOptions,
  ): DrawnNode[];
  findByPlaceholder(
    text: string | RegExp,
    options?: TextMatchOptions & WaitOptions,
  ): Promise<DrawnNode>;

  /** Everything under here, in paint order — the escape hatch. */
  all(predicate?: (node: DrawnNode) => boolean): DrawnNode[];
}

/**
 * How ByComponent names a component: exact display name, RegExp, or a
 * predicate over the name. Owner-based (who wrote the JSX), so it needs
 * development React.
 */
export type ComponentMatch = string | RegExp | ((name: string) => boolean);

export interface TextMatchOptions {
  /** Exact, case-sensitive match. Default is a trimmed substring match. */
  exact?: boolean;
  /** Restrict to one element kind, e.g. `'textinput'`. */
  selector?: string;
}

export interface RoleOptions {
  /** Also require the node's text to match. */
  name?: string | RegExp;
  exact?: boolean;
}

export interface WaitOptions {
  timeout?: number;
  interval?: number;
}

export interface RenderX11Result extends Queries {
  root: { app: NtkApp; render(element: ReactNode): void; unmount(): void };
  app: NtkApp;
  /** null with `backend: 'mock'`. */
  server: TestServer | null;
  /** The `WindowNode` the tree mounted into — the paint and event root. */
  windowNode: DrawnNode;
  window: NtkWindow | null;
  /** The window's 2d context, which is what pixel assertions read. */
  readonly ctx: TestContext2D;
  /** The assistive-technology spy, when `a11y: true` asked for one. */
  at: A11ySpy | null;
  rerender(element: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

/** Install a spy outside `renderX11` — install **before** rendering, and
 * uninstall yourself. Prefer `renderX11(el, { a11y: true })`. */
export function installA11ySpy(): A11ySpy;

/** The utterance for a live node, through the shared model. */
export function nodeUtterance(node: DrawnNode): string;

/** The utterance formatter itself, for callers that gathered the parts
 * elsewhere (scripts/a11y-probe.mjs reads them over real D-Bus). */
export function utteranceOf(parts: {
  name: string;
  role?: string;
  states?: string[];
  value?: { now: number; min?: number; max?: number } | null;
}): string;

/**
 * Mount a tree against a real in-process X server and return a handle plus
 * the queries bound to it.
 */
export function renderX11(
  element: ReactNode,
  options?: RenderX11Options,
): Promise<RenderX11Result>;

/**
 * Flush everything between a state update and a pixel: React's work, the
 * events the injection put on the wire, ntk's frame clock, and an X round
 * trip. A wrapper that only calls `React.act` stays flaky on pixels.
 */
export function act(fn?: () => unknown): Promise<void>;

/** Unmount everything, restore the animation clock, close every server. */
export function cleanup(): Promise<void>;

/** Drain in-flight requests on a connection. */
export function settle(app: NtkApp, roundTrips?: number): Promise<void>;

/** Retry until it stops throwing, `act`-ing between attempts. */
export function waitFor<T>(
  fn: () => T | Promise<T>,
  options?: WaitOptions,
): Promise<T>;

/** The queries bound to a subtree. */
export function within(root: DrawnNode): Queries;

/** The queries bound to the most recent `renderX11`, popups included. */
export const screen: Queries;

/** The text a node presents, joined across its spans. */
export function textOf(node: DrawnNode): string;

/** The role a node reports: its `role` prop, else its element kind. */
export function roleOf(node: DrawnNode): string;

/**
 * The components that created this node, nearest first — the JSX owner
 * chain, not tree ancestry. Empty outside development React.
 */
export function ownerChainOf(node: DrawnNode): string[];

/** Where the JSX that created this node lives, from React's own call-site
 * capture (development mode). Null when there is no debug info. */
export function sourceOf(node: DrawnNode): {
  functionName?: string;
  file: string;
  line: number;
  column: number;
} | null;

export interface InspectedHook {
  /** React's index over the hooks that occupy a slot — how `setHook`
   * addresses it. Null for hooks that don't (useContext). */
  id: number | null;
  /** react-debug-tools' name: 'State', 'Reducer', 'Effect', 'Context', or
   * a custom hook's name with its primitives in `subHooks`. */
  name: string;
  /** Live for editable hooks; DevTools' copy (deep objects appear as
   * previews, the way the DevTools panel shows them) for the rest. */
  value: unknown;
  /** True for useState/useReducer — the hooks `setHook` can write. */
  editable: boolean;
  source: { file: string; line: number; column: number } | null;
  subHooks: InspectedHook[];
}

export interface InspectedComponent {
  /** DevTools' element id — stable for the life of the instance. */
  id: number;
  name: string | null;
  /** The live props object. Treat as read-only. */
  props: Record<string, unknown> | null;
  /** Class component state; null for function components. */
  state: unknown;
  /** Legacy class context only; `useContext` values appear in `hooks`. */
  context: unknown;
  hooks: InspectedHook[];
  /** Owner names, nearest first — who rendered this component. */
  owners: string[];
  /** Set a useState/useReducer value (optionally at a path inside it),
   * through React's own override machinery, `act`-wrapped. */
  setHook(hookID: number, value: unknown): Promise<void>;
  setHook(
    hookID: number,
    path: Array<string | number>,
    value: unknown,
  ): Promise<void>;
}

/**
 * The React side of a node: the nearest mounted component above it, its
 * props and named hooks, and `setHook` to change useState/useReducer
 * state. Drives the React DevTools backend in-process — no WebSocket, but
 * `react-devtools-core` must be installed, and reading hooks re-invokes
 * the component's render function (react-debug-tools recovers names that
 * way).
 */
export function inspect(node: DrawnNode): Promise<InspectedComponent>;

export interface PointerOptions {
  /** Offset from the node's centre. */
  dx?: number;
  dy?: number;
  /** X button number: 1 left, 2 middle, 3 right. */
  button?: number;
  modifiers?: ModifierName[] | number;
}

export interface KeyOptions {
  target?: DrawnNode | null;
  modifiers?: ModifierName[] | number;
  press?: boolean;
  release?: boolean;
}

/**
 * Synchronous input injection, through the X server rather than emitted on
 * the ntk window — so grabs, focus and crossing events all happen for real.
 * Wrap in `act()` to flush what it caused, or use `userEvent`, which does.
 */
export const fireEvent: {
  mouseMove(node: DrawnNode, options?: PointerOptions): void;
  mouseEnter(node: DrawnNode, options?: PointerOptions): void;
  mouseLeave(node: DrawnNode, options?: PointerOptions): void;
  mouseDown(node: DrawnNode, options?: PointerOptions): void;
  mouseUp(node: DrawnNode, options?: PointerOptions): void;
  click(node: DrawnNode, options?: PointerOptions): void;
  doubleClick(node: DrawnNode, options?: PointerOptions): void;
  contextMenu(node: DrawnNode, options?: PointerOptions): void;
  /** A scroll in notches; `smooth` takes fractions of one, as a touchpad
   *  measures them. */
  wheel(
    node: DrawnNode,
    options?: PointerOptions & {
      deltaX?: number;
      deltaY?: number;
      smooth?: boolean;
    },
  ): void;
  key(keysym: number, options?: KeyOptions): void;
  char(char: string, options?: KeyOptions): void;
  screenClick(
    x: number,
    y: number,
    options?: { target?: DrawnNode | null; button?: number },
  ): void;
};

/** `fireEvent`, `act`-wrapped: the layer to reach for by default. */
export const userEvent: {
  click(node: DrawnNode, options?: PointerOptions): Promise<void>;
  doubleClick(node: DrawnNode, options?: PointerOptions): Promise<void>;
  hover(node: DrawnNode, options?: PointerOptions): Promise<void>;
  unhover(node: DrawnNode, options?: PointerOptions): Promise<void>;
  /** A scroll in notches; `smooth` takes fractions of one, as a touchpad
   *  measures them. */
  wheel(
    node: DrawnNode,
    options?: PointerOptions & {
      deltaX?: number;
      deltaY?: number;
      smooth?: boolean;
    },
  ): Promise<void>;
  /** Click to focus, then send each character as a real key. */
  type(
    node: DrawnNode,
    text: string,
    options?: { skipClick?: boolean },
  ): Promise<void>;
  tab(options?: { shift?: boolean; target?: DrawnNode | null }): Promise<void>;
  key(keysym: number, options?: KeyOptions): Promise<void>;
  /** Press outside every window of this root — how a menu is dismissed. */
  clickOutside(options?: {
    target?: DrawnNode | null;
    button?: number;
  }): Promise<void>;
};

/** A node's centre in screen coordinates. */
export function screenPointOf(
  node: DrawnNode,
  options?: { dx?: number; dy?: number },
): { x: number; y: number; server: TestServer };

/** A screen point inside none of this root's windows. */
export function pointOutsideWindows(node: DrawnNode): {
  x: number;
  y: number;
};

export interface PixelOptions {
  /** Per-channel tolerance; antialiasing means you always want one. */
  tolerance?: number;
  message?: string;
}

export type Colour = string | [number, number, number];

/** `[r, g, b]` at a window coordinate. */
export function pixelAt(
  ctx: TestContext2D,
  x: number,
  y: number,
): Promise<[number, number, number]>;

export function expectPixel(
  ctx: TestContext2D,
  x: number,
  y: number,
  want: Colour,
  options?: PixelOptions,
): Promise<[number, number, number]>;

export function waitForPixel(
  ctx: TestContext2D,
  x: number,
  y: number,
  want: Colour,
  options?: PixelOptions & WaitOptions,
): Promise<[number, number, number]>;

/** How many pixels in a region are near a colour. */
export function countPixels(
  ctx: TestContext2D,
  region: { x?: number; y?: number; width: number; height: number },
  want: Colour,
  tolerance?: number,
): Promise<number>;

export function isNear(
  rgb: [number, number, number],
  want: Colour,
  tolerance?: number,
): boolean;

export function toRgb(colour: Colour): [number, number, number];

/**
 * Write a PNG of the window, or return the bytes when `file` is null.
 * Typed as `Uint8Array` rather than node's `Buffer` so these declarations
 * do not drag in `@types/node` — a `Buffer` *is* one.
 */
export function toPNG(
  ctx: TestContext2D,
  file: string | null,
  region: { x?: number; y?: number; width: number; height: number },
): Promise<Uint8Array>;

export interface FrameClock {
  readonly now: number;
  advance(ms: number): number;
  set(ms: number): number;
  restore(): void;
}

/**
 * Drive transitions from a number you control. Install it **before** the
 * render, so every timestamp in the tree comes from the same clock — mixing
 * a real start time with a fake `now` gives a transition that never moves.
 */
export function withFrameClock(startAt?: number): FrameClock;

/** Every window node in a tree, popups included. */
export function windowNodesOf(node: DrawnNode): DrawnNode[];

/** The fake ntk app the op-log tests use — `backend: 'mock'` builds one. */
export function createMockApp(): NtkApp;
export function moveMouse(window: unknown, x: number, y: number): void;
export function pressButton(
  window: unknown,
  x: number,
  y: number,
  options?: { press?: boolean; release?: boolean },
): void;
/** A scroll at a point, in notches — ntk's `wheel` event. */
export function spinWheel(
  window: unknown,
  x: number,
  y: number,
  options?: {
    deltaX?: number;
    deltaY?: number;
    smooth?: boolean;
    buttons?: number;
  },
): void;
