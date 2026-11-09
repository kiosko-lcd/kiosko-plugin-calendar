/**
 * The calendar: one shared source that reads published ICS feeds (Outlook,
 * Teams, Google, iCloud…) as `calendar/events`, and two cards on top of it:
 *
 *   - `calendar/next`: the next meeting as a big countdown that climbs the
 *     theme semaphore as it nears (dim → info → warn → alert) and takes its
 *     tile over when it's about to start and while it lasts.
 *   - `calendar/agenda`: today's remaining meetings and tomorrow's.
 *
 * The source keeps a copy of every feed on disk (named after a hash of the
 * address, which is a secret) and falls back to it when offline.
 */
import { definePlugin, defineSource, defineWidget, t, type Localized, type RenderContext } from '@kiosko/sdk';
import { demoMeetings } from './demo.ts';
import { drawAgenda, drawMessage, drawNext, type Painter } from './draw.ts';
import { fetchAll } from './feed.ts';
import { DEFAULT_IGNORE, icsUrls, loadIcal, mergeMeetings, parseMeetings, type Meeting } from './ics.ts';
import { agendaNow, dayStart, DEFAULT_THRESHOLDS, pickNext, TEXTS } from './meeting.ts';

export type { Meeting };
export { agendaNow, countdown, meetingLevel, pickNext, type Level, type Thresholds } from './meeting.ts';
export { demoMeetings };

const SOURCE = 'calendar/events';

/** Minutes ahead within which the agenda keeps the panel awake. */
const AGENDA_AWAKE_MIN = DEFAULT_THRESHOLDS.greyMin;

