// Frame pacing — how often a window (or a `<glarea>`) paints while its
// content changes faster than anyone can read it, priced in CPU time rather
// than counted in updates.
//
// The frame clock decides *when* a frame may go out: the display's period
// on the Cocoa backend, the server fence or the vertical blank on X11. It
// says nothing about whether the frame is worth painting. A window fed off
// an input path — a terminal under `cat`, a chart on a socket, a simulation
// — claims a repaint every time its data moves, and with nothing between the
// claim and the clock it paints every refresh: on a 120Hz panel whose frames
// cost 6ms of CoreGraphics each, that is 70% of the JS thread spent painting
// screens nobody sees, and the producer — the pty reader, the parser — gets
// what is left. The X11 fence hides the same problem behind backpressure;
// the Cocoa clock has none.
//
// The rule here is a token bucket over paint time. Credit accrues at
// `budget` milliseconds per millisecond of wall time — a budget of 0.25 is
// "painting may take a quarter of the time" — up to a burst allowance; a
// frame spends its measured cost; a claim that finds the bucket in debt
// waits for it to refill to zero, and no longer. Four properties follow,
// and they are what the tests pin:
//
//   - **Idle is immediate.** A quiet window has a full bucket, so the first
//     claim after a pause — a keystroke, a click — paints on the next tick,
//     whatever the last frame cost.
//   - **Cheap is unthrottled.** A frame that costs less than the credit it
//     accrued leaves the bucket where it was. A blit-scrolled list on a 120Hz
//     panel keeps 120Hz: the frames are memmoves and a strip.
//   - **A rare expensive frame is free.** The burst is what absorbs the one
//     relayout in a scroll: it costs the credit, the credit refills, and no
//     frame waited. Only a *stream* of expensive frames drains the bucket —
//     and then the wait after each is `cost × (1/budget − 1)`, which holds
//     paint at exactly the budget's share of wall time.
//   - **A flood that ends is un-throttled at once.** The debt is at most one
//     frame's cost, so the prompt that appears when the flood stops waits
//     for that and nothing more — where an averaged rate would keep
//     throttling it.
//
// A floor (`minFps`) bounds the wait whatever the debt — the screen is never
// more than `1000 / minFps` behind the last paint — and a ceiling (`maxFps`)
// holds even cheap frames to a rate, the knob every terminal has.
//
// **Cost is the JS thread's time**: the flush (layout, paint, the requests
// or the CoreGraphics work) plus, on Cocoa, the present that follows it.
// Not the server's — on X11 the fence already paces to that, and the pacer
// is deliberately inert where a backend has backpressure of its own. The
// clock is injected so that the whole rule runs under a fake one in tests.
//
// Off by default: `'display'` is the built-in, and paints every frame the
// clock gives, after React's own batching — a UI answers its input as
// quickly as it can unless it says otherwise. `'adaptive'` is what a window
// that streams asks for. docs/architecture/frame-pacing.md is the account.

export const DEFAULT_FRAME_RATE = 'display';

/**
 * The presets, as the three numbers they stand for. `budget` is the share
 * of wall time paints may take while the window is busy; `minFps` is the
 * floor (0: none); `maxFps` the ceiling (0: none).
 */
export const FRAME_RATE_PRESETS = Object.freeze({
  display: Object.freeze({ mode: 'display', budget: 1, minFps: 0, maxFps: 0 }),
  adaptive: Object.freeze({
    mode: 'adaptive',
    budget: 0.25,
    minFps: 20,
    maxFps: 0,
  }),
  throughput: Object.freeze({
    mode: 'throughput',
    budget: 0.1,
    minFps: 10,
    maxFps: 30,
  }),
});

const FIELDS = ['budget', 'minFps', 'maxFps'];

// How much paint time a window with no floor may spend before the pacer
// starts charging for it (with a floor, the floor's interval is the burst:
// one frame up to the longest wait the pacer may impose is always free).
const DEFAULT_BURST_MS = 50;

// A wait shorter than this is not armed: a timer cannot keep it, and the
// frame clock's own period would swallow it. The debt carries to the next
// claim instead, so a run of sub-millisecond frames claimed back to back
// still pays for itself once the debt is worth a timer — the budget holds
// on average — while a cheap frame after a flood lands on the tick it would
// have landed on anyway.
const MIN_WAIT_MS = 1;

