/**
 * The calendars the user's desktop already has — EventKit on macOS,
 * Evolution Data Server on a freedesktop session. See
 * docs/desktop-calendar.md.
 */

import type { NtkApp } from './nodes.js';
import type { PermissionStatus } from './permissions.js';

/** Which rung answered: the EventKit bridge, an `osascript` child holding
 *  an `EKEventStore`, or Evolution Data Server over the session bus. */
export type CalendarBackend = 'cocoa' | 'osascript' | 'eds';

/** One calendar the desktop knows about. */
export interface DesktopCalendarInfo {
  uid: string;
  /** The name shown in the desktop's own calendar UI. */
  name: string;
  /** Whether the desktop has it switched on. Always true on macOS, which
   *  has no such state to report. */
  enabled: boolean;
  /** `'#3584e4'` — the colour that UI draws it in, worth carrying into a
   *  day marker. */
  color?: string;
  /** `caldav`, `google`, `local`, `exchange`, `subscription`, `birthday`…
   *  the store's own word, lower-cased. */
  backend?: string;
  readOnly: boolean;
  /** The account it came from, where one is named — a GNOME Online Accounts
   *  entry, or an `EKSource` (`'iCloud'`, `'Google'`). */
  account?: string;
}

/** One occurrence, with any recurrence already expanded. */
export interface DesktopEvent {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  start: Date;
  /** **Exclusive**, on every rung: an all-day event on the 10th ends at
   *  midnight on the 11th. The macOS rungs normalise what EventKit reports
   *  (the last second of the last day) so a caller never has to ask. */
  end: Date;
  allDay: boolean;
  recurring: boolean;
  calendar: { uid: string; name: string; color?: string };
}

/** A calendar that would not answer. One broken backend is not a failure. */
export interface DesktopCalendarError {
  calendar: DesktopCalendarInfo;
  message: string;
}

export interface EventsResult {
  events: DesktopEvent[];
  /** Empty on the macOS rungs, where there is one store. */
  errors: DesktopCalendarError[];
}

/**
 * What `watch` reports. Deliberately thin: re-query rather than patch.
 *
 * `'changed'` with a null calendar and no count is EventKit's — its
 * notification names nothing, and a rung must not invent a count.
 */
export interface CalendarChange {
  calendar: DesktopCalendarInfo | null;
  kind: 'ObjectsAdded' | 'ObjectsModified' | 'ObjectsRemoved' | 'changed';
  count: number | null;
}

export interface EventsOptions {
  /** Restrict to these calendars. Default: every enabled one. */
  calendars?: DesktopCalendarInfo[];
}

/**
 * Nothing on this machine can read a calendar. Raised only by
 * `desktopCalendar({ required: true })`; the default answer is `null`,
 * because a machine with no calendar service is an ordinary machine.
 */
export declare class NoCalendarServiceError extends Error {
  readonly name: 'NoCalendarServiceError';
  readonly cause?: unknown;
}

/**
 * The app may not read the calendars. `status` says why: `'denied'` and
 * `'restricted'` and `'write-only'` are decisions, and `'prompt'` is a
 * request that came back with nothing — TCC declining to ask, which the
 * hook reports as `'unavailable'` rather than as a refusal.
 */
export declare class CalendarAccessError extends Error {
  readonly name: 'CalendarAccessError';
  readonly status: PermissionStatus;
  readonly cause?: unknown;
}

/** A handle on the desktop's calendars. `close()` it. */
export interface DesktopCalendar {
  readonly backend: CalendarBackend;
  /** The grant, without prompting; `'granted'` on a rung with no such gate. */
  access(): Promise<PermissionStatus>;
  /** Raise the system's prompt where there is one. Reads do this on the
   *  first one, so a picker the user never opens never prompts. */
  requestAccess(): Promise<PermissionStatus>;
  /** System Settings › Privacy & Security › Calendars. `false` off macOS. */
  openSettings(): Promise<boolean>;
  listCalendars(): Promise<DesktopCalendarInfo[]>;
  /** Occurrences in `[from, to)`, sorted by start. Rejects with
   *  {@link CalendarAccessError} where the user said no. */
  eventsBetween(
    from: Date,
    to: Date,
    options?: EventsOptions,
  ): Promise<EventsResult>;
  /** Call `onChange` when something moves; the returned function stops. */
  watch(
    from: Date,
    to: Date,
    onChange: (change: CalendarChange) => void,
    options?: EventsOptions,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface DesktopCalendarOptions {
  /** The connection whose backend to ask, when there are several. */
  app?: NtkApp;
  /** Pin one rung and fail rather than fall through it. */
  backend?: CalendarBackend;
  /** Reject with {@link NoCalendarServiceError} instead of answering null. */
  required?: boolean;
}

/**
 * The desktop's calendars, on the best rung this machine has — or `null`,
 * which is an ordinary answer about a machine.
 */
export declare function desktopCalendar(
  options?: DesktopCalendarOptions,
): Promise<DesktopCalendar | null>;

/** Which rung this machine lands on, without reading anything, spawning
 *  anything or prompting. */
export declare function calendarBackend(
  options?: Pick<DesktopCalendarOptions, 'app'>,
): Promise<CalendarBackend | null>;

/** The local calendar day a `Date` falls on, as `'YYYY-MM-DD'` — the key
 *  `byDay` uses and `<Calendar dayContent>` is handed. */
export declare function dayKey(date: Date): string;

/** Occurrences grouped by the local day they appear on. An event lands
 *  under every day it touches, not only under its start. */
export declare function byDay(
  events: DesktopEvent[],
): Map<string, DesktopEvent[]>;

/**
 * `'idle'` before anything is asked, `'denied'` for the user's refusal and
 * `'unavailable'` for the machine's silence — separate words, because only
 * one of them has a Settings switch behind it.
 */
export type DesktopCalendarStatus =
  'idle' | 'loading' | 'ready' | 'denied' | 'unavailable';

export interface UseDesktopCalendarEventsOptions {
  /** Start of the window to read, inclusive. */
  from: Date;
  /** End of the window, exclusive. */
  to: Date;
  /** Restrict to these calendar uids. Default: every enabled calendar. */
  calendars?: string[];
  /** Re-query when the desktop says something changed. */
  watch?: boolean;
  /** Set false to hold off entirely — and to not prompt: a picker that is
   *  not open yet has no business asking for the user's calendar. */
  enabled?: boolean;
}

export interface UseDesktopCalendarEventsResult {
  events: DesktopEvent[];
  /** The same events, keyed by `'YYYY-MM-DD'`, ready for `dayContent`. */
  byDay: Map<string, DesktopEvent[]>;
  /** Every calendar found, for a legend or a filter. */
  calendars: DesktopCalendarInfo[];
  /** Calendars that would not answer while others did. Not fatal. */
  errors: DesktopCalendarError[];
  status: DesktopCalendarStatus;
  /** Which rung answered, once one has. */
  backend: CalendarBackend | null;
  /** Why there are no events, when there is a reason worth showing. */
  error: Error | null;
  /** Re-query now. */
  refresh: () => void;
  /** System Settings › Privacy & Security › Calendars — for `'denied'`, and
   *  for no other status. */
  openSettings: () => Promise<boolean>;
}

/** The user's desktop calendar events, as rendering state. */
export declare function useDesktopCalendarEvents(
  options: UseDesktopCalendarEventsOptions,
): UseDesktopCalendarEventsResult;
