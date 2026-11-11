import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { z } from 'zod';
import { header, stepSchema, type Scenario } from './schema.ts';

/** Parses and validates an NDJSON scenario; errors name the file and line. */
export function parseScenario(text: string, file = 'scenario'): Scenario {
  const lines = text.split('\n').flatMap((l, i) => (l.trim() ? [{ n: i + 1, l }] : []));
  const fail = (n: number, msg: string): never => {
    throw new Error(`${file}:${n}: ${msg}`);
  };
  const parse = <S extends z.ZodTypeAny>(schema: S, n: number, l: string): z.infer<S> => {
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      return fail(n, 'not valid JSON');
    }
    const r = schema.safeParse(raw);
    return r.success
      ? r.data
      : fail(n, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  };
  const first = lines[0];
  if (!first) throw new Error(`${file}: empty scenario`);
  const h = parse(header, first.n, first.l);
  const steps = lines.slice(1).map(({ n, l }) => ({ n, s: parse(stepSchema, n, l) }));
  const limit = h.deck.cols * h.deck.rows;
  let last = 0;
  for (const { n, s } of steps) {
    if (s.at < last) fail(n, `at ${s.at} is before the previous step (${last})`);
    last = s.at;
    if ('key' in s && typeof s.key === 'number' && s.key > limit)
      fail(n, `key ${s.key} is outside the ${h.deck.cols}x${h.deck.rows} deck`);
    if (s.do === 'expect.key' && Object.keys(s).length <= 3)
      fail(n, 'expect.key needs at least one field to check');
  }
  // For plugin A the frames it must send are the expectations.
  if (
    !steps.some(
      ({ s }) => s.do.startsWith('expect.') || (s.do === 'bridge.frame' && s.from === 'a'),
    )
  )
    throw new Error(`${file}: a scenario needs at least one expect.* step or bridge.frame from a`);
  return { header: h, steps: steps.map(({ s }) => s) };
}

export const loadScenario = (path: string): Scenario =>
  parseScenario(readFileSync(path, 'utf8'), basename(path));