const warned = new Set();
function warnOnce(message) {
  if (process.env.NODE_ENV === 'production' || warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

const describe = (value) =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

const HOW =
  "'display' (every frame the clock gives — the default), 'adaptive' " +
  "(paints stay under a quarter of the time, 20fps floor), 'throughput' " +
  '(a tenth, 10fps floor, 30fps ceiling), a number (a ceiling in frames ' +
  'per second), or { budget, minFps, maxFps } — see docs/elements.md ' +
  '"frameRate".';

/**
 * A `frameRate` value — a preset name, a number, or the three numbers — as
 * the policy it stands for: `{ mode, budget, minFps, maxFps }`, frozen.
 * `mode` is the preset's name, or `'custom'` for a number or an object.
 *
 * A number is a ceiling over the default: `60` is "never more than 60fps",
 * and nothing else changes. An object names any of the three; the ones it
 * leaves out are the default's, so `{ budget: 0.25 }` has no floor — which
 * is worth a warning, because a budget with no floor can hold a frame for
 * as long as the last one cost, three times over.
 *
 * `where` names the call site in the error, since the same value arrives
 * as a prop, a root option and an environment variable.
 */
export function resolveFrameRate(value, where = 'frameRate') {
  if (value === undefined || value === null) value = DEFAULT_FRAME_RATE;
  if (typeof value === 'string') {
    const preset = FRAME_RATE_PRESETS[value];
    if (!preset) {
      throw new Error(
        `react-x11: ${where} ${describe(value)} is not a frame rate — ${HOW}`,
      );
    }
    return preset;
  }
  const base = FRAME_RATE_PRESETS[DEFAULT_FRAME_RATE];
  if (typeof value === 'number') {
    if (!(value > 0)) {
      throw new Error(
        `react-x11: ${where} ${describe(value)} — a number is a ceiling in ` +
          `frames per second, so it has to be above zero; ${HOW}`,
      );
    }
    if (!Number.isFinite(value)) return base;
    return Object.freeze({ ...base, mode: 'custom', maxFps: value });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `react-x11: ${where} ${describe(value)} is not a frame rate — ${HOW}`,
    );
  }
  const unknown = Object.keys(value).filter((k) => !FIELDS.includes(k));
  if (unknown.length) {
    throw new Error(
      `react-x11: ${where} has no ${unknown.map((k) => JSON.stringify(k)).join(', ')} ` +
        `— the three numbers are budget, minFps and maxFps; ${HOW}`,
    );
  }
  const num = (name, check, what) => {
    const v = value[name];
    if (v === undefined) return base[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || !check(v)) {
      throw new Error(
        `react-x11: ${where}.${name} ${describe(v)} — ${what}; ${HOW}`,
      );
    }
    return v;
  };
  const policy = Object.freeze({
    mode: 'custom',
    budget: num(
      'budget',
      (v) => v > 0 && v <= 1,
      'the share of wall time paints may take, above 0 and at most 1',
    ),
    minFps: num('minFps', (v) => v >= 0, 'a floor in frames per second, or 0'),
    maxFps: num(
      'maxFps',
      (v) => v >= 0,
      'a ceiling in frames per second, or 0',
    ),
  });
  if (policy.minFps > 0 && policy.maxFps > 0 && policy.minFps > policy.maxFps) {
    throw new Error(
      `react-x11: ${where} puts the floor (minFps ${policy.minFps}) above the ` +
        `ceiling (maxFps ${policy.maxFps}) — the floor is how stale the screen ` +
        'may get, the ceiling how often it may paint, so minFps <= maxFps.',
    );
  }
  if (policy.budget < 1 && policy.minFps === 0) {
    warnOnce(
      `react-x11: ${where} sets budget ${policy.budget} with no minFps — ` +
        'after an expensive frame the next may wait ' +
        `${(1 / policy.budget - 1).toFixed(1)}× its cost with nothing to bound ` +
        "it. Name a floor: { budget, minFps: 20 } is what 'adaptive' does.",
    );
  }
  return policy;
}

/** Whether two resolved policies pace the same way. */
export function sameFramePolicy(a, b) {
  return (
    a === b ||
    (Boolean(a && b) &&
      a.budget === b.budget &&
      a.minFps === b.minFps &&
      a.maxFps === b.maxFps)
  );
}

const ENV = 'REACT_X11_FRAME_RATE';

/**
 * The environment's say: `REACT_X11_FRAME_RATE=adaptive` (or `display`,
 * `throughput`, or a number). It overrides every window's prop and the root
 * option, the way `REACT_X11_BACKEND` overrides `createRoot({ backend })`:
 * an A/B run and a field diagnosis must not need a code change. Undefined
 * when unset or empty; garbage throws with the fix, at the first window.
 */
export function frameRateFromEnv(env = process.env) {
  const raw = env[ENV];
  if (raw === undefined || raw === '') return undefined;
  const text = raw.trim();
  const n = Number(text);
  return text !== '' && Number.isFinite(n) ? n : text;
}

const defaults = new WeakMap();

/**
 * `createRoot({ frameRate })`: the default for every window this root opens
 * that names none of its own. Validated here, so a bad value fails at the
 * call that passed it rather than at the first window it reaches.
 */
export function setFrameRateDefault(app, value) {
  if (value === undefined) {
    defaults.delete(app);
    return;
  }
  resolveFrameRate(value, 'createRoot({ frameRate })');
  defaults.set(app, value);
}

export const frameRateDefaultFor = (app) => defaults.get(app);

/**
 * The policy a window resolves to: the environment first, then its own
 * prop, then the root's default, then the built-in. `where` labels a bad
 * prop in the error; the other two sources are labelled by their names.
 */
export function resolveFramePolicy(prop, app, where = '<window frameRate>') {
  const env = frameRateFromEnv();
  if (env !== undefined) return resolveFrameRate(env, ENV);
  if (prop !== undefined && prop !== null) return resolveFrameRate(prop, where);
  const fallback = frameRateDefaultFor(app);
  if (fallback !== undefined) {
    return resolveFrameRate(fallback, 'createRoot({ frameRate })');
  }
  return FRAME_RATE_PRESETS[DEFAULT_FRAME_RATE];
}

/** The real clock: `performance.now()`, and a one-shot that never holds the
 * process open — a deferral pending when the last window closes must not
 * keep an otherwise finished process alive. */
export const realClock = Object.freeze({
  now: () => performance.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, Math.max(1, ms));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
});

