/**
 * Meetings out of published iCalendar (`.ics`) feeds: Outlook/Teams, Google,
 * iCloud… Microsoft 365 offers no CalDAV and Teams on Linux keeps no local
 * cache, so the practical way in is the address Outlook gives when you
 * publish your calendar.
 *
 * Parsing is left to `ical.js` (Mozilla's, the one Thunderbird uses) rather
 * than done by hand, for two reasons the feeds themselves show:
 *
 *   - Outlook writes times with a `TZID` in Windows zone names ("Romance
 *     Standard Time") and ships its own `VTIMEZONE` blocks with the daylight
 *     saving rules. Resolving that by hand is where off-by-one-hour bugs live.
 *   - Recurring meetings (`RRULE`, `EXDATE`, moved occurrences) must be
 *     expanded: the morning stand-up is one of them.
 *
 * A bug here doesn't look like a bug, it looks like a wrong time, which is
 * worse than not having the feature.
 */

/** One meeting, already resolved to absolute times. */
export interface Meeting {
  title: string;
  /** Start, ms since the epoch. */
  startsAt: number;
  /** End, ms since the epoch (equal to the start for zero-length events). */
  endsAt: number;
  /** Not confirmed (Outlook's "tentative"). */
  tentative?: boolean;
  /** Marked private: widgets don't show its title. */
  private?: boolean;
  /** Invited people who didn't decline, by name (or mailbox). Outlook's published feeds don't carry them. */
  attendees?: string[];
  /**
   * A whole-day event (a holiday, a trip, an on-call day): from local
   * midnight to the midnight after its last day. Only with `includeAllDay`.
   */
  allDay?: boolean;
  /** Names of the calendars it comes from (their `X-WR-CALNAME`), for the widgets' calendar filter. */
  calendars?: string[];
}

/** Outlook's focus-time blocks are marked busy; without these they would light the panel mid-morning. */
export const DEFAULT_IGNORE = ['focus time', 'tiempo de concentración'];

/**
 * `ical.js` is an **optional** dependency: only the calendar needs it. It's
 * loaded lazily so nobody else pays for its start-up, and so the app keeps
 * running when the package is missing (the source then reports it).
 */
export type IcalModule = (typeof import('ical.js'))['default'];

let pending: Promise<IcalModule | null> | null = null;

export function loadIcal(): Promise<IcalModule | null> {
  pending ??= import('ical.js')
    .then((m) => ((m as { default?: IcalModule }).default ?? (m as unknown as IcalModule)))
    .catch(() => null);
  return pending;
}

/**
 * The configured feeds, cleaned: blanks and stray spaces out, `webcal://`
 * (what Apple and Outlook hand out for subscribing) turned into `https://`,
 * and repeats dropped. Pasting the same address twice is easy, and each copy
 * would be one more download producing duplicates to throw away later.
 */
export function icsUrls(raw: readonly unknown[] | string | undefined): string[] {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((u) => String(u ?? '').trim())
    .filter(Boolean)
    .map((u) => u.replace(/^webcals?:\/\//i, 'https://'));
  return [...new Set(list)];
}

/** Lower case and without accents, so "concentracion" also matches "concentración". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function ignored(title: string, patterns: readonly string[]): boolean {
  const s = fold(title);
  return patterns.some((p) => p.trim() !== '' && s.includes(fold(p.trim())));
}

/** Registers the time zones the file defines itself (Outlook's Windows names). */
function registerTimezones(ICAL: IcalModule, comp: any): void {
  for (const vt of comp.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(vt);
      if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vt);
    } catch {
      /* a broken zone leaves its events floating (local time), not the file unreadable */
    }
  }
}

/**
 * The invited people who haven't declined: their name (`CN`) or, without one,
 * the part of the address before the @.
 */
