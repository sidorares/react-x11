import { createElement as h, useCallback, useMemo, useState } from 'react';

import { useAppOrNull } from '../appcontext.js';
import { FrameContext, createFrameBus } from '../frame3d.js';
import { glxFailure } from '../glnodes.js';

/**
 * Failures that mean "one thing in this scene is broken", not "this machine
 * has no 3D". The fallback is for the second: replacing a whole scene with
 * "no 3D here" because a pass shader has a typo would send the reader off to
 * check their drivers.
 */
const SCENE_LEVEL = new Set([
  'GL_SHADER_FAILED',
  'GL_CONTEXT_INCOMPLETE',
  'GL_POST_UNAVAILABLE',
  'GL_POST_TARGET_FAILED',
]);

/**
 * `<Canvas3D>` — the react-three-fiber-shaped entry point to the 3D scene.
 * A thin wrapper over the `<glarea>` host element: it is the surface that
 * owns the GL context, and the scene lives in its children.
 *
 * ```jsx
 * <Canvas3D style={{ flexGrow: 1 }} camera={{ position: [3, 3, 6], fov: 50 }}>
 *   <mesh rotation={[0.4, 0.8, 0]}>
 *     <boxGeometry args={[1, 1, 1]} />
 *     <meshBasicMaterial color="#2980b9" />
 *   </mesh>
 * </Canvas3D>
 * ```
 *
 * Props are `<glarea>`'s (`style`, `clearColor`, `frameLoop`, `glx`,
 * `onCreated`, `onDraw`, `onError`) plus `camera`:
 * `{ position, target, up, fov, near, far, orthographic, zoom }`, and
 * `fallback` (below).
 *
 * The name is `Canvas3D`, not r3f's `Canvas`, because react-x11 already has
 * a `<canvas>` host element — the 2D `onDraw` escape hatch.
 *
 * ## When there is no GL
 *
 * Plenty of X servers cannot give us a GL context — indirect GLX is off by
 * default on Xorg >= 1.17 and Xwayland, which is most desktops. `fallback`
 * is what to show instead:
 *
 * ```jsx
 * <Canvas3D fallback={(err) => <text>No 3D here: {err.message}</text>}>
 * ```
 *
 * An element works too; a function receives the error, whose `code` is one
 * of ntk's `GLXError` values (`GLX_INDIRECT_DISABLED` is the common one) and
 * whose `hint` is a multi-line explanation of how to fix the server. Branch
 * on the code, not on the message.
 *
 * The fallback is rendered in a `<box>` carrying this component's `style`,
 * so it takes the same place in the layout the surface would have. Children
 * are the scene graph and cannot double as the fallback — hence a prop, the
 * same reason `<Suspense fallback>` is one.
 *
 * Without `fallback` the surface stays mounted, draws nothing, and the error
 * goes to `onError` (or to the console, once).
 */
export function Canvas3D({ children, style, fallback, onError, ...props }) {
  const app = useAppOrNull();
  // seeded from the connection: by the time a second <Canvas3D> mounts, the
  // answer is usually already known, and seeding renders its fallback on the
  // first frame rather than after a round trip
  const [error, setError] = useState(() => glxFailure(app));
  const handleError = useCallback(
    (err) => {
      // The fallback means "this surface has no GL", so only a failure to get
      // a context switches to it.
      if (!SCENE_LEVEL.has(err?.code)) setError(err);
      if (onError) return onError(err);
      // Nowhere else for it to go. `<glarea>` logs its own failures only when
      // no onError is set, and this component always sets one — so without
      // this an app that passed neither `fallback` nor `onError` gets a
      // surface that draws nothing and says nothing, which is the worst of
      // the three outcomes and exactly what a blank window looks like.
      if (fallback === undefined)
        console.warn(`react-x11: <Canvas3D>: ${err?.message ?? err}`);
    },
    [onError, fallback],
  );

  // The frame clock lives on the host node, which the children cannot reach:
  // it is handed to the surface as a prop and published on a context, so
  // `useFrame` anywhere inside subscribes to this surface's frames.
  const frames = useMemo(() => createFrameBus(), []);

  if (error && fallback !== undefined) {
    return h(
      'box',
      { style },
      typeof fallback === 'function' ? fallback(error) : fallback,
    );
  }
  return h(
    'glarea',
    { ...props, style, frames, onError: handleError },
    h(FrameContext.Provider, { value: frames }, children),
  );
}

export default Canvas3D;
