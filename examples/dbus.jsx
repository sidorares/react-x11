// A D-Bus explorer: both buses, a tree to walk them, and a pane of detail.
//
// This is the worked example for docs/dbus.md — the connection layer #163
// added — and it is deliberately built the way a real desktop-integration
// feature would be:
//
//   const { bus, status, cause, retry } = useSessionBus();
//
// No provider, nothing to wrap, and **no reason for this window to fail to
// open when there is no bus**. Run it over ssh, in a container, under a bare
// startx, or on Node 20 where npm skipped the optional `dbus-native`
// dependency entirely, and the header renders the reason instead of the
// process dying. That is the whole point of the layer: "there is no bus" is a
// configuration, not an error.
//
//   DBUS_SESSION_BUS_ADDRESS=unix:path=/nope npm run examples:dbus
//
// ## What it shows
//
//   Session bus — :1.148           <- one connection, one identity, shared by
//   System bus — :1.159               every consumer in this process
//     org.a11y.Bus                 <- names, from ListNames
//       /org/a11y/bus              <- objects, from Introspect, lazily
//         org.a11y.Status          <- the interfaces on that object
//
// Selecting a row fills the right pane: a bus's address and status, a name's
// owner and pid, an object's interfaces, an interface's methods, signals and
// **live property values** (one GetAll, on demand).
//
// ## Four things that shaped the code
//
// **Introspection is a round trip per node**, so the tree loads lazily —
// `children: []` is what makes an unexplored branch show a twisty before its
// contents are known, and `onExpandedChange` is where the call goes. Every
// expansion shows `loading…` on the frame the click landed on rather than
// after the reply: answer the input, not the outcome.
//
// **Object paths are a namespace, not a hierarchy anyone arranged.** Reaching
// `org.a11y.Bus`'s only object by hand means `/` → `/org` → `/org/a11y` →
// `/org/a11y/bus`: three rows that say nothing. `compressPath` skips them.
//
// **A service can simply not answer.** `Introspect` on a name whose owner is
// busy, or wedged, or does not implement Introspectable, hangs — so every call
// here is raced against a deadline and a failure becomes a row you can read,
// not a spinner forever.
//
// **Nothing here imports `dbus-native`.** Not the value formatter, not the
// signature reader. An example that did would crash on exactly the install
// this example exists to demonstrate.
//
// Run with: npm run examples:dbus  (needs an X server / DISPLAY)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  createRoot,
  createStyles,
  SplitPane,
  ThemeProvider,
  Tree,
  useSessionBus,
  useSystemBus,
} from '../src/index.js';

// --- palette ---------------------------------------------------------------
//
// There isn't one. Every colour below is a `$token`, so this window is the
// desktop's colours — light on a light desktop, dark on a dark one — and the
// widgets, which read the same palette through React context, cannot drift
// away from the boxes around them. See docs/appearance.md.
//
// This example used to carry a Zinc-ish light palette of its own and hand a
// partial copy of it to `<ThemeProvider>`. That was already a trap and the
// system palette made it visible: the copy never mentioned `text`, so on a
// dark desktop the ink came from the desktop and the surfaces came from here.

const C = {
  page: '$background',
  chrome: '$surfaceHover',
  edge: '$border',
  text: '$text',
  dim: '$textMuted',
  // The faintest neutral the palette has — `border` is lighter than `dim` on
  // a light scheme and darker on a dark one, which is "fainter" both times.
  faint: '$border',
  accent: '$accent',
  mono: '$surfaceHover',

  // Status has no token, because a palette describes a surface and these
  // describe a fact: owned, activatable, unreachable. Mid-tones, so they
  // clear 3:1 against both the light background and the dark one rather than
  // being tuned for white and disappearing on the other.
  good: '#2ea043',
  warn: '#bf8700',
  bad: '#e5484d',
};

// The only thing this app wants that the desktop does not decide: slightly
// rounder corners than the default 4. Colours are deliberately absent.
const THEME = { radius: 5 };

// The palette's mono face rather than the literal: every code surface in
// this app — the chips, the pane titles, the value dumps — is one token, so
// a desktop or an app that has a better monospace than the default sets it
// in one place.
const MONO = '$monoFamily';

