// `<window appId>`: the one name for the identity every desktop calls
// something else.
//
// It was `wmClass`, which is ICCCM's word, and the prop was therefore read by
// exactly one backend. Wayland's backend window had been reading
// `attributes.appId` all along and never saw it; the rename is what connects
// them. X11 keeps its instance/class pair, because that is genuinely what the
// protocol carries; everything else takes the class, which is the half that
// names the application rather than the window.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { windowAttributes } from '../src/nodes/window/hints.js';

describe('<window appId>: one name, every desktop', () => {
  it('passes a plain id through as itself', () => {
    const attrs = windowAttributes({ appId: 'com.example.App' });
    assert.equal(attrs.appId, 'com.example.App');
  });

  it('gives a single-id backend the class out of X11 pair', () => {
    // The instance names this window, the class names the application. A
    // backend with one string wants the application's.
    assert.equal(
      windowAttributes({ appId: ['timer', 'Timer'] }).appId,
      'Timer',
    );
    assert.equal(
      windowAttributes({ appId: { instance: 'timer', class: 'Timer' } }).appId,
      'Timer',
    );
    // ...and an instance with no class is all there is to go on.
    assert.equal(
      windowAttributes({ appId: { instance: 'timer' } }).appId,
      'timer',
    );
  });

  it('accepts the old name and normalises it the same way', () => {
    const attrs = windowAttributes({ wmClass: ['timer', 'Timer'] });
    assert.equal(attrs.appId, 'Timer', 'the old name reached no backend');
    assert.deepEqual(
      attrs.wmClass,
      ['timer', 'Timer'],
      'and is still passed through, so an X11 backend reading it still works',
    );
  });

  it('prefers the new name when an app writes both', () => {
    const attrs = windowAttributes({
      appId: 'com.example.New',
      wmClass: 'Old',
    });
    assert.equal(attrs.appId, 'com.example.New');
  });

  it('adds nothing when an app names no identity', () => {
    assert.equal('appId' in windowAttributes({ title: 'hi' }), false);
  });
});
