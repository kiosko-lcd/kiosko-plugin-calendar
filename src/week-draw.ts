/**
 * Painting the week in meetings. Each day is a strip of its work hours with
 * its meetings filled in, all strips on one time axis so their gaps line up
 * (a short Friday is visibly shorter): the free stretches are what's left
 * dark. A day over the thresholds paints its meetings amber or red; the next
 * free block for deep work is outlined in the theme's "fine" colour, and the
 * same mark leads its line of text.
 *
 *   - Rows (one day per row): from a 172×320 portrait to a 600×400 card.
 *   - Columns (one day per column, a summary on the left): wide strips such
 *     as 1920×140.
 */
import { hanScript, type Box, type Localized } from '@kiosko/sdk';
import type { Painter } from './draw.ts';
import { dayStart } from './meeting.ts';
import type { DayLoad, DaysMode, Load, WeekLoad } from './week.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Letters with a hook to the left (j, y in some fonts) stay inside the box. */
const LEFT = 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const WEEK_TEXTS = {
  /** {d}: the block's length ("2 h"). */
  nextHead: { en: 'Next {d} block', es: 'Próximo hueco de {d}', de: 'Nächste {d} frei', 'zh-Hant': '下一段 {d} 空檔', 'zh-Hans': '下一段 {d} 空档' },
  /** {head}: the line above; {when}: "Thursday 9:00–11:30". */
  nextLine: { en: '{head}: {when}', es: '{head}: {when}', de: '{head}: {when}', 'zh-Hant': '{head}：{when}', 'zh-Hans': '{head}：{when}' },
  noBlockWeek: { en: 'No {d} block left this week', es: 'No queda un hueco de {d} esta semana', de: 'Diese Woche keine {d} am Stück mehr frei', 'zh-Hant': '本週沒有 {d} 的空檔了', 'zh-Hans': '本周没有 {d} 的空档了' },
  noBlockNextWeek: { en: 'No {d} block next week', es: 'Sin hueco de {d} la semana que viene', de: 'Nächste Woche keine {d} am Stück frei', 'zh-Hant': '下週沒有 {d} 的空檔', 'zh-Hans': '下周没有 {d} 的空档' },
  noBlockDays: { en: 'No {d} block in the next 5 days', es: 'Sin hueco de {d} en los próximos 5 días', de: 'In den nächsten 5 Tagen keine {d} am Stück frei', 'zh-Hant': '接下來 5 天沒有 {d} 的空檔', 'zh-Hans': '接下来 5 天没有 {d} 的空档' },
  /** {h}: meeting time ("14 h 30"). */
  totalWeek: { en: '{h} of meetings this week', es: '{h} de reuniones esta semana', de: '{h} Termine diese Woche', 'zh-Hant': '本週會議 {h}', 'zh-Hans': '本周会议 {h}' },
  totalNextWeek: { en: '{h} of meetings next week', es: '{h} de reuniones la semana que viene', de: '{h} Termine nächste Woche', 'zh-Hant': '下週會議 {h}', 'zh-Hans': '下周会议 {h}' },
  totalRest: { en: '{h} of meetings for the rest of the week', es: '{h} de reuniones en lo que queda de semana', de: '{h} Termine im Rest der Woche', 'zh-Hant': '本週剩餘會議 {h}', 'zh-Hans': '本周剩余会议 {h}' },
  totalDays: { en: '{h} of meetings in 5 days', es: '{h} de reuniones en 5 días', de: '{h} Termine in 5 Tagen', 'zh-Hant': '5 天內會議 {h}', 'zh-Hans': '5 天内会议 {h}' },
  /** {h}: free time in a day's work hours. */
  free: { en: '{h} free', es: '{h} libres', de: '{h} frei', 'zh-Hant': '空閒 {h}', 'zh-Hans': '空闲 {h}' },
  holiday: { en: 'Holiday', es: 'Festivo', de: 'Feiertag', 'zh-Hant': '假日', 'zh-Hans': '假日' },
  today: { en: 'today', es: 'hoy', de: 'heute', 'zh-Hant': '今天', 'zh-Hans': '今天' },
  tomorrow: { en: 'tomorrow', es: 'mañana', de: 'morgen', 'zh-Hant': '明天', 'zh-Hans': '明天' },
  noDays: { en: 'No working days', es: 'Sin días laborables', de: 'Keine Arbeitstage', 'zh-Hant': '沒有工作日', 'zh-Hans': '没有工作日' },
  noDaysHelp: { en: 'Set them in Settings → Work hours', es: 'Ponlos en Ajustes → Jornada', de: 'Lege sie unter Einstellungen → Arbeitszeit fest', 'zh-Hant': '請在「設定 → 工作時間」中設定', 'zh-Hans': '请在“设置 → 工作时间”中设置' },
} satisfies Record<string, Localized>;

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/**
 * A length of meeting time: "3 h 30", "45 min", "0 h"; past a day, hours with
 * a decimal ("26,5 h") rather than "1 d 2 h", which reads as calendar days.
 */
