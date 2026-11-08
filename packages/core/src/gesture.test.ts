import { expect, it, vi } from 'vitest';
import { HoldGestures } from './gesture.ts';

it('fires the hold while the key is still down, once', () => {
  vi.useFakeTimers();
  const held: string[] = [];
  const g = new HoldGestures((s) => held.push(s));
  g.keyDown('a');
  vi.advanceTimersByTime(999);
  expect(held).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(held).toEqual(['a']);
  vi.advanceTimersByTime(10_000);
  expect(held).toEqual(['a']);
  vi.useRealTimers();
});

it('a release before the delay is a tap and cancels the hold', () => {
  vi.useFakeTimers();
  const held: string[] = [];
  const g = new HoldGestures((s) => held.push(s));
  g.keyDown('a');
  vi.advanceTimersByTime(300);
  expect(g.keyUp('a')).toBe(true);
  vi.advanceTimersByTime(5000);
  expect(held).toEqual([]);
  vi.useRealTimers();
});

it('the release after a fired hold is not a tap, the next press is', () => {
  vi.useFakeTimers();
  const g = new HoldGestures(() => {});
  g.keyDown('a');
  vi.advanceTimersByTime(1500);
  expect(g.keyUp('a')).toBe(false);
  g.keyDown('a');
  expect(g.keyUp('a')).toBe(true);
  vi.useRealTimers();
});

it('slots are independent', () => {
  vi.useFakeTimers();
  const held: string[] = [];
  const g = new HoldGestures((s) => held.push(s));
  g.keyDown('a');
  g.keyDown('b');
  g.keyUp('b');
  vi.advanceTimersByTime(1000);
  expect(held).toEqual(['a']);
  vi.useRealTimers();
});
