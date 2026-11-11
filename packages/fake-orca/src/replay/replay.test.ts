import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenario } from './load.ts';
import { replaySim } from './run.ts';
import { diffTimeline } from './timeline.ts';

const DIR = new URL('../../../../test/replay/', import.meta.url).pathname;
// The sim runner plays the scenarios that name it; `make replay-a` plays the `a` ones.
const files = readdirSync(DIR).filter(
  (f) => f.endsWith('.ndjson') && loadScenario(`${DIR}${f}`).header.sides.includes('sim'),
);

describe('committed scenarios', () => {
  it.each(files)('%s passes its expects and matches its timeline snapshot', async (file) => {
    const sc = loadScenario(`${DIR}${file}`);
    const r = await replaySim(sc);
    expect(r.failures).toEqual([]);
    const snap = readFileSync(
      `${DIR}__snapshots__/${file.replace('.ndjson', '')}.timeline.txt`,
      'utf8',
    );
    expect(diffTimeline(snap.trimEnd().split('\n'), r.timeline)).toEqual([]);
  });
});

const header = '{"v":2,"name":"x","sides":["sim"],"keys":{"1":"a"}}';
const add = '{"at":0,"do":"orca.pane.add","pane":"a"}';
const expectKey = '{"at":0,"do":"expect.key","key":1,"state":"completed"}';
const parse = (...lines: string[]) => parseScenario(lines.join('\n'), 'x.ndjson');

describe('loader', () => {
  it('accepts a minimal scenario and defaults the deck to the MK.2', () => {
    expect(parse(header, add, expectKey).header.deck).toEqual({ cols: 5, rows: 3 });
  });
  it('counts a bridge.frame from a as an expectation, but not one from b', () => {
    const a = '{"at":0,"do":"bridge.frame","from":"a","frame":{"type":"hello"}}';
    const b = '{"at":0,"do":"bridge.frame","from":"b","frame":{"type":"requestSnapshot"}}';
    expect(parse(header, a).steps).toHaveLength(1);
    expect(() => parse(header, b)).toThrow(/at least one expect/);
    expect(() => parse(header, '{"at":0,"do":"bridge.frame","frame":{}}')).toThrow(/x.ndjson:2/);
  });
  it('accepts the plugin B steps and action keys', () => {
    const sc = parse(
      '{"v":2,"name":"x","sides":["b"],"keys":{"1":"a","5":{"action":"attention"}},"runtime":false}',
      '{"at":0,"do":"orca.focus","pane":"a"}',
      '{"at":0,"do":"orca.plugin","key":"1am.agent-deck","status":"absent"}',
      '{"at":0,"do":"deck.pi.open","key":1}',
      '{"at":0,"do":"deck.pi.send","key":1,"message":{"type":"load"}}',
      '{"at":0,"do":"deck.restart","profile":"opendeck-mac"}',
      '{"at":0,"do":"expect.pi","key":1,"messages":[{"type":"state"}]}',
    );
    expect(sc.header.keys['5']).toEqual({ action: 'attention' });
    expect(sc.header.runtime).toBe(false);
    expect(parse(header, add, expectKey).header.runtime).toBe(true);
  });
  it('accepts the version and uninstall steps of plugin A', () => {
    const sc = parse(
      header,
      '{"at":0,"do":"orca.command","id":"deck.uninstall","resultContains":"Elgato"}',
      '{"at":0,"do":"expect.log","contains":"update"}',
      '{"at":0,"do":"expect.file","path":".orca-deck","exists":false}',
    );
    expect(sc.steps).toHaveLength(3);
  });
  it('accepts the plugin A steps', () => {
    const sc = parse(
      header,
      '{"at":0,"do":"orca.activate"}',
      '{"at":0,"do":"deck.restart","up":false}',
      '{"at":1,"do":"orca.command","id":"deck.map","args":{},"result":"x"}',
      '{"at":2,"do":"orca.deactivate"}',
      '{"at":3,"do":"bridge.frame","from":"a","frame":{"type":"hello"}}',
    );
    expect(sc.steps.map((s) => s.do)).toEqual([
      'orca.activate',
      'deck.restart',
      'orca.command',
      'orca.deactivate',
      'bridge.frame',
    ]);
  });
  it.each([
    ['no expect step', [header, add], /at least one expect/],
    [
      'an empty expect.key',
      [header, add, '{"at":0,"do":"expect.key","key":1}'],
      /x.ndjson:3: .*at least one field/,
    ],
    [
      'steps out of order',
      [header, '{"at":5,"do":"orca.restart"}', add, expectKey],
      /x.ndjson:3: at 0 is before/,
    ],
    ['an unknown step kind', [header, '{"at":0,"do":"orca.nope"}', expectKey], /x.ndjson:2/],
    ['an unknown field', [header, '{"at":0,"do":"orca.restart","x":1}', expectKey], /x.ndjson:2/],
    [
      'a key outside the deck',
      [header, '{"at":0,"do":"expect.key","key":16,"state":"idle"}'],
      /outside the 5x3 deck/,
    ],
    [
      'an agent state Orca does not have',
      [header, '{"at":0,"do":"orca.agent","pane":"a","state":"needs_input"}', expectKey],
      /x.ndjson:2/,
    ],
    ['a header without sides', ['{"v":2,"name":"x","keys":{}}', expectKey], /x.ndjson:1/],
    ['version 1', ['{"v":1,"name":"x","sides":["sim"],"keys":{}}', expectKey], /x.ndjson:1/],
    [
      'a bridge.frame from neither side',
      [header, '{"at":0,"do":"bridge.frame","from":"c","frame":{}}', expectKey],
      /x.ndjson:2/,
    ],
    [
      'deck.restart with a non-boolean up',
      [header, '{"at":0,"do":"deck.restart","up":"no"}', expectKey],
      /x.ndjson:2/,
    ],
    ['broken JSON', [header, '{nope', expectKey], /x.ndjson:2: not valid JSON/],
  ])('rejects %s', (_n, lines, message) => {
    expect(() => parse(...lines)).toThrow(message);
  });
});

describe('sim runner', () => {
  it('reports a failed expect with the step time, key and field', async () => {
    const r = await replaySim(
      parse(header, add, '{"at":2000,"do":"expect.key","key":1,"state":"working"}'),
    );
    expect(r.failures).toEqual(['t=2000 key 1 state: expected "working", got "completed"']);
  });
  it('refuses an expect field it cannot evaluate instead of passing it', async () => {
    await expect(
      replaySim(parse(header, add, '{"at":0,"do":"expect.key","key":1,"badge":"x"}')),
    ).rejects.toThrow(/cannot evaluate expect.key badge/);
    await expect(
      replaySim(parse(header, add, '{"at":0,"do":"expect.focus","pane":"a"}')),
    ).rejects.toThrow(/cannot evaluate expect.focus/);
  });
  it('counts steps of other runners as skipped', async () => {
    const r = await replaySim(parse(header, add, '{"at":0,"do":"deck.down","key":1}', expectKey));
    expect(r.skippedSteps).toBe(1);
  });
});
