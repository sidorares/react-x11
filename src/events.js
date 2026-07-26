// Synthetic event system: ntk window events → capture/target/bubble dispatch
// over the drawn node tree, with hit testing, click synthesis, hover
// enter/leave, wheel mapping (X buttons 4-7) and focus/Tab traversal.
// Handlers always read from current props, so updates never go stale.
import {
  runWithPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
} from './priority.js';

const XK_TAB = 0xff09;
const WHEEL_BUTTONS = { 4: [0, -48], 5: [0, 48], 6: [-48, 0], 7: [48, 0] };

export class EventManager {
  constructor(windowNode) {
    this.node = windowNode;
    this.hoverPath = [];
    this.downNode = null;
    this.focused = null;
    this._lastClick = { time: 0, x: 0, y: 0, detail: 0 };
  }

  /** DOM-style click counting: repeated presses within 400ms / 4px bump
   * `detail` (2 = double click, 3 = triple …). */
  _clickDetail(native) {
    const now = Date.now();
    const last = this._lastClick;
    const detail =
      now - last.time < 400 &&
      Math.abs(native.x - last.x) <= 4 &&
      Math.abs(native.y - last.y) <= 4
        ? last.detail + 1
        : 1;
    this._lastClick = { time: now, x: native.x, y: native.y, detail };
    return detail;
  }

  attach() {
    const wnd = this.node.window;
    if (typeof wnd.on !== 'function') return;
    wnd.on('mousedown', (ev) => this._onMouseDown(ev));
    wnd.on('mouseup', (ev) => this._onMouseUp(ev));
    wnd.on('mousemove', (ev) => this._onMouseMove(ev));
    wnd.on('mouseout', (ev) => this._onMouseOut(ev));
    wnd.on('keydown', (ev) => this._onKey('KeyDown', ev));
    wnd.on('keyup', (ev) => this._onKey('KeyUp', ev));
  }

  _public(node) {
    return node.isWindow ? node.window : node;
  }

  _hit(ev) {
    return this.node.hitTest(ev.x, ev.y) ?? this.node;
  }

  _path(target) {
    const path = [];
    for (
      let n = target;
      n;
      n = n === this.node ? null : (n.parent ?? this.node)
    ) {
      path.unshift(n);
      if (n === this.node) break;
    }
    return path;
  }

  _makeEvent(type, native, target, extra) {
    const ev = {
      type,
      x: native?.x ?? 0,
      y: native?.y ?? 0,
      target: this._public(target),
      currentTarget: null,
      nativeEvent: native,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {
        ev.propagationStopped = true;
      },
      ...extra,
    };
    if (target.abs) {
      ev.localX = ev.x - target.abs.x;
      ev.localY = ev.y - target.abs.y;
    }
    return ev;
  }

