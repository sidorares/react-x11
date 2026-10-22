#!/usr/bin/env node
// `npm create react-x11 <dir>` — the same command as `react-x11 create <dir>`.
// This package is the alias npm's `create` convention needs, published at
// react-x11's version and pinned to it by .github/workflows/release-please.yml,
// which stamps the version and the dependency below at publish time. A bin
// has to be a file of its own package, so it is this one line rather than
// none.
import { runCreate } from 'react-x11/create';

process.exitCode = runCreate(process.argv.slice(2), {
  command: 'create-react-x11',
});
