/**
 * What a meeting means right now: how close it is, which colour that is, and
 * which meeting a tile should be talking about. Pure functions of the list
 * and the clock, so widgets repaint every minute without asking the source.
 */
import { matchFilter, type Localized, type ThemeColors } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';

/** How long before the start (ms) the meeting climbs each step of the semaphore. */
export interface Thresholds {
  /** Further away it's drawn faint and lets the panel sleep. */
  greyMs: number;
  readyMs: number;
  warnMs: number;
  alertMs: number;
}

const MIN = 60_000;

export const DEFAULT_THRESHOLDS: Thresholds = { greyMs: 120 * MIN, readyMs: 30 * MIN, warnMs: 10 * MIN, alertMs: 3 * MIN };

/**
 * The ladder, the same one agents use, so a meeting speaks the panel's
 * language instead of inventing a new one: `idle` (far) → `grey` → `ready`
 * → `warn` → `alert`, and `now` once it started, which is the most urgent
 * thing a panel can show: it's the only one that doesn't wait.
 */
export type Level = 'idle' | 'grey' | 'ready' | 'warn' | 'alert' | 'now';

export function meetingLevel(m: Pick<Meeting, 'startsAt'>, now: number, t: Thresholds): Level {
  if (m.startsAt <= now) return 'now';
  const left = m.startsAt - now;
  if (left <= t.alertMs) return 'alert';
  if (left <= t.warnMs) return 'warn';
  if (left <= t.readyMs) return 'ready';
  if (left <= t.greyMs) return 'grey';
  return 'idle';
}

/** The theme semaphore for a level: dim while it only informs, colour as it claims. */
export function levelColor(level: Level, c: ThemeColors): string {
  switch (level) {
    case 'alert':
    case 'now':
      return c.alert;
    case 'warn':
      return c.warn;
    case 'ready':
      return c.info;
    default:
      return c.inkDim;
  }
}

/**
 * The meeting under way (the earliest one, if they overlap) and those still
 * to start, in order. All-day events are neither: a holiday doesn't start
 * at midnight nor keep the tile all day.
 */
export function agendaNow<M extends Pick<Meeting, 'startsAt' | 'endsAt' | 'allDay'>>(items: readonly M[], now: number): { current: M | null; next: M[] } {
  const live = items.filter((m) => !m.allDay && m.endsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  return { current: live.find((m) => m.startsAt <= now) ?? null, next: live.filter((m) => m.startsAt > now) };
}

/**
 * The meeting a single tile should talk about: the one under way, unless the
 * following one is about to start (back-to-back meetings): then knowing
 * where to go next matters more than how long the current one lasts.
 */
export function pickNext<M extends Pick<Meeting, 'startsAt' | 'endsAt' | 'allDay'>>(items: readonly M[], now: number, t: Pick<Thresholds, 'warnMs'>): M | null {
  const { current, next } = agendaNow(items, now);
  const upcoming = next[0] ?? null;
  if (!current) return upcoming;
  return upcoming && upcoming.startsAt - now <= t.warnMs ? upcoming : current;
}

/** What a widget lists: the calendars it was asked for, and without tentative meetings if so. */
export interface Selection {
  /** Patterns for `matchFilter` against the calendars' names; empty = all. */
  calendars?: readonly string[];
  hideTentative?: boolean;
}

/**
 * The meetings of the calendars the widget shows. A meeting found in
 * several calendars passes if any of them does (and none is excluded). One
 * without a calendar name (a feed that doesn't name itself) is matched as "".
 */
export function selectMeetings<M extends Pick<Meeting, 'calendars' | 'tentative'>>(items: readonly M[], o: Selection): M[] {
  const filtered = o.calendars?.length ? items.filter((m) => matchFilter(m.calendars?.length ? m.calendars : [''], o.calendars)) : [...items];
  return o.hideTentative ? filtered.filter((m) => !m.tentative) : filtered;
}

/** Local midnight of the day `ms` falls in, `days` later. */
export function dayStart(ms: number, days = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Whole local days from today to the day of `ms` (0 today, 1 tomorrow…). */
export function daysFrom(now: number, ms: number): number {
  return Math.round((dayStart(ms) - dayStart(now)) / 86_400_000);
}

export const TEXTS = {
  meeting: { en: 'Meeting', es: 'Reunión' },
  private: { en: 'Private meeting', es: 'Reunión privada' },
  tentative: { en: 'tentative', es: 'provisional' },
  inProgress: { en: 'In progress', es: 'En curso' },
  next: { en: 'Next', es: 'Siguiente' },
  today: { en: 'Today', es: 'Hoy' },
  tomorrow: { en: 'Tomorrow', es: 'Mañana' },
  nowBig: { en: 'now', es: 'ahora' },
  endsIn: { en: 'ends in', es: 'acaba en' },
  in: { en: 'in', es: 'en' },
  noMore: { en: 'No more meetings', es: 'No quedan reuniones' },
  noneToday: { en: 'Nothing else today', es: 'Nada más hoy' },
  noneTomorrow: { en: 'No meetings', es: 'Sin reuniones' },
  allDay: { en: 'all day', es: 'todo el día' },
  noCalendar: { en: 'No calendar yet', es: 'Aún sin calendario' },
  noCalendarHelp: { en: 'Add its ICS address in Settings → Data sources', es: 'Pon su dirección ICS en Ajustes → Fuentes de datos' },
} satisfies Record<string, Localized>;

/** What a tile may say about a meeting: private ones never show their title. */
export function displayTitle(m: Pick<Meeting, 'title' | 'private'>, tr: (t: Localized) => string, showTitle = true): string {
  if (m.private) return tr(TEXTS.private);
  return (showTitle && m.title.trim()) || tr(TEXTS.meeting);
}
