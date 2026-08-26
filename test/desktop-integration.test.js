// `createRoot({ desktop })` — the off switch for the three things react-x11
// starts for you that talk to the session bus (issue #417).
//
// The policy is process-wide and it latches, so every case here releases it
// again in `afterEach`. That is the harness undoing what the harness caused;
// there is deliberately no way for an application to turn an integration back
// on, which is the behaviour the last test in the file pins down.
import { test, describe, after, afterEach, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';

import {
  _resetDesktopIntegration,
  desktopIntegrationEnabled,
  setDesktopIntegration,
} from '../src/desktopintegration.js';
import {
  _resetAppearance,
  appearanceSnapshot,
  systemAppearance,
} from '../src/appearance.js';
import { _resetBusState, busRefs } from '../src/bus.js';
import { GlobalMenuExport } from '../src/globalmenu.js';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { fakeRegistrar } from './helpers/fake-registrar.js';
import { runScript } from './helpers/run-script.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const h = React.createElement;

// The remembered answer lives in $XDG_CACHE_HOME; point it at a scratch
// directory so nothing here reads — or writes — the developer's own desktop.
let cacheHome;
const savedCacheHome = process.env.XDG_CACHE_HOME;

before(async () => {
  cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rx11-desktop-'));
  process.env.XDG_CACHE_HOME = cacheHome;
});

after(async () => {
  if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCacheHome;
  await fs.rm(cacheHome, { recursive: true, force: true });
});

/** Plant a remembered answer, the way a previous run of an app would have. */
async function rememberDark() {
  const file = path.join(cacheHome, 'react-x11', 'appearance.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      v: 1,
      colorScheme: 'dark',
      accent: '#ed5b00',
      contrast: 'normal',
      reducedMotion: false,
    }),
  );
}

afterEach(async () => {
  await fs.rm(path.join(cacheHome, 'react-x11'), {
    recursive: true,
    force: true,
  });
  _resetDesktopIntegration();
  _resetAppearance();
  _resetBusState();
});

describe('the policy', () => {
  test('everything is on with no option, and `true` changes nothing', () => {
    setDesktopIntegration(undefined);
    setDesktopIntegration(true);
    for (const feature of ['appearance', 'a11y', 'globalMenu']) {
      assert.equal(desktopIntegrationEnabled(feature), true, feature);
    }
  });

  test('`false` turns off all three', () => {
    setDesktopIntegration(false);
    for (const feature of ['appearance', 'a11y', 'globalMenu']) {
      assert.equal(desktopIntegrationEnabled(feature), false, feature);
    }
  });

  test('the object form turns off only what it names', () => {
    setDesktopIntegration({ appearance: false });
    assert.equal(desktopIntegrationEnabled('appearance'), false);
    assert.equal(desktopIntegrationEnabled('a11y'), true);
    assert.equal(desktopIntegrationEnabled('globalMenu'), true);
  });

  test('off latches: nothing turns an integration back on', () => {
    setDesktopIntegration(false);
    setDesktopIntegration(true);
    setDesktopIntegration({ appearance: true, a11y: true, globalMenu: true });
    for (const feature of ['appearance', 'a11y', 'globalMenu']) {
      assert.equal(desktopIntegrationEnabled(feature), false, feature);
    }
  });

  test('a misspelt integration is a throw, not a silent no-op', () => {
    // the failure mode this exists to prevent: `desktop: { a11Y: false }`
    // leaving the bridge running and nothing saying so
    assert.throws(
      () => setDesktopIntegration({ notifications: false }),
      /no such desktop integration/,
    );
    assert.throws(() => setDesktopIntegration('off'), /takes false or/);
    // and nothing was applied on the way to the throw
    assert.equal(desktopIntegrationEnabled('a11y'), true);
  });
});

describe('through createRoot', () => {
  test('the option is validated before anything is started', async () => {
    await assert.rejects(
      () => createRoot({ app: createMockApp(), desktop: { nope: false } }),
      /no such desktop integration/,
    );
    assert.equal(desktopIntegrationEnabled('a11y'), true);
  });

  test('`desktop: false` turns the three off for the process', async () => {
    const root = await createRoot({ app: createMockApp(), desktop: false });
    try {
      for (const feature of ['appearance', 'a11y', 'globalMenu']) {
        assert.equal(desktopIntegrationEnabled(feature), false, feature);
      }
    } finally {
      await root.unmount();
    }
  });

  test('a second root cannot turn back on what the first turned off', async () => {
    const app = createMockApp();
    const first = await createRoot({ app, desktop: false });
    const second = await createRoot({ app, desktop: true });
    try {
      assert.equal(desktopIntegrationEnabled('a11y'), false);
    } finally {
      await second.unmount();
      await first.unmount();
    }
  });
});

