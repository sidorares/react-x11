// Desktop notifications on the cocoa backend — `UNUserNotificationCenter`
// through @windowkit/appkit (>= 0.5), the top rung of src/notifications.js's
// ladder. `CocoaApp.notifications` is this object; its presence is the
// capability, and its `available()` is the second gate: the centre only
// delivers for a code-signed app bundle with a bundle id, and a bare `node`
// process reports itself unavailable so the ladder can move on to
// `osascript` rather than post into the void.
//
// Three things about the system shape the code:
//
// - **Authorization is the system's prompt, once per bundle.** The first
//   post from an app the user has not answered for asks first, and a
//   refusal is a refusal — reported, not fallen through.
// - **Actions are categories.** The centre knows an action set only as a
//   registered category, and `setNotificationCategories` *replaces* the set,
//   so every distinct action list this process has used stays registered
//   under a name derived from its keys. A click on the banner itself is the
//   action `default`, the freedesktop word the ladder speaks.
// - **The user's answer comes back as an event** on the app's callback,
//   naming the notification by identifier — `notification-action` and
//   `notification-dismissed`, which the app routes here.

function categoryId(actions) {
  return `react-x11:${actions.map((a) => a.key).join(',')}`;
}

export class CocoaNotifications {
  constructor(app) {
    this.app = app;
    this._native = app._native;
    this._handles = new Map(); // identifier -> handle
    this._categories = new Map(); // id -> { id, actions }
    this._settings = null;
    this._authorized = null;
  }

  /** The bridge's settings, read once — `available` is the bundle question. */
  settings() {
    if (this._settings) return this._settings;
    this._settings = new Promise((resolve) => {
      try {
        this._native.notificationSettings((s) =>
          resolve(s ?? { available: false }),
        );
      } catch {
        resolve({ available: false });
      }
    });
    return this._settings;
  }

  async available() {
    const s = await this.settings();
    return s?.available === true;
  }

  /**
   * Ask once; the system remembers, and so does this.
   *
   * Three answers, not two. `granted` and `denied` are the obvious pair, and
   * `unasked` is the one that matters: a falsy `granted` does **not** mean
   * the user said no. A bundle Launch Services has never registered — an
   * ad-hoc signature in a temp directory, say — gets no prompt at all, and
   * the request comes back refused with the status still `notDetermined`.
   * Calling that a refusal would tell the user they declined something they
   * were never shown, and would stop a ladder that has every right to carry
   * on: nobody has turned anything off. So the status is read again
   * afterwards, and it is the system, not the boolean, that says which
   * happened.
   *
   * @returns {Promise<'granted'|'denied'|'unasked'>}
   */
  async _authorize() {
    if (this._authorized != null) return this._authorized;
    const s = await this.settings();
    if (
      s.authorizationStatus === 'authorized' ||
      s.authorizationStatus === 'provisional'
    ) {
      this._authorized = 'granted';
      return this._authorized;
    }
    if (s.authorizationStatus === 'denied') {
      this._authorized = 'denied';
      return this._authorized;
    }
    const granted = await new Promise((resolve) => {
      try {
        this._native.requestNotificationAuthorization(
          ['alert', 'sound', 'badge'],
          (ok) => resolve(Boolean(ok)),
        );
      } catch {
        resolve(false);
      }
    });
    if (granted) {
      this._authorized = 'granted';
      return this._authorized;
    }
    // Refused — by the user, or by a system that never asked one. The prompt
    // moves the status off `notDetermined`; nothing else does.
    this._settings = null;
    const after = await this.settings();
    if (after.authorizationStatus === 'notDetermined') {
      // Not cached: a later post, from a bundle the system has since
      // registered, deserves the prompt this one never got.
      return 'unasked';
    }
    this._authorized = 'denied';
    return this._authorized;
  }

  _ensureCategory(actions) {
    if (!actions?.length) return undefined;
    const id = categoryId(actions);
    if (!this._categories.has(id)) {
      this._categories.set(id, {
        id,
        actions: actions.map((a) => ({
          id: a.key,
          title: a.label ?? a.key,
          foreground: true,
        })),
      });
      this._native.setNotificationCategories([...this._categories.values()]);
    }
    return id;
  }

  _props(options, identifier) {
    const props = {
      title: options.summary,
      body: options.body ?? '',
      sound: options.silent ? null : 'default',
    };
    if (identifier) props.identifier = identifier;
    if (options.subtitle) props.subtitle = options.subtitle;
    const categoryId = this._ensureCategory(options.actions);
    if (categoryId) props.categoryId = categoryId;
    if (options.userInfo) props.userInfo = options.userInfo;
    return props;
  }

  /**
   * Post, if the user has allowed it.
   *
   * `null` rather than a throw when the centre could not ask (see
   * `_authorize`): the ladder reads that as "this rung cannot serve" and
   * moves on. A real refusal still throws, because it is an answer.
   */
  async post(options) {
    const auth = await this._authorize();
    if (auth === 'denied') {
      const err = new Error(
        'react-x11: notifications are not allowed for this app — the user ' +
          'declined them in System Settings › Notifications.',
      );
      err.name = 'NotificationsDeniedError';
      throw err;
    }
    if (auth !== 'granted') return null;
    const handle = new CocoaHandle(this, options);
    await handle._post({});
    return handle;
  }

  /** `notification-action` / `notification-dismissed` from the app. */
  route(ev) {
    const handle = this._handles.get(ev.identifier);
    if (!handle) return;
    if (ev.type === 'notification-action') {
      handle._action(
        ev.actionId === 'default' ? 'default' : String(ev.actionId),
      );
    } else if (ev.type === 'notification-dismissed') {
      this._handles.delete(ev.identifier);
      handle._closed('dismissed');
    }
  }
}

class CocoaHandle {
  constructor(centre, options) {
    this.backend = 'cocoa';
    this.id = null;
    this._centre = centre;
    this._options = options;
    this._done = false;
  }

  _post(patch) {
    const centre = this._centre;
    const native = centre._native;
    this._options = { ...this._options, ...patch };
    const props = centre._props(this._options, this.id);
    return new Promise((resolve, reject) => {
      const done = (error) => (error ? reject(error) : resolve(this));
      try {
        if (this.id) {
          native.updateNotification(this.id, props, done);
        } else {
          this.id = native.postNotification(props, done);
          centre._handles.set(this.id, this);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  update(patch = {}) {
    if (this._done) return Promise.resolve(this);
    return this._post(patch);
  }

  async close() {
    if (this._done || !this.id) return;
    this._centre._handles.delete(this.id);
    try {
      this._centre._native.removeNotification(this.id);
    } finally {
      this._closed('closed');
    }
  }

  _action(key) {
    try {
      this._options.onAction?.(key);
    } catch (err) {
      console.error('react-x11: a notification action handler threw', err);
    }
  }

  _closed(reason) {
    if (this._done) return;
    this._done = true;
    try {
      this._options.onClose?.(reason);
    } catch (err) {
      console.error('react-x11: a notification close handler threw', err);
    }
  }
}
