/**
 * A believable working day for the gallery and the editor, derived from
 * `now` only (so the same instant always draws the same card): a review
 * under way, a one-to-one coming up, a tentative workshop later and
 * tomorrow's planning. Generic names only.
 */
import { localize } from '@tessera/sdk';
import type { Meeting } from './ics.ts';

const MIN = 60_000;

export function demoMeetings(now: number, locale = 'en', o: { current?: boolean } = {}): Meeting[] {
  const tr = (en: string, es: string) => localize({ en, es }, locale);
  // Meetings sit on quarter hours, like real ones.
  const base = Math.floor(now / (15 * MIN)) * 15 * MIN;
  const d = new Date(now);
  const tomorrowAt = (h: number, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
  const all: Meeting[] = [
    { title: tr('Design review', 'Revisión de diseño'), startsAt: base, endsAt: base + 30 * MIN, attendees: ['Alex', 'Sam', 'Kim'] },
    { title: tr('1:1 with Jordan', '1:1 con Jordan'), startsAt: base + 30 * MIN, endsAt: base + 60 * MIN, attendees: ['Jordan'] },
    { title: tr('Roadmap workshop', 'Taller de hoja de ruta'), startsAt: base + 180 * MIN, endsAt: base + 240 * MIN, tentative: true },
    { title: tr('Quarterly planning', 'Planificación trimestral'), startsAt: tomorrowAt(9, 30), endsAt: tomorrowAt(11, 0), attendees: ['Alex', 'Jordan', 'Robin', 'Sam', 'Taylor'] },
  ];
  // Without the one under way, a single tile shows a countdown instead of "now".
  return o.current === false ? all.filter((m) => !(m.startsAt <= now && m.endsAt > now)) : all;
}
