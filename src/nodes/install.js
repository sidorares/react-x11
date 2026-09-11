// Puts a concern's methods onto the class they belong to.
//
// The node classes are split by concern rather than by class: the scroll
// blit's methods live in scrollblit.js whether they are Node's or
// WindowNode's, the paint walk's in paint.js, and so on. Each concern writes
// its methods as the body of a class that is never instantiated — a part —
// and the class's own file installs its parts right after declaring it:
//
//   installMethods(Node, NodeStyling, NodeCascade, …);
//
// What the class ends up with is what one class body would have given it: the
// same function objects, as non-enumerable properties of the same prototype.
// Anything that compares against a prototype (`node.paint !==
// Node.prototype.paint`) or overrides a method in a subclass sees no
// difference.
//
// Two guards keep the arrangement safe to edit. A name defined twice — in the
// class and a part, or in two parts — throws while the module loads, instead
// of whichever ran last silently winning. And each part's prototype is
// re-parented onto the class's parent, so `super` in a moved method means
// what it meant in the class body.

/** part -> the class it was installed onto */
const installed = new WeakMap();

/** prototype -> (key -> the part that defined it) */
const origins = new WeakMap();

/**
 * Install each part's methods and accessors onto `target.prototype`.
 *
 * @param {Function} target the class
 * @param {...Function} parts classes whose bodies hold the rest of its methods
 */
export function installMethods(target, ...parts) {
  const proto = target.prototype;
  const parent = Object.getPrototypeOf(proto);
  if (!origins.has(proto)) origins.set(proto, new Map());
  const defined = origins.get(proto);
  for (const part of parts) {
    if (installed.has(part)) {
      throw new Error(
        `react-x11: ${part.name} is already installed onto ` +
          `${installed.get(part).name}; a part belongs to exactly one class.`,
      );
    }
    const keys = Reflect.ownKeys(part.prototype).filter(
      (key) => key !== 'constructor',
    );
    for (const key of keys) {
      if (Object.hasOwn(proto, key)) {
        const first = defined.get(key) ?? `the ${target.name} class body`;
        throw new Error(
          `react-x11: ${target.name}.${String(key)} is defined twice, in ` +
            `${first} and in ${part.name}. A method lives in exactly one ` +
            `file under src/nodes/ — rename one of them, or delete it.`,
        );
      }
    }
    Object.setPrototypeOf(part.prototype, parent);
    for (const key of keys) {
      Object.defineProperty(
        proto,
        key,
        Object.getOwnPropertyDescriptor(part.prototype, key),
      );
      defined.set(key, part.name);
    }
    installed.set(part, target);
  }
}

/** The class `part` was installed onto, or undefined: what the test that
 *  every part under src/nodes/ is installed somewhere reads. */
export const installedOnto = (part) => installed.get(part);
