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
  meeting: { en: 'Meeting', es: 'Reunión', de: 'Termin', 'zh-Hant': '會議', 'zh-Hans': '会议' },
  private: { en: 'Private meeting', es: 'Reunión privada', de: 'Privater Termin', 'zh-Hant': '私人會議', 'zh-Hans': '私人会议' },
  tentative: { en: 'tentative', es: 'provisional', de: 'vorläufig', 'zh-Hant': '暫定', 'zh-Hans': '暂定' },
  inProgress: { en: 'In progress', es: 'En curso', de: 'Läuft', 'zh-Hant': '進行中', 'zh-Hans': '进行中' },
  next: { en: 'Next', es: 'Siguiente', de: 'Nächster', 'zh-Hant': '下一場', 'zh-Hans': '下一场' },
  today: { en: 'Today', es: 'Hoy', de: 'Heute', 'zh-Hant': '今天', 'zh-Hans': '今天' },
  tomorrow: { en: 'Tomorrow', es: 'Mañana', de: 'Morgen', 'zh-Hant': '明天', 'zh-Hans': '明天' },
  nowBig: { en: 'now', es: 'ahora', de: 'jetzt', 'zh-Hant': '現在', 'zh-Hans': '现在' },
  endsIn: { en: 'ends in', es: 'acaba en', de: 'endet in', 'zh-Hant': '還剩', 'zh-Hans': '还剩' },
  in: { en: 'in', es: 'en', de: 'in', 'zh-Hant': '再過', 'zh-Hans': '再过' },
  noMore: { en: 'No more meetings', es: 'No quedan reuniones', de: 'Keine Termine mehr', 'zh-Hant': '沒有其他會議', 'zh-Hans': '没有其他会议' },
  noneToday: { en: 'Nothing else today', es: 'Nada más hoy', de: 'Heute nichts mehr', 'zh-Hant': '今天沒有其他行程', 'zh-Hans': '今天没有其他安排' },
  noneTomorrow: { en: 'No meetings', es: 'Sin reuniones', de: 'Keine Termine', 'zh-Hant': '沒有會議', 'zh-Hans': '没有会议' },
  allDay: { en: 'all day', es: 'todo el día', de: 'ganztägig', 'zh-Hant': '全天', 'zh-Hans': '全天' },
  noCalendar: { en: 'No calendar yet', es: 'Aún sin calendario', de: 'Noch kein Kalender', 'zh-Hant': '尚未設定行事曆', 'zh-Hans': '尚未设置日历' },
  noCalendarHelp: { en: 'Add its ICS address in Settings → Data sources', es: 'Pon su dirección ICS en Ajustes → Fuentes de datos', de: 'ICS-Adresse unter Einstellungen → Datenquellen hinzufügen', 'zh-Hant': '請在「設定 → 資料來源」中加入它的 ICS 網址', 'zh-Hans': '请在“设置 → 数据源”中添加它的 ICS 网址' },
} satisfies Record<string, Localized>;

/** What a tile may say about a meeting: private ones never show their title. */
export function displayTitle(m: Pick<Meeting, 'title' | 'private'>, tr: (t: Localized) => string, showTitle = true): string {
  if (m.private) return tr(TEXTS.private);
  return (showTitle && m.title.trim()) || tr(TEXTS.meeting);
}
