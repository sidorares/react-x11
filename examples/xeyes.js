const React = require('react');
const ReactX11 = require('../src/index.js')

let lastMousePos = {
  x: 0,
  y: 0
}

class Eye extends React.Component {
  paint(ev) {
    const win = this.w;
    const at = this.props.lookingAt;
    if (!win) {
      return;
    }
    const pupilX = at.x - win.x - win.width/2;
    const pupilY = at.y - win.y - win.height/2;

    const ctx = win.getContext('2d');
    ctx.fillStyle = this.props.color;
    ctx.fillRect(0, 0, ctx.width, ctx.height);
    const gradient = ctx.createRadialGradient(pupilX, pupilY, 0, win.width/2, win.height/2, win.width/2);
    gradient.addColorStop(0, this.props.color);
    gradient.addColorStop(0.5, this.props.color);
    gradient.addColorStop(0.505, 'white');
    gradient.addColorStop(0.995, 'white');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ctx.width, ctx.height);
  }

  componentDidUpdate() {
    this.paint();
  }
  render() {
    return React.createElement('window', {
      ref: w => this.w = w,
      onExpose: ev=> this.paint(ev),
      x: this.props.x,
      y: this.props.y,
      width: this.props.width,
      height: this.props.height
    })
  }
}

class App extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      lookingAt: {x: 0, y: 0},
      width: 200,
      height: 200
    }
  }

  componentDidMount() {
    // poll mouse
    setInterval(() => {
      connection.rootWindow().queryPointer((err, pointer) => {
        this.setState({
          lookingAt: {
            x: pointer.childX,
            y: pointer.childY
          }
        });
      })
    }, 100);
  }

  render() {
    const trackPointer = ev => {
      this.setState({
        lookingAt: {
          x: ev.rootx,
          y: ev.rooty
        }
      });
    }

    const layoutChildren = ev => {
      this.setState({
        width: ev.width,
        height: ev.height
      })
    }

    return (
      React.createElement('window', {onMouseMove: trackPointer, onResize: layoutChildren, width: 200, height: 200},
        React.createElement(Eye, {color: 'green', lookingAt: this.state.lookingAt, x: 0, y: 0, width: this.state.width / 2, height: this.state.height}),
        React.createElement(Eye, {color: 'blue', lookingAt: this.state.lookingAt, x: this.state.width / 2, y: 0, width: this.state.width / 2, height: this.state.height})
      )
    )
  }
}

ReactX11.render(React.createElement(App), (inst, conn) => {
  connection = conn;
});
