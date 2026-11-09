import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheFiles, fetchAll, fetchIcs } from './feed.ts';

const FEED = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
/** The secret part of a published address: it must never reach a file name or a log line. */
const SECRET = 'reachcalendar-5c5ef16e0539aeed2b150db640e04380';

interface Fake {
  url: (path: string) => string;
  hits: { path: string; ifNoneMatch?: string }[];
  close: () => Promise<void>;
}

/** A local server: `/feed` answers ICS with an ETag, `/page` a web page, `/gone` a 404. */
async function serve(): Promise<Fake> {
  const hits: Fake['hits'] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!.replace(`/${SECRET}`, '');
    hits.push({ path, ifNoneMatch: req.headers['if-none-match'] });
    if (path === '/feed') {
      if (req.headers['if-none-match'] === '"v1"') return void res.writeHead(304).end();
      return void res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' }).end(FEED);
    }
    if (path === '/page') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><html><body>Calendar</body></html>');
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}/${SECRET}${path}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'calendar-feed-'));
}

test('feed: keeps a copy named after a hash of the address, readable only by the user', async () => {
  const srv = await serve();
  const dir = tempDir();
  try {
    const r = await fetchIcs(srv.url('/feed'), { dir, timeoutMs: 5000 });
    assert.deepEqual(r, { ics: FEED, cached: false });
    const files = readdirSync(dir);
    assert.deepEqual(files.sort(), [`feed-${cacheFiles(dir, srv.url('/feed')).key}.etag`, `feed-${cacheFiles(dir, srv.url('/feed')).key}.ics`].sort());
    for (const f of files) {
      assert.ok(!f.includes(SECRET) && !f.includes('127.0.0.1'), `${f} must not carry the address`);
      if (process.platform !== 'win32') assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
      assert.ok(!readFileSync(join(dir, f), 'utf8').includes(SECRET));
    }
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed: an unchanged calendar is not downloaded again (ETag)', async () => {
  const srv = await serve();
  const dir = tempDir();
  try {
    await fetchIcs(srv.url('/feed'), { dir, timeoutMs: 5000 });
    const again = await fetchIcs(srv.url('/feed'), { dir, timeoutMs: 5000 });
    assert.deepEqual(again, { ics: FEED, cached: false });
    assert.equal(srv.hits.at(-1)?.ifNoneMatch, '"v1"');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed: offline, the copy on disk keeps the meetings; with no copy it fails', async () => {
  const srv = await serve();
  const dir = tempDir();
  const url = srv.url('/feed');
  await fetchIcs(url, { dir, timeoutMs: 5000 });
  await srv.close(); // the network goes away
  try {
    const r = await fetchIcs(url, { dir, timeoutMs: 2000 });
    assert.equal(r.ics, FEED);
    assert.equal(r.cached, true);
    assert.match(r.error ?? '', /unreachable/);
    const empty = tempDir();
    try {
      await assert.rejects(fetchIcs(url, { dir: empty, timeoutMs: 2000 }), (err: Error) => /unreachable/.test(err.message) && !err.message.includes(SECRET));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed: a server error falls back to the copy; a web page instead of a feed does not', async () => {
  const srv = await serve();
  const dir = tempDir();
  try {
    // A copy from earlier, good days for both addresses.
    for (const path of ['/page', '/gone']) writeFileSync(cacheFiles(dir, srv.url(path)).ics, FEED);
    const gone = await fetchIcs(srv.url('/gone'), { dir, timeoutMs: 5000 });
    assert.deepEqual([gone.cached, gone.error], [true, 'HTTP 404']);
    // Pasting the browser link is a mistake to show, not an outage to hide behind the old copy.
    await assert.rejects(fetchIcs(srv.url('/page'), { dir, timeoutMs: 5000 }), /web page, not a calendar/);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchAll: one broken calendar does not hide the others; warnings name its position, once', async () => {
  const srv = await serve();
  const dir = tempDir();
  const logs: string[] = [];
  try {
    const urls = [srv.url('/feed'), srv.url('/gone')];
    const o = { dir, timeoutMs: 5000, log: (m: string) => logs.push(m) };
    assert.deepEqual(await fetchAll(urls, o), [FEED]);
    assert.deepEqual(await fetchAll(urls, o), [FEED]);
    assert.equal(logs.length, 1, 'not again on every read');
    assert.match(logs[0]!, /calendar 2 of 2: HTTP 404/);
    assert.ok(logs.every((l) => !l.includes(SECRET) && !l.includes('127.0.0.1')));
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
