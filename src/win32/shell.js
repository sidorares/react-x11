// The shell integrations, as the seams react-x11's ladders look for.
//
// Each one is found by capability rather than by platform — `app.createStatusItem`,
// `app.setDockBadge`, `app.filePanels` — which is the rule in AGENTS.md and
// what lets the same hook answer from a portal on Linux, from AppKit on a Mac
// and from Shell_NotifyIcon here.
//
// Everything below is asynchronous because the bridge is: a tray icon, a
// taskbar button and a file dialog all live on the UI thread, where their
// modal loops belong.

/** A tray icon. `useTray()` drives this shape through `app.createStatusItem`. */
export class Win32StatusItem {
  constructor(app, options = {}) {
    this.app = app;
    this._native = app._native;
    this._listeners = { click: new Set(), action: new Set() };
    this._menu = [];
    this.handle = this._native.trayCreate({
      tooltip: options.tooltip ?? options.title ?? '',
      ...iconOf(options),
    });
    app._statusItems.set(this.handle, this);
    if (options.menu) this.setMenu(options.menu);
  }

  update(options = {}) {
    if (options.tooltip !== undefined || options.title !== undefined) {
      this._native.trayUpdate(this.handle, {
        tooltip: options.tooltip ?? options.title ?? '',
      });
    }
    if (options.menu) this.setMenu(options.menu);
  }

  /**
   * The menu behind a right-click. Flattened to `{ label, action }` because
   * the bridge holds no item model: a separator is a label of `-`, and the
   * action is the string that comes back, which keeps the menu the app wrote
   * the menu that answers.
   */
  setMenu(items) {
    this._menu = items ?? [];
    this._native.trayMenu(
      this.handle,
      this._menu.map((item, at) => ({
        label:
          item.separator || item.type === 'separator'
            ? '-'
            : (item.label ?? ''),
        action: String(item.id ?? item.action ?? at),
      })),
    );
  }

  on(name, fn) {
    this._listeners[name]?.add(fn);
    return () => this._listeners[name]?.delete(fn);
  }

  _emit(name, value) {
    for (const fn of [...(this._listeners[name] ?? [])]) {
      try {
        fn(value);
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') console.error(err);
      }
    }
  }

  /** The item the action belongs to, found by the id `setMenu` handed over. */
  /**
   * A menu item was chosen. `action` is the string this item was registered
   * under — the bridge holds no item model, so the menu the app wrote is
   * found again here by that string.
   *
   * `onSelect`, given the item, is the contract every backend keeps
   * (src/cocoa/statusitem.js, src/cocoa/dock.js). This used to call
   * `onClick()` with no argument, which is a different callback — the one
   * for a click on the *icon* — so every menu command did nothing at all.
   */
  _activate(action) {
    const item = this._menu.find(
      (entry, at) => String(entry.id ?? entry.action ?? at) === action,
    );
    item?.onSelect?.(item);
    this._emit('action', item ?? action);
  }

  remove() {
    this.app._statusItems.delete(this.handle);
    this._native.trayRemove(this.handle);
  }
}

/** An `{ icon, iconWidth, iconHeight }` triple from whatever the caller gave. */
function iconOf(options) {
  const icon = options.icon ?? options.image;
  if (icon && icon.data && icon.width && icon.height) {
    return {
      icon: Buffer.from(icon.data.buffer ?? icon.data),
      iconWidth: icon.width,
      iconHeight: icon.height,
    };
  }
  // A string icon is a name on the freedesktop rung and an SF Symbol on the
  // Cocoa one. Windows has no icon theme to look a name up in, so it is
  // ignored rather than guessed at, and the app's own icon is used.
  return {};
}

/**
 * The native open/save panels — `app.filePanels`, whose *presence* is what
 * puts the top rung on src/filedialog.js's ladder.
 */
export class Win32FilePanels {
  constructor(app) {
    this.app = app;
    this._native = app._native;
    this._pending = new Map();
  }

  /**
   * `show(kind, opts, wnd)` — the contract src/filedialog.js calls. Resolves
   * with the chosen paths, or with an empty list when the user cancelled,
   * which is not an error and must not be one.
   */
  show(kind, opts = {}, wnd = null) {
    const request = this._native.fileDialog({
      kind: kind === 'save' ? 'save' : 'open',
      title: opts.title,
      buttonLabel: opts.buttonLabel ?? opts.prompt,
      defaultPath: opts.defaultPath ?? opts.directory,
      defaultName: opts.defaultName ?? opts.nameFieldStringValue,
      multiple: Boolean(opts.multiple ?? opts.allowsMultipleSelection),
      directory: Boolean(opts.chooseDirectories ?? opts.canChooseDirectories),
      filters: (opts.filters ?? []).map((filter) => ({
        name: filter.name ?? 'Files',
        extensions: filter.extensions ?? [],
      })),
      ownerHwnd: wnd ? this._native.windowHandle(wnd.id) : 0,
    });
    return new Promise((resolve) => this._pending.set(request, resolve));
  }

