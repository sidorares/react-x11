// Dates: `DatePicker` for one day and for a span, and the `Calendar` grid on
// its own with a day's events drawn into it.
//
// Everything on the right-hand switches is live — block the weekends, let a
// range span the days that are blocked, move the week's first day, change the
// locale — so the behaviour can be poked at rather than read about.
// Run with: npm run examples:datepicker  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  Calendar,
  DatePicker,
  Select,
  Switch,
  createRoot,
  createStyles,
} from '../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, padding: 16, gap: 12 },
  heading: { fontSize: 20, color: '$text' },
  hint: { fontSize: 11, color: '$textMuted' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: '$textMuted', width: 96 },
  value: { color: '$text' },
  columns: { flexDirection: 'row', gap: 16, flexGrow: 1, minHeight: 0 },
  card: {
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    backgroundColor: '$surface',
    padding: 8,
    gap: 8,
  },
  agenda: { flexGrow: 1, minWidth: 0, gap: 6, padding: 8 },
  agendaDay: { fontSize: 15, color: '$text' },
  event: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventTime: { fontSize: 12, color: '$textMuted', width: 46 },
  eventTitle: { fontSize: 12, color: '$text' },
  dot: { width: 5, height: 5, borderRadius: 3 },
  switches: { gap: 8 },
});

// A day the way the widgets want one: 'YYYY-MM-DD', local, no time on it.
const iso = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

const dayFromNow = (n) => {
  const date = new Date();
  date.setDate(date.getDate() + n);
  return iso(date);
};

const TODAY = dayFromNow(0);

// The overlay this control was designed to grow: a diary, keyed by day, drawn
// into the grid through `dayContent`. Nothing about it is special-cased in the
// widget — it is a callback returning boxes.
const KIND_COLOR = { work: '#e67e22', personal: '#27ae60', travel: '#8e44ad' };

const EVENTS = {
  [dayFromNow(0)]: [
    { time: '09:30', title: 'Standup', kind: 'work' },
    { time: '14:00', title: 'Renderer review', kind: 'work' },
  ],
  [dayFromNow(1)]: [{ time: '19:00', title: 'Climbing', kind: 'personal' }],
  [dayFromNow(3)]: [
    { time: '08:05', title: 'Train to Berlin', kind: 'travel' },
    { time: '11:00', title: 'X11 workshop', kind: 'work' },
    { time: '20:30', title: 'Dinner with M', kind: 'personal' },
  ],
  [dayFromNow(6)]: [{ time: '10:00', title: 'Dentist', kind: 'personal' }],
  [dayFromNow(9)]: [{ time: '17:45', title: 'Flight home', kind: 'travel' }],
};

// Days somebody else already has: these are blocked outright, and a range
// cannot be drawn across them unless `spanBlocked` says otherwise.
const BOOKED = new Set([dayFromNow(4), dayFromNow(5), dayFromNow(12)]);

const LOCALES = [
  { value: 'en-GB', label: 'en-GB' },
  { value: 'en-US', label: 'en-US' },
  { value: 'fr-FR', label: 'fr-FR' },
  { value: 'de-DE', label: 'de-DE' },
  { value: 'ja-JP', label: 'ja-JP' },
];

const WEEK_START = [
  { value: 'locale', label: "the locale's" },
  { value: '1', label: 'Monday' },
  { value: '0', label: 'Sunday' },
];

function Dot({ color }) {
  return <box style={[s.dot, { backgroundColor: color }]} />;
}

/** The agenda for whichever day is selected — the other half of an overlay:
 *  the marks say *that* there is something, this says what. */
function Agenda({ day }) {
  const events = EVENTS[day] ?? [];
  return (
    <box style={[s.card, s.agenda]}>
      <text style={s.agendaDay}>{day ?? 'no day selected'}</text>
      {events.length === 0 && <text style={s.hint}>Nothing on.</text>}
      {events.map((event) => (
        <box key={event.time} style={s.event}>
          <Dot color={KIND_COLOR[event.kind]} />
          <text style={s.eventTime}>{event.time}</text>
          <text style={s.eventTitle}>{event.title}</text>
        </box>
      ))}
      {BOOKED.has(day) && <text style={s.hint}>Blocked — already taken.</text>}
    </box>
  );
}