export const events = defineSource({
  id: 'events',
  name: { en: 'Calendar meetings', es: 'Reuniones del calendario' },
  description: {
    en: 'Meetings of today and the next days from one or more published calendars (ICS). All-day, free and focus-time events are left out.',
    es: 'Las reuniones de hoy y de los próximos días de uno o varios calendarios publicados (ICS). Se dejan fuera los eventos de todo el día, los libres y los de concentración.',
  },
  options: t.object({
    urls: t.list(
      t.string({ secret: true, format: 'url', risk: 'network', placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics', label: { en: 'ICS address', es: 'Dirección ICS' } }),
      {
        max: 10,
        label: { en: 'Calendars (ICS addresses)', es: 'Calendarios (direcciones ICS)' },
        help: {
          en: 'The secret address of a published calendar (Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → ICS). Anyone with it can read your agenda: treat it like a password.',
          es: 'La dirección secreta de un calendario publicado (Outlook web: Configuración → Calendario → Calendarios compartidos → Publicar un calendario → ICS). Quien la tenga lee tu agenda: trátala como una contraseña.',
        },
      },
    ),
    ignore: t.list(t.string({ label: { en: 'Text', es: 'Texto' } }), {
      default: [...DEFAULT_IGNORE],
      label: { en: 'Ignore titles containing', es: 'Ignorar títulos que contengan' },
      help: { en: 'Busy blocks that are not meetings, like focus time. Case and accents don’t matter.', es: 'Bloques ocupados que no son reuniones, como el tiempo de concentración. Da igual mayúsculas y tildes.' },
    }),
    horizonDays: t.integer({
      default: 1,
      min: 0,
      max: 14,
      label: { en: 'Days ahead', es: 'Días por delante' },
      help: { en: 'Besides today. The agenda needs at least 1 to show tomorrow.', es: 'Además de hoy. La agenda necesita al menos 1 para enseñar mañana.' },
    }),
    timeoutMs: t.duration({ default: 20_000, min: 1_000, max: 120_000, advanced: true, label: { en: 'Download timeout', es: 'Tiempo máximo de descarga' } }),
  }),
  intervalMs: 5 * 60_000,
  async read(ctx): Promise<Meeting[]> {
    const { options: o } = ctx;
    const urls = icsUrls(o.urls);
    if (!urls.length) throw new Error('no calendar: add the ICS address of a published calendar to this source');
    // Only now, with a calendar configured, is the optional dependency loaded.
    const ICAL = await loadIcal();
    if (!ICAL) throw new Error('the optional dependency ical.js is not installed (npm install ical.js)');
    const feeds = await fetchAll(urls, { dir: ctx.dataDir, timeoutMs: o.timeoutMs, signal: ctx.signal, log: ctx.log });
    if (!feeds.length) throw new Error(`${urls.length > 1 ? 'no calendar' : 'the calendar'} could be read, and there is no copy on disk`);
    const from = dayStart(ctx.now);
    const until = dayStart(ctx.now, o.horizonDays + 1) - 1;
    const all: Meeting[] = [];
    let unreadable = 0;
    for (const ics of feeds) {
      try {
        all.push(...parseMeetings(ICAL, ics, { ignore: o.ignore }, from, until));
      } catch {
        // One unreadable feed can't take the others down.
        unreadable++;
      }
    }
    if (unreadable === feeds.length) throw new Error('the calendar feed could not be parsed as iCalendar');
    return mergeMeetings(all);
  },
  demo: ({ now, locale }) => demoMeetings(now, locale),
});

const meetingsOf = (sources: Record<string, unknown>): Meeting[] | undefined => {
  const v = sources[SOURCE];
  return Array.isArray(v) ? (v as Meeting[]) : undefined;
};

const painter = (g: Painter['g'], ctx: RenderContext<unknown, unknown>): Painter => ({ g, kit: ctx.kit, theme: ctx.theme, t: ctx.t, locale: ctx.locale, now: ctx.now });

const minutes = (def: number, label: Localized, help?: Localized) =>
  t.integer({ default: def, min: 0, max: 24 * 60, unit: 'min', label, ...(help ? { help } : {}) });

export const next = defineWidget({
  id: 'next',
  name: { en: 'Next meeting', es: 'Próxima reunión' },
  description: {
    en: 'A big countdown to your next meeting. Its colour climbs the semaphore as it nears, and it takes the tile over when it’s about to start.',
    es: 'Una cuenta atrás grande hasta tu próxima reunión. Su color sube por el semáforo según se acerca, y se queda la tesela cuando está a punto de empezar.',
  },
  icon: 'calendar-clock',
  category: 'time',
  tags: ['calendar', 'calendario', 'meeting', 'reunión', 'outlook', 'teams', 'ics'],
  size: { min: { w: 160, h: 90 }, preferred: { w: 400, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    showTitle: t.boolean({
      default: true,
      label: { en: 'Show the title', es: 'Mostrar el título' },
      help: { en: 'Off: only the time and the countdown. Private meetings never show it.', es: 'Apagado: sólo la hora y la cuenta atrás. Las privadas nunca lo enseñan.' },
    }),
    greyMin: minutes(DEFAULT_THRESHOLDS.greyMin, { en: 'Awake from (min before)', es: 'Despierta desde (min antes)' }, { en: 'Further away it is drawn dim and lets the panel sleep.', es: 'Más lejos se pinta tenue y deja dormir al panel.' }),
    readyMin: minutes(DEFAULT_THRESHOLDS.readyMin, { en: 'Info colour from (min before)', es: 'Color informativo desde (min antes)' }),
    warnMin: minutes(DEFAULT_THRESHOLDS.warnMin, { en: 'Warning colour from (min before)', es: 'Color de aviso desde (min antes)' }),
    alertMin: minutes(DEFAULT_THRESHOLDS.alertMin, { en: 'Alert from (min before)', es: 'Alerta desde (min antes)' }, { en: 'From here until it ends, it takes its tile over.', es: 'Desde aquí hasta que acaba, se queda la tesela.' }),
  }),
  redraw: 'minute',
  render(g, ctx) {
    const p = painter(g, ctx);
    const list = meetingsOf(ctx.sources);
    if (!list) return drawMessage(p, ctx.box, ctx.t(TEXTS.noCalendar), ctx.t(TEXTS.noCalendarHelp));
    const m = pickNext(list, ctx.now, ctx.options);
    if (!m) return drawMessage(p, ctx.box, ctx.t(TEXTS.noMore));
    drawNext(p, ctx.box, m, ctx.options);
  },
  visible: ({ sources, now }) => {
    const list = meetingsOf(sources);
    return !list || list.some((m) => m.endsAt > now);
  },
  urgent: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources) ?? [], now);
    return !!current || (!!upcoming[0] && upcoming[0].startsAt - now <= options.alertMin * 60_000);
  },
  idle: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources) ?? [], now);
    return !current && !(upcoming[0] && upcoming[0].startsAt - now <= options.greyMin * 60_000);
  },
  // Without the meeting under way, so the gallery shows a countdown rather than "now".
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoMeetings(now, locale, { current: false }) } }),
});

