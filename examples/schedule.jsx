// A conference schedule: three days, five rooms, and a grid of talks to star.
//
//   npm run examples:schedule
//
// A timetable is the layout `position: 'sticky'` exists for (docs/styling.md,
// "Sticky positioning"): the grid scrolls both ways, and the part that says
// what you are looking at never leaves. Nothing here listens to the scroll —
// every held edge below is a style.
//
// ## What to try
//
//   Scroll down     each day's header holds the top of the pane, and the next
//                   day's header pushes it off as it arrives: a header cannot
//                   leave the day it belongs to.
//   Scroll across   (shift + wheel, or a touchpad) the times hold the start
//                   edge and the talks slide under them. The day's name is
//                   sticky inside its own banner, so it stays readable however
//                   far across you are.
//   The corner      where the room names meet the times: held both ways at
//                   once, over everything.
//   Star a talk     click it, or Tab to it and press Space. "Starred" keeps
//                   just those.
//   Jump to a day   the chips scroll straight to it. Where a day is comes from
//                   its `onLayout`, which reports where layout put the day —
//                   not where its header happens to be held.
//   LANG=he_IL.UTF-8 npm run examples:schedule
//                   the whole grid mirrors, and the times hold the right-hand
//                   edge: they stick by `start`, not by `left`.
//
// What does not work yet: CSS's `scroll-padding`. Tab to a talk and the pane
// scrolls it to the edge it needs — which can be under the held header.
import React, { useCallback, useMemo, useRef, useState } from 'react';

import { createRoot, createStyles } from '../src/index.js';
import { XK_KP_ENTER, XK_RETURN, XK_SPACE } from '../src/keysyms.js';

const TIME_WIDTH = 64;
const COLUMN = 200;
const BANNER = 36;
const ROOMS_ROW = 32;
const SLOT = 44; // half an hour
const FIRST_HOUR = 9;
const SLOTS = 18; // 09:00 to 18:00
const LUNCH = { start: 7, length: 2 }; // 12:30 to 13:30

const DAYS = [
  { id: 'thu', short: 'Thu', name: 'Thursday', date: '12 November' },
  { id: 'fri', short: 'Fri', name: 'Friday', date: '13 November' },
  { id: 'sat', short: 'Sat', name: 'Saturday', date: '14 November' },
];

const ROOMS = [
  { id: 'hall', name: 'Main Hall', seats: 900 },
  { id: 'harbour', name: 'Harbour', seats: 320 },
  { id: 'loft', name: 'The Loft', seats: 140 },
  { id: 'studio', name: 'Studio B', seats: 80 },
  { id: 'lab', name: 'Hack Lab', seats: 40 },
];

const TRACKS = {
  keynote: { label: 'Keynote', color: '#8b5cf6' },
  rendering: { label: 'Rendering', color: '#3b82f6' },
  protocol: { label: 'Protocol', color: '#f59e0b' },
  react: { label: 'React', color: '#10b981' },
  tooling: { label: 'Tooling', color: '#ec4899' },
};

const KEYNOTES = [
  'Opening keynote: the wire carries drawing',
  'Keynote: retained mode, revisited',
  'Closing keynote: what a frame costs',
];

const TALKS = [
  ['Damage rects, and the frames they save', 'rendering'],
  ['Scrolling at the speed of CopyArea', 'rendering'],
  ['Glyph caches and where they live', 'rendering'],
  ['Colour spaces for the rest of us', 'rendering'],
  ['Shadows you only blur once', 'rendering'],
  ['GL inside a retained tree', 'rendering'],
  ['Hit testing in reverse paint order', 'rendering'],
  ['Sticky headers from first principles', 'rendering'],
  ['A tour of the X11 wire', 'protocol'],
  ['Drag and drop between strangers', 'protocol'],
  ['Clipboard archaeology', 'protocol'],
  ['Keyboard layouts are not keymaps', 'protocol'],
  ['Window managers are just clients', 'protocol'],
  ['Accessibility over D-Bus', 'protocol'],
  ['Idle, awake, and in between', 'protocol'],
  ['Round trips you did not mean to make', 'protocol'],
  ['Fast Refresh outside the browser', 'react'],
  ['Custom renderers without tears', 'react'],
  ['Container queries in a flexbox world', 'react'],
  ['Virtual lists that do not flicker', 'react'],
  ['Transitions that reverse mid-flight', 'react'],
  ['Designing for right-to-left', 'react'],
  ['Forms a screen reader can use', 'react'],
  ['Suspense for the desktop', 'react'],
  ['Testing pixels without a screen', 'tooling'],
  ['Benchmarks that fail loudly', 'tooling'],
  ['Packaging a single executable', 'tooling'],
  ['Profiling a frame, end to end', 'tooling'],
  ['Mutation testing, honestly', 'tooling'],
  ['Fonts are hard: shaping and fallback', 'tooling'],
];

