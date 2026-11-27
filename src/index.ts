/**
 * The calendar: one shared source that reads published ICS feeds (Outlook,
 * Teams, Google, iCloud…) as `calendar/events`, and two cards on top of it:
 *
 *   - `calendar/next`: the next meeting as a big countdown that climbs the
 *     theme semaphore as it nears (dim → info → warn → alert) and takes its
 *     tile over when it's about to start and while it lasts.
 *   - `calendar/agenda`: the meetings left today and those of the next days.
 *   - `calendar/week-load`: meeting hours against free hours on each working
 *     day of the week, and the next free block for deep work.
 *
 * The source keeps a copy of every feed on disk (named after a hash of the
 * address, which is a secret) and falls back to it when offline. It has
 * profiles (Kiosko 0.2.12 on), for calendars kept apart: «Work» and
 * «Personal», each with its own addresses, copies and options.
 */
import { definePlugin, defineSource, defineWidget, drawEmpty, isWorkingAt, listOptions, PluginError, t, type Localized, type RenderContext } from '@kiosko/sdk';
import { demoMeetings, demoWeek } from './demo.ts';
import { agendaDays, drawAgenda, drawMessage, drawNext, type Painter } from './draw.ts';
import { fetchAll } from './feed.ts';
import { DEFAULT_IGNORE, icsUrls, loadIcal, mergeMeetings, parseMeetings, type Meeting } from './ics.ts';
import { agendaNow, dayStart, DEFAULT_THRESHOLDS, pickNext, selectMeetings, TEXTS } from './meeting.ts';
import { DAYS_MODES, weekLoad } from './week.ts';
import { drawWeek, WEEK_TEXTS } from './week-draw.ts';

export type { Meeting };
export { agendaNow, meetingLevel, pickNext, selectMeetings, type Level, type Thresholds } from './meeting.ts';
export { demoMeetings, demoWeek };
export { weekLoad, type DayLoad, type DaysMode, type WeekLoad, type WeekOptions } from './week.ts';

const SOURCE = 'calendar/events';
const MIN = 60_000;

