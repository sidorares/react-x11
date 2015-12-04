var render        = require('./render.js');
var RootComponent = require('./root_component.js');

var s1 = new Date();
module.exports.AppRegistry = function(key, handler) {
  // each app is launched with it's own X11 connection
  // in the future one connection might be reused
  // but at the moment: X11 connection (aka display) <-> ntk app <-> AppRegistry item
  var ntk = require('ntk');
  ntk.createClient(function(err, app) {
    app.appRegistryKey = key;
    var component = handler();
    var s2 = new Date();
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! Creating react-x11 app', s2 - s1);
    render(component, new RootComponent(app));
  });
};