const SPEAKERS = [
  'Ada Okafor',
  'Mika Lindqvist',
  'Priya Raman',
  'Tomás Herrera',
  'Lena Vogel',
  'Kenji Sato',
  'Amara Diallo',
  'Jonas Berg',
  'Sofia Marin',
  'Idris Haddad',
  'Noor Aziz',
  'Mateo Ruiz',
  'Hanna Koskinen',
  'Ravi Menon',
  'Elena Petrova',
  'Oskar Nilsson',
];

/** A small seeded generator, so the schedule is the same on every run: a
 *  screenshot, a test and a reader can all point at the same talk. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The programme, as data: `{ days, rooms, talks }`, where a talk sits in one
 * room for `length` half-hour slots from `start`. The app takes any schedule
 * of this shape — this is the seam the tests use.
 */
export function buildSchedule(seed = 2026) {
  const next = seeded(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const talks = [];
  DAYS.forEach((day, d) => {
    ROOMS.forEach((room, r) => {
      let slot = 2;
      if (r === 0) {
        talks.push({
          id: `${day.id}-keynote`,
          day: day.id,
          room: room.id,
          start: 0,
          length: 2,
          title: KEYNOTES[d],
          speaker: pick(SPEAKERS),
          track: 'keynote',
        });
      }
      while (slot < SLOTS) {
        if (slot >= LUNCH.start && slot < LUNCH.start + LUNCH.length) {
          slot = LUNCH.start + LUNCH.length;
          continue;
        }
        // a gap now and then, to catch your breath
        if (next() < 0.12) {
          slot++;
          continue;
        }
        let length = 1 + Math.floor(next() * 3);
        if (slot < LUNCH.start) length = Math.min(length, LUNCH.start - slot);
        length = Math.min(length, SLOTS - slot);
        const [title, track] = pick(TALKS);
        talks.push({
          id: `${day.id}-${room.id}-${slot}`,
          day: day.id,
          room: room.id,
          start: slot,
          length,
          title,
          speaker: pick(SPEAKERS),
          track,
        });
        slot += length;
      }
    });
  });
  return { days: DAYS, rooms: ROOMS, talks };
}

const SCHEDULE = buildSchedule();

/** `09:30` for a slot index. */
export function timeOf(slot) {
  const minutes = FIRST_HOUR * 60 + slot * 30;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

const s = createStyles({
  root: { flexGrow: 1, backgroundColor: '$background' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 16,
    paddingEnd: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  heading: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: 'bold', color: '$text' },
  subtitle: {
    fontSize: 12,
    color: '$textMuted',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },
  chip: {
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '$border',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  chipOn: {
    backgroundColor: '$accent',
    borderColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  chipText: { fontSize: 12, color: '$text' },
  chipTextOn: { color: '$accentText' },

  pane: { overflow: 'scroll', flexGrow: 1 },
  day: { flexShrink: 0 },

  // The day's banner and its row of rooms, held at the top of the pane as
  // one piece — so the next day pushes both off together, rather than the
  // rooms sliding up over the banner on the way out.
  dayHeader: { position: 'sticky', top: 0, flexShrink: 0 },
  banner: {
    height: BANNER,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '$accent',
  },
  // sticky inside the banner, which scrolls across with the grid: the day's
  // name stays at the start edge of the pane
  bannerLabel: {
    position: 'sticky',
    start: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingStart: 16,
    paddingEnd: 16,
  },
  bannerDay: { fontSize: 15, fontWeight: 'bold', color: '$accentText' },
  bannerDate: { fontSize: 12, color: '$accentText' },
  roomsRow: {
    height: ROOMS_ROW,
    flexShrink: 0,
    flexDirection: 'row',
    backgroundColor: '$surface',
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  // held at the start edge inside a header held at the top: the corner
  corner: {
    position: 'sticky',
    start: 0,
    width: TIME_WIDTH,
    flexShrink: 0,
    justifyContent: 'center',
    paddingStart: 10,
    backgroundColor: '$surface',
    borderEndWidth: 1,
    borderColor: '$border',
  },
  cornerText: { fontSize: 11, color: '$textMuted' },
  roomCell: {
    width: COLUMN,
    flexShrink: 0,
    justifyContent: 'center',
    paddingStart: 10,
    paddingEnd: 10,
  },
  roomName: { fontSize: 12, fontWeight: 'bold', color: '$text' },
  roomSeats: { fontSize: 11, color: '$textMuted' },

  body: { flexDirection: 'row', flexShrink: 0 },
  // the times, held at the start edge while the talks scroll under them
  times: {
    position: 'sticky',
    start: 0,
    width: TIME_WIDTH,
    flexShrink: 0,
    backgroundColor: '$surface',
    borderEndWidth: 1,
    borderColor: '$border',
  },
  slot: { height: SLOT, flexShrink: 0, paddingStart: 10, paddingTop: 4 },
  hour: { fontSize: 12, color: '$text' },
  halfHour: { fontSize: 11, color: '$textMuted' },
  grid: { position: 'relative', height: SLOTS * SLOT, flexShrink: 0 },
  hourLine: {
    position: 'absolute',
    start: 0,
    end: 0,
    height: 1,
    backgroundColor: '$border',
  },
  columnLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: '$border',
  },
  lunch: {
    position: 'absolute',
    start: 0,
    end: 0,
    top: LUNCH.start * SLOT + 1,
    height: LUNCH.length * SLOT - 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '$surface',
  },
  lunchText: { fontSize: 12, color: '$textMuted' },

  talk: {
    position: 'absolute',
    overflow: 'hidden',
    gap: 2,
    paddingStart: 8,
    paddingEnd: 6,
    paddingTop: 4,
    paddingBottom: 3,
    backgroundColor: '$surface',
    borderWidth: 1,
    borderStartWidth: 4,
    borderColor: '$border',
    cursor: 'pointer',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  starred: {
    backgroundColor: '$selection',
    ':hover': { backgroundColor: '$selection' },
  },
  talkTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '$text',
    maxLines: 2,
    textOverflow: 'ellipsis',
  },
  // half an hour has room for one line of title and one of detail
  oneLine: { maxLines: 1 },
  talkMeta: {
    fontSize: 11,
    color: '$textMuted',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },
});

/** Space, Return or a click: the props that make a box a button. */
function pressable(onPress) {
  return {
    role: 'button',
    focusable: true,
    onClick: onPress,
    onKeyDown: (ev) => {
      if (
        ev.keysym === XK_SPACE ||
        ev.keysym === XK_RETURN ||
        ev.keysym === XK_KP_ENTER
      ) {
        ev.preventDefault();
        onPress();
      }
    },
  };
}

function Talk({ talk, column, starred, onToggle }) {
  const track = TRACKS[talk.track];
  const toggle = useCallback(() => onToggle(talk.id), [onToggle, talk.id]);
  const until = timeOf(talk.start + talk.length);
  return (
    <box
      {...pressable(toggle)}
      aria-pressed={starred}
      aria-label={`${talk.title}, ${talk.speaker}, ${timeOf(talk.start)} to ${until}`}
      data-testname={`talk-${talk.id}`}
      style={[
        s.talk,
        {
          start: column * COLUMN + 4,
          top: talk.start * SLOT + 3,
          width: COLUMN - 8,
          height: talk.length * SLOT - 6,
          borderStartColor: track.color,
        },
        starred && s.starred,
      ]}
    >
      <text style={[s.talkTitle, talk.length === 1 && s.oneLine]}>
        {starred ? '★ ' : ''}
        {talk.title}
      </text>
      {talk.length > 1 && <text style={s.talkMeta}>{talk.speaker}</text>}
      <text style={s.talkMeta}>
        {timeOf(talk.start)}–{until} · {track.label}
      </text>
    </box>
  );
}

function Day({ day, rooms, talks, starred, onToggle, onPlaced }) {
  const columns = useMemo(
    () => new Map(rooms.map((room, i) => [room.id, i])),
    [rooms],
  );
  return (
    <box
      style={[s.day, { width: TIME_WIDTH + rooms.length * COLUMN }]}
      data-testname={`day-${day.id}`}
      onLayout={(rect) => onPlaced(day.id, rect.y)}
    >
      <box style={s.dayHeader} data-testname={`header-${day.id}`}>
        <box style={s.banner}>
          <box style={s.bannerLabel} data-testname={`label-${day.id}`}>
            <text style={s.bannerDay}>{day.name}</text>
            <text style={s.bannerDate}>{day.date}</text>
          </box>
        </box>
        <box style={s.roomsRow}>
          <box style={s.corner} data-testname={`corner-${day.id}`}>
            <text style={s.cornerText}>{day.short}</text>
          </box>
          {rooms.map((room) => (
            <box key={room.id} style={s.roomCell}>
              <text style={s.roomName}>{room.name}</text>
              <text style={s.roomSeats}>{room.seats} seats</text>
            </box>
          ))}
        </box>
      </box>
      <box style={s.body}>
        <box style={s.times} data-testname={`times-${day.id}`}>
          {Array.from({ length: SLOTS }, (_, i) => (
            <box key={i} style={s.slot}>
              <text style={i % 2 ? s.halfHour : s.hour}>{timeOf(i)}</text>
            </box>
          ))}
        </box>
        <box style={[s.grid, { width: rooms.length * COLUMN }]}>
          {Array.from({ length: SLOTS / 2 }, (_, i) => (
            <box key={`h${i}`} style={[s.hourLine, { top: i * 2 * SLOT }]} />
          ))}
          {rooms.map((room, i) => (
            <box
              key={`c${room.id}`}
              style={[s.columnLine, { start: i * COLUMN }]}
            />
          ))}
          <box style={s.lunch}>
            <text style={s.lunchText}>
              Lunch · {timeOf(LUNCH.start)}–{timeOf(LUNCH.start + LUNCH.length)}
            </text>
          </box>
          {talks.map((talk) => (
            <Talk
              key={talk.id}
              talk={talk}
              column={columns.get(talk.room)}
              starred={starred.has(talk.id)}
              onToggle={onToggle}
            />
          ))}
        </box>
      </box>
    </box>
  );
}

export function SchedulePanel({ schedule = SCHEDULE, initialStarred = [] }) {
  const [starred, setStarred] = useState(() => new Set(initialStarred));
  const [starredOnly, setStarredOnly] = useState(false);
  const pane = useRef(null);
  const dayTops = useRef(new Map());
  const toggle = useCallback((id) => {
    setStarred((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const placed = useCallback((id, y) => dayTops.current.set(id, y), []);
  const byDay = useMemo(() => {
    const out = new Map(schedule.days.map((day) => [day.id, []]));
    for (const talk of schedule.talks) out.get(talk.day)?.push(talk);
    return out;
  }, [schedule]);
  const shown = (talks) =>
    starredOnly ? talks.filter((talk) => starred.has(talk.id)) : talks;

  return (
    <box style={s.root}>
      <box style={s.toolbar}>
        <box style={s.heading}>
          <text style={s.title}>Retained Mode 2026</text>
          <text style={s.subtitle}>
            {schedule.days.length} days · {schedule.rooms.length} rooms ·{' '}
            {schedule.talks.length} talks
          </text>
        </box>
        {schedule.days.map((day) => (
          <box
            key={day.id}
            {...pressable(() =>
              pane.current?.scrollTo({ y: dayTops.current.get(day.id) ?? 0 }),
            )}
            aria-label={`Jump to ${day.name}`}
            data-testname={`jump-${day.id}`}
            style={s.chip}
          >
            <text style={s.chipText}>{day.short}</text>
          </box>
        ))}
        <box
          {...pressable(() => setStarredOnly((on) => !on))}
          aria-pressed={starredOnly}
          data-testname="starred-only"
          style={[s.chip, starredOnly && s.chipOn]}
        >
          <text style={[s.chipText, starredOnly && s.chipTextOn]}>
            ★ Starred · {starred.size}
          </text>
        </box>
      </box>
      <box ref={pane} style={s.pane} data-testname="pane">
        {schedule.days.map((day) => (
          <Day
            key={day.id}
            day={day}
            rooms={schedule.rooms}
            talks={shown(byDay.get(day.id) ?? [])}
            starred={starred}
            onToggle={toggle}
            onPlaced={placed}
          />
        ))}
      </box>
    </box>
  );
}

export function App(props) {
  return (
    <window
      width={900}
      height={620}
      minWidth={480}
      minHeight={360}
      title="Retained Mode 2026 — Schedule"
      style={{ backgroundColor: '$background' }}
    >
      <SchedulePanel {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}