export const events = defineSource({
  id: 'events',
  name: { en: 'Calendar meetings', es: 'Reuniones del calendario', de: 'Kalendertermine', 'zh-Hant': '行事曆會議', 'zh-Hans': '日历会议' },
  description: {
    en: 'Meetings of this week and the next days from one or more published calendars (ICS). Free and focus-time events are left out, and all-day ones unless you ask for them.',
    es: 'Las reuniones de esta semana y de los próximos días de uno o varios calendarios publicados (ICS). Se dejan fuera los eventos libres y los de concentración, y los de todo el día salvo que los pidas.',
    de: 'Die Termine dieser Woche und der nächsten Tage aus einem oder mehreren veröffentlichten Kalendern (ICS). Als frei markierte Termine und Fokuszeit bleiben außen vor, ganztägige ebenso, sofern du sie nicht anforderst.',
    'zh-Hant': '從一個或多個已發布的行事曆（ICS）取得本週及接下來幾天的會議。空閒與專注時間的活動會排除，全天活動也會排除，除非你要求顯示。',
    'zh-Hans': '从一个或多个已发布的日历（ICS）获取本周及接下来几天的会议。空闲和专注时间的事件会被排除，全天事件也会排除，除非你要求显示。',
  },
  options: t.object({
    urls: t.list(
      t.string({ secret: true, format: 'url', risk: 'network', placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics', label: { en: 'ICS address', es: 'Dirección ICS', de: 'ICS-Adresse', 'zh-Hant': 'ICS 網址', 'zh-Hans': 'ICS 网址' } }),
      {
        max: 10,
        label: { en: 'Calendars (ICS addresses)', es: 'Calendarios (direcciones ICS)', de: 'Kalender (ICS-Adressen)', 'zh-Hant': '行事曆（ICS 網址）', 'zh-Hans': '日历（ICS 网址）' },
        help: {
          en: 'The secret address of a published calendar (Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → ICS). Anyone with it can read your agenda: treat it like a password.',
          es: 'La dirección secreta de un calendario publicado (Outlook web: Configuración → Calendario → Calendarios compartidos → Publicar un calendario → ICS). Quien la tenga lee tu agenda: trátala como una contraseña.',
          de: 'Die geheime Adresse eines veröffentlichten Kalenders (Outlook im Web: Einstellungen → Kalender → Freigegebene Kalender → Kalender veröffentlichen → ICS). Wer sie hat, kann deine Termine lesen: Behandle sie wie ein Passwort.',
          'zh-Hant': '已發布行事曆的私密網址（Outlook 網頁版：設定 → 行事曆 → 共用行事曆 → 發佈行事曆 → ICS）。任何人拿到它都能讀取你的行程：請像密碼一樣保管。',
          'zh-Hans': '已发布日历的私密网址（Outlook 网页版：设置 → 日历 → 共享日历 → 发布日历 → ICS）。任何人拿到它都能读取你的日程：请像密码一样保管。',
        },
      },
    ),
    ignore: t.list(t.string({ label: { en: 'Text', es: 'Texto', de: 'Text', 'zh-Hant': '文字', 'zh-Hans': '文本' } }), {
      default: [...DEFAULT_IGNORE],
      label: { en: 'Ignore titles containing', es: 'Ignorar títulos que contengan', de: 'Titel ignorieren, die enthalten', 'zh-Hant': '忽略標題包含以下文字者', 'zh-Hans': '忽略标题包含以下文字的' },
      help: { en: 'Busy blocks that are not meetings, like focus time. Case and accents don’t matter.', es: 'Bloques ocupados que no son reuniones, como el tiempo de concentración. Da igual mayúsculas y tildes.', de: 'Als beschäftigt markierte Blöcke, die keine Termine sind, etwa Fokuszeit. Groß-/Kleinschreibung und Akzente spielen keine Rolle.', 'zh-Hant': '不是會議的忙碌時段，例如專注時間。不分大小寫與重音符號。', 'zh-Hans': '不是会议的忙碌时段，例如专注时间。不区分大小写和重音符号。' },
    }),
    horizonDays: t.integer({
      default: 6,
      min: 0,
      max: 14,
      label: { en: 'Days ahead', es: 'Días por delante', de: 'Tage im Voraus', 'zh-Hant': '往後天數', 'zh-Hans': '往后天数' },
      help: { en: 'Besides today. The agenda shows as many days as this plus one, at most.', es: 'Además de hoy. La agenda enseña como mucho estos días más uno.', de: 'Zusätzlich zu heute. Die Agenda zeigt höchstens so viele Tage plus einen.', 'zh-Hant': '不含今天。行程最多顯示此天數加一天。', 'zh-Hans': '不含今天。日程最多显示此天数加一天。' },
    }),
    includeAllDay: t.boolean({
      label: { en: 'Include all-day events', es: 'Incluir los eventos de todo el día', de: 'Ganztägige Termine einbeziehen', 'zh-Hant': '包含全天活動', 'zh-Hans': '包含全天事件' },
      help: { en: 'Holidays, trips, on-call days: listed at the top of their day in the agenda. They never count as the next meeting.', es: 'Festivos, viajes, guardias: salen al principio de su día en la agenda. Nunca cuentan como la próxima reunión.', de: 'Feiertage, Reisen, Bereitschaftstage: stehen in der Agenda oben an ihrem Tag. Sie zählen nie als nächster Termin.', 'zh-Hant': '假日、出差、值班日：列在行程中當天的最上方。它們永遠不會算作下一場會議。', 'zh-Hans': '假日、出差、值班日：列在日程中当天的最上方。它们永远不会算作下一场会议。' },
    }),
  }),
  intervalMs: 5 * MIN,
  minIntervalMs: MIN,
  // Feeds download at once; each gets two thirds of this, so a slow one falls back to its copy on disk in time.
  timeoutMs: 30_000,
  async read(ctx): Promise<Meeting[]> {
    const { options: o } = ctx;
    const urls = icsUrls(o.urls);
    if (!urls.length) throw new PluginError({
        en: 'No calendar: add the ICS address of a published calendar to this source',
        es: 'Sin calendario: pon en esta fuente la dirección ICS de un calendario publicado',
        de: 'Kein Kalender: Füge dieser Datenquelle die ICS-Adresse eines veröffentlichten Kalenders hinzu',
        'zh-Hant': '沒有行事曆：請在這個資料來源中加入已發布行事曆的 ICS 網址',
        'zh-Hans': '没有日历：请在此数据源中添加已发布日历的 ICS 网址',
      });
    // Only now, with a calendar configured, is the optional dependency loaded.
    const ICAL = await loadIcal();
    if (!ICAL) throw new Error('the optional dependency ical.js is not installed (npm install ical.js)');
    const timeoutMs = Math.max(1000, Math.round((ctx.timeoutMs * 2) / 3));
    const feeds = await fetchAll(urls, { dir: ctx.cacheDir || ctx.dataDir, timeoutMs, signal: ctx.signal, log: ctx.log, profile: (ctx as { profile?: string }).profile });
    if (!feeds.length) throw new Error(`${urls.length > 1 ? 'no calendar' : 'the calendar'} could be read, and there is no copy on disk`);
    // From a week back: the week-load card shows the days of this week already gone.
    const from = dayStart(ctx.now, -6);
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
    if (unreadable === feeds.length) throw new PluginError({
        en: 'The calendar could not be read as iCalendar: check that its address is the ICS one',
        es: 'El calendario no se pudo leer como iCalendar: comprueba que su dirección es la ICS',
        de: 'Der Kalender konnte nicht als iCalendar gelesen werden: Prüfe, ob es die ICS-Adresse ist',
        'zh-Hant': '無法以 iCalendar 格式讀取行事曆：請確認網址是 ICS 網址',
        'zh-Hans': '无法以 iCalendar 格式读取日历：请确认网址是 ICS 网址',
      });
    return mergeMeetings(all);
  },
  demo: ({ now, locale }) => demoMeetings(now, locale),
  // The calendars the meetings came from (their own names), for the widgets' filter.
  choices: {
    calendars: (meetings) => [...new Set((Array.isArray(meetings) ? meetings : []).flatMap((m) => m.calendars ?? []))].sort((a, b) => a.localeCompare(b)).map((value) => ({ value })),
  },
  // Separate sets of calendars («Work», «Personal»), each with its own copies on disk: Kiosko 0.2.12 and later; older ones ignore it.
  ...({ profiles: true } as {}),
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
    choices: { source: 'calendar/events', list: 'calendars' },
    label: { en: 'Calendars', es: 'Calendarios', de: 'Kalender', 'zh-Hant': '行事曆', 'zh-Hans': '日历' },
    help: {
      en: 'Empty: all. Names as each calendar calls itself (Work, Holidays…), comma-separated; * matches anything, a leading ! leaves out.',
      es: 'Vacío: todos. Nombres como se llama cada calendario (Trabajo, Festivos…), separados por comas; * vale por cualquier cosa y un ! delante excluye.',
      de: 'Leer: alle. Namen, wie sich jeder Kalender selbst nennt (Arbeit, Feiertage…), durch Kommas getrennt; * steht für beliebigen Text, ein vorangestelltes ! schließt aus.',
      'zh-Hant': '留空：全部。各行事曆自己的名稱（工作、假日…），以逗號分隔；* 比對任何內容，開頭加 ! 表示排除。',
      'zh-Hans': '留空：全部。各日历自身的名称（工作、假日…），用逗号分隔；* 匹配任意内容，开头加 ! 表示排除。',
    },
  });

export const next = defineWidget({
  id: 'next',
  name: { en: 'Next meeting', es: 'Próxima reunión', de: 'Nächster Termin', 'zh-Hant': '下一場會議', 'zh-Hans': '下一场会议' },
  description: {
    en: 'A big countdown to your next meeting. Its colour climbs the semaphore as it nears, and it takes the tile over when it’s about to start.',
    es: 'Una cuenta atrás grande hasta tu próxima reunión. Su color sube por el semáforo según se acerca, y se queda la tesela cuando está a punto de empezar.',
    de: 'Ein großer Countdown bis zu deinem nächsten Termin. Je näher er rückt, desto weiter wandert die Farbe die Ampel hinauf, und kurz vor Beginn übernimmt er die Kachel.',
    'zh-Hant': '距離下一場會議的大字倒數。越接近顏色越往紅綠燈的紅色走，快開始時會佔據整個方格。',
    'zh-Hans': '距离下一场会议的大字倒计时。越接近颜色越往红绿灯的红色走，快开始时会占据整个格子。',
  },
  icon: 'calendar-clock',
  category: 'time',
  tags: ['calendar', 'calendario', 'meeting', 'reunión', 'outlook', 'teams', 'ics'],
  size: { min: { w: 160, h: 90 }, preferred: { w: 400, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    showTitle: t.boolean({
      default: true,
      label: { en: 'Show the title', es: 'Mostrar el título', de: 'Titel anzeigen', 'zh-Hant': '顯示標題', 'zh-Hans': '显示标题' },
      help: { en: 'Off: only the time and the countdown. Private meetings never show it.', es: 'Apagado: sólo la hora y la cuenta atrás. Las privadas nunca lo enseñan.', de: 'Aus: nur Uhrzeit und Countdown. Private Termine zeigen ihn nie.', 'zh-Hant': '關閉：只顯示時間與倒數。私人會議一律不顯示標題。', 'zh-Hans': '关闭：只显示时间和倒计时。私人会议一律不显示标题。' },
    }),
    showAttendees: t.boolean({
      default: true,
      label: { en: 'Show who attends', es: 'Mostrar quién asiste', de: 'Teilnehmende anzeigen', 'zh-Hant': '顯示與會者', 'zh-Hans': '显示参会人' },
      help: { en: 'With the title. Outlook’s published calendars don’t carry them.', es: 'Junto al título. Los calendarios publicados de Outlook no los traen.', de: 'Zusammen mit dem Titel. Veröffentlichte Outlook-Kalender enthalten sie nicht.', 'zh-Hant': '與標題一起顯示。Outlook 發布的行事曆不含與會者。', 'zh-Hans': '与标题一起显示。Outlook 发布的日历不含参会人。' },
    }),
    greyMs: before(DEFAULT_THRESHOLDS.greyMs, { en: 'Awake from (before it starts)', es: 'Despierta desde (antes de empezar)', de: 'Aktiv ab (vor Beginn)', 'zh-Hant': '開始前多久喚醒', 'zh-Hans': '开始前多久唤醒' }, { en: 'Further away it is drawn dim and lets the panel sleep.', es: 'Más lejos se pinta tenue y deja dormir al panel.', de: 'Liegt er weiter weg, wird er gedimmt gezeichnet und das Panel darf schlafen.', 'zh-Hant': '離開始還早時會以暗色繪製，並讓面板休眠。', 'zh-Hans': '离开始还早时以暗色绘制，并让副屏休眠。' }),
    readyMs: before(DEFAULT_THRESHOLDS.readyMs, { en: 'Info colour from (before it starts)', es: 'Color informativo desde (antes de empezar)', de: 'Infofarbe ab (vor Beginn)', 'zh-Hant': '開始前多久轉為資訊色', 'zh-Hans': '开始前多久变为信息色' }),
    warnMs: before(DEFAULT_THRESHOLDS.warnMs, { en: 'Warning colour from (before it starts)', es: 'Color de aviso desde (antes de empezar)', de: 'Warnfarbe ab (vor Beginn)', 'zh-Hant': '開始前多久轉為警告色', 'zh-Hans': '开始前多久变为警告色' }, { en: 'Also when, back to back, the next meeting replaces the one under way.', es: 'También cuando, con reuniones seguidas, la siguiente sustituye a la que está en curso.', de: 'Auch wenn bei direkt aufeinanderfolgenden Terminen der nächste den laufenden ablöst.', 'zh-Hant': '會議接連進行時，下一場取代進行中的會議也會套用。', 'zh-Hans': '会议连着开时，下一场取代进行中的会议也会适用。' }),
    alertMs: before(DEFAULT_THRESHOLDS.alertMs, { en: 'Alert from (before it starts)', es: 'Alerta desde (antes de empezar)', de: 'Alarm ab (vor Beginn)', 'zh-Hant': '開始前多久進入警示', 'zh-Hans': '开始前多久进入警示' }, { en: 'From here until it ends, it takes its tile over.', es: 'Desde aquí hasta que acaba, se queda la tesela.', de: 'Ab hier bis zum Ende übernimmt er seine Kachel.', 'zh-Hant': '從這時起直到會議結束，都會佔據它的方格。', 'zh-Hans': '从这时起直到会议结束，都会占据它的格子。' }),
    hideTentative: t.boolean({ label: { en: 'Skip tentative meetings', es: 'Saltar las provisionales', de: 'Vorläufige Termine überspringen', 'zh-Hant': '略過暫定的會議', 'zh-Hans': '跳过暂定的会议' }, help: { en: 'Invitations not accepted yet.', es: 'Invitaciones aún sin aceptar.', de: 'Noch nicht angenommene Einladungen.', 'zh-Hant': '尚未接受的邀請。', 'zh-Hans': '尚未接受的邀请。' } }),
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
  name: { en: 'Agenda', es: 'Agenda', de: 'Agenda', 'zh-Hant': '行程', 'zh-Hans': '日程' },
  description: {
    en: 'The meetings left today and those of the next days: the one under way highlighted, the next one with its countdown.',
    es: 'Las reuniones que quedan hoy y las de los próximos días: la que está en curso resaltada, la siguiente con su cuenta atrás.',
    de: 'Die restlichen Termine von heute und die der nächsten Tage: der laufende hervorgehoben, der nächste mit Countdown.',
    'zh-Hant': '今天剩下的會議與接下來幾天的會議：進行中的會醒目標示，下一場附倒數。',
    'zh-Hans': '今天剩下的会议和接下来几天的会议：进行中的会突出显示，下一场附倒计时。',
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
      label: { en: 'Days', es: 'Días', de: 'Tage', 'zh-Hant': '天數', 'zh-Hans': '天数' },
      help: { en: 'Today included: 1 is only today, 2 today and tomorrow. The source must look as many days ahead, minus one.', es: 'Hoy incluido: 1 es sólo hoy, 2 hoy y mañana. La fuente debe mirar esos días por delante, menos uno.', de: 'Heute eingeschlossen: 1 ist nur heute, 2 heute und morgen. Die Datenquelle muss so viele Tage minus einen vorausschauen.', 'zh-Hant': '含今天：1 表示只有今天，2 表示今天和明天。資料來源往後查看的天數須為此值減一。', 'zh-Hans': '含今天：1 表示只有今天，2 表示今天和明天。数据源往后查看的天数须为此值减一。' },
    }),
    showTitle: t.boolean({
      default: true,
      label: { en: 'Show the titles', es: 'Mostrar los títulos', de: 'Titel anzeigen', 'zh-Hant': '顯示標題', 'zh-Hans': '显示标题' },
      help: { en: 'Off: "Meeting" instead, for a screen others see. Private meetings never show theirs.', es: 'Apagado: «Reunión» en su lugar, para una pantalla que ven otros. Las privadas nunca lo enseñan.', de: 'Aus: stattdessen „Termin“, für einen Bildschirm, den andere sehen. Private Termine zeigen ihren nie.', 'zh-Hant': '關閉：改顯示「會議」，適合別人也看得到的螢幕。私人會議一律不顯示標題。', 'zh-Hans': '关闭：改为显示“会议”，适合别人也能看到的屏幕。私人会议一律不显示标题。' },
    }),
    ...listOptions(),
    calendars: calendarsFilter(),
    greyMs: before(DEFAULT_THRESHOLDS.greyMs, { en: 'Awake from (before it starts)', es: 'Despierta desde (antes de empezar)', de: 'Aktiv ab (vor Beginn)', 'zh-Hant': '開始前多久喚醒', 'zh-Hans': '开始前多久唤醒' }, { en: 'With no meeting this close, it lets the panel sleep.', es: 'Sin una reunión así de cerca, deja dormir al panel.', de: 'Ist kein Termin so nah, darf das Panel schlafen.', 'zh-Hant': '沒有這麼近的會議時，會讓面板休眠。', 'zh-Hans': '没有这么近的会议时，会让副屏休眠。' }),
    warnMs: before(DEFAULT_THRESHOLDS.warnMs, { en: 'Warning colour from (before it starts)', es: 'Color de aviso desde (antes de empezar)', de: 'Warnfarbe ab (vor Beginn)', 'zh-Hant': '開始前多久轉為警告色', 'zh-Hans': '开始前多久变为警告色' }, { en: 'From here the card takes its tile over.', es: 'Desde aquí la tarjeta se queda la tesela.', de: 'Ab hier übernimmt die Karte ihre Kachel.', 'zh-Hant': '從這時起，卡片會佔據它的方格。', 'zh-Hans': '从这时起，卡片会占据它的格子。' }),
    alertMs: before(DEFAULT_THRESHOLDS.alertMs, { en: 'Alert colour from (before it starts)', es: 'Color de alerta desde (antes de empezar)', de: 'Alarmfarbe ab (vor Beginn)', 'zh-Hant': '開始前多久轉為警示色', 'zh-Hans': '开始前多久变为警示色' }),
    holdMs: t.duration({
      default: 10 * MIN,
      max: 120 * MIN,
      advanced: true,
      label: { en: 'Keep the tile after a start', es: 'Quedarse la tesela al empezar', de: 'Kachel nach Beginn behalten', 'zh-Hant': '開始後仍佔據方格', 'zh-Hans': '开始后仍占据格子' },
      help: { en: 'Once you know where you are, the tile goes back to its rotation.', es: 'Pasado el arranque ya sabes dónde estás, y la tesela vuelve a su turno.', de: 'Sobald du weißt, wo du hinmusst, kehrt die Kachel in ihre Rotation zurück.', 'zh-Hant': '開始一陣子後你已經知道該去哪裡，方格就會回到輪播。', 'zh-Hans': '开始一阵子后你已经知道该去哪里，格子就会回到轮播。' },
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

const HOUR = 60 * MIN;

/** The week's load, worked out once a minute per tile (the render, `idle` and the tests ask for the same). */
let weekMemo: { key: string; list: unknown; value: ReturnType<typeof weekLoad> } | null = null;
const weekOf = (list: Meeting[], src: unknown, now: number, workday: RenderContext<unknown, unknown>['workday'], o: Parameters<typeof weekLoad>[3], locale: string) => {
  const key = `${Math.floor(now / MIN)}|${locale}|${JSON.stringify(workday)}|${JSON.stringify(o)}|${list.length}`;
  if (weekMemo && weekMemo.key === key && weekMemo.list === src) return weekMemo.value;
  const value = weekLoad(list, now, workday, o, locale);
  weekMemo = { key, list: src, value };
  return value;
};

const percent = (def: number, label: Localized, help?: Localized) => t.integer({ default: def, min: 0, max: 100, unit: '%', slider: true, label, ...(help ? { help } : {}) });

export const weekLoadWidget = defineWidget({
  id: 'week-load',
  name: { en: 'Your week in meetings', es: 'Tu semana en reuniones', de: 'Deine Woche in Terminen', 'zh-Hant': '你的一週會議', 'zh-Hans': '你的一周会议' },
  description: {
    en: 'Meeting hours against free hours on each working day of the week, the busiest days in amber or red, the next free block long enough for deep work, and the week’s total.',
    es: 'Horas de reunión frente a horas libres en cada día laborable de la semana, los días más cargados en ámbar o rojo, el próximo hueco largo para trabajo profundo y el total de la semana.',
    de: 'Terminstunden gegenüber freien Stunden an jedem Arbeitstag der Woche, die vollsten Tage in Gelb oder Rot, der nächste freie Block, der für konzentriertes Arbeiten reicht, und die Summe der Woche.',
    'zh-Hant': '本週每個工作日的會議時數與空閒時數、最滿的日子以琥珀色或紅色標示、下一段足以專注工作的空檔，以及本週總計。',
    'zh-Hans': '本周每个工作日的会议时长与空闲时长、最满的日子以琥珀色或红色标示、下一段足以专注工作的空档，以及本周总计。',
  },
  icon: 'calendar-range',
  category: 'time',
  tags: ['calendar', 'calendario', 'meeting', 'reunión', 'week', 'semana', 'focus', 'deep work', 'outlook', 'teams', 'ics'],
  size: { min: { w: 160, h: 100 }, preferred: { w: 480, h: 260 } },
  sources: [SOURCE],
  options: t.object({
    days: t.enum(DAYS_MODES, {
      default: 'week',
      labels: {
        week: { en: 'The whole week', es: 'Toda la semana', de: 'Die ganze Woche', 'zh-Hant': '整週', 'zh-Hans': '整周' },
        rest: { en: 'The rest of the week', es: 'Lo que queda de semana', de: 'Der Rest der Woche', 'zh-Hant': '本週剩餘的日子', 'zh-Hans': '本周剩余的日子' },
        next5: { en: 'The next 5 working days', es: 'Los próximos 5 días laborables', de: 'Die nächsten 5 Arbeitstage', 'zh-Hant': '接下來 5 個工作日', 'zh-Hans': '接下来 5 个工作日' },
      },
      label: { en: 'Days', es: 'Días', de: 'Tage', 'zh-Hant': '天數', 'zh-Hans': '天数' },
      help: {
        en: 'The working days and hours of Settings → Work hours; holidays are days off. Once the week’s work is over, the whole week and its rest are the coming one. The source must look as many days ahead.',
        es: 'Los días y horas de Ajustes → Jornada; los festivos no se trabajan. Acabada la semana, toda la semana y lo que queda de ella son la que viene. La fuente debe mirar esos días por delante.',
        de: 'Die Arbeitstage und -zeiten aus Einstellungen → Arbeitszeit; Feiertage sind frei. Ist die Arbeitswoche vorbei, zeigen „ganze Woche“ und „Rest der Woche“ die kommende. Die Datenquelle muss so viele Tage vorausschauen.',
        'zh-Hant': '使用「設定 → 工作時間」中的工作日與時間；假日不上班。本週工作結束後，「整週」與「剩餘的日子」會改顯示下一週。資料來源須往後查看足夠的天數。',
        'zh-Hans': '使用“设置 → 工作时间”中的工作日与时间；假日不上班。本周工作结束后，“整周”和“剩余的日子”会改为显示下一周。数据源须往后查看足够的天数。',
      },
    }),
    blockMs: t.duration({
      default: 2 * HOUR,
      min: 15 * MIN,
      max: 8 * HOUR,
      label: { en: 'Free block to look for', es: 'Hueco libre que buscar', de: 'Gesuchter freier Block', 'zh-Hant': '要找的空檔長度', 'zh-Hans': '要找的空档长度' },
      help: { en: 'The next stretch without meetings at least this long, within work hours: for deep work.', es: 'El próximo tramo sin reuniones de al menos esto, dentro de la jornada: para trabajo profundo.', de: 'Der nächste Abschnitt ohne Termine, mindestens so lang, innerhalb der Arbeitszeit: für konzentriertes Arbeiten.', 'zh-Hant': '工作時間內下一段至少這麼長、沒有會議的時段：用來專注工作。', 'zh-Hans': '工作时间内下一段至少这么长、没有会议的时段：用来专注工作。' },
    }),
    warnPercent: percent(50, { en: 'Amber from', es: 'Ámbar desde', de: 'Gelb ab', 'zh-Hant': '琥珀色起點', 'zh-Hans': '琥珀色起点' }, { en: 'Share of the day’s work hours in meetings.', es: 'Parte de la jornada de ese día en reuniones.', de: 'Anteil der Arbeitszeit des Tages in Terminen.', 'zh-Hant': '當天工作時間中會議所佔的比例。', 'zh-Hans': '当天工作时间中会议所占的比例。' }),
    alertPercent: percent(75, { en: 'Red from', es: 'Rojo desde', de: 'Rot ab', 'zh-Hant': '紅色起點', 'zh-Hans': '红色起点' }, { en: 'Share of the day’s work hours in meetings.', es: 'Parte de la jornada de ese día en reuniones.', de: 'Anteil der Arbeitszeit des Tages in Terminen.', 'zh-Hant': '當天工作時間中會議所佔的比例。', 'zh-Hans': '当天工作时间中会议所占的比例。' }),
    hideTentative: t.boolean({
      label: { en: 'Don’t count tentative meetings', es: 'No contar las provisionales', de: 'Vorläufige Termine nicht zählen', 'zh-Hant': '不計入暫定的會議', 'zh-Hans': '不计入暂定的会议' },
      help: { en: 'Invitations not accepted yet. All-day events and those marked free never count.', es: 'Invitaciones aún sin aceptar. Los eventos de todo el día y los marcados como libres nunca cuentan.', de: 'Noch nicht angenommene Einladungen. Ganztägige und als frei markierte Termine zählen nie.', 'zh-Hant': '尚未接受的邀請。全天活動與標為空閒的活動一律不計。', 'zh-Hans': '尚未接受的邀请。全天事件和标为空闲的事件一律不计。' },
    }),
    calendars: calendarsFilter(),
  }),
  redraw: 'minute',
  render(g, ctx) {
    const p = painter(g, ctx);
    const list = meetingsOf(ctx.sources, ctx.options);
    if (!list) return drawMessage(p, ctx.box, ctx.t(TEXTS.noCalendar), ctx.t(TEXTS.noCalendarHelp));
    const week = weekOf(list, ctx.sources[SOURCE], ctx.now, ctx.workday, ctx.options, ctx.locale);
    if (!week.days.length) return drawMessage(p, ctx.box, ctx.t(WEEK_TEXTS.noDays), ctx.t(WEEK_TEXTS.noDaysHelp));
    drawWeek(p, ctx.box, week, ctx.options);
  },
  // Outside work hours it lets the panel sleep.
  idle: ({ now, workday }) => !isWorkingAt(workday, now),
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoWeek(now, locale) } }),
});

export default definePlugin({
  id: 'calendar',
  name: { en: 'Calendar', es: 'Calendario', de: 'Kalender', 'zh-Hant': '行事曆', 'zh-Hans': '日历' },
  version: '0.4.0',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  permissions: { network: ['user'] },
  description: {
    en: 'Meetings from published ICS calendars (Outlook/Teams, Google…): a countdown to the next one, the agenda of the next days and how full your week is.',
    es: 'Reuniones de calendarios ICS publicados (Outlook/Teams, Google…): una cuenta atrás hasta la siguiente, la agenda de los próximos días y lo llena que está tu semana.',
    de: 'Termine aus veröffentlichten ICS-Kalendern (Outlook/Teams, Google…): ein Countdown bis zum nächsten, die Agenda der nächsten Tage und wie voll deine Woche ist.',
    'zh-Hant': '來自已發布 ICS 行事曆（Outlook/Teams、Google…）的會議：下一場的倒數、接下來幾天的行程，以及你這週有多滿。',
    'zh-Hans': '来自已发布 ICS 日历（Outlook/Teams、Google…）的会议：下一场的倒计时、接下来几天的日程，以及你这周有多满。',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'calendar',
  sources: [events],
  widgets: [next, agenda, weekLoadWidget],
});
