import { beforeEach, describe, expect, it, vi } from 'vitest';

type Host = 'elgato' | 'opendeck' | 'unknown';
type Listener = (ev: { device?: { id: string } }) => void;
type AppearListener = (ev: { action: { device: { id: string } } }) => void;

/** A fresh `devices.ts` (empty "gone" list) in the given host. */
async function load(host: Host) {
  const subscribe = vi.fn<(l: Listener) => void>();
  const subscribeAppear = vi.fn<(l: AppearListener) => void>();
  vi.doMock('@elgato/streamdeck', () => ({
    default: {
      devices: { onDeviceDidDisconnect: subscribe },
      actions: { onWillAppear: subscribeAppear },
    },
  }));
  vi.doMock('./host.ts', () => ({ currentHost: () => ({ host }) }));
  const m = await import('./devices.ts');
  m.watchDevices();
  const emit = (ev: Parameters<Listener>[0]) => subscribe.mock.calls[0]![0](ev);
  const appear = (id: string) => subscribeAppear.mock.calls[0]![0]({ action: { device: { id } } });
  return {
    ...m,
    subscribe,
    subscribeAppear,
    disconnect: (id: string) => emit({ device: { id } }),
    emit,
    appear,
  };
}

// A deck as the SDK lists it: `isConnected` is false for a registration deck until deviceDidConnect; `actions` are
// the actions the host shows on it (willAppear adds, willDisappear removes).
const deck = (id: string, isConnected: boolean, actions: unknown[] = []) => ({
  id,
  isConnected,
  actions,
});

beforeEach(() => vi.resetModules());

describe('isDeckConnected', () => {
  it('elgato: the SDK flag decides (a registration deck without deviceDidConnect is not connected)', async () => {
    const { isDeckConnected } = await load('elgato');
    expect(isDeckConnected(deck('A', false))).toBe(false);
    // An unplugged known deck can still be listed with keys: in the Elgato app it is not connected.
    expect(isDeckConnected(deck('A', false, [{}]))).toBe(false);
    expect(isDeckConnected(deck('A', true))).toBe(true);
  });

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

  it('unknown: a deck counts as connected when the SDK says so or the host shows keys on it', async () => {
    const { isDeckConnected } = await load('unknown');
    expect(isDeckConnected(deck('A', false))).toBe(false);
    expect(isDeckConnected(deck('A', false, [{}]))).toBe(true);
    expect(isDeckConnected(deck('A', true))).toBe(true);
  });

  it('unknown (Fifine Control Deck): registration decks without deviceDidConnect, keys on one of them', async () => {
    const { isDeckConnected } = await load('unknown');
    const decks = [
      deck('D6', false, [{}, {}]),
      deck('D6-Pro', false),
      deck('D6-2', false),
      // The 1x1 virtual device Fifine connects, named after the plugin UUID: connected, none of our keys.
      deck('UUID', true),
    ];
    expect(decks.filter(isDeckConnected).map((d) => d.id)).toEqual(['D6', 'UUID']);
  });

  it('unknown: unplug via willDisappear (keys gone) or deviceDidDisconnect; replug via willAppear or the SDK flag', async () => {
    const { isDeckConnected, disconnect, appear } = await load('unknown');
    // willDisappear only: the SDK drops the keys.
    expect(isDeckConnected(deck('A', false))).toBe(false);
    // deviceDidDisconnect while the keys are still listed.
    disconnect('A');
    expect(isDeckConnected(deck('A', false, [{}]))).toBe(false);
    expect(isDeckConnected(deck('B', false, [{}]))).toBe(true);
    // Replug, the host shows the keys again.
    appear('A');
    expect(isDeckConnected(deck('A', false, [{}]))).toBe(true);
    // Replug with deviceDidConnect.
    disconnect('A');
    expect(isDeckConnected(deck('A', true, [{}]))).toBe(true);
  });

  it('a disconnect for a deck the SDK does not know is ignored', async () => {
    const { isDeckConnected, emit } = await load('opendeck');
    expect(() => emit({})).not.toThrow();
    expect(isDeckConnected(deck('A', false))).toBe(true);
  });

  it('watchDevices subscribes once', async () => {
    const { watchDevices, subscribe, subscribeAppear } = await load('opendeck');
    watchDevices();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribeAppear).toHaveBeenCalledOnce();
  });
});
