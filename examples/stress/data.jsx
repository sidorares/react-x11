// Tables: a big static one and a small live one.
//
// The big table is a windowing test — 50,000 rows, of which the twenty or so
// on screen are actually mounted. Scrolling it should stay smooth and the
// memory should not track the row count.
//
// The ticker is the interesting damage case: a timer changes a handful of
// cells per tick while the rest of the table holds still. Each tick is a
// React commit that walks the mounted rows, so it is exactly the case
// `paintChanged` exists for — an unchanged row whose style object was
// rebuilt must not claim damage. Watch the frame log: ticks should report a
// rect around the changed rows, not the window.
//
// What to look for:
//   - sorting 50,000 rows by clicking a header, and the selection surviving
//   - dragging a header edge resizing the column and the body following
//   - the ticker's arrows and colours matching the direction of each change
//   - keyboard: Up/Down/PageUp/PageDown/Home/End move the selection without
//     building the rows in between
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createStyles, Switch, Table } from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 16, gap: 10 },
  head: { fontSize: 18, color: '$text' },
  hint: { fontSize: 11, color: '$textMuted' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  split: { flexDirection: 'row', gap: 12, flexGrow: 1, minHeight: 0 },
  card: {
    backgroundColor: '$background',
    borderWidth: 1,
    borderColor: '$track',
    borderRadius: 4,
    padding: 8,
    gap: 6,
    minHeight: 0,
  },
  title: { fontSize: 12, color: '$text', flexShrink: 0 },
});

// --- the big one -----------------------------------------------------------

const KINDS = ['source', 'test', 'doc', 'asset', 'config'];
const OWNERS = ['ada', 'grace', 'alan', 'edsger', 'barbara', 'donald'];

const BIG_ROWS = Array.from({ length: 50000 }, (_, i) => ({
  id: i,
  name: `module-${String(i).padStart(6, '0')}.js`,
  kind: KINDS[i % KINDS.length],
  owner: OWNERS[(i * 7) % OWNERS.length],
  size: ((i * 2654435761) % 1048576) | 0,
  lines: ((i * 97) % 4000) + 12,
  modified: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
}));

const BIG_COLUMNS = [
  { id: 'name', label: 'Name', width: 190 },
  { id: 'kind', label: 'Kind', width: 80 },
  { id: 'owner', label: 'Owner', width: 90 },
  {
    id: 'size',
    label: 'Size',
    width: 90,
    align: 'right',
    value: (row) => row.size,
    // A cell that draws itself owns its colour, selected row included — the
    // selection is a filled bar, and `$text` on it is unreadable.
    render: (row, { selected }) => (
      <text
        style={{
          fontSize: 11,
          fontFamily: 'monospace',
          color: selected ? '$hoverText' : '$text',
        }}
      >
        {(row.size / 1024).toFixed(1)}k
      </text>
    ),
  },
  { id: 'lines', label: 'Lines', width: 70, align: 'right' },
  { id: 'modified', label: 'Modified', width: 110 },
];

function BigTable() {
  const [selected, setSelected] = useState(null);
  const [sort, setSort] = useState({ column: 'name', direction: 'asc' });

  // Sorting is the caller's job past a few thousand rows (docs/components.md),
  // and memoising it is the whole point — re-sorting 50k rows inside render
  // on every unrelated state change is what makes a table feel broken.
  const rows = useMemo(() => {
    const column = BIG_COLUMNS.find((c) => c.id === sort.column);
    const key = column?.value ?? ((row) => row[sort.column]);
    const sign = sort.direction === 'desc' ? -1 : 1;
    return [...BIG_ROWS].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      return sign * (av < bv ? -1 : av > bv ? 1 : 0);
    });
  }, [sort]);

  return (
    <box style={{ ...s.card, flexGrow: 1, flexBasis: 0 }}>
      <text style={s.title}>
        {BIG_ROWS.length.toLocaleString('en-US')} rows — sorted by {sort.column}{' '}
        {sort.direction}
      </text>
      <Table
        columns={BIG_COLUMNS}
        rows={rows}
        sort={sort}
        onSortChange={setSort}
        selected={selected}
        onSelect={setSelected}
        style={{ flexGrow: 1 }}
      />
      <text style={s.hint}>
        {selected == null
          ? 'nothing selected'
          : `selected ${BIG_ROWS[selected]?.name}`}
      </text>
    </box>
  );
}

