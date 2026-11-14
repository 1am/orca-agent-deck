import { expect, it } from 'vitest';
import { mergeHostCensus } from './host-scope.ts';

const census = (omitted: string[], down: string[] = omitted) => ({ omitted, down });

it('drops the runtime entry of a paired server that was read', () => {
  const r = mergeHostCensus(census(['runtime:E1', 'ssh:box']), [{ id: 'E1', census: census([]) }]);
  expect(r).toEqual(census(['ssh:box']));
});

it('keeps a retired peer of a paired server omitted but not down', () => {
  const r = mergeHostCensus(census(['runtime:E1']), [
    { id: 'E1', census: census(['runtime:retired', 'ssh:far']) },
  ]);
  expect(r.omitted).toEqual(['runtime:retired', 'ssh:far']);
  expect(r.down).toEqual(['ssh:far']);
});

it('marks a server we could not read as env: in both lists', () => {
  const r = mergeHostCensus(census(['runtime:E1']), [{ id: 'E1', census: null }]);
  expect(r).toEqual(census(['env:E1']));
});

it('keeps a local runtime peer that matches no paired server, and matches encoded ids', () => {
  expect(mergeHostCensus(census(['runtime:gone']), [])).toEqual(census(['runtime:gone']));
  const r = mergeHostCensus(census(['runtime:env%201']), [{ id: 'env 1', census: census([]) }]);
  expect(r).toEqual(census([]));
});
