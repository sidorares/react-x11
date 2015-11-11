//var x11 = require('x11');
//var React = {}
//React.createConnection = function(cb) {
//  x11.createConnection();
//};

var clone = function(obj) {
  return JSON.parse(JSON.stringify(obj));
};

module.exports = {
  createElement: function() {
      //return arguments;

      var component = arguments[0];
      var props     = arguments[1];
      var children  = [];
      var ch;
      for (var i=2; i < arguments.length; ++i) {
        ch = arguments[i];
        if (typeof ch == 'string') {
          children.push(new module.exports.Text({ text: ch }));
        }
        else
          children.push(arguments[i]);
      }
      var c = new component(props, children);
      c.hitTest = function(pt) {
        var res = [];
        if (c.props && c.props.left <= pt.x && c.props.top <= pt.y && c.props.left + c.props.width >= pt.x && c.props.top + c.props.height >= pt.y ) {
          res.push(this);
          if (this.props && this.props.children) {
          for (var i=0; i < this.props.children.length; ++i) {
            var ch = this.props.children[i];
            if (ch && ch.hitTest) {
              var hits = ch.hitTest(pt);
              res = res.concat(hits);
            }
          }

          }
        }
        return res;
      }

      c.setProps = function(newProps) {
        var e = c;
        var needsUpdate = false;
        for (var key in newProps) {
          if (this.props[key] != newProps[key]) {
            this.props[key] = newProps[key];
            needsUpdate = true;
          }
        }
        this._needsUpdate = needsUpdate;
      };
      return c;
  },
  View: function(args, children) {
    if (!args)
      args = {};
    this.props = args;
    this.props.children = children;
    this.props.style = args.style || { color: 0xa0a0a0 };
    this.render = function() {
      return this;
    };
    this.draw = function(ctx) {
      console.log(this.props.style.color);
      //ctx.setForeground(this.props.style.color);
      ctx.fillRect(this.props.left, this.props.top, this.props.width, this.props.height, 0.5, 0.5, 0.5, 1);
      //ctx.setForeground(0);
      //ctx.rectangle(this.props);
      if (this.props.children) {
        this.props.children.forEach(function(c) {
          c.draw(ctx);
        });
      }
    };
  },
  Text: function Text(args) {
    this.fontHeight = 12;
    this.fontWidth = 5;
    this.props = args;
    //var width = ctx.measureText(this.props.text).width;
    var width = this.props.text.length*15;
    this.props.style = { margin: 5, width: width, height: 2*this.fontHeight };
    if (!this.props.text)
      this.props.text = '';
    this.render = function() {
      return this;
    };
    this.draw = function(ctx) {
      //ctx.setForeground(0);
      ctx.fillText(this.props.text, this.props.left, this.props.top + this.fontHeight);
    };
  },

  P: function(args, children) {
    this.props = args || {};
    this.props.style = this.props.style || { flexDirection: 'row', flexWrap: 'wrap' };
    this.props.p = children[0].props.text;
    this.props.children = this.props.p.split(' ').map( function(w) { return new module.exports.createElement(module.exports.Text, { text: w, onMousemove: function() { console.log(this.props.text);} }); });
    this.render = function() {
      return this;
    };
    this.draw = function(ctx) {
      //ctx.setForeground(0xfef0f0); //this.props.style.color);
      console.log('P', this.props);
      //ctx.fillRect(this.props);
      //ctx.rectangle(this.props);
      this.props.children.forEach(function(c) {
        //ctx.setForeground(0);
        //ctx.rectangle(c.props);
        c.draw(ctx);
      });
    };
  }
};
