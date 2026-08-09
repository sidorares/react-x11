// `useFrame` — run a callback on every frame of the surrounding `<Canvas3D>`.
//
// The frame clock belongs to the `<glarea>`'s X window, which is a host node
// the component tree cannot reach: refs attach after the commit, and a hook
// in a grandchild has no path to it at all. So `<Canvas3D>` makes a **bus**,
// hands it to the surface as a prop and publishes it on a context. The
// surface runs it once per frame; components subscribe from anywhere inside.
//
// What this is *not* is r3f's escape from re-rendering. There, `useFrame`
// mutates an Object3D in place and React never hears about it. The scene here
// is described by props, so a callback that wants to move something calls a
// state setter and the change lands on the next frame. That makes this a
// frame clock scoped to one surface, which is the thing that was missing —
// the alternative was a ref to the window and a raw requestAnimationFrame.

import { createContext, useContext, useEffect, useRef } from 'react';

export const FrameContext = createContext(null);

/**
 * The per-surface subscriber list. Callbacks run in the order they
 * subscribed, and a callback added while one is running joins the next frame
 * rather than this one — iterating a copy keeps a subscriber that unmounts
 * mid-frame from skipping its neighbour.
 */
export function createFrameBus() {
  const callbacks = new Set();
  return {
    get size() {
      return callbacks.size;
    },
    subscribe(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    run(state, delta) {
      if (callbacks.size === 0) return false;
      for (const callback of [...callbacks]) callback(state, delta);
      return true;
    },
  };
}

/**
 * Run `callback(state, delta)` on every frame of the enclosing `<Canvas3D>`.
 *
 * ```jsx
 * function Spin() {
 *   const [angle, setAngle] = useState(0);
 *   useFrame((state, delta) => setAngle((a) => a + delta));
 *   return <mesh rotation={[0, angle, 0]}>…</mesh>;
 * }
 * ```
 *
 * `delta` is seconds since the previous frame, so animation runs at the same
 * speed whatever the frame rate. `state` carries `{ gl, backend, width,
 * height, elapsed, frame, camera }` — `elapsed` being seconds since the
 * surface's first frame, and `camera` the matrices the frame was drawn with.
 *
 * **Subscribing makes the surface animate.** A `<Canvas3D>` redraws on demand
 * by default — on a prop change, a resize or an expose — and a frame clock
 * nothing drives would tick once and stop. So a surface with subscribers
 * schedules the next frame, exactly as `frameLoop="always"` does. Unsubscribe
 * (return from the effect, or unmount) and it goes quiet again.
 *
 * The callback is stored in a ref, so it always sees current state and does
 * not need to be memoized to avoid resubscribing every render.
 */
export function useFrame(callback) {
  const bus = useContext(FrameContext);
  const latest = useRef(callback);
  latest.current = callback;
  if (!bus) {
    throw new Error(
      'react-x11: useFrame() must be called inside a <Canvas3D>, whose frame ' +
        'clock it runs on. For a window-wide clock use the window ref’s ' +
        'requestAnimationFrame instead.',
    );
  }
  useEffect(
    () => bus.subscribe((state, delta) => latest.current(state, delta)),
    [bus],
  );
}

export default useFrame;
