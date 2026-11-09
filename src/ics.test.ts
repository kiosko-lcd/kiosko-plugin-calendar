import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_IGNORE, icsUrls, ignored, loadIcal, mergeMeetings, parseMeetings, type Meeting } from './ics.ts';

/**
 * `ical.js` is an optional dependency: without it these tests are skipped
 * instead of failing. Nobody should need it to run the suite.
 */
const ICAL = await loadIcal();
const skip = ICAL ? false : 'optional dependency ical.js not installed';

/** 2026-08-18 (a Tuesday) at 09:00 Madrid time (CEST, +0200). */
const NOW = Date.parse('2026-08-18T09:00:00+02:00');
const END_OF_DAY = Date.parse('2026-08-18T23:59:59.999+02:00');

const parse = (ics: string, o: { from?: number; until?: number; ignore?: string[] } = {}) =>
  parseMeetings(ICAL!, ics, { ignore: o.ignore ?? DEFAULT_IGNORE }, o.from ?? NOW, o.until ?? END_OF_DAY);

/** A minimal ICS shaped like Outlook's: Windows TZID plus its VTIMEZONE. */
function ics(events: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:Romance Standard Time',
    'BEGIN:STANDARD',
    'DTSTART:16011028T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010325T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function vevent(fields: Record<string, string>): string {
  return ['BEGIN:VEVENT', ...Object.entries(fields).map(([k, v]) => `${k}:${v}`), 'END:VEVENT'].join('\r\n');
}

const at = (local: string) => ({ 'DTSTART;TZID=Romance Standard Time': local });
const span = (start: string, end: string) => ({ ...at(start), 'DTEND;TZID=Romance Standard Time': end });

test('calendar: resolves Windows TZIDs with the VTIMEZONE of the file itself', { skip }, () => {
  // Otherwise a zone database would be needed; the typical bug is exactly one
  // hour off, which in a meeting reminder is worse than no reminder.
  const [m] = parse(ics(vevent({ ...span('20260818T103000', '20260818T110000'), SUMMARY: 'Committee' })));
  assert.ok(m, 'should find the meeting');
  assert.equal(new Date(m.startsAt).toISOString(), '2026-08-18T08:30:00.000Z', '10:30 CEST is 08:30 UTC');
  assert.equal(m.endsAt - m.startsAt, 30 * 60_000);
});

test('calendar: expands recurrences (the morning stand-up is one)', { skip }, () => {
  const cal = ics(vevent({ ...span('20260601T094500', '20260601T100000'), RRULE: 'FREQ=WEEKLY;UNTIL=20270101T000000Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR', SUMMARY: 'Daily', UID: 'daily-1' }));
  const found = parse(cal);
  assert.equal(found.length, 1, "today's occurrence, a Tuesday");
  assert.equal(found[0]!.title, 'Daily');
  assert.equal(new Date(found[0]!.startsAt).toISOString(), '2026-08-18T07:45:00.000Z');
});

test('calendar: a series started years ago still reaches today', { skip }, () => {
  // The old 500-occurrence cap stopped a weekday stand-up created two years
  // before, silently: the walk starts at the first occurrence, not today.
  const cal = ics(vevent({ ...span('20220103T094500', '20220103T100000'), RRULE: 'FREQ=DAILY', SUMMARY: 'Old daily', UID: 'old-1' }));
  assert.deepEqual(parse(cal).map((m) => m.title), ['Old daily']);
});

