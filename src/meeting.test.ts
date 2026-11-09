import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localize, THEMES } from '@kiosko/sdk';
import { agendaNow, countdown, DEFAULT_THRESHOLDS, displayTitle, levelColor, meetingLevel, pickNext } from './meeting.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-04T13:00:00');
const at = (minutes: number) => ({ startsAt: NOW + minutes * MIN });

test('meetingLevel: the ladder of imminence', () => {
  const t = DEFAULT_THRESHOLDS;
  assert.equal(meetingLevel(at(180), NOW, t), 'idle', 'far: informs, does not claim');
  assert.equal(meetingLevel(at(90), NOW, t), 'grey');
  assert.equal(meetingLevel(at(20), NOW, t), 'ready');
  assert.equal(meetingLevel(at(6), NOW, t), 'warn');
  assert.equal(meetingLevel(at(2), NOW, t), 'alert');
  assert.equal(meetingLevel(at(-10), NOW, t), 'now', 'started is the most urgent there is');
  // Thresholds are inclusive: at exactly 10 minutes it already warns.
  assert.equal(meetingLevel(at(10), NOW, t), 'warn');
});

test('levelColor: dim while it informs, then the theme semaphore', () => {
  const c = THEMES[0]!.colors;
  assert.deepEqual(
    (['idle', 'grey', 'ready', 'warn', 'alert', 'now'] as const).map((l) => levelColor(l, c)),
    [c.inkDim, c.inkDim, c.info, c.warn, c.alert, c.alert],
  );
});

const m = (title: string, start: number, len = 30) => ({ title, startsAt: NOW + start * MIN, endsAt: NOW + (start + len) * MIN });

test('agendaNow: the meeting under way and the ones still to start', () => {
  const { current, next } = agendaNow([m('Later', 60), m('Done', -60), m('Now', -10), m('Soon', 15)], NOW);
  assert.equal(current?.title, 'Now');
  assert.deepEqual(next.map((x) => x.title), ['Soon', 'Later']);
  assert.equal(agendaNow([m('Done', -60)], NOW).current, null);
});

test('pickNext: back to back, the next one wins once it is close', () => {
  const now = [m('Review', -20, 30), m('One to one', 10)];
  assert.equal(pickNext(now, NOW, { warnMin: 10 })?.title, 'One to one', 'at 10 minutes, where to go next matters more');
  assert.equal(pickNext(now, NOW, { warnMin: 5 })?.title, 'Review');
  assert.equal(pickNext([m('Later', 45)], NOW, { warnMin: 10 })?.title, 'Later');
  assert.equal(pickNext([m('Done', -60)], NOW, { warnMin: 10 }), null);
});

test('countdown: "12 min", "1 h 5 min", rounded up', () => {
  assert.equal(countdown(12 * MIN), '12 min');
  assert.equal(countdown(11 * MIN + 1), '12 min', 'never says less than what is left');
  assert.equal(countdown(30_000), '1 min');
  assert.equal(countdown(65 * MIN), '1 h 5 min');
  assert.equal(countdown(120 * MIN), '2 h');
  assert.equal(countdown(-5 * MIN), '0 min');
});

test('displayTitle: private meetings never show theirs', () => {
  const es = (t: Parameters<typeof localize>[0]) => localize(t, 'es');
  assert.equal(displayTitle({ title: 'Dentist', private: true }, es), 'Reunión privada');
  assert.equal(displayTitle({ title: 'Committee' }, es, false), 'Reunión');
  assert.equal(displayTitle({ title: '  ' }, es), 'Reunión');
  assert.equal(displayTitle({ title: 'Committee' }, es), 'Committee');
});
