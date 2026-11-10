/**
 * Painting the two calendar cards. Everything is sized from the box it gets,
 * so the same code serves a 320×240 corner and a 1920×462 strip.
 */
import { drawMore, listLayout, type Box, type Formatters, type Graphics, type Localized, type RenderContext, type Theme } from '@kiosko/sdk';
import type { Meeting } from './ics.ts';
import { agendaNow, dayStart, daysFrom, displayTitle, levelColor, meetingLevel, TEXTS, type Thresholds } from './meeting.ts';

export interface Painter {
  g: Graphics;
  kit: RenderContext<unknown, unknown>['kit'];
  theme: Theme;
  t: (text: Localized) => string;
  fmt: Formatters;
  locale: string;
  now: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function roundRect(g: Graphics, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

function weekday(ms: number, locale: string): string {
  try {
    return new Date(ms).toLocaleDateString(locale, { weekday: 'long' });
  } catch {
    return new Date(ms).toLocaleDateString('en', { weekday: 'long' });
  }
}

/**
 * The big countdown: "18 min" with the number big and the unit small, which
 * reads at a glance where a monospaced "18 min" gives the unit as much weight
 * as the number. A word ("now") or a clock time stays whole.
 */
function bigText(p: Painter, text: string, family: string) {
  const { g, kit } = p;
  const split = /\d/.test(text) && /\p{L}/u.test(text);
  const parts = split ? text.split(' ').map((s) => ({ s, small: !/\d/.test(s) })) : [{ s: text, small: false }];
  const opts = (size: number, small: boolean) => ({ size: small ? Math.round(size * 0.42) : size, family });
  const width = (size: number) => parts.reduce((a, part) => a + kit.measureTracked(g, part.s, opts(size, part.small)), 0) + size * 0.16 * (parts.length - 1);
  return {
    /** Largest size up to `max` that fits `maxW`. */
    fit: (max: number, maxW: number) => {
      let size = Math.round(max);
      while (size > 12 && width(size) > maxW) size--;
      return size;
    },
    width,
    /** Draws with the baseline at `base`; returns the width. */
    draw: (x: number, base: number, size: number, color: string, align: 'left' | 'right' = 'left') => {
      const total = width(size);
      let cx = align === 'right' ? x - total : x;
      for (const part of parts) {
        cx += kit.drawTracked(g, part.s, cx, base, { ...opts(size, part.small), color }) + size * 0.16;
      }
      return total;
    },
  };
}

/** A centred line (and an optional hint below it) for "nothing to show". */
export function drawMessage(p: Painter, box: Box, text: string, sub?: string): void {
  const { g, kit, theme } = p;
  const size = Math.round(clamp(box.h / 5, 11, 28));
  const so = { size: Math.max(10, Math.round(size * 0.7)), family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' as const };
  const lead = so.size * 1.35;
  // The hint wraps to two lines on narrow tiles rather than losing its end.
  const subLines = sub && box.h >= size * 2.8 ? kit.wrapLines(g, sub, box.w, box.h >= size * 2.8 + lead ? 2 : 1, so) : [];
  const block = size * 0.75 + (subLines.length ? so.size * 0.6 + subLines.length * lead : 0);
  const base = box.y + (box.h - block) / 2 + size * 0.75;
  const o = { size, family: theme.fonts.sans, color: theme.colors.inkDim, align: 'center' as const };
  kit.drawTracked(g, kit.truncate(g, text, box.w, o), box.x + box.w / 2, base, o);
  subLines.forEach((line, i) => kit.drawTracked(g, line, box.x + box.w / 2, base + so.size * 0.6 + (i + 1) * lead, so));
}

/**
 * The next meeting as one big countdown. Far away it's dim; as it nears it
 * gets a spine in the semaphore colour (info, then warn); a few minutes
 * before the start the whole card turns into a solid alert field, like the
 * old panel did, and once under way it says "now" and how long is left.
 */
export function drawNext(p: Painter, box: Box, m: Meeting, o: Thresholds & { showTitle: boolean; showAttendees: boolean }): void {
  const { g, kit, theme, now, t: tr, fmt } = p;
  const hhmm = (ms: number) => fmt.time(ms);
  const countdown = (ms: number) => fmt.duration(ms, { round: 'up' });
  const c = theme.colors;
  const f = theme.fonts;
  const level = meetingLevel(m, now, o);
  const tone = levelColor(level, c);
  const solid = level === 'alert';
  const started = level === 'now';
  const days = daysFrom(now, m.startsAt);

  // On the solid field the text takes the background colour, so it reads as a cut-out.
  const ink = solid
    ? { strong: c.bg, mid: kit.css(kit.hex(c.bg), 0.78), accent: c.bg, big: c.bg }
    : { strong: level === 'idle' ? c.inkDim : c.ink, mid: c.inkDim, accent: tone, big: tone };

  let x = box.x;
  let y = box.y;
  let w = box.w;
  let h = box.h;
  if (solid) {
    roundRect(g, box.x, box.y, box.w, box.h, Math.min(theme.radius, box.h * 0.12));
    g.fillStyle = tone;
    g.fill();
    const inset = Math.round(clamp(Math.min(box.w, box.h) * 0.06, 4, 16));
    x += inset;
    w -= inset * 2;
    y += Math.round(inset * 0.6);
    h -= Math.round(inset * 1.2);
  } else if (level !== 'idle' && level !== 'grey') {
    const spine = Math.round(clamp(Math.min(box.w, box.h) * 0.025, 3, 8));
    g.fillStyle = tone;
    g.fillRect(box.x, box.y, spine, box.h);
    const shift = spine + Math.round(clamp(box.w * 0.025, 6, 16));
    x += shift;
    w -= shift;
  }

  const label =
    (started ? tr(TEXTS.inProgress) : days <= 0 ? tr(TEXTS.next) : days === 1 ? tr(TEXTS.tomorrow) : weekday(m.startsAt, p.locale)) +
    (m.tentative ? ` · ${tr(TEXTS.tentative)}` : '');
  const range = `${hhmm(m.startsAt)}–${hhmm(m.endsAt)}`;
  const title = displayTitle(m, tr, o.showTitle);
  const who = o.showTitle && o.showAttendees && !m.private && m.attendees?.length ? m.attendees.join(', ') : '';
  const big = started ? tr(TEXTS.nowBig) : days <= 0 ? countdown(m.startsAt - now) : hhmm(m.startsAt);
  const sub = started ? `${tr(TEXTS.endsIn)} ${countdown(m.endsAt - now)}` : '';

  const wide = w >= h * 2.4;
  const L = Math.round(clamp(h * (wide ? 0.14 : 0.1), 10, 26));
  const labelO = { size: L, family: f.sansBold, color: ink.accent, smallCaps: true, tracking: Math.max(1, L * 0.08) };
  const metaO = { size: L, family: f.mono, color: ink.mid };
  const titleFamily = f.sansBold;

  /** Title lines (wrapped) between `top` and `bottom`, plus `meta` under them if it fits. */
  const textBlock = (bx: number, bw: number, top: number, bottom: number, maxT: number, meta: string) => {
    const avail = bottom - top;
    let T = Math.round(clamp(Math.min(maxT, avail * 0.9), 11, 44));
    const metaH = meta ? L * 1.5 : 0;
    let lines = clamp(Math.floor((avail - metaH) / (T * 1.2)), 0, 2);
    let withMeta = !!meta && lines > 0;
    if (lines === 0) {
      withMeta = false;
      if (avail < 11) return;
      T = Math.min(T, Math.floor(avail / 1.15));
      lines = 1;
    }
    const titleO = { size: T, family: titleFamily, color: ink.strong };
    const rows = kit.wrapLines(g, title, bw, lines, titleO);
    const used = rows.length * T * 1.2 + (withMeta ? metaH : 0);
    // Centred in the gap on wide cards; right under the label on stacked ones.
    let yy = wide ? top + Math.max(0, (avail - used) / 2) : top;
    for (const row of rows) {
      kit.drawTracked(g, row, bx, yy + T * 0.95, titleO);
      yy += T * 1.2;
    }
    if (withMeta) kit.drawTracked(g, kit.truncate(g, meta, bw, metaO), bx, yy + L * 1.15, metaO);
  };

  if (wide) {
    // Text on the left, the countdown on the right.
    const gap = Math.round(clamp(h * 0.15, 8, 32));
    const bw = Math.min(w * 0.45, h * 2.6);
    const bt = bigText(p, big, f.monoBold);
    const B = bt.fit(clamp(h * 0.6, 16, 160), bw);
    const subO = { size: L, family: f.sans, color: ink.mid, align: 'right' as const };
    const blockH = B * 0.74 + (sub ? L * 1.7 : 0);
    const bigBase = y + (h - blockH) / 2 + B * 0.74;
    const bigW = bt.draw(x + w, bigBase, B, ink.big, 'right');
    if (sub) kit.drawTracked(g, kit.truncate(g, sub, bw, subO), x + w, bigBase + L * 1.7, subO);

    const lw = Math.max(0, w - Math.max(bigW, sub ? kit.measureTracked(g, sub, subO) : 0) - gap);
    kit.drawTracked(g, kit.truncate(g, label, lw, labelO), x, y + L * 0.9, labelO);
    textBlock(x, lw, y + L * 1.4, y + h, h * 0.26, who ? `${range} · ${who}` : range);
    return;
  }

  // Stacked: label and time on top, title below, the countdown at the bottom.
  const rangeO = { ...metaO, align: 'right' as const };
  const rangeW = kit.measureTracked(g, range, rangeO);
  const labelMax = w - rangeW - L;
  if (labelMax >= L * 2.5) {
    kit.drawTracked(g, kit.truncate(g, label, labelMax, labelO), x, y + L * 0.9, labelO);
    kit.drawTracked(g, range, x + w, y + L * 0.9, rangeO);
  } else {
    kit.drawTracked(g, kit.truncate(g, range, w, metaO), x, y + L * 0.9, metaO);
  }

  const bt = bigText(p, big, f.monoBold);
  const B = bt.fit(clamp(h * 0.4, 16, 150), w);
  const bigBase = y + h - Math.round(B * 0.06);
  const bigW = bt.draw(x, bigBase, B, ink.big);
  // "ends in 25 min" beside "now" if there's room, else above it with the attendees' line.
  const subO = { size: Math.max(10, Math.round(L * 1.05)), family: f.sans, color: ink.mid, align: 'right' as const };
  const subBeside = !!sub && bigW + L + kit.measureTracked(g, sub, subO) <= w;
  if (subBeside) kit.drawTracked(g, sub, x + w, bigBase, subO);
  const meta = sub && !subBeside ? sub : who;
  textBlock(x, w, y + L * 1.5, bigBase - B * 0.74 - Math.max(4, B * 0.12), h * 0.17, meta);
}

/** One day of the agenda: its all-day events first, then its meetings in order. */
export interface AgendaDay {
  /** 0 today, 1 tomorrow… */
  offset: number;
  items: Meeting[];
}

/**
 * The days the agenda shows: today's meetings not yet over (one that began
 * yesterday and still runs included), then each next day's by start, and
 * every all-day event on each day it covers.
 */
export function agendaDays(meetings: readonly Meeting[], now: number, days: number): AgendaDay[] {
  const n = Math.max(1, Math.round(days));
  const out: AgendaDay[] = [];
  for (let offset = 0; offset < n; offset++) {
    const from = dayStart(now, offset);
    const to = dayStart(now, offset + 1);
    const whole = meetings.filter((m) => m.allDay && m.startsAt < to && m.endsAt > Math.max(from, now));
    const timed = meetings.filter((m) => !m.allDay && m.endsAt > now && m.startsAt < to && (offset === 0 || m.startsAt >= from));
    out.push({ offset, items: [...whole.sort((a, b) => a.startsAt - b.startsAt), ...timed.sort((a, b) => a.startsAt - b.startsAt)] });
  }
  return out;
}

type Line = { kind: 'head'; day: AgendaDay } | { kind: 'item'; m: Meeting } | { kind: 'none'; day: AgendaDay };

/** A day's lines: its title, then its meetings, or one line saying there are none. */
function linesOf(days: readonly AgendaDay[]): Line[] {
  return days.flatMap((day): Line[] => [{ kind: 'head', day }, ...(day.items.length ? day.items.map((m): Line => ({ kind: 'item', m })) : [{ kind: 'none', day } as Line])]);
}

export interface AgendaOptions extends Pick<Thresholds, 'warnMs' | 'alertMs'> {
  days: number;
  showTitle: boolean;
  rows: number;
}

/**
 * The meetings left today (the one under way highlighted, the next one with
 * its countdown) and those of the next days, each day under its title. Days
 * side by side, in columns, on a wide strip; one under the other otherwise.
 * Rows follow the shared list options (a day title takes a row); what
 * doesn't fit is counted in "+N more" at the bottom.
 */
export function drawAgenda(p: Painter, box: Box, meetings: readonly Meeting[], o: AgendaOptions): void {
  const { g, kit, theme, now, t: tr, fmt } = p;
  const c = theme.colors;
  const f = theme.fonts;
  const days = agendaDays(meetings, now, o.days);
  const first = agendaNow(days[0]?.items ?? [], now).next[0];

  // Columns: one day each on a wide strip (at least 240 px per column), several days per column when they don't fit.
  const wide = days.length >= 2 && box.w >= box.h * 2.2 && box.w >= 460;
  const maxCols = wide ? Math.max(2, Math.floor(box.w / 240)) : 1;
  const perCol = Math.ceil(days.length / Math.min(maxCols, days.length));
  const columns: AgendaDay[][] = [];
  for (let i = 0; i < days.length; i += perCol) columns.push(days.slice(i, i + perCol));
  const colGap = columns.length > 1 ? Math.round(clamp(box.w * 0.03, 10, 32)) : 0;
  const colW = (box.w - colGap * (columns.length - 1)) / columns.length;
  const lines = columns.map(linesOf);
  // Every column with the same rows, so they line up.
  const longest = Math.max(...lines.map((l) => l.length));
  const spec = { sizes: { 'one-line': { min: 17, max: clamp(colW / 10, 17, 45) } }, minRows: Math.max(columns.length > 1 ? 4 : 5, longest) };

  const dayTitle = (offset: number) => {
    const ms = dayStart(now, offset);
    const date = `${weekday(ms, p.locale)} ${new Date(ms).getDate()}`;
    return offset === 0 ? `${tr(TEXTS.today)} · ${date}` : offset === 1 ? `${tr(TEXTS.tomorrow)} · ${date}` : date;
  };

  columns.forEach((_, ci) => {
    const area: Box = { x: box.x + ci * (colW + colGap), y: box.y, w: colW, h: box.h };
    const list = lines[ci]!;
    const plan = listLayout(area, list.length, o, spec);
    const rowH = plan.rowH;
    // Letters by the row, but no bigger than the time, title and countdown still fit across the column.
    const R = Math.max(10, Math.min(rowH / 1.5, colW / 18));
    const headO = { size: Math.round(R * 0.8), family: f.sansBold, color: c.inkDim, smallCaps: true, tracking: Math.max(1, R * 0.06) };
    const timeO = { size: Math.round(R * 0.9), family: f.mono, color: c.inkDim };
    const titleO = { size: Math.round(R), family: f.sans, color: c.ink };
    const sideO = { size: Math.round(R * 0.85), family: f.sans, color: c.inkDim, align: 'right' as const };
    const inset = Math.max(4, Math.round(R * 0.4));
    const timeColW = kit.measureTracked(g, fmt.time(dayStart(now) + 12 * 3_600_000 + 59 * 60_000), timeO);
    const baseOf = (top: number) => top + rowH / 2 + R * 0.36;

    const row = (m: Meeting, x: number, top: number, w: number) => {
      const live = !m.allDay && m.startsAt <= now;
      const base = baseOf(top);
      if (live) {
        roundRect(g, x, top + 1, w, rowH - 2, Math.min(theme.radius, rowH * 0.3));
        g.fillStyle = c.surfaceEdge;
        g.fill();
        g.fillStyle = c.info;
        g.fillRect(x, top + 1, Math.max(3, Math.round(R * 0.15)), rowH - 2);
      }
      const tx = x + inset;
      if (m.allDay) {
        // No time: a dot where it would go.
        g.fillStyle = c.info;
        g.beginPath();
        g.arc(tx + timeColW / 2, base - R * 0.3, Math.max(2, R * 0.18), 0, Math.PI * 2);
        g.fill();
      } else {
        kit.drawTracked(g, fmt.time(m.startsAt), tx, base, { ...timeO, color: live ? c.info : c.inkDim });
      }
      // The one under way says when it ends; the next one, when it starts;
      // an all-day event, that it is. A short form when the long one would
      // squeeze the title: the end time for the one under way ("18 min"
      // alone would read as a start).
      let full = '';
      let short = '';
      let sideColor = c.inkDim;
      if (m.allDay) {
        full = tr(TEXTS.allDay);
      } else if (live) {
        short = `–${fmt.time(m.endsAt)}`;
        full = `${tr(TEXTS.endsIn)} ${fmt.duration(m.endsAt - now, { round: 'up' })}`;
        sideColor = c.info;
      } else if (m === first) {
        const left = m.startsAt - now;
        short = fmt.duration(left, { round: 'up' });
        full = `${tr(TEXTS.in)} ${short}`;
        sideColor = left <= o.alertMs ? c.alert : left <= o.warnMs ? c.warn : c.inkDim;
      }
      const right = x + w - inset;
      const titleX = tx + timeColW + R * 0.6;
      const text = displayTitle(m, tr, o.showTitle) + (m.tentative ? ' (?)' : '');
      const to = { ...titleO, color: m.tentative ? c.inkDim : c.ink };
      const textW = kit.measureTracked(g, text, to);
      const widthOf = (str: string) => (str ? kit.measureTracked(g, str, sideO) : 0);
      let side = full;
      if (side && (widthOf(full) > w * 0.4 || titleX + textW + R * 0.6 + widthOf(full) > right)) side = short;
      if (side && widthOf(side) > w * 0.4) side = '';
      const sideW = widthOf(side);
      if (side) kit.drawTracked(g, side, right, base, { ...sideO, color: sideColor });
      const titleW = right - titleX - (side ? sideW + R * 0.6 : 0);
      if (titleW > R) kit.drawTracked(g, kit.truncate(g, text, titleW, to), titleX, base, to);
    };

    // A day title can't be the last line drawn: its meetings would all be in "+N more".
    // With room for a single line, that line is the first meeting, without its title.
    let drawn = list.slice(0, plan.shown);
    if (plan.shown < list.length && drawn[drawn.length - 1]?.kind === 'head') drawn = drawn.length > 1 ? drawn.slice(0, -1) : list.slice(1, 2);
    const shown = drawn.length;
    drawn.forEach((line, i) => {
      const top = area.y + i * rowH;
      if (line.kind === 'head') {
        kit.drawTracked(g, kit.truncate(g, dayTitle(line.day.offset), area.w, headO), area.x, top + rowH * 0.5 + headO.size * 0.45, headO);
      } else if (line.kind === 'none') {
        const eo = { ...titleO, size: Math.round(R * 0.9), color: c.inkFaint };
        kit.drawTracked(g, kit.truncate(g, tr(line.day.offset === 0 ? TEXTS.noneToday : TEXTS.noneTomorrow), area.w - inset, eo), area.x + inset, baseOf(top) - R * 0.02, eo);
      } else {
        row(line.m, area.x, top, area.w);
      }
    });
    const hidden = list.filter((l) => l.kind === 'item' && !drawn.includes(l)).length;
    if (hidden && plan.more) drawMore(g, p, { hidden, more: { ...plan.more, y: area.y + shown * rowH } }, { indent: inset });
    if (ci > 0) {
      g.fillStyle = c.surfaceEdge;
      g.fillRect(Math.round(area.x - colGap / 2), box.y + R * 0.2, 1, box.h - R * 0.4);
    }
  });
}
