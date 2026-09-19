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
export function installTaskbar(app) {
  const handleOf = () => {
    const [first] = [...app._windows.values()];
    return first ? app._native.windowHandle(first.id) : 0;
  };

  app.setDockBadge = (label) => {
    const hwnd = handleOf();
    if (!hwnd) return;
    // No icon to put on it yet, so clear rather than pretend.
    app._native.taskbarOverlay(hwnd, null);
    if (label != null && String(label) !== '')
      app._native.taskbarFlash(hwnd, true);
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
