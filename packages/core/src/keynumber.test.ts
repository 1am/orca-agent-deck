import { expect, it } from 'vitest';
import { formatKeyNumber, keyNumber } from './keynumber.ts';

it.each([
  [2, 3, { column: 0, row: 0 }, 1],
  [2, 3, { column: 1, row: 1 }, 5],
  [3, 5, { column: 4, row: 0 }, 5],
  [3, 5, { column: 0, row: 1 }, 6],
  [3, 5, { column: 4, row: 2 }, 15],
  [4, 8, { column: 7, row: 3 }, 32],
  [4, 8, { column: 3, row: 2 }, 20],
])('layout %ix%i %j -> %i', (_rows, columns, coordinates, expected) => {
  expect(keyNumber(coordinates, columns)).toBe(expected);
});

it('formats with and without a page', () => {
  expect(formatKeyNumber(5)).toBe('5');
  expect(formatKeyNumber(5, null)).toBe('5');
  expect(formatKeyNumber(5, 2)).toBe('2·5');
});
