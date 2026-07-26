const { test } = require('node:test');
const assert = require('node:assert');
const React = require('react');
const ReactX11 = require('../src/index.js');

// End-to-end test: react-x11 -> real ntk client -> node-x11's pure-JS
// in-process X server. No $DISPLAY needed (see ntk docs/xserver.md).
const xserver = require('x11/lib/xserver/index.js');

async function createHeadlessApp() {
  const { createClient } = await import('ntk');
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  return { server, app };
}

function render(element, app) {
  return new Promise((resolve) => {
    ReactX11.render(element, (instance) => resolve(instance), app);
  });
}

test('renders a window tree into an in-process X server', async () => {
  const { app } = await createHeadlessApp();
  try {
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, title: 'integration' },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      app,
    );

    assert.ok(instance, 'render callback should receive the root instance');
    assert.ok(instance.id > 0, 'root instance should be a real X11 window');

    // Update pass: resize and retitle through React props.
    await render(
      React.createElement(
        'window',
        { width: 320, height: 240, title: 'integration-updated' },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      app,
    );

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});
