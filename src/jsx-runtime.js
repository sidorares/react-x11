// The automatic JSX runtime, so a project can set
// `"jsxImportSource": "react-x11"` and have JSX type-check against the X11
// elements instead of the DOM's. At runtime this is React's own runtime —
// the elements are host components either way; only the *types* differ, and
// they have to come from somewhere TypeScript will look.
export { Fragment, jsx, jsxs } from 'react/jsx-runtime';
