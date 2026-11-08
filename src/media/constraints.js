// Constraints: what `getUserMedia` and `applyConstraints` are asked for, in
// the web's own dictionaries (design/architecture/media-capture.md §2.1) —
// and the choice of a device and its settings they come to.
//
// The vocabulary is Media Capture and Streams' exactly, so code written
// against a browser ports as written and the components facade passes a
// page's constraints through untouched:
//
//   - a bare value, or `{ ideal }`, is a **preference**: the device and the
//     settings nearest it win, and nothing fails over one;
//   - `{ exact }`, `{ min }` and `{ max }` are **required**: a device that
//     cannot meet one is not chosen, and where none can the request rejects
//     with an `OverconstrainedError` naming the constraint;
//   - `true` asks for the kind at its defaults, `false` or nothing for none.
//
// The choice is the spec's SelectSettings, simplified to what a desktop's
// devices describe: each device's `capabilities` (a range per number, a
// list per string or boolean) and `defaults` (what it runs at where nothing
// is asked). The device with the least fitness distance wins — the sum, over
// the preferences, of how far the nearest setting it can take is from the
// one asked — the default device first among equals. `advanced` sets are not
// read: nothing a desktop app asks for needs them, and they are the one part
// of the dictionary a reader cannot follow at a glance.
//
// Pure: devices and constraints in, a device and settings out. Opening what
// was chosen is the backend's, and the settings a source reports once open
// are the truth — a camera's formats are a list, and `width: 1000` comes back
// as whichever of them is nearest.

import { OverconstrainedError } from './errors.js';

const NUMERIC = new Set([
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
]);
const STRINGS = new Set(['facingMode', 'resizeMode']);
const BOOLEANS = new Set([
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
]);
const IDS = new Set(['deviceId', 'groupId']);

/** The constraints each kind reads; anything else is ignored, as a browser
 *  ignores a constraint it does not support. */
export const VIDEO_CONSTRAINTS = Object.freeze([
  'deviceId',
  'groupId',
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'facingMode',
  'resizeMode',
]);
export const AUDIO_CONSTRAINTS = Object.freeze([
  'deviceId',
  'groupId',
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
]);

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const asList = (v) => (Array.isArray(v) ? v.map(String) : [String(v)]);

function badValue(name, value, expected) {
  return new TypeError(
    `react-x11: the ${JSON.stringify(name)} constraint is ` +
      `${JSON.stringify(value)} — expected ${expected}`,
  );
}

/** One property's constraint as `{ exact?, min?, max?, ideal? }` — strings
 *  and ids as lists, since `{ exact: ['user', 'environment'] }` is legal. */
function normalizeValue(name, value) {
  if (NUMERIC.has(name)) {
    const number = (v, part) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw badValue(
          `${name}${part ? `.${part}` : ''}`,
          v,
          'a finite number, or { exact, ideal, min, max } of them',
        );
      }
      return v;
    };
    if (typeof value === 'number') return { ideal: number(value) };
    if (!isPlainObject(value)) {
      throw badValue(name, value, 'a number, or { exact, ideal, min, max }');
    }
    const out = {};
    for (const part of ['exact', 'ideal', 'min', 'max']) {
      if (value[part] !== undefined) out[part] = number(value[part], part);
    }
    return out;
  }
  if (BOOLEANS.has(name)) {
    if (typeof value === 'boolean') return { ideal: [value] };
    if (!isPlainObject(value)) {
      throw badValue(name, value, 'a boolean, or { exact, ideal }');
    }
    const out = {};
    for (const part of ['exact', 'ideal']) {
      if (value[part] === undefined) continue;
      if (typeof value[part] !== 'boolean') {
        throw badValue(`${name}.${part}`, value[part], 'a boolean');
      }
      out[part] = [value[part]];
    }
    return out;
  }
  // strings and ids
  if (typeof value === 'string' || Array.isArray(value)) {
    return { ideal: asList(value) };
  }
  if (!isPlainObject(value)) {
    throw badValue(
      name,
      value,
      'a string, an array of them, or { exact, ideal }',
    );
  }
  const out = {};
  for (const part of ['exact', 'ideal']) {
    if (value[part] !== undefined) out[part] = asList(value[part]);
  }
  return out;
}

/**
 * A kind's constraints — `true`, an object, or `false`/absent — as a map of
 * property to normalized constraint, or null where the kind is not asked.
 * Throws a TypeError for a value no constraint can be.
 */
