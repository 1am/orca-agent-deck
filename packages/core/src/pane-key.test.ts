import { expect, it } from 'vitest';
import { paneKey, splitPaneKey } from './pane-key.ts';

it('joins and splits a pane key without changing it', () => {
  expect(paneKey('tab1', 'leaf1')).toBe('tab1:leaf1');
  expect(splitPaneKey('tab1:leaf1')).toEqual({ tabId: 'tab1', leafId: 'leaf1' });
});

it('gives empty parts for a malformed key and ignores extra segments', () => {
  expect(splitPaneKey('tab1')).toEqual({ tabId: 'tab1', leafId: '' });
  expect(splitPaneKey('')).toEqual({ tabId: '', leafId: '' });
  expect(splitPaneKey('a:b:c')).toEqual({ tabId: 'a', leafId: 'b' });
});
