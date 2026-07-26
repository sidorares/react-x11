// The same hello world without JSX — plain node, no build step.
// Run with: npm run examples:simple-nojsx  (needs an X server / DISPLAY)
import React from 'react';
import { createRoot } from '../src/index.js';

const h = React.createElement;

function App() {
  return h(
    'window',
    { width: 320, height: 200, title: 'react-x11', backgroundColor: '#f4f4f4' },
    h(
      'box',
      {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 12,
        padding: 16,
      },
      h(
        'text',
        { fontSize: 24, color: '#222' },
        'Hello, ',
        h('text', { color: '#c0392b' }, 'X11'),
        '!',
      ),
      h(
        'box',
        { backgroundColor: '#3498db', borderRadius: 6, padding: 10 },
        h('text', { color: 'white' }, 'flexbox via yoga-layout'),
      ),
    ),
  );
}

const root = await createRoot();
root.render(h(App));
