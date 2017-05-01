# react-x11

[![Greenkeeper badge](https://badges.greenkeeper.io/sidorares/react-x11.svg)](https://greenkeeper.io/)

React custom rendering where side effects are communication with [X11 server](https://www.x.org/wiki/Documentation/). The goal is to create a simple library where you would apply your React or React Native like experience to build small GUI programs to run in X Window environment (usually linux desktop, but I personally more often code under osx + [XQuattz](https://www.xquartz.org/))

This library is mostly written in javascript all way down, no special bridging code in different language required. For communication with X server [node-x11](https://github.com/sidorares/node-x11) library is used, which is pure JS implementation of X11 protocol (think of it as xlib rewritten in javascript/node.js)

![react-devtools-x11](https://cloud.githubusercontent.com/assets/173025/24536323/6af97598-1625-11e7-88d4-74f429b7f470.gif)

Currently only `window` component is available, in the future we'll add windowless controls support, simple controls library and [yoga-layout](https://www.npmjs.com/package/yoga-layout) powered layout management


```js
const React = require('react');
const ReactX11 = require('react-x11')
class App extends React.Component {

  handleRef (win) {
    // win is https://github.com/sidorares/ntk/blob/master/lib/window.js instance
    win.on('expose', ev => {
      ctx.fillStyle = 'black';
      ctx.fillText('Hello', ev.x, ev.y);
    })
  }

  render() {

    const paintRadialGradient = e => {
      const ctx = e.window.getContext('2d');
      const gradient = ctx.createRadialGradient(0, 0, 0, e.x, e.y, 500);
      gradient.addColorStop(0, "green");
      gradient.addColorStop(0.5, "green");
      gradient.addColorStop(1, "rgb(255, 255, 255)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, ctx.width, ctx.height);
    }

    return (
      <window ref={this.handleRef} onMouseDown={ev => console.log('hello')}>
        <window onMouseMove={paintRadialGradient} />
      </window>
    )
  }
}

ReactX11.render(React.createElement(App));
```