export function hoursText(p: Pick<Painter, 'fmt' | 'locale'>, ms: number): string {
  const rounded = Math.round(ms / (5 * MIN)) * 5 * MIN;
  const unit = (n: string) => p.fmt.duration(2 * HOUR, { compact: true }).replace('2', n);
  if (rounded <= 0) return unit('0');
  if (rounded < 24 * HOUR) return p.fmt.duration(rounded, { round: 'nearest', compact: true });
  let n: string;
  try {
    n = new Intl.NumberFormat(p.locale, { maximumFractionDigits: 1 }).format(rounded / HOUR);
  } catch {
    n = (Math.round(rounded / (HOUR / 10)) / 10).toString();
  }
  return unit(n);
}

function weekday(ms: number, locale: string, style: 'long' | 'short'): string {
  try {
    return new Date(ms).toLocaleDateString(locale, { weekday: style });
  } catch {
    return new Date(ms).toLocaleDateString('en', { weekday: style });
  }
}

/** A day's label: "Thu", "Thu 26", and the CJK way "週四" / "26日 週四". */
export function dayLabel(ms: number, locale: string, withDate: boolean): string {
  const day = weekday(ms, locale, 'short').replace(/\.$/, '');
  if (!withDate) return day;
  const n = new Date(ms).getDate();
  return hanScript(locale) ? `${n}日 ${day}` : `${day} ${n}`;
}

/** When the block is: "today 14:00–16:00", "tomorrow …", "Thursday 9:15–11:30" (short weekday if asked). */
export function blockWhen(p: Painter, block: { start: number; end: number }, short = false): string {
  const days = Math.round((dayStart(block.start) - dayStart(p.now)) / 86_400_000);
  const day = days === 0 ? p.t(WEEK_TEXTS.today) : days === 1 ? p.t(WEEK_TEXTS.tomorrow) : weekday(block.start, p.locale, short ? 'short' : 'long').replace(/\.$/, '');
  return `${day} ${p.fmt.range(block.start, block.end)}`;
}

/** The lines about the next free block: a head and a "when" (or one line saying there is none). */
function nextTexts(p: Painter, w: WeekLoad, mode: DaysMode, blockMs: number) {
  const d = p.fmt.duration(blockMs, { compact: true });
  if (!w.next) {
    const none = mode === 'next5' ? WEEK_TEXTS.noBlockDays : w.nextWeek ? WEEK_TEXTS.noBlockNextWeek : WEEK_TEXTS.noBlockWeek;
    return { found: false, head: fill(p.t(none), { d }), when: '', whenShort: '', line: fill(p.t(none), { d }), lineShort: '' };
  }
  const head = fill(p.t(WEEK_TEXTS.nextHead), { d });
  const when = blockWhen(p, w.next);
  const whenShort = blockWhen(p, w.next, true);
  const line = fill(p.t(WEEK_TEXTS.nextLine), { head, when });
  const lineShort = fill(p.t(WEEK_TEXTS.nextLine), { head, when: whenShort });
  return { found: true, head, when, whenShort, line, lineShort };
}