/** The panel, without a window round it, so examples/app.jsx can show it in
 *  a tab. */
export function DatesPanel() {
  const [day, setDay] = useState(TODAY);
  const [stay, setStay] = useState({ start: null, end: null });
  const [browsing, setBrowsing] = useState(TODAY);
  const [noWeekends, setNoWeekends] = useState(false);
  const [spanBlocked, setSpanBlocked] = useState(false);
  const [locale, setLocale] = useState('en-GB');
  const [weekStart, setWeekStart] = useState('locale');

  const isDateBlocked = (date, { weekday }) =>
    BOOKED.has(date) || (noWeekends && (weekday === 0 || weekday === 6));

  const shared = {
    locale,
    weekStartsOn: weekStart === 'locale' ? undefined : Number(weekStart),
    isDateBlocked,
  };

  const span = stay.start
    ? `${stay.start} → ${stay.end ?? '…'}`
    : 'nothing picked';

  return (
    <box style={s.panel}>
      <text style={s.heading}>Dates</text>
      <text style={s.hint}>
        Arrows walk the grid, PageUp/PageDown change month (Shift: year), Enter
        picks. Grey days are blocked — three are already booked, and the
        switches below take the weekends out too.
      </text>

      <box style={s.row}>
        <text style={s.label}>One date</text>
        <DatePicker
          {...shared}
          value={day}
          onChange={(ev) => setDay(ev.value)}
          min={dayFromNow(-30)}
          style={{ width: 190 }}
        />
        <text style={s.value}>{day ?? '—'}</text>
      </box>

      <box style={s.row}>
        <text style={s.label}>A range</text>
        <DatePicker
          {...shared}
          mode="range"
          value={stay}
          spanBlocked={spanBlocked}
          onChange={(ev) => setStay(ev.value)}
          style={{ width: 250 }}
        />
        <text style={s.value}>{span}</text>
      </box>

      <box style={s.columns}>
        <box style={s.card}>
          {/* the same grid the picker drops, inline — with the diary drawn
              into it through `dayContent` */}
          <Calendar
            {...shared}
            value={browsing}
            onChange={(ev) => setBrowsing(ev.value)}
            dayContent={(date, state) =>
              (EVENTS[date] ?? [])
                .slice(0, 3)
                .map((event, i) => (
                  <Dot
                    key={i}
                    color={
                      state.selected ? state.color : KIND_COLOR[event.kind]
                    }
                  />
                ))
            }
          />
          <text style={s.hint}>Dots are events. Click a day to read them.</text>
        </box>

        <box style={{ flexGrow: 1, minWidth: 0, gap: 12 }}>
          <Agenda day={browsing} />
          <box style={[s.card, s.switches]}>
            <box style={s.row}>
              <Switch
                checked={noWeekends}
                onChange={(ev) => setNoWeekends(ev.value)}
              />
              <text style={s.value}>Block weekends</text>
            </box>
            <box style={s.row}>
              <Switch
                checked={spanBlocked}
                onChange={(ev) => setSpanBlocked(ev.value)}
              />
              <text style={s.value}>A range may span blocked days</text>
            </box>
            <box style={s.row}>
              <text style={s.label}>Locale</text>
              <Select
                options={LOCALES}
                value={locale}
                onChange={(ev) => setLocale(ev.value)}
                style={{ width: 120 }}
              />
            </box>
            <box style={s.row}>
              <text style={s.label}>Week starts</text>
              <Select
                options={WEEK_START}
                value={weekStart}
                onChange={(ev) => setWeekStart(ev.value)}
                style={{ width: 120 }}
              />
            </box>
          </box>
        </box>
      </box>
    </box>
  );
}

function App() {
  return (
    <window
      width={760}
      height={620}
      title="dates"
      style={{ backgroundColor: '$surfaceHover' }}
    >
      <DatesPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
