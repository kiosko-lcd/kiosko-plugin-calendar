/**
 * Painting the two calendar cards. Everything is sized from the box it gets,
 * so the same code serves a 320×240 corner and a 1920×462 strip.
 */
import type { Box, Graphics, Localized, RenderContext, Theme } from '@tessera/sdk';
import type { Meeting } from './ics.ts';
import { agendaNow, countdown, dayStart, daysFrom, displayTitle, hhmm, levelColor, meetingLevel, TEXTS, type Thresholds } from './meeting.ts';

export interface Painter {
  g: Graphics;
  kit: RenderContext<unknown, unknown>['kit'];
  theme: Theme;
  t: (text: Localized) => string;
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

/** A centred line (and an optional hint below it) for "nothing to show". */
export function drawMessage(p: Painter, box: Box, text: string, sub?: string): void {
  const { g, kit, theme } = p;
  const size = Math.round(clamp(box.h / 5, 11, 28));
  const subSize = Math.max(10, Math.round(size * 0.7));
  const withSub = !!sub && box.h >= size * 2.8;
  const block = size * 0.75 + (withSub ? subSize * 1.6 : 0);
  const base = box.y + (box.h - block) / 2 + size * 0.75;
  const o = { size, family: theme.fonts.sans, color: theme.colors.inkDim, align: 'center' as const };
  kit.drawTracked(g, kit.truncate(g, text, box.w, o), box.x + box.w / 2, base, o);
  if (withSub) {
    const so = { ...o, size: subSize, color: theme.colors.inkFaint };
    kit.drawTracked(g, kit.truncate(g, sub!, box.w, so), box.x + box.w / 2, base + subSize * 1.6, so);
  }
}

/**
 * The next meeting as one big countdown. Far away it's dim; as it nears it
 * gets a spine in the semaphore colour (info, then warn); a few minutes
 * before the start the whole card turns into a solid alert field, like the
 * old panel did, and once under way it says "now" and how long is left.
 */
export function drawNext(p: Painter, box: Box, m: Meeting, o: Thresholds & { showTitle: boolean }): void {
  const { g, kit, theme, now, t: tr } = p;
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
    (started ? tr(TEXTS.now) : days <= 0 ? tr(TEXTS.next) : days === 1 ? tr(TEXTS.tomorrow) : weekday(m.startsAt, p.locale)) +
    (m.tentative ? ` · ${tr(TEXTS.tentative)}` : '');
  const range = `${hhmm(m.startsAt)}–${hhmm(m.endsAt)}`;
  const title = displayTitle(m, tr, o.showTitle);
  const who = o.showTitle && !m.private && m.attendees?.length ? m.attendees.join(', ') : '';
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
    const bigO = { size: Math.round(clamp(h * 0.6, 16, 160)), family: f.monoBold, color: ink.big, align: 'right' as const };
    bigO.size = kit.fitSize(g, big, bw, bigO, 12);
    const subO = { size: L, family: f.sans, color: ink.mid, align: 'right' as const };
    const blockH = bigO.size * 0.74 + (sub ? L * 1.7 : 0);
    const bigBase = y + (h - blockH) / 2 + bigO.size * 0.74;
    kit.drawTracked(g, big, x + w, bigBase, bigO);
    if (sub) kit.drawTracked(g, kit.truncate(g, sub, bw, subO), x + w, bigBase + L * 1.7, subO);

    const lw = Math.max(0, w - Math.max(bw, kit.measureTracked(g, big, bigO)) - gap);
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

  const bigO = { size: Math.round(clamp(h * 0.4, 16, 150)), family: f.monoBold, color: ink.big };
  bigO.size = kit.fitSize(g, big, w, bigO, 12);
  const bigBase = y + h - Math.round(bigO.size * 0.06);
  const bigW = kit.drawTracked(g, big, x, bigBase, bigO);
  // "ends in 25 min" beside "now" if there's room, else above it with the attendees' line.
  const subO = { size: Math.max(10, Math.round(L * 1.05)), family: f.sans, color: ink.mid, align: 'right' as const };
  const subBeside = !!sub && bigW + L + kit.measureTracked(g, sub, subO) <= w;
  if (subBeside) kit.drawTracked(g, sub, x + w, bigBase, subO);
  const meta = sub && !subBeside ? sub : who;
  textBlock(x, w, y + L * 1.5, bigBase - bigO.size * 0.74 - Math.max(4, bigO.size * 0.12), h * 0.17, meta);
}

interface Section {
  title: string;
  items: Meeting[];
  empty: string;
}

/**
 * Today's meetings still to come (the one under way highlighted, the next
 * one with its countdown) and tomorrow's, like the old agenda card. Side by
 * side on a wide strip, one under the other otherwise.
 */
export function drawAgenda(p: Painter, box: Box, meetings: readonly Meeting[], o: { tomorrow: boolean } & Pick<Thresholds, 'warnMin' | 'alertMin'>): void {
  const { g, kit, theme, now, t: tr } = p;
  const c = theme.colors;
  const f = theme.fonts;
  const t1 = dayStart(now, 1);
  const t2 = dayStart(now, 2);
  const live = meetings.filter((m) => m.endsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  const today = live.filter((m) => m.startsAt < t1);
  const tomorrow = o.tomorrow ? live.filter((m) => m.startsAt >= t1 && m.startsAt < t2) : [];
  if (!today.length && !tomorrow.length) return drawMessage(p, box, tr(TEXTS.noMore));
  const first = agendaNow(today, now).next[0];

  const dayTitle = (offset: number) => {
    const ms = dayStart(now, offset);
    return `${tr(offset === 0 ? TEXTS.today : TEXTS.tomorrow)} · ${weekday(ms, p.locale)} ${new Date(ms).getDate()}`;
  };
  const sections: Section[] = [{ title: dayTitle(0), items: today, empty: tr(TEXTS.noneToday) }];
  if (o.tomorrow) sections.push({ title: dayTitle(1), items: tomorrow, empty: tr(TEXTS.noneTomorrow) });

  const twoCols = sections.length === 2 && box.w >= box.h * 2.2 && box.w >= 460;
  const colGap = Math.round(clamp(box.w * 0.03, 10, 32));
  const colW = twoCols ? (box.w - colGap) / 2 : box.w;
  const R = Math.round(clamp(Math.min(box.h / (twoCols ? 6 : 7.5), colW / 15), 11, 30));
  const rowH = Math.round(R * 1.5);
  const headH = Math.round(R * 1.4);

  const headO = { size: Math.round(R * 0.8), family: f.sansBold, color: c.inkDim, smallCaps: true, tracking: Math.max(1, R * 0.06) };
  const timeO = { size: Math.round(R * 0.9), family: f.mono, color: c.inkDim };
  const titleO = { size: R, family: f.sans, color: c.ink };
  const sideO = { size: Math.round(R * 0.85), family: f.sans, color: c.inkDim, align: 'right' as const };
  const inset = Math.max(4, Math.round(R * 0.4));

  const row = (m: Meeting, x: number, top: number, w: number) => {
    const live = m.startsAt <= now;
    const base = top + rowH / 2 + R * 0.36;
    if (live) {
      roundRect(g, x, top + 1, w, rowH - 2, Math.min(theme.radius, rowH * 0.3));
      g.fillStyle = c.surfaceEdge;
      g.fill();
      g.fillStyle = c.info;
      g.fillRect(x, top + 1, Math.max(3, Math.round(R * 0.15)), rowH - 2);
    }
    const tx = x + inset;
    const timeW = kit.drawTracked(g, hhmm(m.startsAt), tx, base, { ...timeO, color: live ? c.info : c.inkDim });
    // The one under way says when it ends; the next one, when it starts.
    let side = '';
    let sideColor = c.inkDim;
    if (live) {
      side = `${tr(TEXTS.endsIn)} ${countdown(m.endsAt - now)}`;
      sideColor = c.info;
    } else if (m === first) {
      const left = m.startsAt - now;
      side = `${tr(TEXTS.in)} ${countdown(left)}`;
      sideColor = left <= o.alertMin * 60_000 ? c.alert : left <= o.warnMin * 60_000 ? c.warn : c.inkDim;
    }
    const right = x + w - inset;
    let sideW = side ? kit.measureTracked(g, side, sideO) : 0;
    if (side && sideW > w * 0.4) {
      side = side.replace(/^\S+\s+/, ''); // "12 min" without "in"/"ends in"
      sideW = kit.measureTracked(g, side, sideO);
      if (sideW > w * 0.4) side = '';
    }
    if (side) kit.drawTracked(g, side, right, base, { ...sideO, color: sideColor });
    const titleX = tx + timeW + R * 0.6;
    const titleW = right - titleX - (side ? sideW + R * 0.6 : 0);
    const text = displayTitle(m, tr) + (m.tentative ? ' (?)' : '');
    const to = { ...titleO, color: m.tentative ? c.inkDim : c.ink };
    if (titleW > R) kit.drawTracked(g, kit.truncate(g, text, titleW, to), titleX, base, to);
  };

  /** Paints a day in `area` and returns the height it used. */
  const section = (s: Section, area: Box): number => {
    kit.drawTracked(g, kit.truncate(g, s.title, area.w, headO), area.x, area.y + headO.size, headO);
    let top = area.y + headH;
    if (!s.items.length) {
      const eo = { ...titleO, size: Math.round(R * 0.9), color: c.inkFaint };
      kit.drawTracked(g, kit.truncate(g, s.empty, area.w - inset, eo), area.x + inset, top + rowH / 2 + R * 0.34, eo);
      return headH + rowH;
    }
    const fit = Math.max(1, Math.floor((area.h - headH) / rowH));
    const shown = s.items.length <= fit ? s.items : s.items.slice(0, fit - 1);
    for (const m of shown) {
      row(m, area.x, top, area.w);
      top += rowH;
    }
    if (shown.length < s.items.length) {
      const mo = { ...titleO, size: Math.round(R * 0.85), color: c.inkDim };
      kit.drawTracked(g, `+${s.items.length - shown.length} ${tr(TEXTS.more)}`, area.x + inset, top + rowH / 2 + R * 0.34, mo);
      top += rowH;
    }
    return top - area.y;
  };

  if (twoCols) {
    sections.forEach((s, i) => section(s, { x: box.x + i * (colW + colGap), y: box.y, w: colW, h: box.h }));
    g.fillStyle = c.surfaceEdge;
    g.fillRect(Math.round(box.x + colW + colGap / 2), box.y + R * 0.2, 1, box.h - R * 0.4);
    return;
  }
  let used = section(sections[0]!, box);
  // Tomorrow only gets what today leaves, and only if a row of it fits.
  for (const s of sections.slice(1)) {
    const gap = Math.round(R * 0.5);
    const rest = box.h - used - gap;
    if (rest < headH + rowH) break;
    used += gap + section(s, { x: box.x, y: box.y + used + gap, w: box.w, h: rest });
  }
}
