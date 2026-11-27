/**
 * A believable working day for the gallery and the editor, derived from
 * `now` only (so the same instant always draws the same card): a review
 * under way, a one-to-one coming up, a tentative workshop later, tomorrow's
 * planning and on-call day (an all-day event), and a few meetings in the
 * days after. Generic names only.
 */
import { localize, type Localized } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';

const MIN = 60_000;

export function demoMeetings(now: number, locale = 'en', o: { current?: boolean } = {}): Meeting[] {
  const tr = (text: Localized) => localize(text, locale);
  // Meetings sit on quarter hours, like real ones.
  const base = Math.floor(now / (15 * MIN)) * 15 * MIN;
  const d = new Date(now);
  const dayAt = (days: number, h: number, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m).getTime();
  const tomorrowAt = (h: number, m: number) => dayAt(1, h, m);
  const all: Meeting[] = [
    { title: tr({ en: 'Design review', es: 'Revisión de diseño', de: 'Design-Review', 'zh-Hant': '設計審查', 'zh-Hans': '设计评审' }), startsAt: base, endsAt: base + 30 * MIN, attendees: ['Alex', 'Sam', 'Kim'] },
    { title: tr({ en: '1:1 with Jordan', es: '1:1 con Jordan', de: '1:1 mit Jordan', 'zh-Hant': '與 Jordan 一對一', 'zh-Hans': '与 Jordan 一对一' }), startsAt: base + 30 * MIN, endsAt: base + 60 * MIN, attendees: ['Jordan'] },
    { title: tr({ en: 'Roadmap workshop', es: 'Taller de hoja de ruta', de: 'Roadmap-Workshop', 'zh-Hant': '路線圖工作坊', 'zh-Hans': '路线图研讨会' }), startsAt: base + 180 * MIN, endsAt: base + 240 * MIN, tentative: true },
    { title: tr({ en: 'On call', es: 'Guardia', de: 'Bereitschaft', 'zh-Hant': '值班', 'zh-Hans': '值班' }), startsAt: dayAt(1, 0, 0), endsAt: dayAt(2, 0, 0), allDay: true },
    { title: tr({ en: 'Quarterly planning', es: 'Planificación trimestral', de: 'Quartalsplanung', 'zh-Hant': '季度規劃', 'zh-Hans': '季度规划' }), startsAt: tomorrowAt(9, 30), endsAt: tomorrowAt(11, 0), attendees: ['Alex', 'Jordan', 'Robin', 'Sam', 'Taylor'] },
    { title: tr({ en: 'Standup', es: 'Daily', de: 'Daily', 'zh-Hant': '每日站會', 'zh-Hans': '每日站会' }), startsAt: dayAt(2, 9, 0), endsAt: dayAt(2, 9, 15) },
    { title: tr({ en: 'Customer demo', es: 'Demo con el cliente', de: 'Kundendemo', 'zh-Hant': '客戶展示', 'zh-Hans': '客户演示' }), startsAt: dayAt(2, 12, 0), endsAt: dayAt(2, 13, 0) },
    { title: tr({ en: 'Bank holiday', es: 'Festivo', de: 'Feiertag', 'zh-Hant': '國定假日', 'zh-Hans': '法定节假日' }), startsAt: dayAt(4, 0, 0), endsAt: dayAt(5, 0, 0), allDay: true },
    { title: tr({ en: 'Retrospective', es: 'Retrospectiva', de: 'Retrospektive', 'zh-Hant': '回顧會議', 'zh-Hans': '回顾会' }), startsAt: dayAt(5, 16, 0), endsAt: dayAt(5, 17, 0) },
  ];
  // Without the one under way, a single tile shows a countdown instead of "now".
  return o.current === false ? all.filter((m) => !(m.startsAt <= now && m.endsAt > now)) : all;
}

/**
 * A believable working week for the week-load card, the same pattern every
 * week around `now` (the one before and the one after too, so the card has
 * data whichever week it shows): a light Monday, a packed Tuesday with two
 * meetings on top of each other, a crowded Wednesday with an on-call day and
 * a tentative one, a Thursday with a two-hour hole in the morning and a quiet
 * Friday afternoon. Hours inside 9:00–17:00, the default working day.
 */
