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
      down: false,
      w: 500,
      isOver: 'yes'
    }
  }

  componentDidMount() {
    //setInterval(() => {
    //  this.setState({w: this.state.w + 1 });
    //}, 5000);
  }

  mainWndRef(w) {
    if (!w) {
      //console.log('Detach ref!')
      return
    }
    //console.log('Attach ref!')
    if (this.w === w) {
      //console.log('already saved')
      return;
    }
    this.w = w;
    const ctx = w.getContext('2d')
    w.on('mousemove', ev => {
      ctx.fillStyle = 'black';
      ctx.fillRect(ev.x - 1, ev.y - 1, 2, 2);
    })
  }

  innerWndRef(w) {
    if (!w) {
      //console.log('Detach ref!')
      return
    }
    //console.log('Attach ref!')
    if (this.ww === w) {
      //console.log('already saved')
      return;
    }
    this.ww = w;
    const ctx = w.getContext('2d')
    w.on('mousemove', ev => {
      ctx.fillStyle = 'red';
      ctx.fillRect(ev.x - 1, ev.y - 1, 2, 2);
    })
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
      React.createElement('window', {name: 'topWindow', ref: (w) => { this.mainWndRef(w) }, onMouseOut: () => this.setState({down: false}), onMouseOver: () => this.setState({down: true}), width: this.state.w, height: 500, title: `test ${this.state.isOver}`, onResize: ev=> this.setState({isOver: `${ev.x} ${ev.y} ${ev.width} ${ev.height}`})},
        !!this.state.down && React.createElement('window', {title: 'child', name: 'childWindow', ref: (w) => { this.innerWndRef(w) }, width: 200, height: 200, x: 50, y: 150, onMouseOver: () => this.setState({isOver: 'yes'}), onMouseOut: () => this.setState({isOver: 'no'}) }
          //,React.createElement('window', {key: 1, title: 'child child1', name: 'childChildWindow1', width: 20, height: 20, x: 5, y: 15}),
          //React.createElement('window', {key: 2, title: 'child child2', name: 'childChildWindow2', width: 20, height: 20, x: 15, y: 15},
          //  React.createElement('div', {ref: (e) => { console.log('divele!!!!', e) }, title: 'child child child2'})
          //
        )
      )
    )
  }
}

ReactX11.render(React.createElement(App));
