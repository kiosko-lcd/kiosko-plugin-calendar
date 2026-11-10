import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBaseContext, defaultsOf, validate, DEFAULT_WORKDAY } from '@kiosko/sdk';
import plugin, { agenda, events, next, type Meeting } from './index.ts';
import { agendaDays } from './draw.ts';
import { loadIcal } from './ics.ts';

const SOURCE = 'calendar/events';
const MIN = 60_000;
const start = Date.parse('2026-11-04T13:00:00');
const meeting = (startsAt: number, len = 60): Meeting => ({ title: 'Contrast', startsAt, endsAt: startsAt + len * MIN });
const state = <O>(options: O, list: Meeting[] | undefined, now: number) => ({ options, data: undefined, sources: list ? { [SOURCE]: list } : {}, now, working: true, workday: DEFAULT_WORKDAY });

test('plugin: ids and the source every widget reads', () => {
  assert.equal(plugin.id, 'calendar');
  assert.deepEqual(plugin.sources?.map((s) => s.id), ['events']);
  assert.deepEqual(plugin.widgets?.map((w) => w.id), ['next', 'agenda']);
  for (const w of plugin.widgets ?? []) assert.deepEqual(w.sources, [SOURCE]);
});

test('agenda: the meeting under way keeps the tile only right after it starts', () => {
  const data = [meeting(start)];
  const urgent = (now: number, holdMs = 10 * MIN) => agenda.urgent!(state({ ...defaultsOf(agenda.options!), holdMs }, data, now));
  assert.equal(urgent(start + 5 * MIN), true);
  assert.equal(urgent(start + 11 * MIN), false);
  // With more margin, longer.
  assert.equal(urgent(start + 11 * MIN, 30 * MIN), true);
  // And a meeting about to start claims it too.
  assert.equal(urgent(start - 8 * MIN), true);
  assert.equal(urgent(start - 20 * MIN), false);
});

test('next: urgent from the alert threshold until the end; idle beyond the grey one', () => {
  const o = defaultsOf(next.options!);
  const data = [meeting(start, 30)];
  const s = (now: number) => state(o, data, now);
  assert.equal(next.urgent!(s(start - 4 * MIN)), false);
  assert.equal(next.urgent!(s(start - 3 * MIN)), true);
  assert.equal(next.urgent!(s(start + 20 * MIN)), true, 'in progress');
  assert.equal(next.urgent!(s(start + 31 * MIN)), false, 'over');
  assert.equal(next.idle!(s(start - 3 * 60 * MIN)), true, 'three hours away');
  assert.equal(next.idle!(s(start - 90 * MIN)), false);
  assert.equal(next.visible!(s(start + 31 * MIN)), false, 'nothing left to show');
  // Before the source has data (no calendar yet) it shows a hint and lets the panel sleep.
  assert.equal(next.visible!(state(o, undefined, start)), true);
  assert.equal(next.idle!(state(o, undefined, start)), true);
});

test('demos: every widget brings its own meetings, relative to now', () => {
  const now = Date.parse('2026-11-05T10:42:00');
  for (const w of plugin.widgets ?? []) {
    const d = w.demo!({ options: defaultsOf(w.options!), now, locale: 'es' });
    const list = d.sources?.[SOURCE] as Meeting[];
    assert.ok(Array.isArray(list) && list.length >= 3, w.id);
    assert.ok(list.some((m) => m.startsAt > now), `${w.id}: something to come`);
  }
  const source = events.demo!({ now, locale: 'en' });
  assert.ok(source.some((m) => m.startsAt <= now && m.endsAt > now), 'the source demo has a meeting under way');
});

test('source: without addresses it fails without touching the network', async () => {
  const options = validate(events.options!, {}).value;
  assert.deepEqual(options.ignore, ['focus time', 'tiempo de concentración']);
  const ctx = { ...createBaseContext({ now: Date.now(), dataDir: '/nonexistent' }), options, signal: new AbortController().signal, intervalMs: 5 * MIN, timeoutMs: 30_000 };
  await assert.rejects(events.read!(ctx), /no calendar/);
});

const skip = (await loadIcal()) ? false : 'optional dependency ical.js not installed';

