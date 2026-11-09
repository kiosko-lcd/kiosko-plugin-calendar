/**
 * What a meeting means right now: how close it is, which colour that is, and
 * which meeting a tile should be talking about. Pure functions of the list
 * and the clock, so widgets repaint every minute without asking the source.
 */
import type { Localized, ThemeColors } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';

/** Minutes before the start at which the meeting climbs each step of the semaphore. */
export interface Thresholds {
  /** Further away it's drawn faint and lets the panel sleep. */
  greyMin: number;
  readyMin: number;
  warnMin: number;
  alertMin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { greyMin: 120, readyMin: 30, warnMin: 10, alertMin: 3 };

/**
 * The ladder, the same one agents use, so a meeting speaks the panel's
 * language instead of inventing a new one: `idle` (far) → `grey` → `ready`
 * → `warn` → `alert`, and `now` once it started, which is the most urgent
 * thing a panel can show: it's the only one that doesn't wait.
 */
export type Level = 'idle' | 'grey' | 'ready' | 'warn' | 'alert' | 'now';

export function meetingLevel(m: Pick<Meeting, 'startsAt'>, now: number, t: Thresholds): Level {
  if (m.startsAt <= now) return 'now';
  const left = (m.startsAt - now) / 60_000;
  if (left <= t.alertMin) return 'alert';
  if (left <= t.warnMin) return 'warn';
  if (left <= t.readyMin) return 'ready';
  if (left <= t.greyMin) return 'grey';
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

/** The meeting under way (the earliest one, if they overlap) and those still to start, in order. */
export function agendaNow<M extends Pick<Meeting, 'startsAt' | 'endsAt'>>(items: readonly M[], now: number): { current: M | null; next: M[] } {
  const live = items.filter((m) => m.endsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  return { current: live.find((m) => m.startsAt <= now) ?? null, next: live.filter((m) => m.startsAt > now) };
}

/**
 * The meeting a single tile should talk about: the one under way, unless the
 * following one is about to start (back-to-back meetings): then knowing
 * where to go next matters more than how long the current one lasts.
 */
export function pickNext<M extends Pick<Meeting, 'startsAt' | 'endsAt'>>(items: readonly M[], now: number, t: Pick<Thresholds, 'warnMin'>): M | null {
  const { current, next } = agendaNow(items, now);
  const upcoming = next[0] ?? null;
  if (!current) return upcoming;
  return upcoming && upcoming.startsAt - now <= t.warnMin * 60_000 ? upcoming : current;
}

/** "12 min", "1 h 5 min", "2 h". Rounded up: "in 0 min" would be a lie until it starts. */
export function countdown(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 24-hour "09:45", the same in every language. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  more: { en: 'more', es: 'más' },
  noCalendar: { en: 'No calendar yet', es: 'Aún sin calendario' },
  noCalendarHelp: { en: 'Add its ICS address in Settings → Data sources', es: 'Pon su dirección ICS en Ajustes → Fuentes de datos' },
} satisfies Record<string, Localized>;

/** What a tile may say about a meeting: private ones never show their title. */
export function displayTitle(m: Pick<Meeting, 'title' | 'private'>, tr: (t: Localized) => string, showTitle = true): string {
  if (m.private) return tr(TEXTS.private);
  return (showTitle && m.title.trim()) || tr(TEXTS.meeting);
}