// --- the live one ----------------------------------------------------------

const SYMBOLS = [
  'ACME',
  'BOLT',
  'CRUX',
  'DYNE',
  'EPIC',
  'FLUX',
  'GYRO',
  'HELM',
  'IRIS',
  'JOLT',
  'KILN',
  'LUME',
];

const initialTicker = () =>
  SYMBOLS.map((symbol, i) => ({
    id: symbol,
    symbol,
    price: 40 + i * 7.5,
    change: 0,
    volume: 1000 + i * 137,
  }));

const TICKER_COLUMNS = [
  { id: 'symbol', label: 'Symbol', width: 70 },
  {
    id: 'price',
    label: 'Price',
    width: 80,
    align: 'right',
    value: (row) => row.price,
    render: (row, { selected }) => (
      <text
        style={{
          fontSize: 11,
          fontFamily: 'monospace',
          color: selected ? '$hoverText' : '$text',
        }}
      >
        {row.price.toFixed(2)}
      </text>
    ),
  },
  {
    id: 'change',
    label: 'Change',
    width: 80,
    align: 'right',
    value: (row) => row.change,
    // Red and green both sink into the selection bar, so the selected row
    // drops the colour and lets the arrow carry the direction — which is the
    // reason to encode it twice in the first place.
    render: (row, { selected }) => (
      <text
        style={{
          fontSize: 11,
          fontFamily: 'monospace',
          color: selected
            ? '$hoverText'
            : row.change > 0
              ? '#00b894'
              : row.change < 0
                ? '#d63031'
                : '#b2bec3',
        }}
      >
        {row.change > 0 ? '▲' : row.change < 0 ? '▼' : '·'}{' '}
        {Math.abs(row.change).toFixed(2)}
      </text>
    ),
  },
  {
    id: 'volume',
    label: 'Volume',
    width: 80,
    align: 'right',
    value: (row) => row.volume,
  },
];

function TickerTable() {
  const [rows, setRows] = useState(initialTicker);
  const [live, setLive] = useState(false);
  const [perTick, setPerTick] = useState(2);
  const tick = useRef(0);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => {
      const n = tick.current++;
      setRows((prev) =>
        prev.map((row, i) => {
          // Only `perTick` rows move per tick, chosen by rotation rather than
          // at random: a deterministic pattern makes the frame log readable,
          // and it means the same drag can be compared across runs.
          if ((i + n) % Math.ceil(SYMBOLS.length / perTick) !== 0) return row;
          const delta = ((((i * 37 + n * 13) % 21) - 10) / 10) * 1.5;
          return {
            ...row,
            price: Math.max(1, row.price + delta),
            change: delta,
            volume: row.volume + (((i + n) % 7) + 1) * 10,
          };
        }),
      );
    }, 250);
    return () => clearInterval(timer);
  }, [live, perTick]);

  return (
    <box style={{ ...s.card, width: 340, flexShrink: 0 }}>
      <text style={s.title}>Live ticker</text>
      <box style={s.row}>
        <text style={s.hint}>live</text>
        <Switch checked={live} onChange={(ev) => setLive(ev.value)} />
        <text style={s.hint}>{perTick} rows/tick</text>
        <Switch
          checked={perTick > 2}
          onChange={(ev) => setPerTick(ev.value ? 12 : 2)}
        />
      </box>
      <Table
        columns={TICKER_COLUMNS}
        rows={rows}
        rowHeight={22}
        style={{ flexGrow: 1 }}
      />
      <text style={s.hint}>
        {live
          ? 'ticking every 250ms — watch the damage rect'
          : 'switch on to start the timer'}
      </text>
    </box>
  );
}

export function DataPanel() {
  return (
    <box style={s.panel}>
      <text style={s.head}>Data</text>
      <text style={s.hint}>
        A windowed table over fifty thousand rows next to a table whose cells
        change on a timer. The ticker is the damage test: a tick that repaints
        the whole window means an unchanged row claimed damage.
      </text>
      <box style={s.split}>
        <BigTable />
        <TickerTable />
      </box>
    </box>
  );
}
