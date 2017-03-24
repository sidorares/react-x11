const ReactX11 = require('./Reconciler.js');

module.exports.render = ReactX11.render;

module.exports.AppRegistry = (key, handler) => {
  // each app is launched with it's own X11 connection
  // in the future one connection might be reused
  // but at the moment: X11 connection (aka display) <-> ntk app <-> AppRegistry item
  const ntk = require('ntk');
  ntk.createClient((err, app) => {
    app.appRegistryKey = key;
    const element = handler();
    app.inspect = () => {
      return '<X11 connection />'
    }
    ReactX11.render(element, app, () => { console.log('AAAAA', arguments)});
  });
};
