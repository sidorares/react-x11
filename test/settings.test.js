// examples/settings.jsx — the parts a control gallery never has to get right.
//
// The store is a seam, so nothing here writes to `~/.config`. The assertions
// are about the behaviours that make this a program rather than a grid of
// widgets: search that finds settings rather than pages, a value that can be
// invalid, a reset that knows the default, and a window that mirrors.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  within,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { SettingsPanel, memoryStore } = await import('../examples/settings.jsx');

afterEach(cleanup);

const h = React.createElement;

const mount = async (store) => {
  const handle = await renderX11(h(SettingsPanel, { store }), {
    width: 820,
    height: 560,
  });
  // Not `getByText('Appearance')` — that is both a page in the sidebar and
  // the heading beside it. Wait for the search field, and for it to be laid
  // out, since `userEvent.click` needs a rect to aim at.
  await waitFor(() => {
    const field = screen.getByPlaceholder('Search settings');
    assert.ok(field.abs?.width > 0, 'not laid out yet');
  });
  return handle;
};

const page = () => within(screen.getByTestName('page'));
const search = () => screen.getByPlaceholder('Search settings');
// A control's role name comes from its *own* text, and a Switch has none — so
// find the row by the label beside it, then the control within.
const rowFor = (label) => within(page().getByRole('group', { name: label }));

describe('examples/settings', () => {
  test('search finds settings, not pages, and goes where they live', async () => {
    await mount(memoryStore());

    // "telemetry" is a keyword on a setting that lives on a page whose name
    // does not contain it. A search that matched page names would find
    // nothing, which is the failure this shape exists to avoid.
    await userEvent.type(search(), 'telemetry');

    await waitFor(() => page().getByText('Send usage statistics'));
    page().getByText('Search results');
  });

  test('a reset goes back to the shipped default, not the last saved value', async () => {
    await mount(memoryStore());

    // nothing is dirty yet, so there is no bar and no per-row reset
    assert.equal(screen.queryAllByText('Discard').length, 0);
    assert.equal(page().queryAllByText('Reset').length, 0);

    await userEvent.click(rowFor('Animate transitions').getByRole('switch'));

    await waitFor(() => screen.getByText('1 unsaved change'));
    await userEvent.click(page().getByText('Reset'));

    // back to the default means back to *not dirty* — a reset that set the
    // value without clearing the change is the bug worth pinning
    await waitFor(() =>
      assert.equal(screen.queryAllByText('Discard').length, 0),
    );

    // …and "the default" is the one the app ships with, not the last value
    // applied. Those are the same until something has been saved, which is
    // why a test that never applies anything cannot tell them apart.
    await userEvent.click(screen.getByRole('option', { name: 'Account' }));
    const nameField = () => page().getByPlaceholder('what other people see');
    await waitFor(() => nameField());

    await userEvent.type(nameField(), 'ada');
    await userEvent.click(screen.getByText('Apply'));
    await waitFor(() => assert.equal(screen.queryAllByText('Apply').length, 0));

    await userEvent.type(nameField(), '!');
    await userEvent.click(page().getByText('Reset'));
    await waitFor(() => assert.equal(nameField().value, ''));
  });

  test('an invalid value blocks Apply and says why', async () => {
    const store = memoryStore();
    await mount(store);

    await userEvent.click(screen.getByRole('option', { name: 'Account' }));
    await waitFor(() => page().getByText('Display name'));

    await userEvent.type(page().getByPlaceholder('you@example.org'), 'nope');

    await waitFor(() => page().getByText('that is not an address'));
    screen.getByText('one of these is not valid yet');

    // and Apply does not take it
    await userEvent.click(screen.getByText('Apply'));
    await waitFor(() => screen.getByText('one of these is not valid yet'));
    assert.equal(store.saved.length, 0);
  });

  test('Apply writes the whole set, once', async () => {
    const store = memoryStore();
    await mount(store);

    await userEvent.click(rowFor('Animate transitions').getByRole('switch'));
    await waitFor(() => screen.getByText('Apply'));
    await userEvent.click(screen.getByText('Apply'));

    await waitFor(() => assert.equal(store.saved.length, 1));
    assert.equal(store.saved[0].animate, false);
    // the untouched ones go too — a settings file with only what changed is a
    // file that cannot answer "what is this set to"
    assert.equal(store.saved[0].density, 'comfortable');

    // …and the bar goes, because nothing is dirty any more
    await waitFor(() => assert.equal(screen.queryAllByText('Apply').length, 0));
  });

  test('a setting that depends on another is disabled until it is on', async () => {
    await mount(memoryStore());
    await userEvent.click(screen.getByRole('option', { name: 'Privacy' }));
    await waitFor(() => page().getByText('Lock when idle'));

    page().getByText('needs the setting above');
    await userEvent.click(rowFor('Lock when idle').getByRole('switch'));
    await waitFor(() =>
      assert.equal(page().queryAllByText('needs the setting above').length, 0),
    );
  });

  test('an RTL language mirrors the window', async () => {
    // The whole of the mirroring is `direction` on the theme; no component
    // below reads it. So the assertion is about *layout*: in a left-to-right
    // window the sidebar is at the left edge, and in a right-to-left one it
    // is not.
    const { windowNode: ltr } = await mount(memoryStore({ language: 'en-GB' }));
    const leftSidebar = screen.getByPlaceholder('Search settings').abs.x;
    const width = ltr.abs.width;
    cleanup();

    await mount(memoryStore({ language: 'ar-EG' }));
    const rightSidebar = screen.getByPlaceholder('Search settings').abs.x;

    assert.ok(
      leftSidebar < width / 2,
      `ltr sidebar should start at the left, was ${leftSidebar}`,
    );
    assert.ok(
      rightSidebar > width / 2,
      `rtl sidebar should start at the right, was ${rightSidebar}`,
    );
  });
});
