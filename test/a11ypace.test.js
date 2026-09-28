// How often an accessibility bridge pushes (src/a11ypace.js): at once after a
// quiet spell, once per interval through a stream, and what
// REACT_X11_A11Y_INTERVAL says the interval is.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  A11yPacer,
  DEFAULT_A11Y_INTERVAL,
  a11yInterval,
} from '../src/a11ypace.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the interval is 500 ms, and the variable sets it in ms', () => {
  assert.equal(DEFAULT_A11Y_INTERVAL, 500);
  assert.equal(a11yInterval({}), 500);
  assert.equal(a11yInterval({ REACT_X11_A11Y_INTERVAL: '' }), 500);
  assert.equal(a11yInterval({ REACT_X11_A11Y_INTERVAL: '100' }), 100);
  assert.equal(
    a11yInterval({ REACT_X11_A11Y_INTERVAL: '0' }),
    0,
    'every change',
  );
  // nothing it could mean: the default, rather than no pacing at all
  assert.equal(a11yInterval({ REACT_X11_A11Y_INTERVAL: 'fast' }), 500);
  assert.equal(a11yInterval({ REACT_X11_A11Y_INTERVAL: '-5' }), 500);
});

test('a change after a quiet spell may go at once', () => {
  const pacer = new A11yPacer(1000);
  assert.equal(
    pacer.ready(() => assert.fail('nothing is owed')),
    true,
  );
});

test('a stream is held to one push per interval, and the last catches up', async () => {
  const pacer = new A11yPacer(60);
  let later = 0;
  pacer.pushed();
  // six changes inside the interval ask for one push between them
  for (let i = 0; i < 6; i++) {
    assert.equal(
      pacer.ready(() => later++),
      false,
    );
  }
  assert.equal(later, 0, 'held');
  await sleep(90);
  assert.equal(later, 1, 'and pushed once, when the interval was up');
});

test('an urgent push takes what the stream was owed', async () => {
  const pacer = new A11yPacer(40);
  let later = 0;
  pacer.pushed();
  assert.equal(
    pacer.ready(() => later++),
    false,
  );
  // the bridge pushes now, for a focus change, and says so
  pacer.cancel();
  pacer.pushed();
  await sleep(70);
  assert.equal(later, 0, 'the held push is not also made');
});

test('an interval of 0 is a push per change', () => {
  const pacer = new A11yPacer(0);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      pacer.ready(() => assert.fail('never deferred')),
      true,
    );
    pacer.pushed();
  }
});