/**
 * The pacer one frame source owns — a `WindowNode`, a `GlAreaNode`. The
 * source asks `defer(fn)` before scheduling a frame: `false` means "now",
 * and the source schedules as it always did; `true` means the pacer has
 * armed a one-shot that will call `fn` when the frame may start, and a
 * second `defer` before then is coalesced into it. The source brackets each
 * frame with `began()`/`ended()`, and reports work outside that bracket —
 * the Cocoa present — with `charge()`. Any frame that runs by another route
 * (a discrete input's early flush) calls `cancel()`, so a deferral never
 * fires for a frame that has already been painted.
 *
 * `clock` is `{ now(), after(ms, fn) → cancel }`, replaceable for a test;
 * every method reads it at call time.
 */
export class FramePacer {
  constructor(
    policy = FRAME_RATE_PRESETS[DEFAULT_FRAME_RATE],
    clock = realClock,
  ) {
    this.clock = clock;
    this.policy = null;
    this._timer = null;
    this._startedAt = null;
    this._armedWait = 0;
    this.stats = {
      mode: DEFAULT_FRAME_RATE,
      budget: 1,
      minFps: 0,
      maxFps: 0,
      /** frames that painted */
      frames: 0,
      /** claims that armed a wait */
      deferred: 0,
      /** claims folded into a wait already armed */
      coalesced: 0,
      /** what the last painted frame cost, ms (flush plus present) */
      lastCostMs: 0,
      /** the wait the last painted frame followed, ms; 0 when none */
      lastWaitMs: 0,
    };
    this.configure(policy);
  }

