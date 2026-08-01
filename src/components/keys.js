// X11 keysyms used by the widget keyboard handlers.
//
// The names live in `src/keysyms.js`, published as `react-x11/keysyms`, so
// app code, the widgets and `fireEvent.key` in `react-x11/test` all name a
// key the same way. This module stays as the widgets' import path.

export {
  XK_RETURN,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_UP,
  XK_RIGHT,
  XK_DOWN,
  XK_PAGE_UP,
  XK_PAGE_DOWN,
  XK_END,
} from '../keysyms.js';
