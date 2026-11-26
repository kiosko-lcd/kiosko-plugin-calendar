// Days are local days: the tests run on a clock with daylight saving time.
process.env.TZ = 'Europe/Madrid';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, defaultsOf, DEFAULT_WORKDAY, THEMES, type Workday } from '@kiosko/sdk';
import { renderWidget, widgetState } from '@kiosko/sdk/testing';
import { demoWeek } from './demo.ts';
import { loadIcal, parseMeetings, type Meeting } from './ics.ts';
import { weekLoadWidget } from './index.ts';
import { countable, daysOf, firstDayOfWeek, freeGaps, mergeIntervals, weekLoad, type WeekOptions } from './week.ts';

const SOURCE = 'calendar/events';
const MIN = 60_000;
const HOUR = 60 * MIN;
const O: WeekOptions = { days: 'week', blockMs: 2 * HOUR, warnPercent: 50, alertPercent: 75 };
/** Local time on a day of November 2026: `at(26, 10, 42)` is Thursday the 26th, 10:42. */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const meeting = (title: string, startsAt: number, endsAt: number, extra: Partial<Meeting> = {}): Meeting => ({ title, startsAt, endsAt, ...extra });
const THU = at(26, 10, 42);
const hours = (ms: number) => ms / HOUR;

test('week: intervals merge where they overlap or touch, and the gaps between them', () => {
  assert.deepEqual(mergeIntervals([[5, 8], [1, 3], [2, 4], [8, 9], [10, 10]]), [[1, 4], [5, 9]]);
  assert.deepEqual(freeGaps([[2, 4], [6, 7]], 0, 10), [[0, 2], [4, 6], [7, 10]]);
  assert.deepEqual(freeGaps([[0, 3], [2, 12]], 1, 10), []);
});

test('week: overlapping meetings count once', () => {
  const list = [
    meeting('Workshop', at(24, 9, 30), at(24, 12)),
    meeting('Customer call', at(24, 11, 30), at(24, 12, 30)),
    // The same hour in two calendars, under different titles.
    meeting('Sync', at(24, 14), at(24, 15)),
    meeting('Sync (team)', at(24, 14), at(24, 15)),
    // Inside another one.
    meeting('Quick question', at(24, 10), at(24, 10, 15)),
  ];
  const tue = weekLoad(list, THU, DEFAULT_WORKDAY, O, 'es').days.find((d) => d.date === at(24, 0))!;
  assert.equal(hours(tue.meetingMs), 4, '9:30–12:30 and 14:00–15:00');
  assert.equal(hours(tue.freeMs), 4);
  assert.deepEqual(tue.busy, [[at(24, 9, 30), at(24, 12, 30)], [at(24, 14), at(24, 15)]]);
});

test('week: meetings are clipped to the work hours', () => {
  const list = [
    meeting('Early call', at(23, 8), at(23, 10)),
    meeting('Late call', at(23, 16, 30), at(23, 18)),
    meeting('Evening', at(23, 19), at(23, 20)),
    // From Monday evening into Tuesday morning (an overnight release).
    meeting('Release', at(23, 22), at(24, 9, 30)),
  ];
  const w = weekLoad(list, THU, DEFAULT_WORKDAY, O, 'es');
  const mon = w.days.find((d) => d.date === at(23, 0))!;
  assert.equal(hours(mon.meetingMs), 1.5, '9–10 and 16:30–17, nothing of the evening');
  assert.deepEqual(mon.busy, [[at(23, 9), at(23, 10)], [at(23, 16, 30), at(23, 17)]]);
  const tue = w.days.find((d) => d.date === at(24, 0))!;
  assert.equal(hours(tue.meetingMs), 0.5);
  assert.equal(hours(w.totalMs), 2);
});

