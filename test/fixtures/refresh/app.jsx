// Hot module for the refresh e2e test. The test rewrites the VERSION
// constant below and asserts the same useState id turns up with the new
// version — hook state survived, code did not.
//
// The module also registers a host element at module scope — the pattern
// tree-shaking forces on component libraries — so a reload exercises the
// re-registration policy (#318): the second evaluation registers a new
// create() under the same name and must replace silently, not throw.
// Namespace imports, because inside a hot module only default/namespace
// bindings initialize synchronously.
import React from 'react';
import * as Host from '../../../src/host.js';
import * as XNode from '../../../src/node.js';

const VERSION = 'v1';

class BadgeNode extends XNode.Node {
  constructor(props, app) {
    super('badge', props, app);
  }
}

Host.registerElement('badge', {
  create: (props, app) => new BadgeNode(props, app),
});

export default function App() {
  const [id] = React.useState(() => Math.random().toString(36).slice(2, 10));
  React.useEffect(() => {
    console.log(`RENDER ${id} ${VERSION}`);
  });
  return (
    <box style={{ width: 60, height: 24, backgroundColor: '#3498db' }}>
      <badge style={{ width: 10, height: 10 }} />
    </box>
  );
}