function totalTemplate(p: Painter, w: WeekLoad, mode: DaysMode): string {
  return p.t(mode === 'next5' ? WEEK_TEXTS.totalDays : w.nextWeek ? WEEK_TEXTS.totalNextWeek : mode === 'rest' ? WEEK_TEXTS.totalRest : WEEK_TEXTS.totalWeek);
}

function loadColor(p: Painter, load: Load): string {
  const c = p.theme.colors;
  return load === 'alert' ? c.alert : load === 'warn' ? c.warn : c.info;
}

/** Minutes from the day's midnight (past 1440 for hours after midnight), on the clock: right across a DST change. */
function minuteOf(t: number, date: number): number {
  const d = new Date(t);
  return (dayStart(t) > date ? 24 * 60 : 0) + d.getHours() * 60 + d.getMinutes();
}

/** The time of day every strip spans: the earliest start and the latest end of the days shown. */
function axisOf(days: readonly DayLoad[]): { from: number; to: number } {
  const working = days.filter((d) => d.end > d.start);
  if (!working.length) return { from: 9 * 60, to: 17 * 60 };
  return { from: Math.min(...working.map((d) => minuteOf(d.start, d.date))), to: Math.max(...working.map((d) => minuteOf(d.end, d.date))) };
}

function roundRect(p: Painter, x: number, y: number, w: number, h: number, r: number): void {
  p.g.beginPath();
  p.g.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** One day's strip in `x…x+w`: its work hours, its meetings, the free block, and on today the time gone by. */
function drawStrip(p: Painter, day: DayLoad, axis: { from: number; to: number }, x: number, y: number, w: number, h: number, next: WeekLoad['next'], label: string) {
  const { g, kit, theme } = p;
  const c = theme.colors;
  const span = Math.max(1, axis.to - axis.from);
  const xOf = (t: number) => x + (clamp(minuteOf(t, day.date), axis.from, axis.to) - axis.from) * (w / span);
  const r = Math.min(theme.radius / 3, h / 2, 4);
  if (day.end <= day.start) {
    // A holiday: an empty outline with its word, no hours.
    roundRect(p, x + 0.5, y + 0.5, w - 1, h - 1, r);
    g.strokeStyle = c.surfaceEdge;
    g.lineWidth = 1;
    g.stroke();
    const o = { size: Math.round(clamp(h * 0.8, 10, 16)), family: theme.fonts.sans, color: c.inkFaint, align: 'center' as const };
    if (label && h >= 10) kit.drawTracked(g, kit.truncate(g, label, w - 4, o), x + w / 2, y + h / 2 + o.size * 0.36, o);
    return;
  }
  const x0 = xOf(day.start);
  const x1 = xOf(day.end);
  g.save();
  roundRect(p, x0, y, x1 - x0, h, r);
  g.clip();
  g.fillStyle = c.surfaceEdge;
  g.fillRect(x0, y, x1 - x0, h);
  g.fillStyle = loadColor(p, day.load);
  for (const [a, b] of day.busy) {
    const ax = xOf(a);
    // A sliver of a meeting still shows: at least a pixel.
    g.fillRect(ax, y, Math.max(1, xOf(b) - ax), h);
  }
  if (next && next.start >= day.start && next.end <= day.end) {
    const ax = xOf(next.start);
    const bw = xOf(next.end) - ax;
    g.fillStyle = kit.css(kit.hex(c.ok), 0.28);
    g.fillRect(ax, y, bw, h);
    g.strokeStyle = c.ok;
    g.lineWidth = Math.max(1.5, Math.min(3, h * 0.12));
    g.strokeRect(ax + g.lineWidth / 2, y + g.lineWidth / 2, bw - g.lineWidth, h - g.lineWidth);
  }
  if (day.today && p.now > day.start) {
    // The part of today already gone, dimmed, and a hairline at now.
    const nx = xOf(Math.min(p.now, day.end));
    g.fillStyle = kit.css(kit.hex(c.bg), 0.55);
    g.fillRect(x0, y, nx - x0, h);
    if (p.now < day.end) {
      g.fillStyle = c.ink;
      g.fillRect(Math.round(nx) - 1, y, 2, h);
    }
  }
  g.restore();
}

export interface WeekDrawOptions {
  days: DaysMode;
  blockMs: number;
}

/** Hour ticks over the strips ("9", "12", "15"), every 1, 2, 3 or 4 hours, as far apart as they need. */
function drawAxis(p: Painter, axis: { from: number; to: number }, x: number, w: number, base: number, size: number) {
  const { g, kit, theme } = p;
  const o = { size, family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' as const };
  let hourFmt: Intl.DateTimeFormat;
  try {
    hourFmt = new Intl.DateTimeFormat(p.locale, { hour: 'numeric', hour12: p.fmt.hour12 });
  } catch {
    hourFmt = new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: p.fmt.hour12 });
  }
  // On a 24-hour clock the bare number ("12", not "12 Uhr" or "12時"); on a 12-hour one, the language's "12 PM".
  const label = (min: number) => (p.fmt.hour12 ? hourFmt.format(new Date(2026, 0, 1, Math.floor(min / 60) % 24)) : String(Math.floor(min / 60) % 24));
  const span = Math.max(1, axis.to - axis.from);
  const widest = kit.measureTracked(g, label(23 * 60), o) + size;
  const step = [1, 2, 3, 4, 6].find((s) => (s * 60 * w) / span >= widest * 1.4);
  if (!step) return;
  let after = -Infinity;
  for (let m = Math.ceil(axis.from / 60) * 60; m <= axis.to; m += 60) {
    if ((m / 60) % step) continue;
    const text = label(m);
    const half = kit.measureTracked(g, text, o) / 2;
    // Centred on its hour; the first and last pushed inside the strip.
    const tx = clamp(x + ((m - axis.from) * w) / span, x + half, x + w - half);
    if (tx - half < after + size * 0.6) continue;
    kit.drawTracked(g, text, tx, base, o);
    after = tx + half;
  }
}