test('source: reads, merges and caches several feeds, and keeps working offline', { skip }, async () => {
  const now = Date.now();
  const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = (uid: string, title: string, startsAt: number, extra: string[] = []) =>
    ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${utc(startsAt)}`, `DTEND:${utc(startsAt + 30 * MIN)}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT'];
  const cal = (name: string, ...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `X-WR-CALNAME:${name}`, ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const soon = Math.ceil(now / MIN) * MIN + 20 * MIN;
  const feeds: Record<string, string> = {
    '/a.ics': cal('Work', ev('1', 'Review', soon), ev('2', 'Focus time', soon + 60 * MIN), ev('3', 'Shared', soon + 120 * MIN)),
    // The same "Shared" meeting seen from a second calendar, plus one too far ahead.
    '/b.ics': cal('Team', ev('3b', 'Shared', soon + 120 * MIN), ev('4', 'Next week', now + 8 * 86_400_000)),
  };
  const server = createServer((req, res) => {
    const body = feeds[req.url ?? ''];
    if (body) res.writeHead(200, { 'content-type': 'text/calendar' }).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'calendar-src-'));
  const options = validate(events.options!, { urls: [`${base}/a.ics`, ` ${base}/b.ics `, '', `${base}/a.ics`], horizonDays: 1 }).value;
  const logs: string[] = [];
  const ctx = { ...createBaseContext({ now, dataDir, log: (m: string) => void logs.push(m) }), options, signal: new AbortController().signal, intervalMs: 5 * MIN, timeoutMs: 30_000 };
  try {
    const got = await events.read!(ctx);
    assert.deepEqual(got.map((m) => m.title), ['Review', 'Shared'], 'focus time ignored, duplicate merged, next week out of the window');
    assert.equal(got[0]!.startsAt, soon);
    assert.deepEqual(got.map((m) => m.calendars), [['Work'], ['Work', 'Team']], 'named after each calendar; a shared one after both');
    assert.equal(readdirSync(dataDir).filter((f) => f.endsWith('.ics')).length, 2, 'one copy per feed');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const offline = await events.read!(ctx);
    assert.deepEqual(offline, got, 'same meetings from the copies on disk');
    assert.ok(logs.length > 0 && logs.every((l) => !l.includes(base)), 'warned, without the address');
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('source: options are the shared ones; no timeout of its own', () => {
  const o = validate(events.options!, {}).value;
  assert.deepEqual(Object.keys(o).sort(), ['horizonDays', 'ignore', 'includeAllDay', 'urls']);
  assert.equal(o.horizonDays, 6, 'a week, so the agenda can show one');
  assert.equal(o.includeAllDay, false);
  assert.equal(events.timeoutMs, 30_000);
  assert.ok((events.minIntervalMs ?? 0) >= MIN);
});

test('widgets: thresholds are durations in ms; agenda days replace "tomorrow"', () => {
  const n = defaultsOf(next.options!);
  assert.deepEqual([n.greyMs, n.readyMs, n.warnMs, n.alertMs], [120 * MIN, 30 * MIN, 10 * MIN, 3 * MIN]);
  assert.equal(n.showAttendees, true);
  assert.equal(n.hideTentative, false);
  const a = defaultsOf(agenda.options!);
  assert.deepEqual({ days: a.days, showTitle: a.showTitle, rows: a.rows, holdMs: a.holdMs, greyMs: a.greyMs }, { days: 2, showTitle: true, rows: 0, holdMs: 10 * MIN, greyMs: 120 * MIN });
  assert.equal('tomorrow' in a, false);
  assert.equal(agenda.hideWhenEmpty, true, 'an agenda with nothing left leaves the rotation, as it always did');
});

test('agenda: the days it shows, all-day events first on each day they cover', () => {
  const now = Date.parse('2026-11-04T13:00:00');
  const day = (d: number, h: number, mm = 0) => new Date(2026, 10, 4 + d, h, mm).getTime();
  const list: Meeting[] = [
    { title: 'Morning', startsAt: day(0, 9), endsAt: day(0, 10) },
    { title: 'Afternoon', startsAt: day(0, 15), endsAt: day(0, 16) },
    { title: 'Trip', startsAt: day(1, 0), endsAt: day(3, 0), allDay: true },
    { title: 'Tomorrow', startsAt: day(1, 9), endsAt: day(1, 10) },
    { title: 'Friday', startsAt: day(2, 11), endsAt: day(2, 12) },
    { title: 'Monday', startsAt: day(5, 11), endsAt: day(5, 12) },
  ];
  const titles = (days: number) => agendaDays(list, now, days).map((d) => d.items.map((m) => m.title));
  assert.deepEqual(titles(1), [['Afternoon']], 'a finished meeting is gone');
  assert.deepEqual(titles(3), [['Afternoon'], ['Trip', 'Tomorrow'], ['Trip', 'Friday']]);
  assert.equal(titles(7).length, 7);
  assert.deepEqual(titles(7)[4], [], 'a free Sunday');
  assert.deepEqual(titles(7)[5], ['Monday']);
  const o = (days: number) => ({ ...defaultsOf(agenda.options!), days });
  assert.equal(agenda.empty!(state(o(1), [list[0]!], now)), true, 'nothing left today');
  assert.equal(agenda.empty!(state(o(2), [list[0]!, list[3]!], now)), false, 'but something tomorrow');
  assert.equal(agenda.empty!(state(o(2), undefined, now)), false, 'no calendar yet: it shows how to add one');
});

test('next: a calendar filter and tentative meetings', () => {
  const o = { ...defaultsOf(next.options!), calendars: ['Work'], hideTentative: true };
  const list: Meeting[] = [
    { ...meeting(start - 2 * MIN), title: 'Personal thing', calendars: ['Personal'] },
    { ...meeting(start - MIN), title: 'Maybe', calendars: ['Work'], tentative: true },
  ];
  assert.equal(next.urgent!(state(o, list, start - 3 * MIN)), false, 'neither claims the tile');
  assert.equal(next.urgent!(state({ ...o, calendars: [] }, list, start - 3 * MIN)), true);
});
