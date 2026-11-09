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
 * Safety cap on the occurrences walked per series. A malformed rule could
 * iterate forever, but the cap must stay high: the walk starts at the
 * series' first occurrence, and a weekday stand-up created three years ago
 * is already ~800 occurrences before today.
 */
const MAX_OCCURRENCES = 20_000;
/** Keep walking a little past the window: an occurrence moved earlier into it is found by its original slot. */
const MOVED_SLACK_MS = 7 * 86_400_000;

/**
 * Meetings that overlap `[from, until]`, in order. Left out: all-day events,
 * those marked free, out of office or cancelled, and those whose title
 * matches one of `ignore` (case and accents aside). A meeting already under
 * way when `from` arrives still counts: it's the one claiming the user.
 *
 * Throws when `ics` isn't iCalendar at all; a single broken event is skipped.
 */
export function parseMeetings(ICAL: IcalModule, ics: string, o: { ignore: readonly string[] }, from: number, until: number): Meeting[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(ICAL, comp);

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
    if (!start || start.isDate) return; // all day
    const sub = item.component;
    if (!claims(sub)) return;
    const title = String(item.summary ?? '').trim();
    if (ignored(title, o.ignore)) return;
    const startsAt = start.toJSDate().getTime();
    const endsAt = end ? end.toJSDate().getTime() : startsAt;
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
    });
  };

  for (const ev of events) {
    if (!ev.isRecurring()) {
      add(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    let next: any;
    let guard = 0;
    while ((next = it.next()) && guard++ < MAX_OCCURRENCES) {
      if (next.toJSDate().getTime() > until + MOVED_SLACK_MS) break;
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
 * which by the merge order is the one of the feed listed first.
 */
export function mergeMeetings(meetings: readonly Meeting[]): Meeting[] {
  const seen = new Set<string>();
  return meetings
    .slice()
    .sort((a, b) => a.startsAt - b.startsAt)
    .filter((m) => {
      const key = `${m.startsAt}|${m.title.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
