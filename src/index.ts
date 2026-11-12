/**
 * The calendar: one shared source that reads published ICS feeds (Outlook,
 * Teams, Google, iCloud…) as `calendar/events`, and two cards on top of it:
 *
 *   - `calendar/next`: the next meeting as a big countdown that climbs the
 *     theme semaphore as it nears (dim → info → warn → alert) and takes its
 *     tile over when it's about to start and while it lasts.
 *   - `calendar/agenda`: the meetings left today and those of the next days.
 *
 * The source keeps a copy of every feed on disk (named after a hash of the
 * address, which is a secret) and falls back to it when offline.
 */
import { definePlugin, defineSource, defineWidget, drawEmpty, listOptions, t, type Localized, type RenderContext } from '@kiosko/sdk';
import { demoMeetings } from './demo.ts';
import { agendaDays, drawAgenda, drawMessage, drawNext, type Painter } from './draw.ts';
import { fetchAll } from './feed.ts';
import { DEFAULT_IGNORE, icsUrls, loadIcal, mergeMeetings, parseMeetings, type Meeting } from './ics.ts';
import { agendaNow, dayStart, DEFAULT_THRESHOLDS, pickNext, selectMeetings, TEXTS } from './meeting.ts';

export type { Meeting };
export { agendaNow, meetingLevel, pickNext, selectMeetings, type Level, type Thresholds } from './meeting.ts';
export { demoMeetings };

const SOURCE = 'calendar/events';
const MIN = 60_000;

