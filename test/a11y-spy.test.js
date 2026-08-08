// The assistive-technology spy (`renderX11(..., { a11y: true })`): screen-
// reader-shaped assertions with no bus anywhere. Input is real — injected
// through the in-process X server, so Tab is the event manager's Tab and a
// press is a press — and the observations are the same hook feed the AT-SPI
// bridge serves to Orca, cut off before D-Bus.
//
// The four tests at the top are the canonical ones — the checks a sighted
// test author cannot make by looking and a unit test cannot express:
// focus order, no keyboard trap, nothing nameless, state changes announced.
// They are written to be stolen into applications wholesale.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { Button, Checkbox, Slider, Switch, announce } from '../src/index.js';
import {
  cleanup,
  renderX11,
  userEvent,
  utteranceOf,
  XK_RIGHT,
  XK_SPACE,
} from '../src/testing/index.js';
import { hooks } from '../src/a11y.js';

const h = React.createElement;
const { useState } = React;

/** A settings pane with one of everything the keyboard reaches. */
function App({ onSave = () => {} } = {}) {
  const [agreed, setAgreed] = useState(true);
  const [notify, setNotify] = useState(false);
  const [volume, setVolume] = useState(30);
  return h(
    'box',
    { style: { padding: 12, gap: 8 } },
    h('text', null, 'Preferences'),
    h(Button, { onPress: onSave }, 'Save'),
    h(
      Checkbox,
      { checked: agreed, onChange: (ev) => setAgreed(ev.value) },
      'Enable telemetry',
    ),
    h(Switch, {
      'aria-label': 'Notifications',
      checked: notify,
      onChange: (ev) => setNotify(ev.value),
    }),
    h(Slider, {
      'aria-label': 'Volume',
      value: volume,
      min: 0,
      max: 100,
      step: 1,
      onChange: (ev) => setVolume(ev.value),
      style: { width: 160 },
    }),
    h('textinput', { placeholder: 'Name' }),
  );
}

beforeEach(() => cleanup());
after(() => cleanup());

// ---------------------------------------------------------------------------
// The canonical four
// ---------------------------------------------------------------------------

test('focus order: tabbing tells the story in the right order', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  for (let i = 0; i < 5; i++) await userEvent.tab();
  const heard = at
    .events()
    .filter((e) => e.type === 'focus')
    .map((e) => e.summary);
  assert.deepEqual(heard, [
    'focus: Save, button',
    'focus: Enable telemetry, check box, checked',
    'focus: Notifications, switch',
    'focus: Volume, slider, 30 percent',
    'focus: Name, entry',
  ]);
});

test('no keyboard trap: Tab cycles, in both directions', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  const stops = at.focusables();
  assert.equal(stops.length, 5);
  // n+1 presses land back on the first stop — nothing swallowed the cycle
  for (let i = 0; i <= stops.length; i++) await userEvent.tab();
  assert.equal(at.focused().node, stops[0].node);
  // and backwards wraps to the last
  await userEvent.tab({ shift: true });
  assert.equal(at.focused().node, stops[stops.length - 1].node);
});

test('nothing the keyboard reaches is nameless', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  for (const stop of at.focusables()) {
    assert.notEqual(
      stop.utterance,
      '(no accessible name)',
      `a blind user reaching this <${stop.node.kind}> would be told nothing`,
    );
    assert.notEqual(stop.name, '', `unnamed ${stop.role}`);
  }
});

test('a state change is announced, not just repainted', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  await userEvent.tab();
  await userEvent.tab(); // the checkbox, checked
  at.since();
  await userEvent.key(XK_SPACE);
  const heard = at.since();
  assert.ok(
    heard.some((e) => e.type === 'state' && e.state === 'checked' && !e.on),
    `expected a checked→off state change, heard: ${heard.map((e) => e.summary).join(' | ')}`,
  );
  // …and back
  await userEvent.key(XK_SPACE);
  assert.ok(
    at.since().some((e) => e.type === 'state' && e.state === 'checked' && e.on),
  );
});

// ---------------------------------------------------------------------------
// The rest of the feed
// ---------------------------------------------------------------------------

test('adjusting a slider announces its value', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  // Tab, not click: a press on the track is a jump-to-position gesture and
  // would move the value before the arrow key does
  for (let i = 0; i < 4; i++) await userEvent.tab();
  assert.equal(at.focused().role, 'slider');
  at.since();
  await userEvent.key(XK_RIGHT);
  const heard = at.since();
  assert.ok(
    heard.some((e) => e.type === 'value' && e.value === 31),
    `expected value: 31, heard: ${heard.map((e) => e.summary).join(' | ')}`,
  );
  assert.equal(at.focused().utterance, 'Volume, slider, 31 percent');
});

test('typing echoes through text-changed, character by character', async () => {
  const { at, getByRole } = await renderX11(h(App), { a11y: true });
  const input = getByRole('textbox');
  await userEvent.type(input, 'hi');
  const inserts = at
    .events()
    .filter((e) => e.type === 'text-insert')
    .map((e) => e.text);
  assert.deepEqual(inserts, ['h', 'i']);
  // the name is still the placeholder — a value is not a name
  assert.equal(at.focused().utterance, 'Name, entry');
});

test('announce() is observable, and reports delivery', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  assert.equal(announce('Saved', { assertive: true }), true);
  const heard = at.since().filter((e) => e.type === 'announce');
  assert.deepEqual(
    heard.map((e) => e.summary),
    ['announce: Saved'],
  );
  assert.equal(heard[0].assertive, true);
});

test('the audit catches what it exists to catch', async () => {
  // a focusable box nobody named: exactly the control the nameless check
  // is for — prove the utterance flags it rather than passing politely
  const { at } = await renderX11(
    h('box', { focusable: true, style: { width: 40, height: 40 } }),
    { a11y: true },
  );
  const [stop] = at.focusables();
  assert.equal(stop.utterance, '(no accessible name)');
});

test('the spy uninstalls with its render', async () => {
  const { at } = await renderX11(h(App), { a11y: true });
  assert.equal(typeof hooks.focus, 'function');
  await cleanup();
  assert.equal(hooks.focus, null);
  assert.equal(hooks.announce, null);
  // the log survives teardown for post-mortem assertions
  assert.ok(Array.isArray(at.events()));
  assert.equal(announce('nobody is listening'), false);
});

test('utteranceOf is the documented model, exactly', () => {
  assert.equal(
    utteranceOf({
      name: 'Volume',
      role: 'slider',
      states: ['sensitive', 'focusable'],
      value: { now: 30, min: 0, max: 100 },
    }),
    'Volume, slider, 30 percent',
  );
  assert.equal(
    utteranceOf({ name: 'Save', role: 'button', states: ['focusable'] }),
    'Save, button, unavailable',
  );
  assert.equal(
    utteranceOf({ name: '', role: 'filler' }),
    '(no accessible name)',
  );
});
