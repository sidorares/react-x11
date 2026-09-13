// Requests with a nullable object argument, encoded here because the fork
// of wayland-client refuses them.
//
// `xdg_toplevel.set_parent(null)`, `set_fullscreen(null)` ("whichever
// output"), `xdg_surface.get_popup(null, …)` (a popup whose parent is a layer
// surface) and `zwlr_layer_shell_v1.get_layer_surface(…, null, …)` ("the
// output the compositor prefers") all pass a null object, which the wire
// spells as the id 0. The protocol XML marks each of those arguments
// `allow-null`; the library's `format_args` never reads that attribute and
// throws on an id of 0 for every `object`. So the request is encoded through
// the same `requestNow` the `$` namespace uses, against a copy of the
// definition in which the nullable argument is a plain `uint` — the identical
// four bytes on the wire, minus the check.
//
// Delete when the fork accepts `null` for `allow-null` objects.

/**
 * Send `proxy.<name>(...args)` the way `proxy.$.<name>` would, allowing
 * `null`/`0` for the arguments the protocol marks nullable. Returns the new
 * proxy for a request that creates one, as `$` does.
 */
export function requestNullable(proxy, name, ...args) {
  const opcode = proxy.opcode(name);
  const def = proxy.requests[opcode];
  if (!def) {
    throw new Error(
      `${proxy.name}.${name} is not available at version ${proxy.version}`,
    );
  }
  const creates = def.args[0]?.type === 'new_id' && def.args[0].interface;
  // `$` omits the leading new_id from the caller's arguments; so does this.
  const shift = creates ? 1 : 0;
  const wire = args.slice();
  const patched = def.args.map((arg, i) => {
    const at = i - shift;
    if (at < 0 || arg.type !== 'object' || !isNullable(arg)) return arg;
    const v = wire[at];
    if (v == null || v === 0) {
      wire[at] = 0;
      return { ...arg, type: 'uint' };
    }
    return arg;
  });
  const encodeDef = { ...def, args: patched };
  const display = proxy.display;
  if (creates) {
    const itf = display.createInterface(def.args[0].interface);
    try {
      display.requestNow(proxy.id, opcode, encodeDef, itf.id, ...wire);
    } catch (err) {
      display.deleteId(itf.id);
      throw err;
    }
    return itf;
  }
  display.requestNow(proxy.id, opcode, encodeDef, ...wire);
  return undefined;
}

/** The JSON keeps the XML attribute as the string "true". */
function isNullable(arg) {
  const v = arg['allow-null'] ?? arg.allowNull;
  return v === true || v === 'true';
}