  /**
   * Take a (new) policy. A change starts from a full bucket: `'display'`
   * takes effect on the next claim rather than after the next paint, and a
   * tighter budget charges from now rather than for a debt run up under the
   * old rule. The same policy again is a no-op, so a caller may sync every
   * frame.
   */
  configure(policy) {
    if (sameFramePolicy(this.policy, policy)) return;
    this.policy = policy;
    this._minGap = policy.maxFps > 0 ? 1000 / policy.maxFps : 0;
    this._maxWait = policy.minFps > 0 ? 1000 / policy.minFps : Infinity;
    this._burst = Number.isFinite(this._maxWait)
      ? this._maxWait
      : DEFAULT_BURST_MS;
    this._credit = this._burst;
    this._creditAt = this.clock.now();
    this._lastStart = -Infinity;
    this._lastEnd = -Infinity;
    const s = this.stats;
    s.mode = policy.mode;
    s.budget = policy.budget;
    s.minFps = policy.minFps;
    s.maxFps = policy.maxFps;
  }

  /** Whether this policy can ever hold a frame. `'display'` cannot, and
   * costs the frame source one property read per claim. */
  get active() {
    return this.policy.budget < 1 || this._minGap > 0;
  }

  _accrue(now) {
    if (now > this._creditAt) {
      this._credit = Math.min(
        this._burst,
        this._credit + this.policy.budget * (now - this._creditAt),
      );
      this._creditAt = now;
    }
  }

  /** How long a frame claimed at `now` has to wait, in ms; 0 for now. */
  wait(now = this.clock.now()) {
    if (!this.active) return 0;
    this._accrue(now);
    const { budget } = this.policy;
    // the debt, paid back at the budget's rate
    let wait = this._credit >= 0 ? 0 : -this._credit / budget;
    // the floor: whatever the debt, a frame is due within `maxWait` of the
    // last frame's end — a promise about staleness, not a rate
    if (Number.isFinite(this._maxWait)) {
      wait = Math.min(wait, Math.max(0, this._lastEnd + this._maxWait - now));
    }
    // the ceiling: not sooner than a period after the last frame *started*,
    // cheap frames included — a rate, measured start to start
    if (this._minGap > 0) {
      wait = Math.max(wait, this._lastStart + this._minGap - now);
    }
    return wait >= MIN_WAIT_MS ? wait : 0;
  }

  /**
   * Hold `fn` until the frame may start, or answer `false` for "schedule it
   * now". At most one wait is armed; a claim while one is armed is folded
   * into it and answers `true` too.
   */
  defer(fn, now = this.clock.now()) {
    if (this._timer) {
      this.stats.coalesced += 1;
      return true;
    }
    const wait = this.wait(now);
    if (!(wait > 0)) return false;
    this.stats.deferred += 1;
    this._armedWait = wait;
    this._timer = this.clock.after(wait, () => {
      this._timer = null;
      fn();
    });
    return true;
  }

  /** Whether a wait is armed. */
  get deferring() {
    return this._timer !== null;
  }

  /** The wait the frame now running followed, ms — read inside the frame,
   * before `ended` files it under the frame's stats. 0 when none. */
  get pendingWait() {
    return this._armedWait;
  }

  /** A frame ran by another route: the wait, if any, has nothing to do. */
  cancel() {
    if (!this._timer) return;
    this._timer();
    this._timer = null;
    // the frame that runs instead was not held by the pacer
    this._armedWait = 0;
  }

  /** A frame is starting. */
  began(now = this.clock.now()) {
    this._startedAt = now;
  }

  /**
   * The frame is over. `painted` false is a flush that found nothing to
   * paint: its cost is charged like any work on the thread, but it is not
   * a frame — the ceiling measures from the last frame that *was* one.
   */
  ended(now = this.clock.now(), painted = true) {
    const startedAt = this._startedAt ?? now;
    this._startedAt = null;
    const cost = Math.max(0, now - startedAt);
    this._accrue(now);
    this._credit -= cost;
    this._lastEnd = now;
    if (!painted) return;
    this._lastStart = startedAt;
    const s = this.stats;
    s.frames += 1;
    s.lastCostMs = cost;
    s.lastWaitMs = this._armedWait;
    this._armedWait = 0;
  }

  /** Work the frame cost outside `began`/`ended` — the present on Cocoa,
   * which runs after the flush returns. Extends the last frame. */
  charge(ms, now = this.clock.now()) {
    if (!(ms > 0)) return;
    this._accrue(now);
    this._credit -= ms;
    this._lastEnd = now;
    this.stats.lastCostMs += ms;
  }
}
