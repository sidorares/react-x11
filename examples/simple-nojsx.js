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
      w: 500
    }
  }

  componentDidMount() {
    setInterval(() => {
      this.setState({w: this.state.w + 1 });
    }, 1000);
  }

  render() {
    return (
      React.createElement('window', {width: this.state.w})
    )
  }
}

ReactX11.render(React.createElement(App));
