// Pointer events for the 3D scene: X pointer events on the <glarea> window,
// raycast against the CPU-side geometry (raycast3d.js), dispatched to the
// mesh they hit and bubbled up its ancestors.
//
// The surface owns one X window, so this is a second, small event pipeline
// beside the 2D EventManager rather than part of it: the hit test is a ray,
// not a rect, and the events carry 3D information.
import {
  runWithPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
} from './priority.js';
import { hasPointerHandlers, raycast } from './raycast3d.js';

/** Does anything in this subtree listen for pointer events? */
export function sceneWantsPointer(nodes) {
  for (const node of nodes) {
    if (!node.isObject3D) continue;
    if (hasPointerHandlers(node)) return true;
    if (sceneWantsPointer(node.children)) return true;
  }
  return false;
}

/** The dispatch path: the mesh that was hit, then its ancestors. */
function bubblePath(node, surface) {
  const path = [];
  for (let n = node; n && n !== surface; n = n.parent) path.push(n);
  return path;
}

export class ScenePointer {
  constructor(surface) {
    this.surface = surface;
    this.hovered = null;
    this.pressed = null;
    this.attached = false;
  }

  attach(wnd) {
    if (this.attached || typeof wnd.on !== 'function') return;
    this.attached = true;
    wnd.on('mousedown', (ev) => this._onPointer('pointerdown', ev));
    wnd.on('mouseup', (ev) => this._onPointer('pointerup', ev));
    wnd.on('mousemove', (ev) => this._onPointer('pointermove', ev));
    wnd.on('mouseout', () => this._onLeave());
  }

  /** The nearest hit under the pointer, or null. */
  _pick(ev) {
    const camera = this.surface.scene.camera;
    if (!camera) return null;
    const [hit] = raycast(this.surface, ev.x, ev.y, camera);
    return hit ?? null;
  }

  _makeEvent(type, hit, native, target) {
    let stopped = false;
    return {
      type,
      target,
      object: hit?.object ?? null,
      point: hit?.point ?? null,
      distance: hit?.distance ?? null,
      face: hit?.face ?? null,
      uv: hit?.uv ?? null,
      x: native?.x,
      y: native?.y,
      nativeEvent: native,
      surface: this.surface,
      stopPropagation() {
        stopped = true;
      },
      get propagationStopped() {
        return stopped;
      },
    };
  }

  /** Call `on<Name>` along the bubble path until one stops propagation. */
  _dispatch(name, hit, native, node = hit?.object) {
    if (!node) return null;
    const prop = `on${name[0].toUpperCase()}${name.slice(1)}`;
    let event = null;
    for (const target of bubblePath(node, this.surface)) {
      const handler = target.props?.[prop];
      if (typeof handler !== 'function') continue;
      event = event ?? this._makeEvent(name.toLowerCase(), hit, native, target);
      event.target = target;
      handler(event);
      if (event.propagationStopped) break;
    }
    return event;
  }

  _onPointer(type, native) {
    const priority =
      type === 'pointermove' ? ContinuousEventPriority : DiscreteEventPriority;
    runWithPriority(priority, () => {
      const hit = this._pick(native);
      if (type === 'pointermove') {
        this._updateHover(hit, native);
        if (hit) this._dispatch('pointerMove', hit, native);
        return;
      }
      if (type === 'pointerdown') {
        this.pressed = hit?.object ?? null;
        if (hit) this._dispatch('pointerDown', hit, native);
        else
          this.surface.props.onPointerMissed?.(
            this._makeEvent('pointermissed', null, native, null),
          );
        return;
      }
      // pointerup: a click is down and up on the same object
      if (hit) this._dispatch('pointerUp', hit, native);
      if (hit && this.pressed === hit.object) {
        this._dispatch('click', hit, native);
      }
      this.pressed = null;
    });
  }

  /** enter/leave, diffed against the object hovered last time. */
  _updateHover(hit, native) {
    const next = hit?.object ?? null;
    if (next === this.hovered) return;
    const previous = this.hovered;
    this.hovered = next;
    if (previous && !previous.destroyed) {
      this._dispatch('pointerOut', null, native, previous);
    }
    if (next) this._dispatch('pointerOver', hit, native);
    this._applyCursor(next);
  }

  _applyCursor(node) {
    const wnd = this.surface.window;
    if (typeof wnd?.setCursor !== 'function') return;
    const cursor = node?.props?.cursor ?? null;
    if (cursor === this._cursor) return;
    this._cursor = cursor;
    wnd.setCursor(cursor);
  }

  _onLeave() {
    if (!this.hovered) return;
    runWithPriority(ContinuousEventPriority, () => {
      this._updateHover(null, null);
    });
  }

  /** A node left the tree: drop references to it. */
  forget(node) {
    if (this.hovered === node) this.hovered = null;
    if (this.pressed === node) this.pressed = null;
  }
}