/** A text with "{h}" in it, the value in its own colour. Returns nothing when it doesn't fit `maxW` (the caller shortens). */
function drawTemplated(p: Painter, template: string, value: string, x: number, base: number, maxW: number, o: { size: number; family: string; color: string }, valueO: { family: string; color: string }): boolean {
  const { g, kit } = p;
  const [before = '', after = ''] = template.split('{h}');
  const vo = { ...o, ...valueO };
  const total = kit.measureTracked(g, before, o) + kit.measureTracked(g, value, vo) + kit.measureTracked(g, after, o);
  if (total > maxW) return false;
  let cx = x;
  if (before) cx += kit.drawTracked(g, before, cx, base, o);
  cx += kit.drawTracked(g, value, cx, base, vo);
  if (after) kit.drawTracked(g, after, cx, base, o);
  return true;
}

/** The small mark of the free block, the same green as on the strips. */
function blockMark(p: Painter, x: number, base: number, size: number): number {
  const s = Math.round(size * 0.62);
  const y = base - size * 0.36 - s / 2;
  p.g.fillStyle = p.kit.css(p.kit.hex(p.theme.colors.ok), 0.28);
  p.g.fillRect(x, y, s, s);
  p.g.strokeStyle = p.theme.colors.ok;
  p.g.lineWidth = 1.5;
  p.g.strokeRect(x + 0.75, y + 0.75, s - 1.5, s - 1.5);
  return s + Math.round(size * 0.4);
}

export function drawWeek(p: Painter, box: Box, w: WeekLoad, o: WeekDrawOptions): void {
  if (box.w >= box.h * 3 && box.w >= 480 && w.days.length > 1) drawColumns(p, box, w, o);
  else drawRows(p, box, w, o);
}

