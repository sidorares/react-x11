// The protocol bench's runner, not its numbers (#416).
//
// Scenarios used to share a process, and they are not independent in one:
// ntk frees X resources from FinalizationRegistry callbacks, so a change to
// how much garbage an *earlier* scenario leaves moves when the collector
// runs inside a *later* one — and a pause landing inside a paced frame
// turns that frame's bounded repaint into a full-window one. `--check` then
// failed by 6x on a scenario the change never touched.
//
// So the runner now gives each scenario its own process, and `--only` runs
// one by name. These pin the plumbing that makes both usable: the filter
// selects, a filter that matches nothing says so instead of measuring
// nothing, a filtered `--save` updates its entries without dropping the
// rest of the baseline, and a scenario missing from the baseline is still
// reported as stale when the run is partial.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNode } from './helpers/run-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'bench', 'protocol.js');
const baselinePath = join(here, '..', 'scripts', 'bench', 'baseline.json');

// The two cheapest scenarios in the file: a state flip and five color
// flips, ~20 requests each. What is being tested is the runner.
const FLIP = 'rounded box state flip';
const COLORS = 'color flips';

const bench = (...args) =>
  runNode(['--import', 'tsx', script, ...args], {}, 120000);

/** The scenario names of a run, read back off the printed table. */
const rows = (stdout) =>
  stdout
    .split('\n')
    .slice(1)
    .filter((line) => line.includes(':'))
    .map((line) => line.split(/ {2,}/)[0]);

test('--only runs just the scenarios whose names match', async () => {
  const { code, stdout } = await bench('--only', FLIP, '--no-isolate');
  assert.equal(code, 0);
  assert.deepEqual(rows(stdout), ['hover: rounded box state flip, on and off']);
});

test('--only is repeatable', async () => {
  const { code, stdout } = await bench(
    '--only',
    FLIP,
    '--only',
    COLORS,
    '--no-isolate',
  );
  assert.equal(code, 0);
  assert.equal(rows(stdout).length, 2);
});

test('a filter that matches nothing fails and lists the scenarios', async () => {
  const { code, stderr } = await bench('--only', 'no such scenario');
  assert.equal(code, 1);
  assert.match(stderr, /matched no scenario/);
  assert.match(stderr, /hover: rounded box state flip, on and off/);
});

test('--only needs an argument', async () => {
  const { code, stderr } = await bench('--only');
  assert.equal(code, 1);
  assert.match(stderr, /--only needs an argument/);
});

test('a filtered --save updates its entries and keeps the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-baseline-'));
  const file = join(dir, 'baseline.json');
  const before = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const name = 'hover: rounded box state flip, on and off';
  // a value no run can produce, so "was it rewritten" has one answer
  before[name] = { ...before[name], requests: 999999 };
  writeFileSync(file, JSON.stringify(before, null, 2));

  const { code } = await bench(
    '--only',
    FLIP,
    '--save',
    '--baseline',
    file,
    '--no-isolate',
  );
  assert.equal(code, 0);

  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.notEqual(after[name].requests, 999999);
  for (const other of Object.keys(after)) {
    if (other === name) continue;
    assert.deepEqual(after[other], before[other]);
  }
});

test('--check under --only still catches a scenario the baseline lacks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-baseline-'));
  const file = join(dir, 'baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const name = 'hover: rounded box state flip, on and off';
  delete baseline[name];
  writeFileSync(file, JSON.stringify(baseline, null, 2));

  const { code, stderr } = await bench(
    '--only',
    FLIP,
    '--check',
    '--baseline',
    file,
    '--no-isolate',
  );
  assert.equal(code, 1);
  assert.match(stderr, /baseline out of date/);
  assert.match(stderr, new RegExp(name));
});

test('--check under --only ignores the scenarios it did not run', async () => {
  const { code, stdout } = await bench('--only', FLIP, '--check');
  assert.equal(code, 0);
  assert.match(
    stdout,
    /no regressions against the baseline \(1 of \d+ scenarios\)/,
  );
});
