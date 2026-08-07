// Testing-Library-shaped queries over the retained node tree.
//
// The tree is right here and fully ours — `node.kind`, `node.props`,
// `node.children` — so the queries walk it directly rather than going
// through React's test selectors. That keeps the failure messages ours (a
// miss prints what *was* there), and keeps the queries independent of
// react-reconciler's internal host-config contract.
//
// Naming follows Testing Library, because that is the vocabulary React
// developers already have:
//
//   getBy*    exactly one, or throw
//   queryBy*  one or null, never throws — the way to assert absence
//   getAllBy* one or more, or throw
//   findBy*   getBy*, retried until it appears or the timeout expires

import { queryAllByComponent, componentInventory } from './components.js';
import { roleNameOf } from '../a11y.js';

const DEFAULT_TIMEOUT = 1000;

/** Depth-first, in paint order, including `<popup>` subtrees. */
function walk(node, visit) {
  if (!node || node.destroyed) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function collect(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/**
 * The text a node presents, joined across its spans and chunks — so a
 * `<text>` built from several styled spans still matches as one string,
 * which is what a reader sees.
 */
export function textOf(node) {
  let out = '';
  walk(node, (n) => {
    if (typeof n.text === 'string') out += n.text;
  });
  return out;
}

function matches(actual, expected, exact) {
  if (expected instanceof RegExp) return expected.test(actual);
  if (typeof expected === 'function') return Boolean(expected(actual));
  const a = exact ? actual : actual.trim().toLowerCase();
  const b = exact ? String(expected) : String(expected).trim().toLowerCase();
  return exact ? a === b : a.includes(b);
}

/**
 * The role a node reports: the `role` prop, else the same kind → role-name
 * table the AT-SPI bridge reads (src/a11y.js), so what a test selects by
 * and what a screen reader hears cannot drift apart. Kinds with no
 * accessibility default (`box`, `canvas`, …) answer their kind, which is
 * what queries were written against.
 */
export function roleOf(node) {
  return roleNameOf(node) ?? node.kind;
}

function describe(node) {
  const text = textOf(node).trim();
  const name = node.props?.['data-testname'];
  return (
    `<${node.kind}${name ? ` data-testname="${name}"` : ''}>` +
    (text ? ` ${JSON.stringify(text.slice(0, 40))}` : '')
  );
}

function inventory(root, limit = 12) {
  const lines = [];
  walk(root, (n) => {
    if (n.kind === 'textchunk' || n.kind === 'textspan') return;
    if (lines.length < limit) lines.push(`  ${describe(n)}`);
  });
  return lines.join('\n');
}

function one(root, found, what, printTree = inventory) {
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new Error(
      `react-x11/test: no element found for ${what}.\nThe tree holds:\n${printTree(root)}`,
    );
  }
  throw new Error(
    `react-x11/test: found ${found.length} elements for ${what}, expected one:\n` +
      found.map((n) => `  ${describe(n)}`).join('\n'),
  );
}

async function retry(fn, { timeout = DEFAULT_TIMEOUT, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      last = err;
      if (Date.now() >= deadline) throw last;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

/**
 * The queries, bound to a subtree. `within(node)` is this with a different
 * root; `screen` is this bound to whatever `renderX11` mounted last.
 */
export function within(root) {
  const q = {
    /** Every node under here, in paint order — the escape hatch. */
    all: (predicate = () => true) => collect(root, predicate),

    queryAllByText: (text, { exact = false, selector = null } = {}) =>
      collect(
        root,
        (n) =>
          // only leaf-ish text holders, or every ancestor would match too
          (n.kind === 'text' ||
            n.kind === 'textinput' ||
            n.kind === 'textarea') &&
          (!selector || n.kind === selector) &&
          matches(
            n.kind === 'text'
              ? textOf(n)
              : (n.value ?? n.props?.placeholder ?? ''),
            text,
            exact,
          ),
      ),

    queryAllByRole: (role, { name = null, exact = false } = {}) =>
      collect(
        root,
        (n) =>
          roleOf(n) === role &&
          (name == null || matches(textOf(n), name, exact)),
      ),

    queryAllByTestName: (name) =>
      collect(root, (n) => n.props?.['data-testname'] === name),

    queryAllByPlaceholder: (text, { exact = false } = {}) =>
      collect(
        root,
        (n) =>
          typeof n.props?.placeholder === 'string' &&
          matches(n.props.placeholder, text, exact),
      ),

    /**
     * Host nodes by the component that created them (the JSX owner): for
     * each rendered instance, the topmost host nodes of its output — so
     * `within(getByComponent('TaskRow'))` scopes the other queries to that
     * instance. Exact name, RegExp, or predicate over the name; needs
     * development React, which records the owner on every element.
     */
    queryAllByComponent: (component) => queryAllByComponent(root, component),
  };

  // getBy / queryBy / getAllBy / findBy are all mechanical from queryAllBy
  for (const [key, queryAll] of Object.entries(q)) {
    if (!key.startsWith('queryAll')) continue;
    const suffix = key.slice('queryAll'.length); // 'ByText', 'ByRole', …
    // a ByComponent miss lists the components in the tree — the caller was
    // trying to spell one of those, not an element kind
    const printTree = suffix === 'ByComponent' ? componentInventory : inventory;
    const label = (arg) =>
      `${suffix.replace(/^By/, '')} ${
        arg instanceof RegExp
          ? String(arg)
          : typeof arg === 'function'
            ? arg.name || '(predicate)'
            : JSON.stringify(arg)
      }`;
    q[`getAll${suffix}`] = (...args) => {
      const found = queryAll(...args);
      if (found.length === 0) {
        throw new Error(
          `react-x11/test: no element found for ${label(args[0])}.\n` +
            `The tree holds:\n${printTree(root)}`,
        );
      }
      return found;
    };
    q[`get${suffix}`] = (...args) =>
      one(root, queryAll(...args), label(args[0]), printTree);
    q[`query${suffix}`] = (...args) => {
      const found = queryAll(...args);
      if (found.length > 1) return one(root, found, label(args[0]));
      return found[0] ?? null;
    };
    q[`find${suffix}`] = (...args) => {
      const options = args.length > 1 ? args[args.length - 1] : undefined;
      return retry(() => q[`get${suffix}`](...args), options);
    };
  }
  return q;
}

/** `within` bound lazily to the most recent `renderX11`. */
export function screenFor(getRoot) {
  const target = {};
  return new Proxy(target, {
    get(_t, prop) {
      const root = getRoot();
      if (!root) {
        throw new Error(
          'react-x11/test: `screen` has nothing to query — call renderX11() first.',
        );
      }
      return within(root)[prop];
    },
  });
}
