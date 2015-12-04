var ntk = require('ntk');

function Screen(app) {
  this.app = app;
  this.nodes = [];
}

module.exports = Screen;

Screen.prototype.append = function(n) {
  console.log('Append!');
  this.nodes.push(n);
}

Screen.prototype.render = function() {
  console.log('Screen.render()');

  /*
  console.log(JSON.stringify(this.nodes, null, 4));
  console.log('========================');
  */
}

module.exports.createElement = function(tag, props) {
  return {
    getNode: function(parent) {
      //console.log('getNode called!');
      //console.trace();

      var app = parent.app;
      var obj;
      if (tag == 'window') {
        obj = app.createWindow(props);
        obj.map();
      }

      var n = {
        app: parent.app,
        props: props,
        obj: obj,
        ch: [],
        on: function(eventName, handler) {
          console.log('added handler for ' + eventName);
        },
        off: function(eventName) {
          console.log('remove listener', eventName, arguments);
        },
        destroy: function() {
          console.log('DESTROYING>>>', this);
        },
        append: function(ch) {
          //console.log('Append called!', n);
          n.ch.push(ch);
        },
        removeChild: function(ch) {
          var index = n.ch.indexOf(ch);
          if (index > -1) {
            n.ch.splice(index, 1);
          }
        },
        setContent: function(c) {
          n.content = c;
        },
        setLabel: function(c) {
          n.label = c;
        },
        setProgress: function(c) {
          console.log('Set progress called!', c)
          n.setContent('xxx ' + c);
          n.progress = c;
          console.log(n);
        }
      };
      return n;
    }
  };
}