export const agenda = defineWidget({
  id: 'agenda',
  name: { en: 'Agenda', es: 'Agenda' },
  description: {
    en: 'Today’s remaining meetings and tomorrow’s: the one under way highlighted, the next one with its countdown.',
    es: 'Las reuniones que quedan hoy y las de mañana: la que está en curso resaltada, la siguiente con su cuenta atrás.',
  },
  icon: 'calendar-days',
  category: 'time',
  tags: ['calendar', 'calendario', 'agenda', 'meeting', 'reunión', 'outlook', 'teams', 'ics'],
  size: { min: { w: 220, h: 120 }, preferred: { w: 600, h: 440 } },
  sources: [SOURCE],
  options: t.object({
    tomorrow: t.boolean({ default: true, label: { en: 'Tomorrow too', es: 'También mañana' }, help: { en: 'Needs 1 or more days ahead in the source.', es: 'Necesita 1 o más días por delante en la fuente.' } }),
    warnMin: minutes(DEFAULT_THRESHOLDS.warnMin, { en: 'Warning colour from (min before)', es: 'Color de aviso desde (min antes)' }, { en: 'From here the card takes its tile over.', es: 'Desde aquí la tarjeta se queda la tesela.' }),
    alertMin: minutes(DEFAULT_THRESHOLDS.alertMin, { en: 'Alert colour from (min before)', es: 'Color de alerta desde (min antes)' }),
    holdMin: t.integer({
      default: 10,
      min: 0,
      max: 120,
      unit: 'min',
      advanced: true,
      label: { en: 'Keep the tile after a start (min)', es: 'Quedarse la tesela al empezar (min)' },
      help: { en: 'Once you know where you are, the tile goes back to its rotation.', es: 'Pasado el arranque ya sabes dónde estás, y la tesela vuelve a su turno.' },
    }),
  }),
  redraw: 'minute',
  render(g, ctx) {
    const p = painter(g, ctx);
    const list = meetingsOf(ctx.sources);
    if (!list) return drawMessage(p, ctx.box, ctx.t(TEXTS.noCalendar), ctx.t(TEXTS.noCalendarHelp));
    drawAgenda(p, ctx.box, list, ctx.options);
  },
  visible: ({ sources, now, options }) => {
    const list = meetingsOf(sources);
    if (!list) return true;
    const limit = dayStart(now, options.tomorrow ? 2 : 1);
    return list.some((m) => m.endsAt > now && m.startsAt < limit);
  },
  urgent: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources) ?? [], now);
    return (!!current && now - current.startsAt < options.holdMin * 60_000) || (!!upcoming[0] && upcoming[0].startsAt - now <= options.warnMin * 60_000);
  },
  idle: ({ sources, now }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources) ?? [], now);
    return !current && !(upcoming[0] && upcoming[0].startsAt - now <= AGENDA_AWAKE_MIN * 60_000);
  },
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoMeetings(now, locale) } }),
});

export default definePlugin({
  id: 'calendar',
  name: { en: 'Calendar', es: 'Calendario' },
  version: '0.1.0',
  description: {
    en: 'Meetings from published ICS calendars (Outlook/Teams, Google…): a countdown to the next one and the agenda of today and tomorrow.',
    es: 'Reuniones de calendarios ICS publicados (Outlook/Teams, Google…): una cuenta atrás hasta la siguiente y la agenda de hoy y mañana.',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'calendar',
  sources: [events],
  widgets: [next, agenda],
});
