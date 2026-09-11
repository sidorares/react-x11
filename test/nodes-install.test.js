// installMethods (src/nodes/install.js): how a node class gets the methods
// that live with their concerns in other files. What it has to preserve is
// what one class body would have given the class — the same function
// objects, non-enumerable, accessors intact, `super` meaning the class's
// parent — and what it has to refuse is a name defined twice, which would
// otherwise go to whichever file happened to install last.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installMethods, installedOnto } from '../src/nodes/install.js';

test('methods and accessors land on the prototype the way a class body puts them', () => {
  class Target {}
  class Part {
    method() {
      return 'method';
    }
    get value() {
      return this._value;
    }
    set value(v) {
      this._value = v;
    }
  }
  installMethods(Target, Part);

  const t = new Target();
  assert.equal(t.method(), 'method');
  t.value = 3;
  assert.equal(t.value, 3);

  // the same function object, so a prototype comparison cannot tell
  assert.equal(Target.prototype.method, Part.prototype.method);
  const m = Object.getOwnPropertyDescriptor(Target.prototype, 'method');
  assert.deepEqual(
    {
      enumerable: m.enumerable,
      writable: m.writable,
      configurable: m.configurable,
    },
    { enumerable: false, writable: true, configurable: true },
  );
  const a = Object.getOwnPropertyDescriptor(Target.prototype, 'value');
  assert.equal(typeof a.get, 'function');
  assert.equal(typeof a.set, 'function');
  assert.equal(a.enumerable, false);
  assert.deepEqual(Object.keys(Target.prototype), []);
  assert.equal(installedOnto(Part), Target);
});

test('a name defined twice throws while installing, and says where both are', () => {
  class Target {
    paint() {}
  }
  class Painting {
    paint() {}
  }
  assert.throws(
    () => installMethods(Target, Painting),
    /Target\.paint is defined twice, in the Target class body and in Painting/,
  );

  class Other {}
  class First {
    hit() {}
  }
  class Second {
    hit() {}
  }
  assert.throws(
    () => installMethods(Other, First, Second),
    /Other\.hit is defined twice, in First and in Second/,
  );
});

test("super in an installed method reaches the class's parent, as it would in the body", () => {
  class Base {
    greet() {
      return 'base';
    }
  }
  class Target extends Base {}
  class Part {
    greet() {
      return 'part, then ' + super.greet();
    }
  }
  installMethods(Target, Part);
  assert.equal(new Target().greet(), 'part, then base');
});

test('a part belongs to exactly one class', () => {
  class One {}
  class Two {}
  class Part {
    method() {}
  }
  installMethods(One, Part);
  assert.throws(
    () => installMethods(Two, Part),
    /Part is already installed onto One/,
  );
});
