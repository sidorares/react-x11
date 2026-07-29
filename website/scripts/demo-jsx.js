// JSX for the playground editor. Demo code is real JSX — the whole point of
// react-x11 — so the runner has to compile it before evaluating it. sucrase
// does exactly one pass (JSX → calls, ESM → CJS) and is small enough to ship.
//
// The **classic** runtime is deliberate: it compiles <box/> to
// React.createElement(...), so the compiled code needs nothing but the
// `React` binding the runner already provides. The automatic runtime would
// emit an import of 'react-x11/jsx-runtime', which a `new Function` body
// cannot have — that entry point is for type checking in a real project
// (see docs/typescript.md), not for a script evaluated in place.
import { transform } from 'sucrase';

export function transformJsx(code) {
  return transform(code, {
    transforms: ['jsx', 'imports'],
    jsxRuntime: 'classic',
    jsxPragma: 'React.createElement',
    jsxFragmentPragma: 'React.Fragment',
    // `imports` compiles `import x from 'y'` to require('y'); interop off
    // keeps the output readable in stack traces.
    enableLegacyBabel5ModuleInterop: false,
    // Drops the __self / __source props sucrase otherwise attaches to every
    // element. React treats __self as the signature of a pre-17 toolchain
    // and warns "outdated JSX transform" once per page; the metadata only
    // feeds click-to-component, which needs an editor to open and is not
    // part of this bundle.
    production: true,
    filePath: 'playground.jsx',
  }).code;
}
