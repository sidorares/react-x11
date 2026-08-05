// The resolve hook behind no-dbus.mjs: `dbus-native` is not installed here.
// Fails with the code and shape npm's own skip produces, so the code under
// test takes exactly the branch it would take on Node 20.
export async function resolve(specifier, context, next) {
  if (specifier === 'dbus-native' || specifier.startsWith('dbus-native/')) {
    const err = new Error(
      `Cannot find package 'dbus-native' imported from ${context.parentURL}`,
    );
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return next(specifier, context);
}