function attendeesOf(sub: any): string[] {
  const out: string[] = [];
  for (const p of sub.getAllProperties?.('attendee') ?? []) {
    if (String(p.getParameter?.('partstat') ?? '').toUpperCase() === 'DECLINED') continue;
    const cn = String(p.getParameter?.('cn') ?? '').trim();
    const mail = String(p.getFirstValue?.() ?? '').replace(/^mailto:/i, '');
    const name = cn && !cn.includes('@') ? cn : (mail.split('@')[0] ?? '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const prop = (sub: any, name: string) => String(sub.getFirstPropertyValue(name) ?? '').toUpperCase();

/** Free, out of office or cancelled: on the calendar, but not claiming the user. */
function claims(sub: any): boolean {
  const busy = prop(sub, 'x-microsoft-cdo-busystatus');
  return prop(sub, 'transp') !== 'TRANSPARENT' && busy !== 'FREE' && busy !== 'OOF' && prop(sub, 'status') !== 'CANCELLED';
}

/**
 * Safety cap on the occurrences walked per series: a malformed rule could
 * iterate forever. High on purpose: the old cap of 500 silently lost a
 * daily series created two years earlier, whose walk never reached today.
 */
const MAX_OCCURRENCES = 20_000;
/** Keep walking a little past the window: an occurrence moved earlier into it is found by its original slot. */
const MOVED_SLACK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

/**
 * Where to start walking a series. Walking costs tens of microseconds per
 * occurrence, and a real feed carries dozens of daily and weekly series
 * started years ago: walked from their first occurrence every five minutes,
 * they would freeze the panel for seconds. A plain daily or weekly rule
 * repeats exactly every `INTERVAL` days or weeks of wall-clock time, so its
 * start can jump forward by whole periods to just before `before` without
 * changing a single occurrence. Rules with `COUNT` (counted from the first
 * one), several rules, or other frequencies are walked from the start
 * (monthly and yearly series are short anyway).
 */
function walkStart(ev: any, before: number): any {
  const rules = ev.component.getAllProperties('rrule');
  if (rules.length !== 1) return undefined;
  const rule = rules[0].getFirstValue();
  if (!rule || rule.count) return undefined;
  const days = rule.freq === 'DAILY' ? 1 : rule.freq === 'WEEKLY' ? 7 : 0;
  if (!days) return undefined;
  const period = days * Math.max(1, rule.interval || 1);
  const start = ev.startDate;
  const periods = Math.floor(Math.floor((before - start.toUnixTime() * 1000) / DAY_MS) / period);
  if (periods <= 0) return undefined;
  const moved = start.clone();
  moved.adjust(periods * period, 0, 0, 0);
  return moved;
}

export interface ParseOptions {
  /** Titles containing any of these (case and accents aside) are left out. */
  ignore: readonly string[];
  /** Keep whole-day events too (holidays, trips, on-call days), whatever their busy status. */
  allDay?: boolean;
  /** Tests only: walk every series from its first occurrence. */
  walkFromStart?: boolean;
}

/** The name a calendar gives itself (`X-WR-CALNAME`), or "" when it gives none. */
export function calendarName(comp: any): string {
  return String(comp.getFirstPropertyValue?.('x-wr-calname') ?? '').trim();
}

/**
 * Meetings that overlap `[from, until]`, in order. Left out: those marked
 * free, out of office or cancelled, those whose title matches one of
 * `ignore` (case and accents aside), and all-day events unless `allDay`
 * (then only cancelled ones are dropped: a holiday is usually "free" and a
 * trip "out of office", which is what one wants to see). A meeting already
 * under way when `from` arrives still counts: it's the one claiming the user.
 *
 * Throws when `ics` isn't iCalendar at all; a single broken event is skipped.
 */
export function parseMeetings(ICAL: IcalModule, ics: string, o: ParseOptions, from: number, until: number): Meeting[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(ICAL, comp);
  const calendar = calendarName(comp);

  // A moved or edited occurrence of a series travels as its own VEVENT with
  // the same UID and a RECURRENCE-ID. Related to its series, the series'
  // iterator yields it in place of the original slot; read alone, the
  // meeting would show twice (at the old time and at the new one).
  const events: any[] = [];
  const series = new Map<string, any>();
  const exceptions: any[] = [];
  for (const sub of comp.getAllSubcomponents('vevent')) {
    if (sub.hasProperty('recurrence-id')) {
      exceptions.push(sub);
      continue;
    }
    try {
      const ev = new ICAL.Event(sub);
      events.push(ev);
      if (ev.isRecurring() && ev.uid && !series.has(ev.uid)) series.set(ev.uid, ev);
    } catch {
      /* a corrupt event must not take the rest down */
    }
  }
  for (const sub of exceptions) {
    try {
      const master = series.get(String(sub.getFirstPropertyValue('uid') ?? ''));
      if (master) master.relateException(sub);
      else events.push(new ICAL.Event(sub));
    } catch {
      /* same */
    }
  }

  const out: Meeting[] = [];
  const add = (item: any, start: any, end: any) => {
    if (!start) return;
    const allDay = !!start.isDate;
    if (allDay && !o.allDay) return;
    const sub = item.component;
    if (allDay ? prop(sub, 'status') === 'CANCELLED' : !claims(sub)) return;
    const title = String(item.summary ?? '').trim();
    if (ignored(title, o.ignore)) return;
    // A date without a time is local midnight; an all-day event without an end lasts that day.
    const startsAt = start.toJSDate().getTime();
    const endsAt = end ? end.toJSDate().getTime() : allDay ? startsAt + DAY_MS : startsAt;
    if (startsAt > until || endsAt <= from) return;
    const attendees = attendeesOf(sub);
    const busy = prop(sub, 'x-microsoft-cdo-busystatus');
    const cls = prop(sub, 'class');
    out.push({
      title,
      startsAt,
      endsAt,
      ...(busy === 'TENTATIVE' || prop(sub, 'status') === 'TENTATIVE' ? { tentative: true } : {}),
      ...(cls === 'PRIVATE' || cls === 'CONFIDENTIAL' ? { private: true } : {}),
      ...(attendees.length ? { attendees } : {}),
      ...(allDay ? { allDay: true } : {}),
      ...(calendar ? { calendars: [calendar] } : {}),
    });
  };

  for (const ev of events) {
    if (!ev.isRecurring()) {
      add(ev, ev.startDate, ev.endDate);
      continue;
    }
    // Occurrences that ended well before the window are skipped without
    // resolving them (`toUnixTime` is cheap, `toJSDate` and details are not).
    const length = ev.endDate && ev.startDate ? Math.max(0, ev.endDate.toUnixTime() - ev.startDate.toUnixTime()) * 1000 : 0;
    const before = from - length - MOVED_SLACK_MS;
    const it = ev.iterator(o.walkFromStart ? undefined : walkStart(ev, before));
    let next: any;
    let guard = 0;
    while ((next = it.next()) && guard++ < MAX_OCCURRENCES) {
      const t = next.toUnixTime() * 1000;
      if (t > until + MOVED_SLACK_MS) break;
      if (t < before) continue;
      try {
        const d = ev.getOccurrenceDetails(next);
        add(d.item, d.startDate, d.endDate);
      } catch {
        /* an occurrence that can't be resolved is skipped */
      }
    }
  }

  out.sort((a, b) => a.startsAt - b.startsAt);
  return out;
}

/**
 * Joins the meetings of several feeds into one ordered list.
 *
 * The same meeting shows up in two calendars as soon as you share one, so
 * duplicates by start time and title are dropped. The first copy is kept,
 * which by the merge order is the one of the feed listed first, and it
 * takes the calendar names of the others (so a calendar filter still finds
 * it in either).
 */
export function mergeMeetings(meetings: readonly Meeting[]): Meeting[] {
  const kept = new Map<string, Meeting>();
  const out: Meeting[] = [];
  for (const m of meetings.slice().sort((a, b) => a.startsAt - b.startsAt)) {
    const key = `${m.startsAt}|${m.title.trim().toLowerCase()}`;
    const first = kept.get(key);
    if (!first) {
      const copy = m.calendars ? { ...m, calendars: [...m.calendars] } : { ...m };
      kept.set(key, copy);
      out.push(copy);
      continue;
    }
    for (const c of m.calendars ?? []) {
      if (!first.calendars) first.calendars = [c];
      else if (!first.calendars.includes(c)) first.calendars.push(c);
    }
  }
  return out;
}