/** One day per row: label, strip, hours; the week's total above and the next block below. */
function drawRows(p: Painter, box: Box, w: WeekLoad, o: WeekDrawOptions): void {
  const { g, kit, theme } = p;
  const c = theme.colors;
  const f = theme.fonts;
  const n = w.days.length;
  const axis = axisOf(w.days);
  const nt = nextTexts(p, w, o.days, o.blockMs);
  const total = hoursText(p, w.totalMs);
  const template = totalTemplate(p, w, o.days);

  // Letter size by the height each row would get with two summary lines, and the width.
  let R = Math.round(clamp(Math.min(box.h / (n + 2.6) / 1.45, box.w / 13), 10, 26));
  const lineH = () => R * 1.45;
  const sumO = () => ({ size: R, family: f.sans, color: c.inkDim });
  const fits = (text: string, size = R, family = f.sans, room = box.w) => kit.measureTracked(g, text, { size, family }) <= room;

  // The next block: on one line if it fits, else its head small above the time; the total above the rows.
  const markW = () => Math.round(R * 0.62) + Math.round(R * 0.4);
  let nextLines = nt.found ? (fits(nt.line, R, f.sans, box.w - markW()) || fits(nt.lineShort, R, f.sans, box.w - markW()) ? 1 : 2) : 1;
  let showTotal = true;
  let showNext = true;
  let showAxis = false;
  const rowsArea = () => box.h - (showTotal ? lineH() : 0) - (showNext ? nextLines * lineH() + R * 0.3 : 0) - (showAxis ? R * 1.25 : 0);
  // Squeeze: fewer summary lines before letters below 11 px.
  while (rowsArea() / n < R * 1.15) {
    if (showNext && nextLines === 2) nextLines = 1;
    else if (showTotal) showTotal = false;
    else if (showNext) showNext = false;
    else if (R > 10) R--;
    else break;
  }
  // Narrow and tall (a portrait tile): each day's label and hours on a line, its strip under them, full width.
  const stacked = box.w < 360 && rowsArea() / n >= R * 2.6;
  if (stacked) {
    while (R < 22 && R + 1 <= box.w / 10.5) {
      R++;
      if (rowsArea() / n < R * 2.6) {
        R--;
        break;
      }
    }
  }
  // Hour ticks above the strips when the rows have room to spare.
  showAxis = !stacked && rowsArea() / n >= R * 2.3 && box.h >= 150;
  const rowH = rowsArea() / n;

  let y = box.y;
  if (showTotal) {
    const base = y + R * 1.05;
    const small = { ...sumO(), size: Math.max(10, Math.round(R * 0.85)) };
    if (!drawTemplated(p, template, total, box.x, base, box.w, sumO(), { family: f.sansBold, color: c.ink }) && !drawTemplated(p, template, total, box.x, base, box.w, small, { family: f.sansBold, color: c.ink })) {
      // Not even smaller: the number, and what's left of the words after it.
      const vo = { size: R, family: f.sansBold, color: c.ink };
      const vw = kit.drawTracked(g, kit.truncate(g, total, box.w, vo), box.x, base, vo);
      const caption = template.replace('{h}', '').replace(/\s+/g, ' ').trim();
      if (box.w - vw - R * 0.4 > R * 2) kit.drawTracked(g, kit.truncate(g, caption, box.w - vw - R * 0.4, small), box.x + vw + R * 0.4, base, small);
    }
    y += lineH();
  }

  const labelO = { size: R, family: f.sans, color: c.inkDim };
  const valueO = { size: R, family: f.sans, color: c.ink, align: 'right' as const };
  const freeO = { size: Math.max(10, Math.round(R * 0.85)), family: f.sans, color: c.inkDim, align: 'right' as const };
  const values = w.days.map((d) => (d.end > d.start ? hoursText(p, d.meetingMs) : ''));
  const frees = w.days.map((d) => (d.end > d.start ? fill(p.t(WEEK_TEXTS.free), { h: hoursText(p, d.freeMs) }) : ''));
  const valueColor = (d: DayLoad) => (d.load === 'alert' ? c.alert : d.load === 'warn' ? c.warn : c.ink);
  const labelOf = (d: DayLoad) => ({ ...labelO, family: d.today ? f.sansBold : f.sans, color: d.today ? c.ink : c.inkDim });

  if (stacked) {
    const stripH = Math.round(clamp(rowH - R * 1.6, 4, R * 1.3));
    const withDate = box.w >= 150;
    w.days.forEach((d, i) => {
      const top = y + i * rowH;
      // Label and strip as one block, centred in the row.
      const blockTop = top + Math.max(0, (rowH - (R * 1.35 + stripH)) / 2);
      const base = blockTop + R * 0.95;
      g.save();
      if (d.past) g.globalAlpha = 0.55;
      const vw = values[i] ? kit.drawTracked(g, values[i]!, box.x + box.w, base, { ...valueO, color: valueColor(d) }) : 0;
      const lo = labelOf(d);
      let label = dayLabel(d.date, p.locale, withDate);
      const room = box.w - LEFT - (vw ? vw + R * 0.5 : 0);
      if (kit.measureTracked(g, label, lo) > room) label = dayLabel(d.date, p.locale, false);
      kit.drawTracked(g, kit.truncate(g, label, room, lo), box.x + LEFT, base, lo);
      drawStrip(p, d, axis, box.x, Math.round(blockTop + R * 1.35), box.w, stripH, w.next, d.holiday ? p.t(WEEK_TEXTS.holiday) : '');
      g.restore();
    });
  } else {
    // Columns: the day labels, the strips, the hours (and free time where there is room).
    const gap = Math.round(R * 0.6);
    let valueW = Math.max(0, ...values.map((v) => kit.measureTracked(g, v, valueO)));
    const widest = (withDate: boolean) => Math.max(...w.days.map((d) => kit.measureTracked(g, dayLabel(d.date, p.locale, withDate), { ...labelO, family: f.sansBold }))) + LEFT;
    // The date beside the weekday only while the strips keep most of the width.
    const withDate = box.w - widest(true) - valueW - gap * 2 >= box.w * 0.45;
    const labels = w.days.map((d) => dayLabel(d.date, p.locale, withDate));
    const labelW = widest(withDate);
    const freeW = Math.max(0, ...frees.map((v) => kit.measureTracked(g, v, freeO)));
    const withFree = box.w - labelW - valueW - freeW - gap * 3 >= Math.max(160, box.w * 0.4);
    let stripX = box.x + labelW + gap;
    let stripW = box.w - labelW - valueW - gap * 2 - (withFree ? freeW + gap : 0);
    if (stripW < 40) {
      // Too narrow for the hours: the strip alone says it.
      valueW = 0;
      stripW = box.w - labelW - gap;
    }
    if (stripW < 24) {
      stripX = box.x;
      stripW = box.w;
    }
    if (showAxis) {
      drawAxis(p, axis, stripX, stripW, y + R * 0.95, Math.max(10, Math.round(R * 0.8)));
      y += R * 1.25;
    }
    const stripH = Math.round(clamp(rowH * 0.5, 4, R * 1.15));
    w.days.forEach((d, i) => {
      const mid = y + i * rowH + rowH / 2;
      const base = mid + R * 0.36;
      g.save();
      if (d.past) g.globalAlpha = 0.55;
      if (stripX > box.x) {
        const lo = labelOf(d);
        kit.drawTracked(g, kit.truncate(g, labels[i]!, labelW, lo), box.x + LEFT, base, lo);
      }
      drawStrip(p, d, axis, stripX, Math.round(mid - stripH / 2), stripW, stripH, w.next, d.holiday ? p.t(WEEK_TEXTS.holiday) : '');
      if (valueW && values[i]) {
        const right = box.x + box.w - (withFree ? freeW + gap : 0);
        kit.drawTracked(g, values[i]!, right, base, { ...valueO, color: valueColor(d) });
        if (withFree) kit.drawTracked(g, frees[i]!, box.x + box.w, base, freeO);
      }
      g.restore();
    });
  }

  if (showNext) {
    const bottom = box.y + box.h;
    const nextO = { size: R, family: f.sans, color: nt.found ? c.ink : c.inkFaint };
    if (nextLines === 2) {
      const headO = { size: Math.max(10, Math.round(R * 0.85)), family: f.sans, color: c.inkDim };
      const b2 = bottom - R * 0.3;
      const b1 = b2 - lineH();
      const mx = blockMark(p, box.x, b1, headO.size);
      kit.drawTracked(g, kit.truncate(g, nt.head, box.w - mx, headO), box.x + mx, b1, headO);
      const when = fits(nt.when, R, f.sansBold) ? nt.when : nt.whenShort;
      kit.drawTracked(g, kit.truncate(g, when, box.w, { ...nextO, family: f.sansBold }), box.x, b2, { ...nextO, family: f.sansBold });
    } else {
      const base = bottom - R * 0.3;
      const mx = nt.found ? blockMark(p, box.x, base, R) : 0;
      // The whole sentence, else with a short weekday, else only when (the mark says what it is).
      const options = nt.found ? [nt.line, nt.lineShort, nt.when, nt.whenShort] : [nt.line];
      const line = options.find((l) => fits(l, R, f.sans, box.w - mx)) ?? options[options.length - 1]!;
      kit.drawTracked(g, kit.truncate(g, line, box.w - mx, nextO), box.x + mx, base, nextO);
    }
  }
}

