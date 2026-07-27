import { createElement as h } from 'react';

/**
 * `<Canvas3D>` — the react-three-fiber-shaped entry point to the 3D scene.
 * A thin wrapper over the `<glarea>` host element: it is the surface that
 * owns the GL context, and the scene lives in its children.
 *
 * ```jsx
 * <Canvas3D flexGrow={1} camera={{ position: [3, 3, 6], fov: 50 }}>
 *   <mesh rotation={[0.4, 0.8, 0]}>
 *     <boxGeometry args={[1, 1, 1]} />
 *     <meshBasicMaterial color="#2980b9" />
 *   </mesh>
 * </Canvas3D>
 * ```
 *
 * Props are `<glarea>`'s (layout props, `clearColor`, `frameLoop`, `glx`,
 * `onCreated`, `onDraw`, `onError`) plus `camera`:
 * `{ position, target, up, fov, near, far, orthographic, zoom }`.
 *
 * The name is `Canvas3D`, not r3f's `Canvas`, because react-x11 already has
 * a `<canvas>` host element — the 2D `onDraw` escape hatch.
 */
export function Canvas3D({ children, ...props }) {
  return h('glarea', props, children);
}

export default Canvas3D;
