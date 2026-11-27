/**
 * Calendars kept apart (Kiosko 0.2.12 on): the source declares profiles, and
 * each profile («Work», «Personal») reads its own addresses, keeps its own
 * copies on disk and ETags, and warns on its own. The default profile names
 * its files as it always did. Fake servers only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createBaseContext, validate } from '@kiosko/sdk';
import { cacheFiles, fetchAll } from './feed.ts';
import { loadIcal } from './ics.ts';
import { events, type Meeting } from './index.ts';

const MIN = 60_000;
const NOW = Date.now();
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const ev = (uid: string, title: string, startsAt: number) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${utc(startsAt)}`, `DTEND:${utc(startsAt + 30 * MIN)}`, `SUMMARY:${title}`, 'END:VEVENT'];
const cal = (name: string, ...list: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `X-WR-CALNAME:${name}`, ...list.flat(), 'END:VCALENDAR'].join('\r\n');
const soon = Math.ceil(NOW / MIN) * MIN + 20 * MIN;

interface Fake {
  base: string;
  hits: { path: string; ifNoneMatch?: string | undefined }[];
  server: Server;
  up: boolean;
}

/** A calendar server: ICS with an ETag per path; `up = false` makes it fail with a 503. */
async function serve(feeds: Record<string, string>): Promise<Fake> {
  const fake = { hits: [], up: true } as unknown as Fake;
  fake.server = createServer((req, res) => {
    const path = req.url ?? '';
    fake.hits.push({ path, ifNoneMatch: req.headers['if-none-match'] });
    const body = feeds[path];
    if (!fake.up) return void res.writeHead(503).end();
    if (!body) return void res.writeHead(404).end();
    const etag = `"${path}-v1"`;
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'text/calendar', etag }).end(body);
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

let office: Fake;
let home: Fake;
before(async () => {
  office = await serve({ '/work.ics': cal('Work', ev('w1', 'Sprint review', soon), ev('w2', 'Planning', soon + 60 * MIN)) });
  home = await serve({ '/family.ics': cal('Family', ev('f1', 'Dentist', soon + 30 * MIN)) });
});
after(() => {
  office.server.close();
  home.server.close();
});

function ctx(dir: string, options: Record<string, unknown>, profile?: string, logs: string[] = []) {
  return {
    ...createBaseContext({ now: NOW, locale: 'en', dataDir: dir, cacheDir: dir, log: (m: string) => void logs.push(m) }),
    options: validate(events.options!, options).value as never,
    signal: new AbortController().signal,
    intervalMs: 5 * MIN,
    timeoutMs: 30_000,
    ...(profile ? { profile } : {}),
  };
}
const read = (c: ReturnType<typeof ctx>) => events.read!(c) as Promise<Meeting[]>;
const calendarChoices = (list: Meeting[]) => events.choices!.calendars!(list, { locale: 'en', t: (x) => (typeof x === 'string' ? x : x.en ?? '') }).map((c) => c.value);
const hash = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

const skip = (await loadIcal()) ? false : 'optional dependency ical.js not installed';

test('source: declares profiles, in a way an older SDK ignores', () => {
  assert.equal((events as { profiles?: boolean }).profiles, true);
});

test('cache files: the default profile\'s named as before, another profile\'s with its id', () => {
  const url = 'https://example.com/secret/calendar.ics';
  assert.deepEqual(cacheFiles('/c', url), { ics: join('/c', `feed-${hash(url)}.ics`), etag: join('/c', `feed-${hash(url)}.etag`), key: hash(url) });
  assert.equal(cacheFiles('/c', url, 'work').ics, join('/c', `feed-work-${hash(url)}.ics`));
  assert.equal(cacheFiles('/c', url, '../x').ics, join('/c', `feed-___x-${hash(url)}.ics`), 'never a path');
});

test('profiles: work and personal calendars, each its own meetings, choices and copies; offline each keeps its own', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-profiles-'));
  try {
    const work = ctx(dir, { urls: [`${office.base}/work.ics`], horizonDays: 1 });
    const personal = ctx(dir, { urls: [`${home.base}/family.ics`], horizonDays: 1 }, 'personal');
    const [w, p] = await Promise.all([read(work), read(personal)]);
    assert.deepEqual(w.map((m) => m.title), ['Sprint review', 'Planning']);
    assert.deepEqual(p.map((m) => m.title), ['Dentist']);
    // The widgets' Calendars filter offers each profile's own calendars.
    assert.deepEqual(calendarChoices(w), ['Work']);
    assert.deepEqual(calendarChoices(p), ['Family']);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.ics')).sort(), [`feed-${hash(`${office.base}/work.ics`)}.ics`, `feed-personal-${hash(`${home.base}/family.ics`)}.ics`].sort());

    office.up = home.up = false;
    try {
      assert.deepEqual(await read(work), w, 'the default profile from its copy');
      assert.deepEqual(await read(personal), p, 'the personal profile from its own');
    } finally {
      office.up = home.up = true;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profiles: the same address in two profiles keeps two copies and two ETags, and each warns on its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-profiles-'));
  try {
    const url = `${office.base}/work.ics`;
    const logs = { a: [] as string[], b: [] as string[] };
    await fetchAll([url], { dir, timeoutMs: 5000, log: (m) => void logs.a.push(m) });
    office.hits.length = 0;
    await fetchAll([url], { dir, timeoutMs: 5000, profile: 'team', log: (m) => void logs.b.push(m) });
    assert.deepEqual(office.hits, [{ path: '/work.ics', ifNoneMatch: undefined }], 'the other profile borrows no ETag: a full download, its own copy');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.ics')).length, 2);

    office.up = false;
    try {
      await fetchAll([url], { dir, timeoutMs: 5000, log: (m) => void logs.a.push(m) });
      await fetchAll([url], { dir, timeoutMs: 5000, profile: 'team', log: (m) => void logs.b.push(m) });
      await fetchAll([url], { dir, timeoutMs: 5000, profile: 'team', log: (m) => void logs.b.push(m) });
    } finally {
      office.up = true;
    }
    assert.equal(logs.a.length, 1, 'the default profile warns once');
    assert.equal(logs.b.length, 1, 'and so does the other, in its own log');
    assert.match(logs.b[0]!, /unreachable \(HTTP 503\); using the copy on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
