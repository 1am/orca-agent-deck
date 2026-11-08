import { expect, it } from 'vitest';
import { ShellActivity } from './shell-activity.ts';

const mk = () => new ShellActivity({ quietMs: 4000, minBusyMs: 8000 });

it('ignores short bursts: a prompt redraw or a quick command never shows', () => {
  const s = mk();
  expect(s.observe('p', 1000, 2000)).toBeNull();
  expect(s.observe('p', 1000, 4000)).toBeNull();
  expect(s.observe('p', 5000, 6000)).toBeNull();
  expect(s.observe('p', 5000, 12000)).toBeNull();
});

it('shows working once output has been continuous long enough, then done when it stops', () => {
  const s = mk();
  let t = 0;
  const out = () => t - 500; // output half a second ago, every poll
  const states: (string | null)[] = [];
  for (t = 1000; t <= 13000; t += 2000) states.push(s.observe('p', out(), t));
  expect(states).toEqual([null, null, null, null, 'working', 'working', 'working']);
  expect(s.busyFor('p', 13000)).toBeGreaterThanOrEqual(8000);
  // Output stops: still working until it has been quiet, then done.
  expect(s.observe('p', 12500, 15000)).toBe('working');
  expect(s.observe('p', 12500, 17500)).toBe('done');
});

it('keeps done until the next busy streak, and a short burst afterwards does not clear it', () => {
  const s = mk();
  for (let t = 1000; t <= 11000; t += 2000) s.observe('p', t - 500, t);
  expect(s.observe('p', 11000, 20000)).toBe('done');
  expect(s.observe('p', 29500, 30000)).toBe('done');
  expect(s.observe('p', 29500, 32000)).toBe('done');
  expect(s.observe('p', 29500, 40000)).toBe('done');
  for (let t = 50000; t <= 60000; t += 2000) s.observe('p', t - 500, t);
  expect(s.observe('p', 60500, 62000)).toBe('working');
});

it('tracks panes separately, has no state without a timestamp, and prunes gone panes', () => {
  const s = mk();
  expect(s.observe('a', null, 1000)).toBeNull();
  expect(s.observe('a', undefined, 3000)).toBeNull();
  for (let t = 1000; t <= 11000; t += 2000) s.observe('b', t - 500, t);
  expect(s.observe('b', 10500, 11000)).toBe('working');
  s.prune(new Set(['a']));
  expect(s.busyFor('b', 11000)).toBe(0);
});