  _answer(request, chose, text) {
    const resolve = this._pending.get(request);
    if (!resolve) return;
    this._pending.delete(request);
    resolve({
      canceled: !chose,
      filePaths: chose && text ? text.split('\n') : [],
    });
  }
}

/**
 * The taskbar button: Windows' answer to the Dock tile.
 *
 * Windows has **no count badge**. `ITaskbarList3::SetOverlayIcon` takes a
 * 16x16 icon, so a number has to be drawn into one — which the renderer can
 * do and this cannot, having no text engine of its own down here. Until that
 * is wired, a badge request sets the flashing state and says so, which is
 * more honest than silently doing nothing.
 */
/**
 * The count drawn into a taskbar overlay icon.
 *
 * `ITaskbarList3::SetOverlayIcon` takes an icon and nothing else: there is no
 * badge API on Windows that draws a number for you, the way the Dock has one.
 * So the number is drawn here, through the same Direct2D verbs everything else
 * draws through, and handed over as pixels.
 *
 * 32×32 because that is the size the shell asks for at every scale it renders
 * the taskbar at, and a smaller icon is scaled up rather than re-rendered.
 * Long labels are clamped to `99+`, which is what every other badge on every
 * other desktop does with them — a taskbar overlay is ~16 device pixels on a
 * 100% display and three glyphs is already generous.
 */
async function badgePixels(app, label, accent) {
  const SIZE = 32;
  const text = String(label);
  const shown = text.length > 3 ? '99+' : text;
  let surface = null;
  try {
    surface = app.createSurface({ width: SIZE, height: SIZE, format: 'argb32' });
    const ctx = surface.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    // Sized to the label: three glyphs in a 32px circle need the smaller face.
    const size = shown.length > 2 ? 15 : 19;
    ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
    // Centred by hand. This context takes `fillText(text, x, baselineY)` and
    // has no `textAlign`/`textBaseline` — it is the verb table's shape, not
    // the canvas API's, and measuring is the part that was never optional.
    const width = ctx.measureText(shown).width;
    ctx.fillText(shown, (SIZE - width) / 2, SIZE / 2 + size * 0.36);
    // A promise: this context's `getImageData` is the asynchronous form, a
    // read being a round trip on the backend it was written for. Here it
    // resolves on a microtask, and it is what makes the badge land a tick
    // after it was asked for rather than in the same call.
    const image = await ctx.getImageData(0, 0, SIZE, SIZE);
    return {
      pixels: Buffer.from(
        image.data.buffer,
        image.data.byteOffset,
        image.data.length,
      ),
      size: SIZE,
    };
  } catch {
    // A badge that could not be drawn is not worth an error path: the caller
    // asked to decorate an icon, and the icon is still there.
    return null;
  } finally {
    surface?.destroy?.();
  }
}

/**
 * Notifications, as a balloon on a tray icon.
 *
 * Shaped like the Cocoa backend's notification centre — `kind`, `available()`,
 * `post()` — because src/notifications.js asks the backend for one and does
 * not care which platform answered. `kind` is what makes the rung report
 * itself honestly in `notificationBackend()`.
 *
 * What this rung cannot do, and says so by not implementing it: actions,
 * replacing a notification in place, and an icon of the app's own. Those want
 * the Windows App SDK's notification manager and an AppUserModelID the system
 * knows — docs/windows.md §"The desktop around the app". Until then the
 * balloon is shown by the shell in the same place, with the same sound, and
 * kept in the same action centre.
 */
export function installNotifications(app) {
  app.notifications = {
    kind: 'win32',
    // Always: Shell_NotifyIcon is in every Windows session, and a user who
    // has turned notifications off has turned off the display of it rather
    // than the call. There is no ask-first here the way there is on macOS.
    available: async () => true,
    post: async (options) => {
      // The app's own tray icon if it has one, so the balloon points at
      // something the user recognises instead of at a second icon.
      const tray = app._statusItems?.values?.().next?.().value ?? null;
      const ok = app._native.trayNotify(tray?.handle ?? 0, {
        title: options.summary ?? '',
        body: options.body ?? '',
        urgency: options.urgency ?? 'normal',
      });
      if (!ok) return null;
      // The handle src/notifications.js hands back. `close` and `update` are
      // the two a caller may reach for; both are no-ops rather than missing,
      // because a balloon is gone when the shell says so and there is nothing
      // to close or replace.
      return {
        backend: 'win32',
        id: 0,
        close: async () => {},
        update: async () => false,
        closed: Promise.resolve('expired'),
      };
    },
  };
}

/**
 * Two things the desktop knows and this process does not: whether anybody is
 * at the keyboard, and whether the screen may go dark.
 *
 * Both are session-wide on Windows and neither needs a window, so they are on
 * the app rather than on a window — the same shape `src/idle.js` reaches for.
 */
