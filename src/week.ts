/**
 * The week in meetings: for each working day, how much of its work hours
 * meetings take and what is left free, the next free stretch long enough for
 * deep work, and the week's total. Pure functions of the meetings, the clock
 * and the user's working week (`ctx.workday`), so the widget repaints every
 * minute without asking the source.
 *
 * What counts as a meeting: a timed event that claims you. The source has
 * already left out the ones marked free (`TRANSP:TRANSPARENT`, Outlook's
 * FREE), out of office and cancelled, and focus-time blocks; here all-day
 * events are left out too (a holiday or a trip is not a meeting), and
 * tentative ones on request. Overlapping meetings count once: two calls at
 * the same hour are one busy hour, not two.
 *
 * Days are local calendar days (built from the date, never by adding 24 h),
 * so a week across a daylight-saving change still starts at midnight and a
 * 9:00 meeting stays at 9:00.
 */
import { scheduleOn, type Workday } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';
import { dayStart } from './meeting.ts';

const MIN = 60_000;

/** Which days the tile shows. */
export type DaysMode = 'week' | 'rest' | 'next5';
export const DAYS_MODES = ['week', 'rest', 'next5'] as const satisfies readonly DaysMode[];

export type Load = 'ok' | 'warn' | 'alert';

export interface WeekOptions {
  days: DaysMode;
  /** Length of the free block to look for, ms. */
  blockMs: number;
  /** Share of a day's work hours in meetings (0–100) from which the day turns amber, and red. */
  warnPercent: number;
  alertPercent: number;
  /** Tentative meetings don't count. */
  hideTentative?: boolean;
}

export interface DayLoad {
  /** Local midnight of the day. */
  date: number;
  /** Its work hours, from `workday` (equal on a day off). */
  start: number;
  end: number;
  /** A holiday that falls on a working weekday. */
  holiday: boolean;
  /** Meetings within its work hours, merged and clipped: [start, end) pairs in order. */
  busy: [number, number][];
  meetingMs: number;
  freeMs: number;
  /** Meetings over the work hours, 0–1 (0 on a day off). */
  share: number;
  load: Load;
  /** Before today. */
  past: boolean;
  today: boolean;
}

export interface WeekLoad {
  days: DayLoad[];
  /** Meeting time over the days shown. */
  totalMs: number;
  /** The first free stretch of at least `blockMs` from now on, within work hours of the days shown. */
  next: { start: number; end: number } | null;
  /** The days are the coming week's (nothing of this week's work hours is left). */
  nextWeek: boolean;
}

/** Meetings that take time: timed, with a length, and tentative ones unless told not to count them. */
export function countable(m: Meeting, o: Pick<WeekOptions, 'hideTentative'> = {}): boolean {
  return !m.allDay && m.endsAt > m.startsAt && !(o.hideTentative && m.tentative);
}

/** Intervals merged where they overlap or touch, in order. */
export function mergeIntervals(list: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]): [number, number] => [a, b]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The gaps of `[from, to)` not covered by `busy` (merged, in order). */
export function freeGaps(busy: readonly (readonly [number, number])[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of busy) {
    if (b <= at) continue;
    if (a >= to) break;
    if (a > at) out.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
    if (at >= to) break;
  }
  if (at < to) out.push([at, to]);
  return out;
}

/** JS weekday (0 = Sunday) a week starts on where `locale` is spoken; Monday when the runtime can't say. */
export function firstDayOfWeek(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    if (typeof first === 'number' && first >= 1 && first <= 7) return first % 7;
  } catch {
    /* Monday below */
  }
  return 1;
}

/** Work hours of the local day starting at `date`: a day off has none. Hours past midnight (a night shift) end the next day. */
export function workHours(w: Workday, date: number): { start: number; end: number; working: boolean; holiday: boolean } {
  const s = scheduleOn(w, date);
  const d = new Date(date);
  const at = (min: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min).getTime();
  if (!s.working) return { start: date, end: date, working: false, holiday: s.holiday };
  const start = at(s.startMin);
  const end = at(s.endMin > s.startMin ? s.endMin : s.endMin + 24 * 60);
  return { start, end, working: end > start, holiday: false };
}

