import { expect, it } from 'vitest';
import type { PaneInfo } from './adapter.ts';
import { PaneRegistry } from './registry.ts';

const pane = (o: Partial<PaneInfo> & { paneKey: string }): PaneInfo => ({
  hostId: 'local',
  handle: 'h-' + o.paneKey,
  worktreeId: 'w',
  title: 'T',
  connected: true,
  agentType: 'claude',
  worktreePath: '/repo',
  ...o,
});

it('resolves by paneKey and follows rotated handles', () => {
  const r = new PaneRegistry();
  r.update([pane({ paneKey: 'a:b', handle: 'old' })]);
  expect(r.resolve({ paneKey: 'a:b' })?.pane.handle).toBe('old');
  r.update([pane({ paneKey: 'a:b', handle: 'new' })]);
  expect(r.resolve({ paneKey: 'a:b' })).toEqual({
    pane: expect.objectContaining({ handle: 'new' }),
    relinked: false,
  });
});

it('uses recordedPaneKey on orphaned terminals', () => {
  const r = new PaneRegistry();
  r.update([pane({ paneKey: 'x:y', orphaned: true, recordedPaneKey: 'a:b' })]);
  const res = r.resolve({ paneKey: 'a:b' });
  expect(res?.pane.paneKey).toBe('x:y');
  expect(res?.relinked).toBe(false);
});

it('falls back to a unique heuristic match, flagged as relinked', () => {
  const r = new PaneRegistry();
  r.update([pane({ paneKey: 'x:y' })]);
  const res = r.resolve({ paneKey: 'a:b', worktreePath: '/repo', title: 'T', agent: 'claude' });
  expect(res).toEqual({ pane: expect.objectContaining({ paneKey: 'x:y' }), relinked: true });
});

it('does not guess when ambiguous or when the agent differs', () => {
  const r = new PaneRegistry();
  r.update([pane({ paneKey: 'x:1' }), pane({ paneKey: 'x:2' })]);
  expect(r.resolve({ paneKey: 'a:b', worktreePath: '/repo', title: 'T' })).toBeUndefined();
  r.update([pane({ paneKey: 'x:1', agentType: 'pi' })]);
  expect(
    r.resolve({ paneKey: 'a:b', worktreePath: '/repo', title: 'T', agent: 'claude' }),
  ).toBeUndefined();
});

it('does not steal a pane mapped by another slot', () => {
  const r = new PaneRegistry();
  r.update([pane({ paneKey: 'x:y' })]);
  r.mappedElsewhere = new Set(['x:y']);
  expect(r.resolve({ paneKey: 'a:b', worktreePath: '/repo', title: 'T' })).toBeUndefined();
});
