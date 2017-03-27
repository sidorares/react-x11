const defineProperty = Object.defineProperty;
defineProperty(global, 'WebSocket', {
  value: require('ws')
});

global.window = global;
defineProperty(global, 'window', {
  value: global
});

const {connectToDevTools} = require('react-devtools-core');
connectToDevTools({
  isAppActive() {
  // Don't steal the DevTools from currently active app.
  return true;
  },
  host: 'localhost',
  // default port? port: ,
  resolveRNStyle: null, // TODO maybe: require('flattenStyle')
});

const React = require('react');
const ReactX11 = require('../src/Reconciler.js')
class App extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      w: 500,
      isOver: 'yes'
    }
  }

  componentDidMount() {
    setInterval(() => {
      this.setState({w: this.state.w + 1 });
    }, 5000);
  }

  doRef() {
    debugger
  }

  render() {

    const grad = (e) => {
      var ctx = e.window.getContext('2d');
      var gradient = ctx.createRadialGradient(0, 0, 0, e.x, e.y, 500);
      gradient.addColorStop(0, "red");
      gradient.addColorStop(0.5, "green");
      gradient.addColorStop(1, "rgb(255, 255, 255)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, ctx.width, ctx.height);
    }

    return (
      React.createElement('window', {width: this.state.w, height: 500, title: `test ${this.state.isOver}`, onMouseDown: (ev) => { console.log('!!!!! down')}, onMouseUp: (ev) => { console.log('!!!!! up')} },
        React.createElement('window', {ref: (qqq) => { this.doRef(qqq) }, width: 200, height: 200, x: 50, y: 150, onMouseOver: () => this.setState({isOver: 'yes'}), onMouseOut: () => this.setState({isOver: 'no'}), onMouseMove: grad })
      )
    )
  }
}

ReactX11.render(React.createElement(App));
