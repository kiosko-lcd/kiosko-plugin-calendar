/**
 * A believable working day for the gallery and the editor, derived from
 * `now` only (so the same instant always draws the same card): a review
 * under way, a one-to-one coming up, a tentative workshop later, tomorrow's
 * planning and on-call day (an all-day event), and a few meetings in the
 * days after. Generic names only.
 */
import { localize } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';

const MIN = 60_000;

export function demoMeetings(now: number, locale = 'en', o: { current?: boolean } = {}): Meeting[] {
  const tr = (en: string, es: string) => localize({ en, es }, locale);
  // Meetings sit on quarter hours, like real ones.
  const base = Math.floor(now / (15 * MIN)) * 15 * MIN;
  const d = new Date(now);
  const dayAt = (days: number, h: number, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m).getTime();
  const tomorrowAt = (h: number, m: number) => dayAt(1, h, m);
  const all: Meeting[] = [
    { title: tr('Design review', 'Revisión de diseño'), startsAt: base, endsAt: base + 30 * MIN, attendees: ['Alex', 'Sam', 'Kim'] },
    { title: tr('1:1 with Jordan', '1:1 con Jordan'), startsAt: base + 30 * MIN, endsAt: base + 60 * MIN, attendees: ['Jordan'] },
    { title: tr('Roadmap workshop', 'Taller de hoja de ruta'), startsAt: base + 180 * MIN, endsAt: base + 240 * MIN, tentative: true },
    { title: tr('On call', 'Guardia'), startsAt: dayAt(1, 0, 0), endsAt: dayAt(2, 0, 0), allDay: true },
    { title: tr('Quarterly planning', 'Planificación trimestral'), startsAt: tomorrowAt(9, 30), endsAt: tomorrowAt(11, 0), attendees: ['Alex', 'Jordan', 'Robin', 'Sam', 'Taylor'] },
    { title: tr('Standup', 'Daily'), startsAt: dayAt(2, 9, 0), endsAt: dayAt(2, 9, 15) },
    { title: tr('Customer demo', 'Demo con el cliente'), startsAt: dayAt(2, 12, 0), endsAt: dayAt(2, 13, 0) },
    { title: tr('Bank holiday', 'Festivo'), startsAt: dayAt(4, 0, 0), endsAt: dayAt(5, 0, 0), allDay: true },
    { title: tr('Retrospective', 'Retrospectiva'), startsAt: dayAt(5, 16, 0), endsAt: dayAt(5, 17, 0) },
  ];
  // Without the one under way, a single tile shows a countdown instead of "now".
  return o.current === false ? all.filter((m) => !(m.startsAt <= now && m.endsAt > now)) : all;
}