export const events = defineSource({
  id: 'events',
  name: { en: 'Calendar meetings', es: 'Reuniones del calendario' },
  description: {
    en: 'Meetings of today and the next days from one or more published calendars (ICS). Free and focus-time events are left out, and all-day ones unless you ask for them.',
    es: 'Las reuniones de hoy y de los próximos días de uno o varios calendarios publicados (ICS). Se dejan fuera los eventos libres y los de concentración, y los de todo el día salvo que los pidas.',
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
      default: 6,
      min: 0,
      max: 14,
      label: { en: 'Days ahead', es: 'Días por delante' },
      help: { en: 'Besides today. The agenda shows as many days as this plus one, at most.', es: 'Además de hoy. La agenda enseña como mucho estos días más uno.' },
    }),
    includeAllDay: t.boolean({
      label: { en: 'Include all-day events', es: 'Incluir los eventos de todo el día' },
      help: { en: 'Holidays, trips, on-call days: listed at the top of their day in the agenda. They never count as the next meeting.', es: 'Festivos, viajes, guardias: salen al principio de su día en la agenda. Nunca cuentan como la próxima reunión.' },
    }),
  }),
  intervalMs: 5 * MIN,
  minIntervalMs: MIN,
  // Feeds download at once; each gets two thirds of this, so a slow one falls back to its copy on disk in time.
  timeoutMs: 30_000,
  async read(ctx): Promise<Meeting[]> {
    const { options: o } = ctx;
    const urls = icsUrls(o.urls);
    if (!urls.length) throw new Error('no calendar: add the ICS address of a published calendar to this source');
    // Only now, with a calendar configured, is the optional dependency loaded.
    const ICAL = await loadIcal();
    if (!ICAL) throw new Error('the optional dependency ical.js is not installed (npm install ical.js)');
    const timeoutMs = Math.max(1000, Math.round((ctx.timeoutMs * 2) / 3));
    const feeds = await fetchAll(urls, { dir: ctx.cacheDir || ctx.dataDir, timeoutMs, signal: ctx.signal, log: ctx.log });
    if (!feeds.length) throw new Error(`${urls.length > 1 ? 'no calendar' : 'the calendar'} could be read, and there is no copy on disk`);
    const from = dayStart(ctx.now);
    const until = dayStart(ctx.now, o.horizonDays + 1) - 1;
    const all: Meeting[] = [];
    let unreadable = 0;
    for (const ics of feeds) {
      try {
        all.push(...parseMeetings(ICAL, ics, { ignore: o.ignore, allDay: o.includeAllDay }, from, until));
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

/** The source's meetings, as the widget's options select them; undefined before there is a calendar. */
const meetingsOf = (sources: Record<string, unknown>, o: { calendars: string[]; hideTentative?: boolean }): Meeting[] | undefined => {
  const v = sources[SOURCE];
  return Array.isArray(v) ? selectMeetings(v as Meeting[], o) : undefined;
};

const painter = (g: Painter['g'], ctx: RenderContext<unknown, unknown>): Painter => ({ g, kit: ctx.kit, theme: ctx.theme, t: ctx.t, fmt: ctx.fmt, locale: ctx.locale, now: ctx.now });

const before = (def: number, label: Localized, help?: Localized) => t.duration({ default: def, max: 24 * 60 * MIN, label, ...(help ? { help } : {}) });

const calendarsFilter = () =>
  t.filter({
    label: { en: 'Calendars', es: 'Calendarios' },
    help: {
      en: 'Empty: all. Names as each calendar calls itself (Work, Holidays…), comma-separated; * matches anything, a leading ! leaves out.',
      es: 'Vacío: todos. Nombres como se llama cada calendario (Trabajo, Festivos…), separados por comas; * vale por cualquier cosa y un ! delante excluye.',
    },
  });

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
    showAttendees: t.boolean({
      default: true,
      label: { en: 'Show who attends', es: 'Mostrar quién asiste' },
      help: { en: 'With the title. Outlook’s published calendars don’t carry them.', es: 'Junto al título. Los calendarios publicados de Outlook no los traen.' },
    }),
    greyMs: before(DEFAULT_THRESHOLDS.greyMs, { en: 'Awake from (before it starts)', es: 'Despierta desde (antes de empezar)' }, { en: 'Further away it is drawn dim and lets the panel sleep.', es: 'Más lejos se pinta tenue y deja dormir al panel.' }),
    readyMs: before(DEFAULT_THRESHOLDS.readyMs, { en: 'Info colour from (before it starts)', es: 'Color informativo desde (antes de empezar)' }),
    warnMs: before(DEFAULT_THRESHOLDS.warnMs, { en: 'Warning colour from (before it starts)', es: 'Color de aviso desde (antes de empezar)' }, { en: 'Also when, back to back, the next meeting replaces the one under way.', es: 'También cuando, con reuniones seguidas, la siguiente sustituye a la que está en curso.' }),
    alertMs: before(DEFAULT_THRESHOLDS.alertMs, { en: 'Alert from (before it starts)', es: 'Alerta desde (antes de empezar)' }, { en: 'From here until it ends, it takes its tile over.', es: 'Desde aquí hasta que acaba, se queda la tesela.' }),
    hideTentative: t.boolean({ label: { en: 'Skip tentative meetings', es: 'Saltar las provisionales' }, help: { en: 'Invitations not accepted yet.', es: 'Invitaciones aún sin aceptar.' } }),
    calendars: calendarsFilter(),
  }),
  redraw: 'minute',
  render(g, ctx) {
    const p = painter(g, ctx);
    const list = meetingsOf(ctx.sources, ctx.options);
    if (!list) return drawMessage(p, ctx.box, ctx.t(TEXTS.noCalendar), ctx.t(TEXTS.noCalendarHelp));
    const m = pickNext(list, ctx.now, ctx.options);
    if (!m) return drawMessage(p, ctx.box, ctx.t(TEXTS.noMore));
    drawNext(p, ctx.box, m, ctx.options);
  },
  visible: ({ sources, now, options }) => {
    const list = meetingsOf(sources, options);
    return !list || list.some((m) => !m.allDay && m.endsAt > now);
  },
  urgent: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources, options) ?? [], now);
    return !!current || (!!upcoming[0] && upcoming[0].startsAt - now <= options.alertMs);
  },
  idle: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources, options) ?? [], now);
    return !current && !(upcoming[0] && upcoming[0].startsAt - now <= options.greyMs);
  },
  // Without the meeting under way, so the gallery shows a countdown rather than "now".
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoMeetings(now, locale, { current: false }) } }),
});