describe('what turning a11y off actually stops', () => {
  // In a child process, and it has to be: `startA11y()` memoises per process,
  // and importing anything from `react-x11/test` sets NO_AT_BRIDGE — so an
  // in-process assertion would be true for a reason that is not this one.
  //
  // `REACT_X11_A11Y=1` is the strongest form of "climb anyway": it overrides
  // NO_AT_BRIDGE *and* makes every rung report why it stopped. What it prints
  // is the observable — a silent run is a climb that never started.
  const child = (source, env) =>
    runScript(
      `
      const { startA11y } = await import('./src/a11y.js');
      const { setDesktopIntegration } = await import(
        './src/desktopintegration.js');
      ${source}
      console.log('bridge=' + (await startA11y()));
    `,
      { REACT_X11_A11Y: '1', NO_AT_BRIDGE: '', ...env },
    );

  test('the climb is loud without the switch, and silent with it', async () => {
    const on = await child('');
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /bridge=null/);
    assert.match(
      on.stderr,
      /accessibility off/,
      'the forced climb reported where it stopped',
    );

    const off = await child('setDesktopIntegration(false);');
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /bridge=null/);
    assert.equal(off.stderr.trim(), '', 'nothing climbed, so nothing reported');
  });
});

describe(
  'what turning the global menu off actually stops',
  { ...needsBroker },
  () => {
    const MENUS = () => [{ id: 'file', label: 'File', items: [] }];

    test('the menu is not exported, and no bus is dialled', async () => {
      await withBus(async (address, broker) => {
        const panel = await fakeRegistrar(address);
        setDesktopIntegration({ globalMenu: false });

        const owner = new GlobalMenuExport({
          getMenus: MENUS,
          target: {
            id: 0x99,
            setProperty: async () => {},
            deleteProperty: async () => {},
          },
          onChange: () => {},
        });
        await owner.start();

        assert.equal(owner.ref, null, 'no bus ref was taken');
        assert.equal(owner.exported, false, 'nothing was exported');
        assert.equal(busRefs('session'), 0);
        // the panel is right there and listening; the switch is what stopped it
        assert.equal(broker.liveClients, 1, 'only the fake panel connected');

        await owner.stop();
        await panel.stop();
        await until(() => busRefs('session') === 0, 'the bus to be released');
      });
    });
  },
);

describe('what turning appearance off actually stops', () => {
  test('the ladder does not run, and no bus is acquired', async () => {
    setDesktopIntegration({ appearance: false });
    const answer = await systemAppearance();
    assert.equal(answer.colorScheme, 'no-preference');
    assert.equal(answer.accent, null);
    assert.equal(answer.contrast, 'normal');
    assert.equal(answer.reducedMotion, false);
    // `source: null` is the tell that nothing answered — not even the cache,
    // which would make an opted-out app draw in whatever colours this machine
    // was in last time
    assert.equal(answer.source, null);
    assert.equal(busRefs('session'), 0);
  });

  test('the cache is not read either, on a machine that has one', async () => {
    // the remembered answer is the *whole* point of the seeding path, so
    // proving it is skipped needs a real one on disk: without the plant this
    // test passes on any machine that has never run an app
    await rememberDark();
    assert.equal(appearanceSnapshot().colorScheme, 'dark', 'the plant took');

    _resetAppearance();
    setDesktopIntegration({ appearance: false });
    assert.equal(appearanceSnapshot().colorScheme, 'no-preference');
    assert.equal(appearanceSnapshot().source, null);
  });

  test('a tree still renders, in the defaults', async () => {
    setDesktopIntegration(false);
    const root = await createRoot({ app: createMockApp() });
    try {
      root.render(h('window', { width: 40, height: 30 }, h('box', null)));
      assert.equal(desktopIntegrationEnabled('appearance'), false);
    } finally {
      await root.unmount();
    }
  });
});
