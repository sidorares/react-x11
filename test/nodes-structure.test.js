// The shape src/nodes/ keeps (src/nodes/install.js explains it). Every class
// a module there exports is a node class or a part installed onto one: a part
// nobody installs is a set of methods that silently do not exist until the
// first call. And the modules import each other without a cycle: a part that
// imported its own class's file would leave load order to decide whether that
// class exists yet when something extends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installedOnto } from '../src/nodes/install.js';
import { Node } from '../src/nodes/node.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'nodes',
);

function modules(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return modules(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

const isClass = (value) =>
  typeof value === 'function' &&
  /^class\b/.test(Function.prototype.toString.call(value));

test('every class exported from src/nodes/ is a node class or an installed part', async () => {
  const stray = [];
  let parts = 0;
  for (const file of modules(ROOT)) {
    const mod = await import(pathToFileURL(file).href);
    for (const [name, value] of Object.entries(mod)) {
      if (!isClass(value)) continue;
      if (value === Node || value.prototype instanceof Node) continue;
      if (installedOnto(value)) {
        parts++;
        continue;
      }
      stray.push(`${relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(
    stray,
    [],
    'exported classes that are neither a node class nor installed onto one',
  );
  assert.ok(
    parts > 20,
    `expected the parts of Node and WindowNode, found ${parts}`,
  );
});

test('the modules under src/nodes/ import each other without a cycle', () => {
  const graph = new Map();
  for (const file of modules(ROOT)) {
    const text = readFileSync(file, 'utf8');
    const deps = [...text.matchAll(/^import\s[\s\S]*?\sfrom\s+'(\.[^']+)';/gm)]
      .map((m) => resolve(dirname(file), m[1]))
      .filter((p) => p.startsWith(ROOT));
    graph.set(file, deps);
  }
  const done = new Set();
  const path = [];
  const visit = (file) => {
    const at = path.indexOf(file);
    if (at !== -1) {
      const cycle = [...path.slice(at), file].map((f) => relative(ROOT, f));
      assert.fail(`import cycle: ${cycle.join(' -> ')}`);
    }
    if (done.has(file)) return;
    path.push(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
    path.pop();
    done.add(file);
  };
  for (const file of graph.keys()) visit(file);
  assert.ok(graph.size > 30, `expected the node modules, found ${graph.size}`);
});