export const agenda = defineWidget({
  id: 'agenda',
  name: { en: 'Agenda', es: 'Agenda' },
  description: {
    en: 'The meetings left today and those of the next days: the one under way highlighted, the next one with its countdown.',
    es: 'Las reuniones que quedan hoy y las de los próximos días: la que está en curso resaltada, la siguiente con su cuenta atrás.',
  },
  icon: 'calendar-days',
  category: 'time',
  tags: ['calendar', 'calendario', 'agenda', 'meeting', 'reunión', 'outlook', 'teams', 'ics'],
  size: { min: { w: 220, h: 120 }, preferred: { w: 600, h: 440 } },
  sources: [SOURCE],
  options: t.object({
    days: t.integer({
      default: 2,
      min: 1,
      max: 7,
      label: { en: 'Days', es: 'Días' },
      help: { en: 'Today included: 1 is only today, 2 today and tomorrow. The source must look as many days ahead, minus one.', es: 'Hoy incluido: 1 es sólo hoy, 2 hoy y mañana. La fuente debe mirar esos días por delante, menos uno.' },
    }),
    showTitle: t.boolean({
      default: true,
      label: { en: 'Show the titles', es: 'Mostrar los títulos' },
      help: { en: 'Off: "Meeting" instead, for a screen others see. Private meetings never show theirs.', es: 'Apagado: «Reunión» en su lugar, para una pantalla que ven otros. Las privadas nunca lo enseñan.' },
    }),
    ...listOptions(),
    calendars: calendarsFilter(),
    greyMs: before(DEFAULT_THRESHOLDS.greyMs, { en: 'Awake from (before it starts)', es: 'Despierta desde (antes de empezar)' }, { en: 'With no meeting this close, it lets the panel sleep.', es: 'Sin una reunión así de cerca, deja dormir al panel.' }),
    warnMs: before(DEFAULT_THRESHOLDS.warnMs, { en: 'Warning colour from (before it starts)', es: 'Color de aviso desde (antes de empezar)' }, { en: 'From here the card takes its tile over.', es: 'Desde aquí la tarjeta se queda la tesela.' }),
    alertMs: before(DEFAULT_THRESHOLDS.alertMs, { en: 'Alert colour from (before it starts)', es: 'Color de alerta desde (antes de empezar)' }),
    holdMs: t.duration({
      default: 10 * MIN,
      max: 120 * MIN,
      advanced: true,
      label: { en: 'Keep the tile after a start', es: 'Quedarse la tesela al empezar' },
      help: { en: 'Once you know where you are, the tile goes back to its rotation.', es: 'Pasado el arranque ya sabes dónde estás, y la tesela vuelve a su turno.' },
    }),
  }),
  redraw: 'minute',
  render(g, ctx) {
    const p = painter(g, ctx);
    const list = meetingsOf(ctx.sources, ctx.options);
    if (!list) return drawMessage(p, ctx.box, ctx.t(TEXTS.noCalendar), ctx.t(TEXTS.noCalendarHelp));
    if (!agendaDays(list, ctx.now, ctx.options.days).some((d) => d.items.length)) return drawEmpty(g, ctx, ctx.t(TEXTS.noMore));
    drawAgenda(p, ctx.box, list, ctx.options);
  },
  empty: ({ sources, now, options }) => {
    const list = meetingsOf(sources, options);
    return !!list && !agendaDays(list, now, options.days).some((d) => d.items.length);
  },
  // Like before the switch existed: nothing left in the agenda, out of the rotation.
  hideWhenEmpty: true,
  urgent: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources, options) ?? [], now);
    return (!!current && now - current.startsAt < options.holdMs) || (!!upcoming[0] && upcoming[0].startsAt - now <= options.warnMs);
  },
  idle: ({ sources, now, options }) => {
    const { current, next: upcoming } = agendaNow(meetingsOf(sources, options) ?? [], now);
    return !current && !(upcoming[0] && upcoming[0].startsAt - now <= options.greyMs);
  },
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoMeetings(now, locale) } }),
});

export default definePlugin({
  id: 'calendar',
  name: { en: 'Calendar', es: 'Calendario' },
  version: '0.2.0',
  description: {
    en: 'Meetings from published ICS calendars (Outlook/Teams, Google…): a countdown to the next one and the agenda of the next days.',
    es: 'Reuniones de calendarios ICS publicados (Outlook/Teams, Google…): una cuenta atrás hasta la siguiente y la agenda de los próximos días.',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'calendar',
  sources: [events],
  widgets: [next, agenda],
});
