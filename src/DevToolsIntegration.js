// Opt-in React DevTools bridge. Enabled by setting REACT_X11_DEVTOOLS=1 in the
// environment; requires the `react-devtools-core` and `ws` packages (dev
// dependencies of this repo, not shipped with the library).
let connected = false;

function connect(renderer) {
  if (connected) {
    return;
  }
  connected = true;

  let connectToDevTools;
  try {
    global.WebSocket = global.WebSocket || require('ws');
    ({ connectToDevTools } = require('react-devtools-core'));
  } catch (err) {
    console.warn(
      'react-x11: REACT_X11_DEVTOOLS is set but devtools could not be loaded. ' +
        'Install react-devtools-core and ws. Original error: ' +
        err.message,
    );
    return;
  }

  connectToDevTools({
    isAppActive: () => true,
    host: process.env.REACT_X11_DEVTOOLS_HOST || 'localhost',
  });

  renderer.injectIntoDevTools({
    bundleType: 1,
    version: require('../package.json').version,
    rendererPackageName: 'react-x11',
    findFiberByHostInstance: (instance) => instance._reactFiber,
  });
}

module.exports = { connect };