test('calendar: jumping ahead in long series changes no occurrence', { skip }, () => {
  // Daily, weekdays, every other week, a Sunday start out of sync with its
  // rule, a skipped day, a moved one, and DST changes in between.
  const cal = ics([
    vevent({ ...span('20230102T094500', '20230102T100000'), RRULE: 'FREQ=DAILY', SUMMARY: 'Daily', UID: 'a' }),
    vevent({ ...span('20220103T093000', '20220103T094500'), RRULE: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', SUMMARY: 'Stand-up', UID: 'b', 'EXDATE;TZID=Romance Standard Time': '20261028T093000' }),
    vevent({ ...span('20210907T160000', '20210907T170000'), RRULE: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=MO', SUMMARY: 'Fortnightly', UID: 'c' }),
    vevent({ ...span('20240107T080000', '20240107T081500'), RRULE: 'FREQ=WEEKLY;BYDAY=MO,WE', SUMMARY: 'Out of sync', UID: 'd' }),
    vevent({ ...span('20200101T120000', '20200101T130000'), RRULE: 'FREQ=DAILY;INTERVAL=3;UNTIL=20271231T000000Z', SUMMARY: 'Every third day', UID: 'e' }),
    vevent({ UID: 'b', 'RECURRENCE-ID;TZID=Romance Standard Time': '20261029T093000', ...span('20261029T113000', '20261029T114500'), SUMMARY: 'Stand-up (moved)' }),
  ].join('\r\n'));
  const key = (ms: Meeting[]) => ms.map((m) => `${new Date(m.startsAt).toISOString()} ${m.title}`);
  for (const day of ['2026-03-27', '2026-03-30', '2026-08-18', '2026-10-24', '2026-10-27', '2026-10-29', '2026-11-02']) {
    const from = Date.parse(`${day}T00:00:00+01:00`);
    const until = from + 3 * 86_400_000;
    const quick = parseMeetings(ICAL!, cal, { ignore: [] }, from, until);
    const slow = parseMeetings(ICAL!, cal, { ignore: [], walkFromStart: true }, from, until);
    assert.ok(quick.length > 0, day);
    assert.deepEqual(key(quick), key(slow), day);
  }
});

test('calendar: a moved occurrence shows once, at its new time; EXDATE removes one', { skip }, () => {
  const series = vevent({ ...span('20260817T094500', '20260817T100000'), RRULE: 'FREQ=DAILY;COUNT=10', SUMMARY: 'Daily', UID: 'd-2', 'EXDATE;TZID=Romance Standard Time': '20260819T094500' });
  const moved = vevent({ UID: 'd-2', 'RECURRENCE-ID;TZID=Romance Standard Time': '20260818T094500', ...span('20260818T120000', '20260818T121500'), SUMMARY: 'Daily (moved)' });
  const found = parse(ics([series, moved].join('\r\n')), { until: Date.parse('2026-08-19T23:59:59+02:00') });
  assert.deepEqual(
    found.map((m) => [m.title, new Date(m.startsAt).toISOString()]),
    [['Daily (moved)', '2026-08-18T10:00:00.000Z']],
    'not at the original 09:45 too, and nothing on the 19th',
  );
});

test('calendar: leaves out what does not claim the user', { skip }, () => {
  const base = span('20260818T120000', '20260818T130000');
  const cal = ics([
    vevent({ ...base, SUMMARY: 'Free', TRANSP: 'TRANSPARENT' }),
    vevent({ ...base, SUMMARY: 'Away', 'X-MICROSOFT-CDO-BUSYSTATUS': 'OOF' }),
    vevent({ ...base, SUMMARY: 'Available', 'X-MICROSOFT-CDO-BUSYSTATUS': 'FREE' }),
    vevent({ ...base, SUMMARY: 'Called off', STATUS: 'CANCELLED' }),
    vevent({ 'DTSTART;VALUE=DATE': '20260818', 'DTEND;VALUE=DATE': '20260819', SUMMARY: 'Holidays' }),
    vevent({ ...base, SUMMARY: 'Tiempo de concentración' }),
    vevent({ ...base, SUMMARY: 'Focus Time' }),
    vevent({ ...base, SUMMARY: 'Real meeting' }),
  ].join('\r\n'));
  assert.deepEqual(parse(cal).map((m) => m.title), ['Real meeting']);
});

test('calendar: a meeting under way still counts; a finished one does not', { skip }, () => {
  const cal = ics([vevent({ ...span('20260818T085000', '20260818T093000'), SUMMARY: 'Under way' }), vevent({ ...span('20260818T080000', '20260818T083000'), SUMMARY: 'Finished' })].join('\r\n'));
  assert.deepEqual(parse(cal).map((m) => m.title), ['Under way']);
});

test('calendar: does not look past the window', { skip }, () => {
  const cal = ics(vevent({ ...span('20260819T090000', '20260819T100000'), SUMMARY: 'Tomorrow' }));
  assert.equal(parse(cal).length, 0);
  assert.equal(parse(cal, { until: Date.parse('2026-08-19T23:59:59+02:00') }).length, 1, 'with one more day it is there');
});

test('calendar: flags tentative and private meetings', { skip }, () => {
  const base = span('20260818T140000', '20260818T150000');
  const cal = ics([
    vevent({ ...base, SUMMARY: 'Maybe', 'X-MICROSOFT-CDO-BUSYSTATUS': 'TENTATIVE' }),
    vevent({ ...base, SUMMARY: 'Secret', CLASS: 'PRIVATE' }),
    vevent({ ...base, SUMMARY: 'Plain' }),
  ].join('\r\n'));
  const found = parse(cal);
  assert.equal(found.find((m) => m.title === 'Maybe')?.tentative, true);
  assert.equal(found.find((m) => m.title === 'Secret')?.private, true);
  const plain = found.find((m) => m.title === 'Plain')!;
  assert.equal(plain.tentative, undefined, 'only set when true');
  assert.equal(plain.private, undefined);
});

test('calendar: attendees who did not decline, by name or mailbox', { skip }, () => {
  const ev = [
    'BEGIN:VEVENT',
    'DTSTART;TZID=Romance Standard Time:20260818T103000',
    'DTEND;TZID=Romance Standard Time:20260818T110000',
    'SUMMARY:Follow-up',
    'ATTENDEE;CN=Ana Pérez;PARTSTAT=ACCEPTED:mailto:ana@example.com',
    'ATTENDEE;CN=Luis Gil;PARTSTAT=DECLINED:mailto:luis@example.com',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:marta.ruiz@example.com',
    'ATTENDEE;CN=ana@example.com;PARTSTAT=TENTATIVE:mailto:ana@example.com',
    'END:VEVENT',
  ].join('\r\n');
  assert.deepEqual(parse(ics(ev))[0]!.attendees, ['Ana Pérez', 'marta.ruiz', 'ana']);
  const [none] = parse(ics(vevent({ ...span('20260818T103000', '20260818T110000'), SUMMARY: 'No attendees' })));
  assert.equal(none!.attendees, undefined);
});

test('calendar: garbage throws (the source counts it, the panel still paints)', { skip }, () => {
  assert.throws(() => parse('this is not an ics'));
});

test('ignored: case and accents do not matter, blank patterns match nothing', () => {
  assert.ok(ignored('TIEMPO DE CONCENTRACION', DEFAULT_IGNORE));
  assert.ok(ignored('Focus time (Viva Insights)', DEFAULT_IGNORE));
  assert.ok(!ignored('Sprint review', DEFAULT_IGNORE));
  assert.ok(!ignored('Anything', ['', '   ']));
});

test('icsUrls: one address or a list, cleaned and without repeats', () => {
  assert.deepEqual(icsUrls('https://a.example/x.ics'), ['https://a.example/x.ics']);
  assert.deepEqual(icsUrls(['https://a.example/x.ics', 'https://b.example/y.ics']), ['https://a.example/x.ics', 'https://b.example/y.ics']);
  // A trailing blank entry must not become a download of the empty string.
  assert.deepEqual(icsUrls(['  https://a.example/x.ics  ', '', '   ']), ['https://a.example/x.ics']);
  assert.deepEqual(icsUrls(''), []);
  assert.deepEqual(icsUrls([]), []);
  assert.deepEqual(icsUrls(['https://a.example/x.ics', 'https://a.example/x.ics', 'https://b.example/y.ics']), ['https://a.example/x.ics', 'https://b.example/y.ics']);
  assert.deepEqual(icsUrls(['webcal://a.example/x.ics']), ['https://a.example/x.ics'], 'webcal is https for fetch');
});

const meeting = (title: string, startsAt: number): Meeting => ({ title, startsAt, endsAt: startsAt + 1_800_000 });

test('mergeMeetings: ordered by time, duplicates across calendars dropped', () => {
  const merged = mergeMeetings([meeting('Retro', 3000), meeting('Daily', 1000), meeting('Daily', 1000), meeting('One to one', 2000)]);
  assert.deepEqual(merged.map((x) => x.title), ['Daily', 'One to one', 'Retro']);
  assert.equal(mergeMeetings([meeting('Daily', 1000), meeting(' daily ', 1000)]).length, 1, 'same title modulo case and spaces');
});

test('mergeMeetings: two meetings at the same time with different titles are two', () => {
  assert.equal(mergeMeetings([meeting('Daily', 1000), meeting('Committee', 1000)]).length, 2);
});
