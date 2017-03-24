const React = require('react');
const ReactX11 = require('../src/index.js')

class App extends React.Component {

  constructor(props) {
    super(props);
    setInterval(() => {
      this.setState({l: 'hello ' + new Date(), w: this.state.w + 1 });
    }, 1000);
  }

  render() {
    return
      React.createElement('window', {width: this.state.w, height: 800, title: this.state.l},
        React.createElement('box', {}, 'test text')
      );
  }
}

ReactX11.AppRegistry('example', () => React.createElement(App) );
