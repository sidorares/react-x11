// Hot module for the refresh e2e test. The test rewrites the VERSION
// constant below and asserts the same useState id turns up with the new
// version — hook state survived, code did not.
import React from 'react';

const VERSION = 'v1';

export default function App() {
  const [id] = React.useState(() => Math.random().toString(36).slice(2, 10));
  React.useEffect(() => {
    console.log(`RENDER ${id} ${VERSION}`);
  });
  return <box style={{ width: 60, height: 24, backgroundColor: '#3498db' }} />;
}
