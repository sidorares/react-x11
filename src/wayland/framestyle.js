// What the desktop says a window frame looks like and does — the part of it
// a client-side frame needs: which buttons go where, the title's font, and
// what a click on the titlebar means.
//
// GTK reads these from GSettings; anything else reads the same keys through
// the settings portal, which serves the `org.gnome.desktop.*` schemas beside
// the four standard appearance values (src/appearance.js reads those, and
// the frame takes its light or dark from there). The keys, with GNOME's
// defaults:
//
//   org.gnome.desktop.wm.preferences
//     button-layout                  'appmenu:close'     left:right, comma lists
//     action-double-click-titlebar   'toggle-maximize'
//     action-middle-click-titlebar   'none'
//     action-right-click-titlebar    'menu'
//   org.gnome.desktop.interface
//     font-name                      'Adwaita Sans 11'   a Pango description
//     text-scaling-factor            1.0
//
// The title is drawn in the *interface* font, bold, because that is what a
// libadwaita headerbar does: measured against one on a desktop whose
// `font-name` is 'Sans 23', its title's cap height is a 23pt DejaVu Sans
// Bold's. `titlebar-font` is for frames the window manager draws (Xwayland
// windows); a client frame that used it would not match the GTK apps beside
// it.
//
// Where there is no portal — another desktop, a test — the defaults stand.
// They are GNOME's, so a frame drawn to them is the frame GTK would draw.

import { EventEmitter } from 'node:events';
import { sessionBus } from '../bus.js';
import { desktopIntegrationEnabled } from '../desktopintegration.js';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SETTINGS_IFACE = 'org.freedesktop.portal.Settings';
const WM = 'org.gnome.desktop.wm.preferences';
const IFACE = 'org.gnome.desktop.interface';
const NAMESPACES = [WM, IFACE];

export const DEFAULTS = Object.freeze({
  buttonLayout: 'appmenu:close',
  fontName: 'Adwaita Sans 11',
  textScaling: 1,
  doubleClick: 'toggle-maximize',
  middleClick: 'none',
  rightClick: 'menu',
});

/** The buttons a client frame can draw; `appmenu`, `icon`, `spacer` have
 * nothing to show here and are dropped. */
const BUTTONS = new Set(['close', 'minimize', 'maximize']);

/**
 * `'icon,menu:minimize,maximize,close'` → `{ left: [], right: ['minimize',
 * 'maximize', 'close'] }`. A layout with no colon is all on the left, as in
 * GTK; a button named twice is drawn once, where it first appears.
 */
export function parseButtonLayout(value) {
  const [left = '', right = ''] = String(value ?? '').split(':');
  const seen = new Set();
  const side = (list) =>
    list
      .split(',')
      .map((b) => b.trim())
      .filter((b) => {
        if (!BUTTONS.has(b) || seen.has(b)) return false;
        seen.add(b);
        return true;
      });
  return { left: side(left), right: side(right) };
}

const WEIGHTS = {
  thin: 100,
  ultralight: 200,
  'ultra-light': 200,
  extralight: 200,
  'extra-light': 200,
  light: 300,
  semilight: 350,
  'semi-light': 350,
  book: 380,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  'semi-bold': 600,
  demibold: 600,
  'demi-bold': 600,
  bold: 700,
  ultrabold: 800,
  'ultra-bold': 800,
  extrabold: 800,
  'extra-bold': 800,
  heavy: 900,
  black: 900,
};
const STYLE_WORDS = new Set([
  'italic',
  'oblique',
  'roman',
  'small-caps',
  'condensed',
  'semi-condensed',
  'extra-condensed',
  'ultra-condensed',
  'expanded',
  'semi-expanded',
  'extra-expanded',
  'ultra-expanded',
]);

/**
 * A Pango font description — `"Adwaita Sans Bold 11"`, `"Sans 23"`,
 * `"DejaVu Sans Condensed Italic 12px"` — as `{ family, size, unit, weight,
 * italic }`. Style words are read off the end until one is not a style
 * word; what remains is the family (the first of a comma list).
 */
