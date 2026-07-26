const React = require('react');
const ReactX11 = require('../src/index.js');

class App extends React.Component {
  render() {
    return (
      <window x={100} y={100} width={100} height={100} title="test">
        <window width={10} height={10} x={1} y={2} title="child" />
      </window>
    );
  }
}

ReactX11.render(React.createElement(App));
