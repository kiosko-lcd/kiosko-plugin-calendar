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
    { title: tr({ en: 'Design review', es: 'Revisión de diseño', de: 'Design-Review' }), startsAt: base, endsAt: base + 30 * MIN, attendees: ['Alex', 'Sam', 'Kim'] },
    { title: tr({ en: '1:1 with Jordan', es: '1:1 con Jordan', de: '1:1 mit Jordan' }), startsAt: base + 30 * MIN, endsAt: base + 60 * MIN, attendees: ['Jordan'] },
    { title: tr({ en: 'Roadmap workshop', es: 'Taller de hoja de ruta', de: 'Roadmap-Workshop' }), startsAt: base + 180 * MIN, endsAt: base + 240 * MIN, tentative: true },
    { title: tr({ en: 'On call', es: 'Guardia', de: 'Bereitschaft' }), startsAt: dayAt(1, 0, 0), endsAt: dayAt(2, 0, 0), allDay: true },
    { title: tr({ en: 'Quarterly planning', es: 'Planificación trimestral', de: 'Quartalsplanung' }), startsAt: tomorrowAt(9, 30), endsAt: tomorrowAt(11, 0), attendees: ['Alex', 'Jordan', 'Robin', 'Sam', 'Taylor'] },
    { title: tr({ en: 'Standup', es: 'Daily', de: 'Daily' }), startsAt: dayAt(2, 9, 0), endsAt: dayAt(2, 9, 15) },
    { title: tr({ en: 'Customer demo', es: 'Demo con el cliente', de: 'Kundendemo' }), startsAt: dayAt(2, 12, 0), endsAt: dayAt(2, 13, 0) },
    { title: tr({ en: 'Bank holiday', es: 'Festivo', de: 'Feiertag' }), startsAt: dayAt(4, 0, 0), endsAt: dayAt(5, 0, 0), allDay: true },
    { title: tr({ en: 'Retrospective', es: 'Retrospectiva', de: 'Retrospektive' }), startsAt: dayAt(5, 16, 0), endsAt: dayAt(5, 17, 0) },
  ];
  // Without the one under way, a single tile shows a countdown instead of "now".
  return o.current === false ? all.filter((m) => !(m.startsAt <= now && m.endsAt > now)) : all;
}