export function demoWeek(now: number, locale = 'en'): Meeting[] {
  const tr = (text: Localized) => localize(text, locale);
  const d = new Date(now);
  const T = {
    standup: { en: 'Standup', es: 'Daily', de: 'Daily', 'zh-Hant': '每日站會', 'zh-Hans': '每日站会' },
    planning: { en: 'Sprint planning', es: 'Planificación del sprint', de: 'Sprintplanung', 'zh-Hant': '衝刺規劃', 'zh-Hans': '冲刺规划' },
    oneOnOne: { en: '1:1 with Jordan', es: '1:1 con Jordan', de: '1:1 mit Jordan', 'zh-Hant': '與 Jordan 一對一', 'zh-Hans': '与 Jordan 一对一' },
    workshop: { en: 'Roadmap workshop', es: 'Taller de hoja de ruta', de: 'Roadmap-Workshop', 'zh-Hant': '路線圖工作坊', 'zh-Hans': '路线图研讨会' },
    customer: { en: 'Customer call', es: 'Llamada con el cliente', de: 'Kundentermin', 'zh-Hant': '客戶通話', 'zh-Hans': '客户通话' },
    review: { en: 'Design review', es: 'Revisión de diseño', de: 'Design-Review', 'zh-Hant': '設計審查', 'zh-Hans': '设计评审' },
    hiring: { en: 'Interview', es: 'Entrevista', de: 'Vorstellungsgespräch', 'zh-Hant': '面試', 'zh-Hans': '面试' },
    sync: { en: 'Team sync', es: 'Sincronización del equipo', de: 'Team-Abstimmung', 'zh-Hant': '團隊同步', 'zh-Hans': '团队同步' },
    onCall: { en: 'On call', es: 'Guardia', de: 'Bereitschaft', 'zh-Hant': '值班', 'zh-Hans': '值班' },
    demo: { en: 'Customer demo', es: 'Demo con el cliente', de: 'Kundendemo', 'zh-Hant': '客戶展示', 'zh-Hans': '客户演示' },
    retro: { en: 'Retrospective', es: 'Retrospectiva', de: 'Retrospektive', 'zh-Hant': '回顧會議', 'zh-Hans': '回顾会' },
  } satisfies Record<string, Localized>;
  // Weekday (1 = Monday) → [title, from, to, extra]; times as hours.
  const week: Record<number, [Localized, number, number, Partial<Meeting>?][]> = {
    1: [[T.standup, 9, 9.25], [T.planning, 10, 11.5], [T.oneOnOne, 15, 15.5]],
    2: [[T.standup, 9, 9.25], [T.workshop, 9.5, 12], [T.customer, 11.5, 12.5], [T.review, 13, 14], [T.hiring, 14, 15.5], [T.sync, 16, 17]],
    3: [[T.standup, 9, 9.25], [T.review, 10, 11], [T.customer, 12, 13], [T.workshop, 14, 15, { tentative: true }], [T.sync, 15.5, 16.75]],
    4: [[T.standup, 9, 9.25], [T.oneOnOne, 11.5, 12.5], [T.sync, 13, 14], [T.hiring, 16, 16.5]],
    5: [[T.standup, 9, 9.25], [T.demo, 10, 10.5], [T.customer, 11, 12], [T.retro, 15, 16]],
  };
  const out: Meeting[] = [];
  for (let i = -7; i <= 13; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    const at = (h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(h), Math.round((h % 1) * 60)).getTime();
    for (const [title, from, to, extra] of week[day.getDay()] ?? []) out.push({ title: tr(title), startsAt: at(from), endsAt: at(to), ...extra });
    // An all-day event, which doesn't count as a meeting.
    if (day.getDay() === 3) out.push({ title: tr(T.onCall), startsAt: day.getTime(), endsAt: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(), allDay: true });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}