test('week: all-day, tentative on request, and zero-length events are not meeting time', () => {
  const list = [
    meeting('On call', at(25, 0), at(26, 0), { allDay: true }),
    meeting('Trip', at(23, 0), at(28, 0), { allDay: true }),
    meeting('Maybe', at(25, 10), at(25, 11), { tentative: true }),
    meeting('Reminder', at(25, 12), at(25, 12)),
    meeting('Real', at(25, 15), at(25, 16)),
  ];
  assert.deepEqual(list.filter((m) => countable(m)).map((m) => m.title), ['Maybe', 'Real']);
  const wed = (o: WeekOptions) => weekLoad(list, THU, DEFAULT_WORKDAY, o, 'es').days.find((d) => d.date === at(25, 0))!;
  assert.equal(hours(wed(O).meetingMs), 2, 'tentative counts by default: the time is held');
  assert.equal(hours(wed({ ...O, hideTentative: true }).meetingMs), 1);
});

const skip = (await loadIcal()) ? false : 'optional dependency ical.js not installed';

test('week: from the feed, events marked free, declined (Outlook keeps them as free) or cancelled take no time', { skip }, async () => {
  const ICAL = (await loadIcal())!;
  const ev = (uid: string, title: string, from: string, to: string, extra: string[] = []) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART;TZID=Europe/Madrid:${from}`, `DTEND;TZID=Europe/Madrid:${to}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT'];
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...ev('1', 'Busy', '20261125T100000', '20261125T110000'),
    ...ev('2', 'Free', '20261125T110000', '20261125T120000', ['TRANSP:TRANSPARENT']),
    ...ev('3', 'Declined', '20261125T120000', '20261125T130000', ['X-MICROSOFT-CDO-BUSYSTATUS:FREE']),
    ...ev('4', 'Cancelled', '20261125T130000', '20261125T140000', ['STATUS:CANCELLED']),
    ...ev('5', 'Out of office', '20261125T140000', '20261125T150000', ['X-MICROSOFT-CDO-BUSYSTATUS:OOF']),
    ...ev('6', 'Tentative', '20261125T150000', '20261125T153000', ['X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE']),
    'BEGIN:VEVENT',
    'UID:7',
    'DTSTART;VALUE=DATE:20261125',
    'DTEND;VALUE=DATE:20261126',
    'SUMMARY:Conference',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const list = parseMeetings(ICAL, ics, { ignore: [], allDay: true }, at(19, 0), at(30, 0));
  const wed = weekLoad(list, THU, DEFAULT_WORKDAY, O, 'es').days.find((d) => d.date === at(25, 0))!;
  assert.equal(hours(wed.meetingMs), 1.5, 'Busy and Tentative only');
  assert.deepEqual(wed.busy, [[at(25, 10), at(25, 11)], [at(25, 15), at(25, 15, 30)]]);
});

test('week: which days, by mode and by the language’s first day of the week', () => {
  const dates = (mode: WeekOptions['days'], now = THU, locale = 'es', w: Workday = DEFAULT_WORKDAY) => daysOf(now, w, mode, locale).days.map((d) => new Date(d).getDate());
  assert.equal(firstDayOfWeek('es'), 1);
  assert.equal(firstDayOfWeek('en-US'), 0);
  assert.deepEqual(dates('week'), [23, 24, 25, 26, 27]);
  assert.deepEqual(dates('week', THU, 'en-US'), [23, 24, 25, 26, 27], 'a Sunday start changes nothing for Monday to Friday');
  assert.deepEqual(dates('rest'), [26, 27]);
  assert.deepEqual(dates('next5'), [26, 27, 30, 1, 2]);
  // Friday evening: the week's work is over, so the coming week.
  const friEvening = at(27, 18);
  assert.deepEqual(dates('week', friEvening), [30, 1, 2, 3, 4]);
  assert.equal(daysOf(friEvening, DEFAULT_WORKDAY, 'week', 'es').nextWeek, true);
  assert.deepEqual(dates('rest', friEvening), [30, 1, 2, 3, 4]);
  assert.deepEqual(dates('next5', friEvening), [30, 1, 2, 3, 4]);
  // Saturday in a Sunday-start language: the coming week too.
  assert.deepEqual(dates('week', at(28, 11), 'en-US'), [30, 1, 2, 3, 4]);
  // Nothing to show without working days.
  assert.deepEqual(dates('week', THU, 'es', { ...DEFAULT_WORKDAY, days: [] }), []);
});

