if (process.env.NODE_ENV !== 'production') {
  const defineProperty = Object.defineProperty;
  defineProperty(global, 'WebSocket', {
    value: require('ws')
  });

  global.window = global;
  defineProperty(global, 'window', {
    value: global
  });

  const { connectToDevTools } = require('react-devtools-core');
  connectToDevTools({
    isAppActive() {
      return true;
    },
    host: 'localhost'
  });

  const highlight = function(n) {
    // TODO: add code to highlight components
    // probably allow component to provide hook to highlight itself
    // and only as a fallback draw rectangle overlay on top
    //console.log('highlight!!!');

    debugger;

    const ctx = n.getContext('2d');
    ctx.beginPath();
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 3;
    ctx.fillRect(0, 0, n.window, n.height);
    ctx.stroke();
  };

  const hideHighlight = function(n) {
    // TODO: add code to hide highlight
    //console.log('hide highlight!!!');
    const ctx = n.getContext('2d');
    ctx.beginPath();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.fillRect(0, 0, n.width, n.height);
    ctx.stroke();
  };

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__.on('react-devtools', agent => {
    //agent.on('highlight', data => hl.highlight(data.node, data.name));
    higlightedNodes = [];
    agent.on('highlight', data => {
      // TODO try to implement 'highlighted' state via change in '__hilighted' prop?
      const firstInternalKey = Object.keys(agent.reactInternals)[0];
      const internals = agent.reactInternals[firstInternalKey];
      if (internals) {
        // TODO this will only work if injectInternals/findFiberByHostInstance
        // is implemented in ./Reconsiler.js
        const ele = internals.getReactElementFromNative(data.node);
        console.log(ele);
        debugger;
      }
      highlight(data.node, data.name);
      higlightedNodes.push(data.node);
    });
    agent.on('hideHighlight', () => {
      higlightedNodes.forEach(n => {
        hideHighlight(n);
      });
      higlightedNodes = [];
    });
  });
}