/** One day per column on a wide strip, with the week's total and the next block on the left. */
function drawColumns(p: Painter, box: Box, w: WeekLoad, o: WeekDrawOptions): void {
  const { g, kit, theme } = p;
  const c = theme.colors;
  const f = theme.fonts;
  const n = w.days.length;
  const axis = axisOf(w.days);
  const nt = nextTexts(p, w, o.days, o.blockMs);

  const S = Math.round(clamp(box.w * 0.26, 170, 460));
  const gap = Math.round(clamp(box.w * 0.012, 8, 24));
  const areaX = box.x + S + gap * 2;
  const areaW = box.x + box.w - areaX;
  const colW = (areaW - gap * (n - 1)) / n;
  const R = Math.round(clamp(Math.min(box.h * 0.2, colW / 7.5), 10, 30));

  // Left: the total, big, its words under it, then the next block.
  const template = totalTemplate(p, w, o.days);
  const total = hoursText(p, w.totalMs);
  const caption = template.replace('{h}', '').replace(/\s+/g, ' ').trim();
  // Its own letter size, by the height: the days' columns may be narrow, the summary isn't.
  const capS = Math.round(clamp(box.h * 0.12, 10, 26));
  const capO = { size: capS, family: f.sans, color: c.inkDim };
  const nextO = { size: capS, family: f.sans, color: nt.found ? c.ink : c.inkFaint };
  const B = Math.round(clamp(Math.min(box.h * 0.38, S * 0.3, capS * 3.2), 12, 84));
  const lines = clamp(Math.floor((box.h - B * 0.85) / (capS * 1.4)), 1, 3);
  const bigO = { size: B, family: f.sansBold, color: c.ink };
  let y = box.y + Math.max(0, (box.h - (B * 0.8 + capO.size * 1.35 * (lines + (lines > 1 ? 0.3 : 0)))) / 2);
  const bigW = kit.measureTracked(g, total, bigO);
  const bigS = bigW > S ? Math.max(12, Math.floor((B * S) / bigW)) : B;
  kit.drawTracked(g, total, box.x, y + bigS * 0.8, { ...bigO, size: bigS });
  // The words beside the number when they fit, else under it.
  const capBeside = box.x + kit.measureTracked(g, total, { ...bigO, size: bigS }) + capO.size * 0.5 + kit.measureTracked(g, caption, capO) <= box.x + S;
  if (capBeside) {
    kit.drawTracked(g, caption, box.x + kit.measureTracked(g, total, { ...bigO, size: bigS }) + capO.size * 0.5, y + bigS * 0.8, capO);
    y += bigS * 0.8;
  } else {
    y += bigS * 0.8;
    if (lines >= 2) {
      y += capO.size * 1.35;
      kit.drawTracked(g, kit.truncate(g, caption, S, capO), box.x, y, capO);
    }
  }
  const rest = capBeside ? lines : lines - 1;
  if (rest >= 1) {
    y += nextO.size * 1.35 + (lines > 1 ? nextO.size * 0.3 : 0);
    const mx = nt.found ? blockMark(p, box.x, y, nextO.size) : 0;
    if (rest >= 2 && nt.found && kit.measureTracked(g, nt.line, nextO) > S - mx) {
      const headO = { ...nextO, color: c.inkDim };
      kit.drawTracked(g, kit.truncate(g, nt.head, S - mx, headO), box.x + mx, y, headO);
      y += nextO.size * 1.35;
      const when = kit.measureTracked(g, nt.when, { ...nextO, family: f.sansBold }) <= S ? nt.when : nt.whenShort;
      kit.drawTracked(g, kit.truncate(g, when, S, { ...nextO, family: f.sansBold }), box.x, y, { ...nextO, family: f.sansBold });
    } else {
      const line = nt.found && kit.measureTracked(g, nt.line, nextO) > S - mx ? nt.lineShort : nt.line;
      kit.drawTracked(g, kit.truncate(g, line, S - mx, nextO), box.x + mx, y, nextO);
    }
  }
  g.fillStyle = c.surfaceEdge;
  g.fillRect(box.x + S + gap, box.y + R * 0.2, 1, box.h - R * 0.4);

  // Right: each day, its label and hours above its strip, the free time under it.
  const headO = { size: R, family: f.sans, color: c.inkDim };
  const valueO = { size: R, family: f.sans, color: c.ink, align: 'right' as const };
  const freeO = { size: Math.max(10, Math.round(R * 0.85)), family: f.sans, color: c.inkDim };
  const withFree = box.h >= R * 4.4;
  const stripH = Math.round(clamp(box.h - R * 1.55 - (withFree ? R * 1.6 : R * 0.2), 4, Math.max(R * 2.2, box.h * 0.35)));
  // Label, strip and free time as one block, centred in the height.
  const top = box.y + Math.max(0, (box.h - (R * 1.55 + stripH + (withFree ? R * 1.6 : 0))) / 2);
  const stripTop = top + R * 1.55;
  const values = w.days.map((d) => (d.end > d.start ? hoursText(p, d.meetingMs) : ''));
  const valueColor = (d: DayLoad) => (d.load === 'alert' ? c.alert : d.load === 'warn' ? c.warn : c.ink);
  // Day and hours side by side above the strip while every column has room for both (the weekday at
  // least); else the day alone above and the hours under the strip, before the free time.
  const together = w.days.every((d, i) => LEFT + kit.measureTracked(g, dayLabel(d.date, p.locale, false), { ...headO, family: f.sansBold }) + R * 0.5 + (values[i] ? kit.measureTracked(g, values[i]!, valueO) : 0) <= colW);
  w.days.forEach((d, i) => {
    const x = areaX + i * (colW + gap);
    g.save();
    if (d.past) g.globalAlpha = 0.55;
    const value = values[i]!;
    const vo = { ...valueO, color: valueColor(d) };
    const vw = value && together ? kit.measureTracked(g, value, vo) : 0;
    const lo = { ...headO, family: d.today ? f.sansBold : f.sans, color: d.today ? c.ink : c.inkDim };
    const room = colW - LEFT - (vw ? vw + R * 0.5 : 0);
    let label = dayLabel(d.date, p.locale, true);
    if (kit.measureTracked(g, label, lo) > room) label = dayLabel(d.date, p.locale, false);
    kit.drawTracked(g, kit.truncate(g, label, room, lo), x + LEFT, top + R * 0.95, lo);
    if (vw) kit.drawTracked(g, value, x + colW, top + R * 0.95, vo);
    drawStrip(p, d, axis, x, Math.round(stripTop), colW, stripH, w.next, d.holiday ? p.t(WEEK_TEXTS.holiday) : '');
    if (withFree && d.end > d.start) {
      const base = stripTop + stripH + freeO.size * 1.3;
      const free = fill(p.t(WEEK_TEXTS.free), { h: hoursText(p, d.freeMs) });
      if (together) kit.drawTracked(g, kit.truncate(g, free, colW, freeO), x, base, freeO);
      else {
        const ho = { ...freeO, color: valueColor(d), align: 'left' as const };
        const hw = kit.drawTracked(g, kit.truncate(g, value, colW, ho), x, base, ho);
        const rest = ` · ${free}`;
        if (hw + kit.measureTracked(g, rest, freeO) <= colW) kit.drawTracked(g, rest, x + hw, base, freeO);
      }
    }
    g.restore();
  });
}