test('week: holidays are days off: shown in the week, skipped by "next 5 days", never free time', () => {
  const w: Workday = { ...DEFAULT_WORKDAY, holidays: ['2026-11-26', '2026-12-01'] };
  const list = [meeting('On a holiday?', at(26, 10), at(26, 11)), meeting('Friday', at(27, 9), at(27, 17))];
  const week = weekLoad(list, at(25, 18), w, { ...O, blockMs: HOUR }, 'es');
  const thu = week.days.find((d) => d.date === at(26, 0))!;
  assert.equal(thu.holiday, true);
  assert.equal(thu.meetingMs, 0);
  assert.equal(thu.freeMs, 0);
  assert.equal(week.totalMs, 8 * HOUR, 'only Friday');
  assert.equal(week.next, null, 'not the holiday, and Friday is full');
  assert.deepEqual(daysOf(at(25, 18), w, 'next5', 'es').days.map((d) => new Date(d).getDate()), [27, 30, 2, 3, 4]);
});

test('week: the next free block, from now on, at least as long as asked', () => {
  const list = demoWeek(THU, 'es');
  const w = weekLoad(list, THU, DEFAULT_WORKDAY, O, 'es');
  // Thursday: 9:00–9:15, 11:30–12:30, 13:00–14:00, 16:00–16:30. At 10:42 the morning gap is too short now.
  assert.deepEqual(w.next, { start: at(26, 14), end: at(26, 16) });
  // At 8:00 it's the morning one, 9:15–11:30.
  assert.deepEqual(weekLoad(list, at(26, 8), DEFAULT_WORKDAY, O, 'es').next, { start: at(26, 9, 15), end: at(26, 11, 30) });
  // Starting on the next quarter hour: at 9:20, 9:30–11:30 is still two hours.
  assert.deepEqual(weekLoad(list, at(26, 9, 20), DEFAULT_WORKDAY, O, 'es').next, { start: at(26, 9, 30), end: at(26, 11, 30) });
  // Three hours: Friday 12:00–15:00.
  assert.deepEqual(weekLoad(list, THU, DEFAULT_WORKDAY, { ...O, blockMs: 3 * HOUR }, 'es').next, { start: at(27, 12), end: at(27, 15) });
  // Four: none left this week.
  assert.equal(weekLoad(list, THU, DEFAULT_WORKDAY, { ...O, blockMs: 4 * HOUR }, 'es').next, null);
  // But over the next five working days, Monday… is the same pattern: none either; an empty Monday has one.
  const emptyMonday = list.filter((m) => new Date(m.startsAt).getDate() !== 30);
  assert.deepEqual(weekLoad(emptyMonday, THU, DEFAULT_WORKDAY, { ...O, days: 'next5', blockMs: 4 * HOUR }, 'es').next, { start: at(30, 9), end: at(30, 17) });
  // A past day's gap never counts.
  assert.equal(weekLoad([], at(27, 15, 30), DEFAULT_WORKDAY, O, 'es').next, null, 'only 1 h 30 left on Friday');
});

test('week: amber and red by the share of each day’s work hours, a short Friday by its own hours', () => {
  const w: Workday = { ...DEFAULT_WORKDAY, byDay: { '5': { end: '13:00', hours: 4 } } };
  const list = [
    meeting('Mon', at(23, 9), at(23, 12)), // 3/8
    meeting('Tue', at(24, 9), at(24, 13)), // 4/8
    meeting('Wed', at(25, 9), at(25, 15)), // 6/8
    meeting('Fri', at(27, 9), at(27, 12)), // 3/4
  ];
  const days = weekLoad(list, THU, w, O, 'es').days;
  assert.deepEqual(days.map((d) => d.load), ['ok', 'warn', 'alert', 'ok', 'alert']);
  assert.equal(days[4]!.end, at(27, 13));
  assert.equal(hours(days[4]!.freeMs), 1);
  // Thresholds the other way round: red is never below amber.
  assert.deepEqual(weekLoad(list, THU, w, { ...O, warnPercent: 60, alertPercent: 40 }, 'es').days.map((d) => d.load), ['ok', 'ok', 'alert', 'ok', 'alert']);
});

