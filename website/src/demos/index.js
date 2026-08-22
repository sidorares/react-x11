import counter from './counter.js';
import layout from './layout.js';
import styling from './styling.js';
import sizeQueries from './size-queries.js';
import rtl from './rtl.js';
import widgets from './widgets.js';
import events from './events.js';
import password from './password.js';
import selection from './selection.js';
import tasks from './tasks.js';
import canvas from './canvas.js';
import menu from './menu.js';
import anchored from './anchored.js';

// Ordered list shown in the playground picker. Each entry:
// { id, title, description, code } (+ optional height/screenWidth/screenHeight).
//
// Every one of these is executed against the JS X server in node by
// scripts/check-demos.mjs, which asserts it mounts and paints — so a demo
// that goes stale when the API moves fails the website's test run rather
// than sitting broken on the site.
const demos = [
  counter,
  layout,
  styling,
  sizeQueries,
  rtl,
  widgets,
  events,
  password,
  selection,
  tasks,
  canvas,
  menu,
  anchored,
];

export default demos;
