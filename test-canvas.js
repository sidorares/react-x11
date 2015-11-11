require('node-jsx').install();

var ntk = require('ntk');

ntk.createClient(main);

var computeLayout = require('css-layout');
var React    = require('./react-x11');
var ComboBox = require('./combobox.jsx');

var clone = function(obj) {
  return JSON.parse(JSON.stringify(obj));
};

function unprops(node) {
  var props = clone(node.props);
  delete props.children;
  if (node.props.children)
    props.children = node.props.children.map(unprops);

  //console.log('UNPROPS:', props);
  return props;
}

function reflow(node, width, height) {
  var window = { style: { width: width, height: height, justifyContent: 'stretch', alignItems: 'stretch' }, children: [ unprops(node) ] };
  window.children[0].style.width = width;
  window.children[0].style.height = height;
  var layout = computeLayout(window);
  //console.log(layout);
  function applyLayout(node, layout, left, top) {

    //console.log(left, top, node);
    //console.log(JSON.stringify(layout, null, 2));
    //debugger

    node.props.width  = layout.width;
    node.props.height = layout.height;
    node.props.left   = layout.left + left;
    node.props.top  = layout.top + top;

    if (node.props.children)
    for (var i=0; i < node.props.children.length; ++i) {
      applyLayout(node.props.children[i], layout.children[i], layout.left + left, layout.top + top);
    }
  }
  applyLayout({ props: { children: [node] } }, layout, 0, 0);
}

function main(err, app) {
  var pix = app.createPixmap({ depth: 24, width: 1000, height: 1000 });
  var mainwnd = app.createWindow({title: "Layout demo", pixmap: pix}).map();
  var rootEle = React.createElement(ComboBox, { foo: 'blah blah' });

  var ctx  = pix.getContext('2d');
  var ctxWin  = mainwnd.getContext('2d');
  var black   = ctx.createSolidPicture(0, 0, 0, 1);
  ctx.setBackground(black);
  ctx.font = '8mm CourierNew';

  var rootNode;
  var prevW = 0;
  var prevH = 0;
  mainwnd.on('resize', function(ev) {
  if ( (ev.width != prevW) || (ev.height != prevH) ) {
      console.log([prevW, ev.width, prevH, ev.height]);
      rootNode = rootEle.render();
      reflow(rootNode, ev.width, ev.height);
      rootNode.draw(ctx);
      // TODO
      ctxWin.draw(ctx);
      prevW = ev.width;
      prevH = ev.height;
    }
  }).on('expose', function(ev) {
    ctxWin.draw(ctx);
  }).on('mousedown', function(ev) {
    if (!rootNode) return;
    // 1 build list of matching views
    // 2 check for handlers up
    var hits = rootNode.hitTest(ev);
    for (var i=1; i <= hits.length; i++) {
      var component = hits[hits.length - i];
      if (component.props.onClick) {
        component.props.onClick.call(component, ev);
      }
    }
  }).on('mousemove', function(ev) {
    if (!rootNode) return;
    var hits = rootNode.hitTest(ev);
    for (var i=1; i <= hits.length; i++) {
      var component = hits[hits.length - i];
      if (component.props.onMousemove) {
        component.props.onMousemove.call(component, ev);
      }
    }
  });
}