test('week: across daylight saving changes, days start at midnight and 9:00 stays 9:00', () => {
  const everyDay: Workday = { ...DEFAULT_WORKDAY, days: [0, 1, 2, 3, 4, 5, 6] };
  for (const [now, sunday] of [
    [new Date(2026, 9, 21, 12).getTime(), new Date(2026, 9, 25)], // back to winter time on Sunday 25 October
    [new Date(2026, 2, 25, 12).getTime(), new Date(2026, 2, 29)], // summer time on Sunday 29 March
  ] as const) {
    const list = [meeting('Sunday', new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 9).getTime(), new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 10).getTime())];
    const w = weekLoad(list, now, everyDay, O, 'es');
    assert.equal(w.days.length, 7);
    for (const d of w.days) {
      assert.equal(new Date(d.date).getHours(), 0, 'midnight');
      assert.equal(new Date(d.start).getHours(), 9);
      assert.equal(new Date(d.end).getHours(), 17);
      assert.equal(hours(d.end - d.start), 8, 'eight hours, even on the 23- or 25-hour day');
    }
    assert.deepEqual(w.days.map((d) => new Date(d.date).getDate()), Array.from({ length: 7 }, (_, i) => sunday.getDate() - 6 + i));
    assert.equal(hours(w.days[6]!.meetingMs), 1);
    assert.equal(w.days[6]!.busy[0]![0], list[0]!.startsAt);
  }
  // Sunday night after the change, the coming week starts on Monday's midnight, not an hour off.
  const next = daysOf(new Date(2026, 9, 25, 23, 30).getTime(), DEFAULT_WORKDAY, 'week', 'es');
  assert.equal(next.nextWeek, true);
  assert.deepEqual(next.days, [26, 27, 28, 29, 30].map((d) => new Date(2026, 9, d).getTime()));
});

test('week: hours past midnight (a night shift) end the next day', () => {
  const night: Workday = { ...DEFAULT_WORKDAY, start: '22:00', end: '06:00' };
  const mon = weekLoad([meeting('Handover', at(24, 5), at(24, 7))], THU, night, O, 'es').days[0]!;
  assert.equal(hours(mon.end - mon.start), 8);
  assert.equal(hours(mon.meetingMs), 1, '5:00–6:00 on Tuesday morning belongs to Monday night');
});

// ---- The widget ----

const SIZES = [{ w: 172, h: 320 }, { w: 160, h: 100 }, { w: 320, h: 240 }, { w: 480, h: 260 }, { w: 640, h: 400 }, { w: 200, h: 500 }, { w: 800, h: 160 }, { w: 960, h: 120 }, { w: 1920, h: 140 }, { w: 1280, h: 400 }, { w: 320, h: 60 }];
const LOCALES = ['en', 'es', 'de', 'zh-Hans', 'zh-Hant'];

test('widget: paints at every size, language and theme, without throwing or spilling', () => {
  // Every theme is painted by kiosko-check.test.ts. Here: every size in every language, a light theme,
  // and other moments of the week (the coming week on Friday evening, an untouched Monday morning).
  const cases = [
    ...SIZES.flatMap((size) => LOCALES.map((locale) => ({ size, locale, theme: 'midnight', now: THU }))),
    ...SIZES.map((size) => ({ size, locale: 'es', theme: 'paper', now: THU })),
    ...SIZES.flatMap((size) => [at(27, 18), at(23, 8)].map((now) => ({ size, locale: 'de', theme: 'midnight', now }))),
  ];
  for (const { size, locale, theme, now } of cases) {
    const r = renderWidget(weekLoadWidget, { size, locale, theme, now });
    const where = `${size.w}x${size.h} ${locale} ${theme} ${new Date(now).toISOString()}`;
    assert.equal(r.error, undefined, where);
    assert.equal(r.outside, 0, where);
    assert.ok(r.texts.length > 0, where);
  }
});

