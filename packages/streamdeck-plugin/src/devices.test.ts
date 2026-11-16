import { beforeEach, describe, expect, it, vi } from 'vitest';

type Host = 'elgato' | 'opendeck' | 'unknown';
type Listener = (ev: { device?: { id: string } }) => void;

/** A fresh `devices.ts` (empty "gone" list) in the given host. */
async function load(host: Host) {
  const subscribe = vi.fn<(l: Listener) => void>();
  vi.doMock('@elgato/streamdeck', () => ({
    default: { devices: { onDeviceDidDisconnect: subscribe } },
  }));
  vi.doMock('./host.ts', () => ({ currentHost: () => ({ host }) }));
  const m = await import('./devices.ts');
  m.watchDevices();
  const emit = (ev: Parameters<Listener>[0]) => subscribe.mock.calls[0]![0](ev);
  return { ...m, subscribe, disconnect: (id: string) => emit({ device: { id } }), emit };
}

// A deck as the SDK lists it: `isConnected` is false for a registration deck until deviceDidConnect.
const deck = (id: string, isConnected: boolean) => ({ id, isConnected });

beforeEach(() => vi.resetModules());

describe('isDeckConnected', () => {
  it.each(['elgato', 'unknown'] as const)(
    '%s: the SDK flag decides (a registration deck without deviceDidConnect is not connected)',
    async (host) => {
      const { isDeckConnected } = await load(host);
      expect(isDeckConnected(deck('A', false))).toBe(false);
      expect(isDeckConnected(deck('A', true))).toBe(true);
    },
  );

  it('opendeck: a registration deck counts as connected without deviceDidConnect', async () => {
    const { isDeckConnected } = await load('opendeck');
    expect(isDeckConnected(deck('A', false))).toBe(true);
    expect(isDeckConnected(deck('B', false))).toBe(true);
  });

  it('opendeck: deviceDidDisconnect ends it for that deck only; replug (SDK flag) brings it back', async () => {
    const { isDeckConnected, disconnect } = await load('opendeck');
    disconnect('A');
    expect(isDeckConnected(deck('A', false))).toBe(false);
    expect(isDeckConnected(deck('B', false))).toBe(true);
    // deviceDidConnect: the SDK flag is true.
    expect(isDeckConnected(deck('A', true))).toBe(true);
    // Unplugged again: the SDK flag is false and the deck stays gone.
    expect(isDeckConnected(deck('A', false))).toBe(false);
  });

  it('a disconnect for a deck the SDK does not know is ignored', async () => {
    const { isDeckConnected, emit } = await load('opendeck');
    expect(() => emit({})).not.toThrow();
    expect(isDeckConnected(deck('A', false))).toBe(true);
  });

  it('watchDevices subscribes once', async () => {
    const { watchDevices, subscribe } = await load('opendeck');
    watchDevices();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
