// `jsxImportSource: "react-x11"` makes the compiler emit imports from
// react-x11/jsx-runtime, so those modules have to exist and work at runtime,
// not just carry the JSX types. Nothing else in the suite loads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as reactRuntime from 'react/jsx-runtime';
import * as reactDevRuntime from 'react/jsx-dev-runtime';

import * as runtime from '../src/jsx-runtime.js';
import * as devRuntime from '../src/jsx-dev-runtime.js';

test('the JSX runtime is React’s own', () => {
  assert.equal(runtime.jsx, reactRuntime.jsx);
  assert.equal(runtime.jsxs, reactRuntime.jsxs);
  assert.equal(runtime.Fragment, reactRuntime.Fragment);
});

test('the development JSX runtime is too', () => {
  assert.equal(devRuntime.jsxDEV, reactDevRuntime.jsxDEV);
  assert.equal(devRuntime.Fragment, reactDevRuntime.Fragment);
});

test('it builds the elements the renderer expects', () => {
  const element = runtime.jsx('box', { style: { flexGrow: 1 } });
  assert.equal(element.type, 'box');
  assert.deepEqual(element.props.style, { flexGrow: 1 });
});
