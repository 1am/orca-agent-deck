import { expect, it, vi } from 'vitest';
import { PluginInstallProbe, pluginAInstalled } from './installed.ts';

const list = (plugins: unknown[]) => JSON.stringify({ ok: true, result: { plugins } });

it('detects an installed plugin A, running or idle', () => {
  expect(pluginAInstalled(list([{ pluginKey: '1am.agent-deck', status: 'running' }]))).toBe(true);
  expect(pluginAInstalled(list([{ pluginKey: '1am.agent-deck', status: 'idle' }]))).toBe(true);
});

it('is false when absent, disabled or the output is garbage', () => {
  expect(pluginAInstalled(list([{ pluginKey: 'other.x', status: 'running' }]))).toBe(false);
  expect(pluginAInstalled(list([{ pluginKey: '1am.agent-deck', status: 'disabled' }]))).toBe(false);
  expect(pluginAInstalled('nope')).toBe(false);
});

const present = list([{ pluginKey: '1am.agent-deck', status: 'idle' }]);

it('probe: unanswered is null, not "not installed"', async () => {
  const probe = new PluginInstallProbe(() => new Promise(() => {}));
  void probe.refresh();
  expect(probe.installed).toBeNull();
});

it('probe: a failing exec stays unknown', async () => {
  const probe = new PluginInstallProbe(() => Promise.reject(new Error('no orca')));
  await probe.refresh();
  expect(probe.installed).toBeNull();
});

it('probe: caches for the TTL, a forced refresh bypasses it', async () => {
  let t = 0;
  const exec = vi.fn().mockResolvedValueOnce(list([])).mockResolvedValue(present);
  const probe = new PluginInstallProbe(exec, () => t);
  await probe.refresh();
  expect(probe.installed).toBe(false);
  t = 30_000;
  await probe.refresh();
  expect(exec).toHaveBeenCalledTimes(1);
  await probe.refresh(true);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(probe.installed).toBe(true);
  t = 100_000;
  await probe.refresh();
  expect(exec).toHaveBeenCalledTimes(3);
});

it('probe: concurrent refreshes share one exec', async () => {
  const exec = vi.fn().mockResolvedValue(present);
  const probe = new PluginInstallProbe(exec, () => 0);
  await Promise.all([probe.refresh(true), probe.refresh(true)]);
  expect(exec).toHaveBeenCalledTimes(1);
});
