// Make `dbus-native` unresolvable in a child process, so the Node 20 install
// — where npm skips the optional dependency because its own engines field is
// `>=22.12.0` — can be tested on every Node rather than only on the one leg of
// the matrix where it happens to be true.
//
// `module.register` rather than `module.registerHooks`: the async form has
// been there since Node 20.6, and this has to run on the oldest supported
// Node.
import { register } from 'node:module';

register('./no-dbus-loader.mjs', import.meta.url);