// react-x11 has `borderWidth` for the whole box and no per-edge borders, so a
// rule is a one-pixel box rather than a border — which is also cheaper: a
// border makes the box a bordered drawing, where this is one filled rect.
const s = createStyles({
  window: { flexDirection: 'column', backgroundColor: C.page },
  rule: { height: 1, flexShrink: 0, backgroundColor: C.edge },
  header: {
    flexDirection: 'row',
    gap: 10,
    padding: 10,
    backgroundColor: C.chrome,
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  chip: {
    flexDirection: 'column',
    gap: 2,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 6,
    backgroundColor: C.page,
    minWidth: 260,
  },
  chipTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipName: { fontSize: 12, fontWeight: 'bold', color: C.text },
  chipLine: { fontSize: 11, color: C.dim, fontFamily: MONO },
  chipWhy: { fontSize: 11, color: C.warn },

  sidebar: {
    // `flexGrow: 1` is what gives the tree a height to fill. SplitPane wraps
    // each child in a pane box that is sized on the main axis and stacks its
    // own children in a column — so an auto-height sidebar leaves the tree,
    // which only asks to grow, with nothing to grow into.
    flexGrow: 1,
    flexDirection: 'column',
    backgroundColor: C.page,
    minHeight: 0,
  },
  sidebarHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 6,
    paddingBottom: 6,
    flexShrink: 0,
  },
  sidebarTitle: { fontSize: 11, color: C.dim, flexGrow: 1, flexBasis: 0 },

  pane: { flexGrow: 1, padding: 14, flexDirection: 'column', gap: 12 },
  paneKind: { fontSize: 10, color: C.faint },
  paneTitle: { fontSize: 15, color: C.text, fontFamily: MONO },
  section: { flexDirection: 'column', gap: 4 },
  sectionTitle: { fontSize: 11, color: C.dim, fontWeight: 'bold' },
  field: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  fieldName: { width: 110, fontSize: 12, color: C.dim, flexShrink: 0 },
  fieldValue: { fontSize: 12, color: C.text, flexGrow: 1, flexBasis: 0 },
  member: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    paddingTop: 2,
    paddingBottom: 2,
  },
  memberName: {
    fontSize: 12,
    color: C.text,
    fontFamily: MONO,
    width: 200,
    flexShrink: 0,
  },
  memberType: {
    fontSize: 11,
    color: C.dim,
    fontFamily: MONO,
    flexGrow: 1,
    flexBasis: 0,
  },
  empty: { fontSize: 12, color: C.faint },
  error: { fontSize: 12, color: C.bad },
  hint: { fontSize: 11, color: C.faint },
});

// --- the node ids -----------------------------------------------------------
//
// The tree is keyed by strings so that expansion survives a reload of any
// branch. `|` is the separator because D-Bus permits it nowhere: bus names are
// `[A-Za-z0-9_.-]`, object paths `[A-Za-z0-9_/]`, interface names
// `[A-Za-z0-9_.]`. Nothing has to be escaped, and nothing can collide.

const idOf = (...parts) => parts.join('|');
const partsOf = (id) => id.split('|');
const kindOf = (id) => partsOf(id)[0];

// --- talking to the bus -----------------------------------------------------

/**
 * Every call is raced against a deadline.
 *
 * A name whose owner is wedged, or which does not implement Introspectable at
 * all, never answers — and a tree node that says `loading…` forever is worse
 * than one that says what went wrong, because there is nothing to do about it
 * and nothing to read.
 */
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not answer within ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

/**
 * Interfaces every object has. An object that declares only these is not an
 * object anyone came to look at — it is a directory node that D-Bus happens
 * to express as an object path.
 */
const SCAFFOLDING = new Set([
  'org.freedesktop.DBus.Peer',
  'org.freedesktop.DBus.Introspectable',
  'org.freedesktop.DBus.Properties',
  'org.freedesktop.DBus.ObjectManager',
]);

const joinPath = (base, node) => `${base === '/' ? '' : base}/${node}`;

