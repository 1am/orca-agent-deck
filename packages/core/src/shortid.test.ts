import { expect, it } from 'vitest';
import { shortIds } from './shortid.ts';

it('is deterministic, short and unique', () => {
  const keys = ['t1:a', 't1:b', 't2:c'];
  const a = shortIds(keys);
  expect(shortIds([...keys].reverse()).get('t1:a')).toBe(a.get('t1:a'));
  expect(new Set(a.values()).size).toBe(3);
  for (const v of a.values()) expect(v).toMatch(/^[0-9a-z]{3,}$/);
});
