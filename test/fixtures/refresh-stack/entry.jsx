import * as Thrower from './thrower.jsx';

try {
  Thrower.fail();
} catch (err) {
  console.log(err.stack);
}
