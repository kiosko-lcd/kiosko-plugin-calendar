import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultsOf, localize, validate } from '@tessera/sdk';
import plugin, { agenda, events, next, type Meeting } from './index.ts';
import { loadIcal } from './ics.ts';

const SOURCE = 'calendar/events';
const MIN = 60_000;
const start = Date.parse('2026-11-04T13:00:00');
const meeting = (startsAt: number, len = 60): Meeting => ({ title: 'Contrast', startsAt, endsAt: startsAt + len * MIN });
const state = <O>(options: O, list: Meeting[] | undefined, now: number) => ({ options, data: undefined, sources: list ? { [SOURCE]: list } : {}, now, working: true });

test('plugin: ids and the source every widget reads', () => {
  assert.equal(plugin.id, 'calendar');
  assert.deepEqual(plugin.sources?.map((s) => s.id), ['events']);
  assert.deepEqual(plugin.widgets?.map((w) => w.id), ['next', 'agenda']);
  for (const w of plugin.widgets ?? []) assert.deepEqual(w.sources, [SOURCE]);
});

test('agenda: the meeting under way keeps the tile only right after it starts', () => {
  const data = [meeting(start)];
  const urgent = (now: number, holdMin = 10) => agenda.urgent!(state({ ...defaultsOf(agenda.options!), holdMin }, data, now));
  assert.equal(urgent(start + 5 * MIN), true);
  assert.equal(urgent(start + 11 * MIN), false);
  // With more margin, longer.
  assert.equal(urgent(start + 11 * MIN, 30), true);
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
  const ctx = { options, now: Date.now(), locale: 'en', t: (x: Parameters<typeof localize>[0]) => localize(x, 'en'), log: () => undefined, dataDir: '/nonexistent', signal: new AbortController().signal };
  await assert.rejects(events.read!(ctx), /no calendar/);
});

const skip = (await loadIcal()) ? false : 'optional dependency ical.js not installed';

test('source: reads, merges and caches several feeds, and keeps working offline', { skip }, async () => {
  const now = Date.now();
  const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = (uid: string, title: string, startsAt: number, extra: string[] = []) =>
    ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${utc(startsAt)}`, `DTEND:${utc(startsAt + 30 * MIN)}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT'];
  const cal = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const soon = Math.ceil(now / MIN) * MIN + 20 * MIN;
  const feeds: Record<string, string> = {
    '/a.ics': cal(ev('1', 'Review', soon), ev('2', 'Focus time', soon + 60 * MIN), ev('3', 'Shared', soon + 120 * MIN)),
    // The same "Shared" meeting seen from a second calendar, plus one too far ahead.
    '/b.ics': cal(ev('3b', 'Shared', soon + 120 * MIN), ev('4', 'Next week', now + 8 * 86_400_000)),
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
  const ctx = { options, now, locale: 'en', t: (x: Parameters<typeof localize>[0]) => localize(x, 'en'), log: (m: string) => logs.push(m), dataDir, signal: new AbortController().signal };
  try {
    const got = await events.read!(ctx);
    assert.deepEqual(got.map((m) => m.title), ['Review', 'Shared'], 'focus time ignored, duplicate merged, next week out of the window');
    assert.equal(got[0]!.startsAt, soon);
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
