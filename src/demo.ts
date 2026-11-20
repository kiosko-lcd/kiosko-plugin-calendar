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