export function normalizeTrackConstraints(kind, constraints) {
  if (constraints === undefined || constraints === false) return null;
  if (constraints === true) return new Map();
  if (!isPlainObject(constraints)) {
    throw new TypeError(
      `react-x11: ${kind} constraints are ${JSON.stringify(constraints)} — ` +
        'expected true, false, or an object such as { width: 1280 }',
    );
  }
  const known = kind === 'video' ? VIDEO_CONSTRAINTS : AUDIO_CONSTRAINTS;
  const out = new Map();
  for (const name of known) {
    if (constraints[name] === undefined) continue;
    out.set(name, normalizeValue(name, constraints[name]));
  }
  return out;
}

/** How far `actual` is from `ideal`, 0 to 1: the spec's relative distance. */
function distanceOf(actual, ideal) {
  if (actual === ideal) return 0;
  return Math.abs(actual - ideal) / Math.max(Math.abs(actual), Math.abs(ideal));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Whether `device` meets the required constraints, how far it is from the
 * preferred ones, and the settings that come nearest: `{ distance, settings }`,
 * or `{ failed }` naming the first required constraint it cannot meet.
 */
export function fitDevice(device, constraints) {
  const caps = device.capabilities ?? {};
  const defaults = device.defaults ?? {};
  const settings = { ...defaults };
  let distance = 0;
  for (const [name, c] of constraints) {
    if (IDS.has(name)) {
      const actual = device[name];
      if (c.exact && !c.exact.includes(actual)) return { failed: name };
      if (c.ideal && !c.ideal.includes(actual)) distance += 1;
      continue;
    }
    if (NUMERIC.has(name)) {
      const range = caps[name];
      const required =
        c.exact !== undefined || c.min !== undefined || c.max !== undefined;
      if (!range) {
        // a setting the device has no range for: a requirement is met only
        // by what it runs at, and a preference is not held against it
        if (!required) continue;
        const v = defaults[name];
        if (
          v === undefined ||
          (c.exact !== undefined && v !== c.exact) ||
          (c.min !== undefined && v < c.min) ||
          (c.max !== undefined && v > c.max)
        ) {
          return { failed: name };
        }
        continue;
      }
      const lo = Math.max(range.min, c.min ?? -Infinity, c.exact ?? -Infinity);
      const hi = Math.min(range.max, c.max ?? Infinity, c.exact ?? Infinity);
      if (lo > hi) return { failed: name };
      const target = c.exact ?? c.ideal ?? defaults[name] ?? lo;
      const value = clamp(target, lo, hi);
      if (c.ideal !== undefined) distance += distanceOf(value, c.ideal);
      settings[name] = value;
      continue;
    }
    if (STRINGS.has(name) || BOOLEANS.has(name)) {
      const options =
        caps[name] ?? (defaults[name] !== undefined ? [defaults[name]] : []);
      const has = (v) =>
        options.some((o) => (BOOLEANS.has(name) ? o === v : String(o) === v));
      if (c.exact) {
        const chosen = c.exact.find(has);
        if (chosen === undefined) return { failed: name };
        settings[name] = chosen;
      } else if (c.ideal) {
        const chosen = c.ideal.find(has);
        if (chosen === undefined) distance += 1;
        else settings[name] = chosen;
      }
    }
  }
  return { distance, settings };
}

/**
 * The device of `devices` the constraints choose, and its settings:
 * `{ device, settings }`. Throws `OverconstrainedError` naming a required
 * constraint where no device meets every one. The default device wins a
 * tie, then the list's order — the backend's, which puts the built-in
 * first.
 */
export function selectDevice(devices, constraints) {
  const ordered = [...devices].sort(
    (a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)),
  );
  let best = null;
  let failed = null;
  for (const device of ordered) {
    const fit = fitDevice(device, constraints);
    if (fit.failed) {
      failed ??= fit.failed;
      continue;
    }
    if (best === null || fit.distance < best.distance) {
      best = { device, settings: fit.settings, distance: fit.distance };
    }
  }
  if (best) return { device: best.device, settings: best.settings };
  throw new OverconstrainedError(failed ?? '');
}

/** Constraints back as the dictionary they were written in, for
 *  `getConstraints()` — a copy, so a caller's edit changes nothing. */
export function constraintsCopy(constraints) {
  if (!isPlainObject(constraints)) return {};
  return structuredClone(constraints);
}

/** A string that is the same for constraints that ask the same thing,
 *  whatever order their keys were written in — what a hook compares. */
export function constraintsKey(value) {
  if (Array.isArray(value)) return `[${value.map(constraintsKey).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${constraintsKey(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