export function installIdle(app) {
  app.lastInputMs = () => app._native.lastInputMs();
  // Counted, because two callers can want the screen awake at once and the
  // first to finish must not speak for the second — a video player and a
  // long upload in the same app is the ordinary case, not the exotic one.
  // ES_CONTINUOUS is a thread state rather than a counted resource, so the
  // count is kept here and the state is set once and cleared once.
  let held = 0;
  app.keepAwake = (display = true) => {
    if (held === 0) app._native.keepAwake(display);
    held += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held -= 1;
      if (held === 0) app._native.keepAwake(null);
    };
  };
}

/**
 * The three surfaces the Windows taskbar has that no other desktop does.
 *
 * They are installed as methods on the app, and that *is* the capability:
 * `useSupports('thumbnailToolbar')` asks whether this method exists, so a
 * component branches on whether the backend has the feature rather than on
 * which platform it is running on, and every other backend reports false
 * without knowing anything about Windows.
 *
 * None of them is a rung on an existing ladder, deliberately. A jump list is
 * not a Dock menu — `useDockMenu`'s items carry a callback and a jump-list
 * task starts a *new process* with arguments, so mapping one to the other
 * would quietly change what a click does. Until a second launch can hand its
 * arguments to the first (docs/windows-integrations.md) they are different
 * features and are named differently.
 */
export function installTaskbarSurfaces(app) {
  /**
   * Up to seven buttons under the taskbar's hover preview.
   *
   * The ids the shell sends back are indices, so the labels are kept here and
   * the click is reported with the button's own `id` — what the caller named
   * it, not where it happened to sit.
   */
  app._thumbButtons = new Map(); // window id -> [caller ids]
  app.thumbnailToolbar = (windowId, buttons) => {
    const list = (buttons ?? []).slice(0, 7);
    app._thumbButtons.set(
      windowId,
      list.map((button) => button.id ?? null),
    );
    app._native.thumbnailToolbar(
      windowId,
      list.map((button) => ({
        tooltip: button.tooltip ?? button.label ?? '',
        enabled: button.enabled !== false,
        dismissOnClick: button.dismissOnClick === true,
        ...iconOf(button),
      })),
    );
  };

  /**
   * The Tasks category of this application's jump list, shown on a right
   * click of its taskbar button. `null` takes it away.
   */
  app.jumpList = (tasks) => {
    app._native.jumpList(
      (tasks ?? []).map((task) => ({
        title: String(task.title ?? ''),
        arguments: String(task.arguments ?? ''),
        description: String(task.description ?? ''),
      })),
    );
  };

  /**
   * A document this app just opened, for the shell's Recent lists — the jump
   * list's own, and Explorer's quick access. `null` clears the list.
   *
   * The same act as `NSDocumentController.noteNewRecentDocumentURL:`, and the
   * reason it is here rather than in a cross-platform hook is that only this
   * backend has one to call today.
   */
  app.noteRecentDocument = (path) => {
    app._native.recentDocument(path == null ? null : String(path));
  };
}

export function installTaskbar(app) {
  const handleOf = () => {
    const [first] = [...app._windows.values()];
    return first ? app._native.windowHandle(first.id) : 0;
  };

  // Which badge was asked for last. Drawing one is asynchronous, so two
  // quick calls can finish in the order the GPU felt like; the counter is
  // what keeps the icon showing the newest answer rather than the slowest.
  let badgeSeq = 0;

  app.setDockBadge = async (label) => {
    const seq = ++badgeSeq;
    const hwnd = handleOf();
    if (!hwnd) return;
    if (label == null || String(label) === '') {
      app._native.taskbarOverlay(hwnd, null);
      return;
    }
    // The accent, so the badge belongs to the desktop it sits on rather than
    // to a colour this file picked. A theme with none falls back to the blue
    // Windows ships with.
    const accent = app.systemAppearance?.()?.accent ?? '#0078D4';
    const badge = await badgePixels(app, label, accent);
    if (!badge || seq !== badgeSeq) return;
    // The description is the accessible name of the overlay — what a screen
    // reader says about the taskbar button, and the one part of a badge that
    // is not a picture.
    app._native.taskbarOverlay(
      hwnd,
      badge.pixels,
      badge.size,
      badge.size,
      String(label),
    );
  };

  app.setTaskbarProgress = (value, { indeterminate = false } = {}) => {
    const hwnd = handleOf();
    if (hwnd) app._native.taskbarProgress(hwnd, value, indeterminate);
  };

  app.requestAttention = () => {
    const hwnd = handleOf();
    if (hwnd) app._native.taskbarFlash(hwnd, true);
    return 1;
  };

  app.cancelAttention = () => {
    const hwnd = handleOf();
    if (hwnd) app._native.taskbarFlash(hwnd, false);
  };
}
