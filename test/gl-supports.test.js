// `useSupports('shaders')` answers about the **connection**, not the machine.
//
// The two come apart on a DRI3-capable box: ntk's capability probe reports
// what the machine could do and consults glPolicy only for 'off', so it
// resolves `direct: true` under the default 'indirect' policy — while the
// context that draws is the indirect one. A hook that reported the machine
// sent a scene into `<shaderMaterial>` that the mount guard then (correctly)
// refused, so the same question had two answers in one render (issue #357).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import {
  directGLFailure,
  hasDirectGL,
  watchDirectGL,
} from '../src/glbackend.js';
import { createRoot, useSupports } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// what a capable machine resolves to, in the shape ntk caches on the app
const CAPABLE = {
  direct: true,
  indirect: true,
  device: '/dev/dri/renderD128',
  reason: null,
};

/** A mock app told what its policy says and what the probe found. */
function glApp({ mode = 'indirect', caps } = {}) {
  const app = createMockApp();
  // ntk's App resolves this from its options on every read; a mock says it
  app.glPolicy = {
    mode,
    devicePath: null,
    maxInFlight: 2,
    linearFallback: true,
  };
  if (caps) app._glCapsResolved = caps;
  return app;
}

/** The last value a `useSupports(feature)` probe rendered with, and its root. */
async function mountProbe(app, feature) {
  const seen = [];
  function Probe() {
    seen.push(useSupports(feature));
    return null;
  }
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  await tick();
  return { seen, x11Root };
}

test('the backend is the policy’s answer, not the machine’s', () => {
  for (const mode of ['indirect', 'off']) {
    assert.equal(
      hasDirectGL(glApp({ mode, caps: CAPABLE })),
      false,
      `${mode} draws through no direct backend, whatever the box could do`,
    );
  }
  for (const mode of ['auto', 'direct']) {
    assert.equal(hasDirectGL(glApp({ mode, caps: CAPABLE })), true);
  }
  // a policy that asked, on a machine that cannot, or before the probe answered
  assert.equal(
    hasDirectGL(glApp({ mode: 'auto', caps: { direct: false, reason: null } })),
    false,
  );
  assert.equal(hasDirectGL(glApp({ mode: 'auto' })), false);
});

test('the reason names the policy when the policy is the reason', () => {
  const indirect = directGLFailure(glApp({ mode: 'indirect', caps: CAPABLE }));
  assert.equal(indirect.code, 'GL_POLICY_INDIRECT');
  assert.match(indirect.message, /glPolicy is 'indirect'/);
  // and points at the one thing that would change it
  assert.match(indirect.hint, /glPolicy: 'auto'/);

  assert.equal(directGLFailure(glApp({ mode: 'off' })).code, 'GL_DISABLED');

  // under a policy that did ask, ntk's own reason is the useful one and is
  // handed on untouched — an addon to install is not a policy to change
  const reason = Object.assign(
    new Error('the x11-dri addon is not installed'),
    {
      code: 'GL_NO_ADDON',
    },
  );
  const asked = glApp({ mode: 'auto', caps: { direct: false, reason } });
  assert.equal(directGLFailure(asked), reason);

  // nothing to report while the probe is still out, or when it found direct
  assert.equal(directGLFailure(glApp({ mode: 'auto' })), null);
  assert.equal(directGLFailure(glApp({ mode: 'auto', caps: CAPABLE })), null);
});

test('nothing is watched when nothing can move', () => {
  // a policy that cannot say direct, and one whose probe already answered
  for (const app of [
    glApp({ mode: 'indirect' }),
    glApp({ mode: 'auto', caps: CAPABLE }),
  ]) {
    app.glCapabilities = () => assert.fail('should not probe');
    assert.equal(typeof watchDirectGL(app, () => {}), 'function');
  }
});

test("useSupports('shaders') is false on a capable box the policy never asked", async () => {
  const app = glApp({ mode: 'indirect', caps: CAPABLE });
  const { seen, x11Root } = await mountProbe(app, 'shaders');
  assert.deepEqual(seen, [false], 'indirect GLX has no shaders to offer');
  await x11Root.unmount();
});

test("useSupports('shaders') is true once the policy asked and the probe agreed", async () => {
  const app = glApp({ mode: 'auto', caps: CAPABLE });
  const { seen, x11Root } = await mountProbe(app, 'shaders');
  assert.deepEqual(seen, [true]);
  await x11Root.unmount();
});

test('a probe that settles late re-renders its readers instead of tearing them', async () => {
  // A policy raised after connecting misses the probe createRoot() waits for,
  // so this is the one case where the answer still moves. It has to move for
  // everyone at once: a component rendered before the settle and one rendered
  // after it were reading different values of the same question.
  const app = glApp({ mode: 'auto' });
  let settle;
  const probed = new Promise((resolve) => {
    settle = resolve;
  });
  let probes = 0;
  app.glCapabilities = () => {
    probes++;
    return probed.then((caps) => {
      app._glCapsResolved = caps;
      return caps;
    });
  };

  const { seen, x11Root } = await mountProbe(app, 'shaders');
  assert.deepEqual(seen, [false], 'an unanswered probe reads as no shaders');
  assert.equal(probes, 1, 'subscribing asks the question ntk answers lazily');

  settle(CAPABLE);
  await probed;
  await tick();
  assert.equal(seen.at(-1), true, 're-rendered when the probe answered');

  await x11Root.unmount();
});