/** Child object paths of `path`, from one Introspect. */
async function childPaths(bus, service, path) {
  const obj = await withDeadline(
    bus.getObject(service, path),
    4000,
    `Introspect ${service} ${path}`,
  );
  return (obj.nodes ?? []).map((node) => joinPath(path, node));
}

/**
 * Skip the scaffolding.
 *
 * `org.freedesktop.Notifications` publishes one object, and reaching it means
 * walking `/` → `/org` → `/org/freedesktop` → `/org/freedesktop/Notifications`
 * — three rows that say nothing and three clicks that teach nothing. So the
 * walk keeps descending while a node declares no interfaces of its own and
 * has exactly one child, and the row shows where it landed. Every D-Bus
 * browser does this; the paths are a namespace, not a hierarchy anybody
 * arranged.
 *
 * Bounded, because the cost is one Introspect per level and a service is free
 * to publish a very deep tree.
 */
async function compressPath(bus, service, path, budget = 8) {
  let current = path;
  for (let depth = 0; depth < budget; depth++) {
    const obj = await withDeadline(
      bus.getObject(service, current),
      4000,
      `Introspect ${service} ${current}`,
    );
    const own = Object.keys(obj.proxy ?? {}).filter((n) => !SCAFFOLDING.has(n));
    const nodes = obj.nodes ?? [];
    if (own.length || nodes.length !== 1) return current;
    current = joinPath(current, nodes[0]);
  }
  return current;
}

/** The interfaces an object declares, with their members. */
async function interfacesOf(bus, service, path) {
  const obj = await withDeadline(
    bus.getObject(service, path),
    4000,
    `Introspect ${service} ${path}`,
  );
  return Object.entries(obj.proxy ?? {}).map(([name, iface]) => ({
    name,
    methods: Object.entries(iface.$methods ?? {}).map(([m, signature]) => ({
      name: m,
      signature,
    })),
    // A signal is `[signature, ...argument names]`, so the head is the type
    // and the tail is what the arguments are called.
    signals: Object.entries(iface.$signals ?? {}).map(([m, decl]) => ({
      name: m,
      signature: Array.isArray(decl) ? decl[0] : '',
      args: Array.isArray(decl) ? decl.slice(1) : [],
    })),
    properties: Object.entries(iface.$properties ?? {}).map(([p, decl]) => ({
      name: p,
      type: decl?.type ?? '?',
      access: decl?.access ?? 'read',
    })),
  }));
}

/** Every readable property on one interface, in a single GetAll. */
async function readProperties(bus, service, path, interfaceName) {
  const obj = await withDeadline(
    bus.getObject(service, path),
    4000,
    `Introspect ${service} ${path}`,
  );
  const iface = obj.proxy?.[interfaceName];
  if (!iface?.$readAllProps) return {};
  return withDeadline(
    iface.$readAllProps(),
    4000,
    `GetAll on ${interfaceName}`,
  );
}

/**
 * A D-Bus value as one line of text.
 *
 * Written out rather than reached for from `dbus-native`'s `toPlain`, because
 * this file must not import the transport — see the header. It covers what
 * actually comes back: primitives, byte arrays, arrays, dict entries as
 * `[key, value]` pairs, and both variant shapes (the classic
 * `[signature, [value]]` pair and the `Variant` class).
 */
