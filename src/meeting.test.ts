import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localize, THEMES } from '@kiosko/sdk';
import { agendaNow, DEFAULT_THRESHOLDS, displayTitle, levelColor, meetingLevel, pickNext, selectMeetings } from './meeting.ts';

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
  assert.equal(pickNext(now, NOW, { warnMs: 10 * MIN })?.title, 'One to one', 'at 10 minutes, where to go next matters more');
  assert.equal(pickNext(now, NOW, { warnMs: 5 * MIN })?.title, 'Review');
  assert.equal(pickNext([m('Later', 45)], NOW, { warnMs: 10 * MIN })?.title, 'Later');
  assert.equal(pickNext([m('Done', -60)], NOW, { warnMs: 10 * MIN }), null);
});

test('agendaNow and pickNext: an all-day event is never under way nor next', () => {
  const holiday = { title: 'Holiday', startsAt: NOW - 13 * 60 * MIN, endsAt: NOW + 11 * 60 * MIN, allDay: true };
  const { current, next } = agendaNow([holiday, m('Soon', 15)], NOW);
  assert.equal(current, null);
  assert.deepEqual(next.map((x) => x.title), ['Soon']);
  assert.equal(pickNext([holiday], NOW, { warnMs: 10 * MIN }), null);
});

test('selectMeetings: calendars by name (any of a merged meeting), tentative ones out if asked', () => {
  const list = [
    { title: 'Standup', calendars: ['Work'] },
    { title: 'Dentist', calendars: ['Personal'] },
    { title: 'Shared', calendars: ['Work', 'Family'] },
    { title: 'Unnamed' },
    { title: 'Maybe', calendars: ['Work'], tentative: true },
  ];
  const titles = (o: Parameters<typeof selectMeetings>[1]) => selectMeetings(list, o).map((x) => x.title);
  assert.deepEqual(titles({}), ['Standup', 'Dentist', 'Shared', 'Unnamed', 'Maybe']);
  assert.deepEqual(titles({ calendars: ['work'] }), ['Standup', 'Shared', 'Maybe'], 'case does not matter');
  assert.deepEqual(titles({ calendars: ['!Work'] }), ['Dentist', 'Unnamed']);
  assert.deepEqual(titles({ calendars: ['Family', 'Personal'] }), ['Dentist', 'Shared']);
  assert.deepEqual(titles({ hideTentative: true }), ['Standup', 'Dentist', 'Shared', 'Unnamed']);
});

test('displayTitle: private meetings never show theirs', () => {
  const es = (t: Parameters<typeof localize>[0]) => localize(t, 'es');
  assert.equal(displayTitle({ title: 'Dentist', private: true }, es), 'Reunión privada');
  assert.equal(displayTitle({ title: 'Committee' }, es, false), 'Reunión');
  assert.equal(displayTitle({ title: '  ' }, es), 'Reunión');
  assert.equal(displayTitle({ title: 'Committee' }, es), 'Committee');
});
