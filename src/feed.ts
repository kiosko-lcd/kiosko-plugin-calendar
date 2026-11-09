/**
 * Downloading the feeds, with a copy of each on disk to survive a network
 * outage (and a restart while offline).
 *
 * A published calendar address is a bearer secret: whoever has it reads the
 * whole agenda. So it never reaches the disk or the log in clear: cache files
 * are named after a hash of it, and messages say "calendar 2 of 3".
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The address answers, but with something that isn't a calendar. */
export class NotAnIcsFeed extends Error {}

/** The server said no (expired link, unpublished calendar…). */
class HttpError extends Error {}

export interface FeedOptions {
  /** Folder for the local copies (the plugin's `dataDir`). */
  dir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Where the local copy of a feed lives. Named after the URL (hashed), not a
 * counter: adding or removing calendars doesn't shuffle the files nor leave a
 * feed reading another one's copy.
 */
export function cacheFiles(dir: string, url: string): { ics: string; etag: string; key: string } {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return { ics: join(dir, `feed-${key}.ics`), etag: join(dir, `feed-${key}.etag`), key };
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Why a download failed, in words that can't contain the address. */
function reason(err: unknown): string {
  if (err instanceof NotAnIcsFeed || err instanceof HttpError) return err.message;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'no answer in time';
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' ? `unreachable (${code})` : 'unreachable';
}

export interface FeedResult {
  ics: string;
  /** Read from the disk because the download failed. */
  cached: boolean;
  /** Why the download failed, when `cached`. */
  error?: string;
}

/**
 * Downloads a feed if it changed (Outlook's are ~350 KB, so `ETag` saves
 * bringing it whole every few minutes) and keeps it on disk.
 *
 * Offline, or with the server failing, it falls back to the last good copy:
 * today's meetings were already in it. A wrong address (a web page instead
 * of the feed) is not an outage, though: hiding it behind the old copy would
 * hide it forever, so it throws, as does any failure with nothing on disk.
 */
export async function fetchIcs(url: string, o: FeedOptions): Promise<FeedResult> {
  const files = cacheFiles(o.dir, url);
  const cached = readIfExists(files.ics);
  const etag = readIfExists(files.etag);
  const timeout = AbortSignal.timeout(o.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: etag && cached ? { 'If-None-Match': etag.trim() } : {},
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
    if (res.status === 304 && cached) return { ics: cached, cached: false };
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes('BEGIN:VCALENDAR')) {
      // Pasting the web interface link instead of the feed is the natural
      // mistake, and Google answers it with its page and a happy 200.
      throw new NotAnIcsFeed(
        /^\s*<(!doctype|html)/i.test(body)
          ? 'the address returns a web page, not a calendar: use the ICS (iCal) address, usually ending in .ics'
          : 'the answer is not an iCalendar feed (no BEGIN:VCALENDAR)',
      );
    }
    try {
      mkdirSync(o.dir, { recursive: true });
      writeFileSync(files.ics, body, { encoding: 'utf8', mode: 0o600 });
      const newEtag = res.headers.get('etag');
      if (newEtag) writeFileSync(files.etag, newEtag, { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* no copy this time; the meetings are still good */
    }
    return { ics: body, cached: false };
  } catch (err) {
    if (err instanceof NotAnIcsFeed || !cached) throw new Error(reason(err));
    return { ics: cached, cached: true, error: reason(err) };
  }
}

/** Which feeds were already reported broken, by hashed key: one warning per breakage, not one every five minutes. */
const warned = new Set<string>();

/**
 * Downloads every feed at once. `allSettled` and not `all` on purpose: with
 * several calendars, one being down can't take the others' meetings away.
 * Returns the feeds that could be read (fresh or from disk).
 */
export async function fetchAll(urls: readonly string[], o: FeedOptions & { log?: (msg: string) => void }): Promise<string[]> {
  const settled = await Promise.allSettled(urls.map((u) => fetchIcs(u, o)));
  const out: string[] = [];
  settled.forEach((r, i) => {
    const { key } = cacheFiles(o.dir, urls[i]!);
    const label = urls.length > 1 ? `calendar ${i + 1} of ${urls.length}` : 'the calendar';
    const problem = r.status === 'rejected' ? `could not read ${label}: ${r.reason instanceof Error ? r.reason.message : 'unknown error'}` : r.value.cached ? `${label} is unreachable (${r.value.error}); using the copy on disk` : null;
    if (r.status === 'fulfilled') out.push(r.value.ics);
    if (!problem) {
      warned.delete(key);
      return;
    }
    if (!warned.has(key)) {
      warned.add(key);
      o.log?.(problem);
    }
  });
  return out;
}