function formatValue(value, depth = 0) {
  if (value === null || value === undefined) return '—';
  if (depth > 4) return '…';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object') return String(value);

  if (value instanceof Uint8Array || Buffer.isBuffer?.(value)) {
    const head = [...value.slice(0, 12)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    return `<${value.length} bytes${value.length ? ` ${head}` : ''}${
      value.length > 12 ? ' …' : ''
    }>`;
  }
  // The forward-compatible variant: { signature, value }.
  if (typeof value.signature === 'string' && 'value' in value) {
    return formatValue(value.value, depth + 1);
  }
  if (Array.isArray(value)) {
    // The classic variant, [[{type,child}…], [value]] — unwrap to the value.
    if (
      value.length === 2 &&
      Array.isArray(value[0]) &&
      Array.isArray(value[1]) &&
      value[1].length === 1 &&
      value[0][0] &&
      typeof value[0][0] === 'object' &&
      'type' in value[0][0]
    ) {
      return formatValue(value[1][0], depth + 1);
    }
    if (value.length === 0) return '[]';
    const items = value
      .slice(0, 8)
      .map((v) => formatValue(v, depth + 1))
      .join(', ');
    return `[${items}${value.length > 8 ? `, … ${value.length} total` : ''}]`;
  }
  const entries = Object.entries(value).slice(0, 8);
  if (!entries.length) return '{}';
  return `{ ${entries
    .map(([k, v]) => `${k}: ${formatValue(v, depth + 1)}`)
    .join(', ')} }`;
}

// --- the tree ---------------------------------------------------------------

const LOADING = (parent) => [
  { id: idOf('loading', parent), label: 'loading…', disabled: true },
];

const failure = (parent, message) => [
  { id: idOf('failed', parent), label: `⚠ ${message}`, disabled: true },
];

/**
 * Children per node id, plus what is still in flight.
 *
 * Kept in one map rather than in the tree items themselves, so that a reload
 * of one branch never rebuilds the array identity of its siblings — and so a
 * failure can sit in the tree as a readable row.
 */
function useLoader(buses) {
  const [loaded, setLoaded] = useState({});
  const [pending, setPending] = useState({});

  // A bus that goes away invalidates everything read over it. The alternative
  // is a tree of paths that no longer resolve, which looks like data.
  const generations = buses.map((b) => b.handle.uniqueName).join(',');
  useEffect(() => {
    setLoaded({});
    setPending({});
  }, [generations]);

  const load = useCallback(
    async (id, fetcher) => {
      setPending((prev) => ({ ...prev, [id]: true }));
      try {
        const children = await fetcher();
        setLoaded((prev) => ({ ...prev, [id]: children }));
      } catch (err) {
        setLoaded((prev) => ({ ...prev, [id]: { error: err.message } }));
      } finally {
        setPending((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [setLoaded, setPending],
  );

  return { loaded, pending, load, reset: () => setLoaded({}) };
}

/** The rows under a node, given what has been loaded for it. */
function childrenFor(id, loaded, pending) {
  if (pending[id]) return LOADING(id);
  const entry = loaded[id];
  if (!entry) return [];
  if (entry.error) return failure(id, entry.error);
  return entry;
}

// --- panes ------------------------------------------------------------------

function Field({ name, children }) {
  return (
    <box style={s.field}>
      <text style={s.fieldName}>{name}</text>
      <text style={s.fieldValue}>{children}</text>
    </box>
  );
}

function Section({ title, empty, children, count }) {
  return (
    <box style={s.section}>
      <text style={s.sectionTitle}>
        {title}
        {count === undefined ? '' : ` (${count})`}
      </text>
      {count === 0 ? <text style={s.empty}>{empty}</text> : children}
    </box>
  );
}

function BusPane({ bus }) {
  const { handle, label, address } = bus;
  return (
    <box style={s.pane}>
      <text style={s.paneKind}>CONNECTION</text>
      <text style={s.paneTitle}>{label}</text>
      <Field name="status">{handle.status}</Field>
      <Field name="unique name">{handle.uniqueName ?? '—'}</Field>
      <Field name="address">{address}</Field>
      {handle.cause ? (
        <Field name="why">{String(handle.cause.cause?.message ?? '')}</Field>
      ) : null}
      <text style={s.hint}>
        {handle.status === 'ready'
          ? 'One connection, shared by everything in this process — the tray, ' +
            'the menu and an exported service would all be on this same ' +
            'socket and this same unique name.'
          : "'unavailable' is a snapshot, not a verdict: failure is not " +
            'cached, so a bus that appears later is found on the next ' +
            'acquisition.'}
      </text>
    </box>
  );
}

function NamePane({ bus, service }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    const read = async () => {
      const b = bus.handle.bus;
      if (!b) return;
      const get = async (fn) => {
        try {
          return await withDeadline(fn(), 3000, 'the bus');
        } catch (err) {
          return `⚠ ${err.message}`;
        }
      };
      const owner = await get(() => b.getNameOwner(service));
      const pid = await get(() => b.getConnectionUnixProcessId(service));
      const uid = await get(() => b.getConnectionUnixUser(service));
      if (live) setInfo({ owner, pid, uid });
    };
    read();
    return () => {
      live = false;
    };
  }, [bus.handle.bus, service]);

  return (
    <box style={s.pane}>
      <text style={s.paneKind}>BUS NAME</text>
      <text style={s.paneTitle}>{service}</text>
      <Field name="owner">{String(info?.owner ?? '…')}</Field>
      <Field name="pid">{String(info?.pid ?? '…')}</Field>
      <Field name="uid">{String(info?.uid ?? '…')}</Field>
      <text style={s.hint}>
        Expand it in the tree to walk the object paths this name publishes.
      </text>
    </box>
  );
}

function ObjectPane({ bus, service, path }) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    const b = bus.handle.bus;
    if (!b) return undefined;
    interfacesOf(b, service, path).then(
      (interfaces) => live && setState({ status: 'ok', interfaces }),
      (err) => live && setState({ status: 'error', message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [bus.handle.bus, service, path]);

  return (
    <box style={s.pane}>
      <text style={s.paneKind}>OBJECT</text>
      <text style={s.paneTitle}>{path}</text>
      <Field name="on">{service}</Field>
      {state.status === 'loading' ? (
        <text style={s.empty}>introspecting…</text>
      ) : state.status === 'error' ? (
        <text style={s.error}>⚠ {state.message}</text>
      ) : (
        <Section
          title="Interfaces"
          count={state.interfaces.length}
          empty="none — this path is a container for the ones below it"
        >
          {state.interfaces.map((iface) => (
            <box key={iface.name} style={s.member}>
              <text style={s.memberName}>{iface.name}</text>
              <text style={s.memberType}>
                {`${iface.methods.length} methods · ${iface.signals.length} signals · ${iface.properties.length} properties`}
              </text>
            </box>
          ))}
        </Section>
      )}
    </box>
  );
}

function InterfacePane({ bus, service, path, interfaceName }) {
  const [state, setState] = useState({ status: 'loading' });
  const [values, setValues] = useState(null);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    setValues(null);
    const b = bus.handle.bus;
    if (!b) return undefined;
    interfacesOf(b, service, path).then(
      (interfaces) => {
        if (!live) return;
        const found = interfaces.find((i) => i.name === interfaceName);
        setState(
          found
            ? { status: 'ok', iface: found }
            : { status: 'error', message: 'the object no longer declares it' },
        );
      },
      (err) => live && setState({ status: 'error', message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [bus.handle.bus, service, path, interfaceName]);

  // Property values are a call, so they are asked for rather than assumed —
  // reading them is observable to the service, and some of them are expensive.
  const readValues = async () => {
    setValues({ status: 'loading' });
    try {
      const props = await readProperties(
        bus.handle.bus,
        service,
        path,
        interfaceName,
      );
      setValues({ status: 'ok', props });
    } catch (err) {
      setValues({ status: 'error', message: err.message });
    }
  };

  if (state.status !== 'ok') {
    return (
      <box style={s.pane}>
        <text style={s.paneKind}>INTERFACE</text>
        <text style={s.paneTitle}>{interfaceName}</text>
        {state.status === 'loading' ? (
          <text style={s.empty}>introspecting…</text>
        ) : (
          <text style={s.error}>⚠ {state.message}</text>
        )}
      </box>
    );
  }

  const { iface } = state;
  return (
    <box style={s.pane}>
      <text style={s.paneKind}>INTERFACE</text>
      <text style={s.paneTitle}>{interfaceName}</text>
      <Field name="on">{`${service} ${path}`}</Field>

      <Section title="Methods" count={iface.methods.length} empty="none">
        {iface.methods.map((m) => (
          <box key={m.name} style={s.member}>
            <text style={s.memberName}>{m.name}</text>
            <text style={s.memberType}>
              {m.signature ? `in: ${m.signature}` : 'no arguments'}
            </text>
          </box>
        ))}
      </Section>

      <Section title="Signals" count={iface.signals.length} empty="none">
        {iface.signals.map((sig) => (
          <box key={sig.name} style={s.member}>
            <text style={s.memberName}>{sig.name}</text>
            <text style={s.memberType}>
              {sig.args.length
                ? `${sig.signature} (${sig.args.join(', ')})`
                : sig.signature || '—'}
            </text>
          </box>
        ))}
      </Section>

      <Section title="Properties" count={iface.properties.length} empty="none">
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button
            onClick={readValues}
            disabled={values?.status === 'loading'}
            style={{ alignSelf: 'flex-start' }}
          >
            {values ? 'Re-read values' : 'Read values (GetAll)'}
          </Button>
          {values?.status === 'error' ? (
            <text style={s.error}>⚠ {values.message}</text>
          ) : null}
        </box>
        {iface.properties.map((p) => (
          <box key={p.name} style={s.member}>
            <text style={s.memberName}>{p.name}</text>
            <text style={s.memberType}>
              {`${p.type} · ${p.access}` +
                (values?.status === 'ok'
                  ? `  =  ${formatValue(values.props[p.name])}`
                  : '')}
            </text>
          </box>
        ))}
      </Section>
    </box>
  );
}

function Placeholder() {
  return (
    <box style={s.pane}>
      <text style={s.paneKind}>NOTHING SELECTED</text>
      <text style={s.empty}>
        Pick a row on the left. Expanding a name introspects it, which is a
        round trip per node — so branches fill in as they open rather than all
        at once.
      </text>
    </box>
  );
}

// --- the header -------------------------------------------------------------

function BusChip({ bus }) {
  const { handle, label, address } = bus;
  const colour =
    handle.status === 'ready'
      ? C.good
      : handle.status === 'connecting'
        ? C.warn
        : C.bad;
  return (
    <box style={s.chip}>
      <box style={s.chipTop}>
        <box style={[s.dot, { backgroundColor: colour }]} />
        <text style={s.chipName}>{label}</text>
        <box style={{ flexGrow: 1 }} />
        {handle.status === 'closed' || handle.status === 'unavailable' ? (
          <Button onClick={handle.retry}>Retry</Button>
        ) : null}
      </box>
      <text style={s.chipLine}>
        {handle.status === 'ready' ? handle.uniqueName : handle.status}
      </text>
      <text style={s.chipLine}>{address}</text>
      {handle.cause ? (
        <text style={s.chipWhy}>
          {String(handle.cause.cause?.message ?? '')}
        </text>
      ) : null}
    </box>
  );
}

// --- the app ----------------------------------------------------------------

function App() {
  const session = useSessionBus();
  const system = useSystemBus();
  const [showUnique, setShowUnique] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [selected, setSelected] = useState(null);

  const buses = useMemo(
    () => [
      {
        kind: 'session',
        label: 'Session bus',
        handle: session,
        address:
          process.env.DBUS_SESSION_BUS_ADDRESS ??
          (process.env.XDG_RUNTIME_DIR
            ? `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`
            : '(no address)'),
      },
      {
        kind: 'system',
        label: 'System bus',
        handle: system,
        address:
          process.env.DBUS_SYSTEM_BUS_ADDRESS ??
          'unix:path=/var/run/dbus/system_bus_socket',
      },
    ],
    [session, system],
  );

  const byKind = useMemo(
    () => Object.fromEntries(buses.map((b) => [b.kind, b])),
    [buses],
  );
  const { loaded, pending, load } = useLoader(buses);

  // Expanding is where every round trip is triggered. The tree hands back the
  // whole open set, so the new id is whatever was not open before.
  const onExpandedChange = (next) => {
    const opened = next.filter((id) => !expanded.includes(id));
    setExpanded(next);
    for (const id of opened) {
      if (loaded[id] || pending[id]) continue;
      const parts = partsOf(id);
      const bus = byKind[parts[1]];
      const b = bus?.handle.bus;
      if (!b) continue;
      if (parts[0] === 'bus') {
        load(id, async () => {
          const names = await withDeadline(b.listNames(), 4000, 'ListNames');
          return names
            .filter((n) => showUnique || !n.startsWith(':'))
            .sort()
            .map((name) => ({
              id: idOf('name', parts[1], name),
              label: name,
              children: [],
            }));
        });
      } else if (parts[0] === 'name') {
        // A name's tree starts at the first object worth looking at, which is
        // rarely `/` — see compressPath.
        load(id, async () => {
          const root = await compressPath(b, parts[2], '/');
          return [
            {
              id: idOf('path', parts[1], parts[2], root),
              label: root,
              children: [],
            },
          ];
        });
      } else if (parts[0] === 'path') {
        load(id, async () => {
          const [paths, interfaces] = await Promise.all([
            childPaths(b, parts[2], parts[3]),
            interfacesOf(b, parts[2], parts[3]),
          ]);
          const compressed = await Promise.all(
            paths.map((p) => compressPath(b, parts[2], p)),
          );
          return [
            ...interfaces.map((iface) => ({
              id: idOf('iface', parts[1], parts[2], parts[3], iface.name),
              label: iface.name,
            })),
            ...compressed.map((p) => ({
              id: idOf('path', parts[1], parts[2], p),
              label: p,
              children: [],
            })),
          ];
        });
      }
    }
  };

  const items = useMemo(
    () =>
      buses.map((bus) => {
        const id = idOf('bus', bus.kind);
        const ready = bus.handle.status === 'ready';
        const decorate = (node) => ({
          ...node,
          children: Array.isArray(node.children)
            ? childrenFor(node.id, loaded, pending).map(decorate)
            : undefined,
        });
        return {
          id,
          label: `${bus.label}${ready ? ` — ${bus.handle.uniqueName}` : ` — ${bus.handle.status}`}`,
          // A bus with no connection is still a branch, so the twisty is there
          // the moment it comes back rather than after a re-render nobody
          // triggers.
          children: ready ? childrenFor(id, loaded, pending).map(decorate) : [],
        };
      }),
    [buses, loaded, pending],
  );

  const detail = () => {
    if (!selected) return <Placeholder />;
    const parts = partsOf(selected);
    const bus = byKind[parts[1]];
    if (!bus) return <Placeholder />;
    switch (kindOf(selected)) {
      case 'bus':
        return <BusPane bus={bus} />;
      case 'name':
        return <NamePane bus={bus} service={parts[2]} />;
      case 'path':
        return <ObjectPane bus={bus} service={parts[2]} path={parts[3]} />;
      case 'iface':
        return (
          <InterfacePane
            bus={bus}
            service={parts[2]}
            path={parts[3]}
            interfaceName={parts[4]}
          />
        );
      default:
        return <Placeholder />;
    }
  };

  return (
    <window
      title="react-x11 — D-Bus explorer"
      width={1000}
      height={660}
      minWidth={640}
      minHeight={420}
      theme={THEME}
      style={s.window}
    >
      <ThemeProvider value={THEME}>
        <box style={s.header}>
          {buses.map((bus) => (
            <BusChip key={bus.kind} bus={bus} />
          ))}
        </box>
        <box style={s.rule} />

        <SplitPane direction="row" defaultSize={340} min={220} minSecond={320}>
          <box style={s.sidebar}>
            <box style={s.sidebarHead}>
              <text style={s.sidebarTitle}>names → objects → interfaces</text>
              <Button
                onClick={() => {
                  // Unique names double the list and are rarely what you are
                  // looking for, so they are opt-in. Collapsing the buses is
                  // what makes the next expansion re-read ListNames.
                  setShowUnique((v) => !v);
                  setExpanded([]);
                }}
              >
                {showUnique ? 'Hide :1.x' : 'Show :1.x'}
              </Button>
            </box>
            <box style={s.rule} />
            <Tree
              items={items}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
              selected={selected}
              onSelect={setSelected}
            />
          </box>

          <box style={{ overflow: 'scroll', flexGrow: 1 }}>{detail()}</box>
        </SplitPane>
      </ThemeProvider>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
