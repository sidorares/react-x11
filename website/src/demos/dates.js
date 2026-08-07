export default {
  id: 'dates',
  title: 'Dates',
  description:
    'DatePicker drops a Calendar on a real popup window; the same grid runs ' +
    'inline. A day is a "YYYY-MM-DD" string in and out, days can be blocked ' +
    'outright, a range refuses to run across one, and dayContent draws ' +
    'whatever you like under the number — here, the events for that day.',
  code: `import React, { useState } from 'react';
import { createRoot, Button, Calendar, DatePicker } from 'react-x11';

// Everything a calendar takes is a day, and a day is a string. So a diary is
// an object keyed by one, and "is there anything on?" is a lookup.
const EVENTS = {
  '2026-08-06': [{ time: '09:30', kind: 'work' }],
  '2026-08-11': [{ time: '19:00', kind: 'personal' }],
  '2026-08-13': [
    { time: '08:05', kind: 'travel' },
    { time: '11:00', kind: 'work' },
  ],
  '2026-08-20': [{ time: '10:00', kind: 'personal' }],
};
const KIND = { work: '#e67e22', personal: '#27ae60', travel: '#8e44ad' };

// Days somebody else already has. A range may not be drawn across one.
const BOOKED = new Set(['2026-08-17', '2026-08-18']);

function App() {
  const [day, setDay] = useState('2026-08-13');
  const [stay, setStay] = useState({ start: null, end: null });

  return (
    <window x={30} y={30} width={560} height={430} title="dates"
            style={{ backgroundColor: '#ffffff' }}>
      <box style={{ padding: 14, gap: 12 }}>
        <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <DatePicker
            mode="range"
            value={stay}
            defaultMonth="2026-08"
            min="2026-08-01"
            isDateBlocked={(d) => BOOKED.has(d)}
            onChange={(ev) => setStay(ev.value)}
            style={{ width: 230 }}
          />
          <Button primary onPress={() => setStay({ start: null, end: null })}>
            Clear
          </Button>
        </box>

        <box style={{ flexDirection: 'row', gap: 14 }}>
          <Calendar
            value={day}
            defaultMonth="2026-08"
            locale="en-GB"
            onChange={(ev) => setDay(ev.value)}
            dayContent={(d, state) =>
              (EVENTS[d] || []).map((event, i) => (
                <box
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: state.selected ? state.color : KIND[event.kind],
                  }}
                />
              ))
            }
          />
          <box style={{ gap: 6, flexGrow: 1 }}>
            <text style={{ fontSize: 15 }}>{day}</text>
            {(EVENTS[day] || []).map((event) => (
              <text key={event.time} style={{ fontSize: 12, color: '#7f8c8d' }}>
                {event.time} — {event.kind}
              </text>
            ))}
            {!EVENTS[day] && (
              <text style={{ fontSize: 12, color: '#7f8c8d' }}>Nothing on.</text>
            )}
            <text style={{ fontSize: 11, color: '#7f8c8d', marginTop: 8 }}>
              Two days in the middle of the month are taken: a range stops
              short of them. Arrows walk the grid, PageUp and PageDown change
              month, Enter picks.
            </text>
          </box>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