  /** Capture → target → bubble along the ancestor path. Returns the event. */
  dispatch(name, target, native, extra) {
    const path = this._path(target);
    const ev = this._makeEvent(
      name[0].toLowerCase() + name.slice(1),
      native,
      target,
      extra,
    );
    for (const n of path) {
      const handler = n.props[`on${name}Capture`];
      if (handler) {
        ev.currentTarget = this._public(n);
        handler(ev);
        if (ev.propagationStopped) return ev;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const handler = path[i].props[`on${name}`];
      if (handler) {
        ev.currentTarget = this._public(path[i]);
        handler(ev);
        if (ev.propagationStopped) return ev;
      }
    }
    return ev;
  }

  _onMouseDown(native) {
    runWithPriority(DiscreteEventPriority, () => {
      const wheel = WHEEL_BUTTONS[native.keycode];
      const target = this._hit(native);
      if (wheel) {
        const ev = this.dispatch('Wheel', target, native, {
          deltaX: wheel[0],
          deltaY: wheel[1],
        });
        if (!ev.defaultPrevented) {
          // default action: scroll the nearest enclosing <scrollview>
          for (let n = target; n; n = n.parent) {
            if (n.kind === 'scrollview' || n.kind === 'textarea') {
              n.scrollBy(ev.deltaY);
              break;
            }
            if (n === this.node) break;
          }
        }
        return;
      }
      this.downNode = target;
      // DOM-like: mousedown moves focus to the nearest focusable ancestor
      const focusable = this._path(target)
        .reverse()
        .find((n) => this._isFocusable(n));
      this.focus(focusable ?? null);
      const ev = this.dispatch('MouseDown', target, native, {
        button: native.keycode,
        detail: this._clickDetail(native),
      });
      if (!ev.defaultPrevented) {
        target._defaultMouseDown?.(ev);
      }
    });
  }

  _onMouseUp(native) {
    if (WHEEL_BUTTONS[native.keycode]) return; // wheel release
    runWithPriority(DiscreteEventPriority, () => {
      const target = this._hit(native);
      const ev = this.dispatch('MouseUp', target, native, {
        button: native.keycode,
      });
      if (this.downNode && !this.downNode.destroyed) {
        this.downNode._defaultMouseUp?.(ev);
      }
      if (this.downNode) {
        // click fires on the nearest common ancestor of press and release
        const downPath = new Set(this._path(this.downNode));
        let clickTarget = target;
        while (clickTarget && !downPath.has(clickTarget)) {
          clickTarget =
            clickTarget.parent ??
            (clickTarget === this.node ? null : this.node);
        }
        if (clickTarget) {
          this.dispatch('Click', clickTarget, native, {
            button: native.keycode,
          });
        }
        this.downNode = null;
      }
    });
  }

  _onMouseMove(native) {
    runWithPriority(ContinuousEventPriority, () => {
      const target = this._hit(native);
      this._updateHover(this._path(target), native);
      const ev = this.dispatch('MouseMove', target, native);
      // drags deliver to the pressed node even when the pointer leaves it
      if (this.downNode && !this.downNode.destroyed) {
        this.downNode._defaultMouseDrag?.(ev);
      }
    });
  }

  _isFocusable(node) {
    return node.props.focusable ?? node.focusableByDefault ?? false;
  }

  _onMouseOut(native) {
    runWithPriority(ContinuousEventPriority, () => {
      this._updateHover([], native);
      this.node.props.onMouseOut?.(
        this._makeEvent('mouseOut', native, this.node),
      );
    });
  }

  /** enter/leave do not propagate: each node on the diff gets its own call. */
  _updateHover(newPath, native) {
    const oldPath = this.hoverPath;
    let common = 0;
    while (
      common < oldPath.length &&
      common < newPath.length &&
      oldPath[common] === newPath[common]
    ) {
      common++;
    }
    for (let i = oldPath.length - 1; i >= common; i--) {
      const n = oldPath[i];
      if (!n.destroyed) {
        n.props.onMouseLeave?.(this._makeEvent('mouseLeave', native, n));
      }
    }
    for (let i = common; i < newPath.length; i++) {
      const n = newPath[i];
      n.props.onMouseEnter?.(this._makeEvent('mouseEnter', native, n));
    }
    this.hoverPath = newPath;
    this._updateCursor(newPath);
  }

  /** Apply the deepest hovered node's `cursor` prop to the window.
   * Feature-detected: needs ntk with Window.setCursor (> 3.1.0). */
  _updateCursor(path) {
    const wnd = this.node.window;
    if (typeof wnd.setCursor !== 'function') return;
    let cursor = null;
    for (let i = path.length - 1; i >= 0; i--) {
      const c = path[i].props.cursor ?? path[i].defaultCursor;
      if (c != null) {
        cursor = c;
        break;
      }
    }
    if (cursor !== this._appliedCursor) {
      this._appliedCursor = cursor;
      wnd.setCursor(cursor);
    }
  }

  _onKey(name, native) {
    runWithPriority(DiscreteEventPriority, () => {
      const wnd = this.node.window;
      const syms = wnd.X?.keycode2keysyms?.[native.keycode];
      const keysym = syms?.[0];
      const target =
        this.focused && !this.focused.destroyed ? this.focused : this.node;
      const ev = this.dispatch(name, target, native, {
        keycode: native.keycode,
        keysym,
        codepoint: native.codepoint,
        key:
          native.codepoint && native.codepoint >= 0x20
            ? String.fromCodePoint(native.codepoint)
            : undefined,
        shiftKey: Boolean(native.buttons & 1),
        ctrlKey: Boolean(native.buttons & 4),
      });
      if (name === 'KeyDown' && keysym === XK_TAB && !ev.defaultPrevented) {
        this._cycleFocus(Boolean(native.buttons & 1));
        return;
      }
      if (name === 'KeyDown' && !ev.defaultPrevented) {
        target._defaultKeyDown?.(ev);
      }
    });
  }

  focus(node) {
    if (node === this.focused) return;
    const old = this.focused;
    this.focused = node;
    if (old && !old.destroyed) {
      old._defaultBlur?.();
      old.props.onBlur?.(this._makeEvent('blur', null, old));
    }
    if (node) {
      node._defaultFocus?.();
      node.props.onFocus?.(this._makeEvent('focus', null, node));
    }
  }

  _focusables() {
    const out = [];
    const walk = (node) => {
      if (node.hidden) return;
      if (this._isFocusable(node)) out.push(node);
      for (const child of node.children) {
        if (!child.isWindow) walk(child);
      }
    };
    walk(this.node);
    return out;
  }

  _cycleFocus(backwards) {
    const list = this._focusables();
    if (list.length === 0) return;
    const index = list.indexOf(this.focused);
    const next = backwards
      ? list[(index <= 0 ? list.length : index) - 1]
      : list[(index + 1) % list.length];
    this.focus(next);
  }

  /** Called when a node leaves the tree so stale references don't linger. */
  forget(node) {
    if (this.downNode === node) this.downNode = null;
    if (this.focused === node) this.focused = null;
    this.hoverPath = this.hoverPath.filter((n) => n !== node);
  }
}