export function parseFontName(value) {
  const words = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let size = null;
  let unit = 'pt';
  const last = words.at(-1);
  if (last && /^\d+(\.\d+)?(px)?$/i.test(last)) {
    if (/px$/i.test(last)) unit = 'px';
    size = parseFloat(last);
    words.pop();
  }
  let weight = 400;
  let italic = false;
  while (words.length > 1) {
    const w = words.at(-1).toLowerCase();
    if (Object.hasOwn(WEIGHTS, w)) weight = WEIGHTS[w];
    else if (STYLE_WORDS.has(w)) {
      if (w === 'italic' || w === 'oblique') italic = true;
    } else break;
    words.pop();
  }
  const family = words.join(' ').split(',')[0].trim() || 'sans-serif';
  return { family, size: size ?? 11, unit, weight, italic };
}

/** The title's font: the interface font, bold, at 96dpi times the scaling
 * factor — in logical pixels. */
export function titleFont(style = DEFAULTS) {
  const f = parseFontName(style.fontName);
  const scaling = Number(style.textScaling) > 0 ? Number(style.textScaling) : 1;
  const px = (f.unit === 'px' ? f.size : (f.size * 96) / 72) * scaling;
  return { family: f.family, size: px, weight: 700 };
}

/** The two namespaces `ReadAll` answered, as a frame style. */
export function fromPortal(all) {
  const wm = all?.[WM] ?? {};
  const iface = all?.[IFACE] ?? {};
  const str = (v, d) => (typeof v === 'string' && v ? v : d);
  const num = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  return Object.freeze({
    buttonLayout: str(wm['button-layout'], DEFAULTS.buttonLayout),
    fontName: str(iface['font-name'], DEFAULTS.fontName),
    textScaling: num(iface['text-scaling-factor'], DEFAULTS.textScaling),
    doubleClick: str(wm['action-double-click-titlebar'], DEFAULTS.doubleClick),
    middleClick: str(wm['action-middle-click-titlebar'], DEFAULTS.middleClick),
    rightClick: str(wm['action-right-click-titlebar'], DEFAULTS.rightClick),
  });
}

/**
 * The desktop's frame style, followed: `value` is always usable (the
 * defaults until the portal answers), and 'change' fires when it moves.
 */
export class FrameStyle extends EventEmitter {
  constructor() {
    super();
    this.value = DEFAULTS;
    /** 'portal' once the portal answered; 'defaults' until then, or for good */
    this.source = 'defaults';
    this._stop = null;
  }

  /**
   * Read once and subscribe. Never throws: no portal means the defaults.
   * The order is appearance.js's, for its reasons — the match rule and the
   * handler go on before the read, so a change landing mid-read is caught,
   * and reads are sequenced so an older answer never overwrites a newer one.
   * The bus ref is released at the end: the subscription outlives it, and
   * holding it would keep the process alive for as long as the frame cared
   * what the desktop said.
   */
  async start() {
    if (!desktopIntegrationEnabled()) return this;
    let ref = null;
    try {
      ref = await sessionBus();
    } catch {
      return this;
    }
    if (!ref) return this;
    let sub = null;
    try {
      sub = await ref.bus.watch(
        `type='signal',sender='${PORTAL_NAME}',` +
          `interface='${SETTINGS_IFACE}',member='SettingChanged'`,
      );
      let started = 0;
      let published = 0;
      const bus = ref.bus;
      const refresh = async () => {
        const mine = ++started;
        const all = await bus.invoke(
          {
            destination: PORTAL_NAME,
            path: PORTAL_PATH,
            interface: SETTINGS_IFACE,
            member: 'ReadAll',
            signature: 'as',
            body: [NAMESPACES],
          },
          { timeout: 5_000 },
        );
        if (!all || mine <= published) return;
        published = mine;
        this.value = fromPortal(all);
        this.source = 'portal';
        this.emit('change', this.value);
      };
      const key = bus.mangle(PORTAL_PATH, SETTINGS_IFACE, 'SettingChanged');
      const onSignal = ([namespace]) => {
        if (!NAMESPACES.includes(namespace)) return;
        refresh().catch(() => {
          // the portal went away mid-session; the last answer stands
        });
      };
      bus.signals.on(key, onSignal);
      const subscription = sub;
      this._stop = () => {
        bus.signals.off?.(key, onSignal);
        subscription?.remove().catch(() => {});
      };
      await refresh();
    } catch {
      await sub?.remove().catch(() => {});
    } finally {
      await ref.release();
    }
    return this;
  }

  stop() {
    this._stop?.();
    this._stop = null;
  }
}