test('widget: the week in Spanish, English (12 h), German and Chinese', () => {
  const es = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'es', now: THU });
  assert.ok(es.texts.includes('Próximo hueco de 2 h: hoy 14:00–16:00'), es.texts.join(' | '));
  assert.ok(es.texts.includes('19 h') && es.texts.includes(' de reuniones esta semana'), 'the total, its number apart');
  assert.ok(es.texts.includes('6 h 45') && es.texts.includes('mar 24'));
  const en = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'en', now: THU, timeFormat: '12h' });
  assert.ok(en.texts.includes('Next 2 h block: today 2:00–4:00 PM'), en.texts.join(' | '));
  const de = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'de', now: at(26, 8) });
  assert.ok(de.texts.includes('Nächste 2 Std. frei: heute 09:15–11:30'), de.texts.join(' | '));
  const zh = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'zh-Hant', now: at(25, 18) });
  assert.ok(zh.texts.some((t) => t.includes('明天') && t.includes('上午 9:15–11:30')), zh.texts.join(' | '));
  // A wide strip: columns, with the free time under each day.
  const strip = renderWidget(weekLoadWidget, { size: { w: 1920, h: 140 }, locale: 'es', now: THU });
  assert.ok(strip.texts.includes('5 h 15 libres'), strip.texts.join(' | '));
});

test('widget: none found, the coming week, and the total past a day', () => {
  const busy = [23, 24, 25, 26, 27].map((d) => meeting('All day long', at(d, 9), at(d, 17)));
  const r = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'es', now: THU, sources: { [SOURCE]: busy } });
  assert.ok(r.texts.includes('No queda un hueco de 2 h esta semana'), r.texts.join(' | '));
  assert.ok(r.texts.includes('40 h'), 'forty hours, not "1 d 16 h"');
  const sat = renderWidget(weekLoadWidget, { size: { w: 480, h: 260 }, locale: 'en', now: at(28, 11), sources: { [SOURCE]: [] } });
  assert.ok(sat.texts.includes(' of meetings next week'), sat.texts.join(' | '));
  assert.ok(sat.texts.some((t) => t.startsWith('Next 2 h block: Monday')), sat.texts.join(' | '));
});

/** Paints with a working week of one's own (`renderWidget` uses the default one). */
function paint(workday: Workday, sources: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const texts: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (texts.push(a[1]), kit.drawTracked(...a)) };
  const g = createCanvas(480, 260).getContext('2d');
  const theme = THEMES[0]!;
  weekLoadWidget.render(g as never, { ...createBaseContext({ now: THU, locale: 'es', workday }), options: { ...defaultsOf(weekLoadWidget.options!), ...options }, data: undefined, sources, working: true, box: { x: 0, y: 0, w: 480, h: 260 }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas }, preview: false } as never);
  return texts;
}

test('widget: holidays, no working days, no calendar yet', () => {
  const holiday = paint({ ...DEFAULT_WORKDAY, holidays: ['2026-11-26'] }, { [SOURCE]: demoWeek(THU, 'es') });
  assert.ok(holiday.includes('Festivo'), holiday.join(' | '));
  assert.ok(holiday.includes('Próximo hueco de 2 h: mañana 12:00–15:00'), holiday.join(' | '));
  assert.deepEqual(paint({ ...DEFAULT_WORKDAY, days: [] }, { [SOURCE]: [] }).slice(0, 1), ['Sin días laborables']);
  assert.deepEqual(paint(DEFAULT_WORKDAY, {}).slice(0, 1), ['Aún sin calendario']);
  // A calendar filter: only "Work" meetings count.
  const list = [meeting('Work', at(26, 14), at(26, 15), { calendars: ['Work'] }), meeting('Dentist', at(26, 15), at(26, 16), { calendars: ['Personal'] })];
  assert.ok(paint(DEFAULT_WORKDAY, { [SOURCE]: list }, { calendars: ['Work'] }).includes('1 h'));
});

test('widget: options, and idle outside work hours', () => {
  const o = defaultsOf(weekLoadWidget.options!);
  assert.deepEqual({ days: o.days, blockMs: o.blockMs, warnPercent: o.warnPercent, alertPercent: o.alertPercent, hideTentative: o.hideTentative, calendars: o.calendars }, { days: 'week', blockMs: 2 * HOUR, warnPercent: 50, alertPercent: 75, hideTentative: false, calendars: [] });
  assert.equal(widgetState(weekLoadWidget, 'idle', { now: THU }), false);
  assert.equal(widgetState(weekLoadWidget, 'idle', { now: at(26, 20) }), true);
  assert.equal(widgetState(weekLoadWidget, 'idle', { now: at(28, 11) }), true, 'Saturday');
});