/**
 * The days to show, as local midnights:
 *   - `week`: the working weekdays (holidays included, marked) of this week,
 *     which starts on the day the user's language starts it on;
 *   - `rest`: those from today on;
 *   - `next5`: the next five working days, holidays skipped, today among
 *     them while it has work hours left.
 * Once this week's work hours are over (Friday evening, the weekend) `week`
 * and `rest` show the coming week.
 */
export function daysOf(now: number, w: Workday, mode: DaysMode, locale: string): { days: number[]; nextWeek: boolean } {
  const today = dayStart(now);
  if (mode === 'next5') {
    const days: number[] = [];
    for (let i = 0; i < 28 && days.length < 5; i++) {
      const date = dayStart(now, i);
      const h = workHours(w, date);
      if (h.working && h.end > now) days.push(date);
    }
    return { days, nextWeek: false };
  }
  const back = (new Date(now).getDay() - firstDayOfWeek(locale) + 7) % 7;
  const week = (offset: number) =>
    Array.from({ length: 7 }, (_, i) => dayStart(now, i - back + offset)).filter((date) => w.days.includes(new Date(date).getDay()));
  let days = week(0);
  let nextWeek = false;
  if (!days.some((date) => date >= today && workHours(w, date).working && workHours(w, date).end > now)) {
    days = week(7);
    nextWeek = true;
  }
  return { days: mode === 'rest' ? days.filter((date) => date >= today) : days, nextWeek };
}

/** The start of the next quarter hour at or after `ms`: a free block starts at 10:15, not 10:07. */
const quarterUp = (ms: number) => {
  const d = new Date(ms);
  const extra = (d.getMinutes() % 15) * MIN + d.getSeconds() * 1000 + d.getMilliseconds();
  return extra ? ms - extra + 15 * MIN : ms;
};

/** Day shares from which a day is amber and red, made consistent (red never below amber). */
function loadOf(share: number, o: Pick<WeekOptions, 'warnPercent' | 'alertPercent'>): Load {
  const warn = Math.max(0, o.warnPercent) / 100;
  const alert = Math.max(warn, o.alertPercent / 100);
  if (share > 0 && share >= alert) return 'alert';
  if (share > 0 && share >= warn) return 'warn';
  return 'ok';
}

export function weekLoad(meetings: readonly Meeting[], now: number, w: Workday, o: WeekOptions, locale = 'en'): WeekLoad {
  const { days: dates, nextWeek } = daysOf(now, w, o.days, locale);
  const today = dayStart(now);
  const intervals = meetings.filter((m) => countable(m, o)).map((m): [number, number] => [m.startsAt, m.endsAt]);
  const merged = mergeIntervals(intervals);
  const days = dates.map((date): DayLoad => {
    const h = workHours(w, date);
    const busy = h.working ? mergeIntervals(merged.map(([a, b]): [number, number] => [Math.max(a, h.start), Math.min(b, h.end)])) : [];
    const meetingMs = busy.reduce((sum, [a, b]) => sum + (b - a), 0);
    const span = h.end - h.start;
    const share = span > 0 ? meetingMs / span : 0;
    return { date, start: h.start, end: h.end, holiday: h.holiday, busy, meetingMs, freeMs: span - meetingMs, share, load: loadOf(share, o), past: date < today, today: date === today };
  });
  const totalMs = days.reduce((sum, d) => sum + d.meetingMs, 0);
  let next: WeekLoad['next'] = null;
  const from = quarterUp(now);
  const need = Math.max(MIN, o.blockMs);
  for (const d of days) {
    if (d.end <= from || d.end <= d.start) continue;
    const gap = freeGaps(d.busy, Math.max(d.start, from), d.end).find(([a, b]) => b - a >= need);
    if (gap) {
      next = { start: gap[0], end: gap[1] };
      break;
    }
  }
  return { days, totalMs, next, nextWeek };
}
