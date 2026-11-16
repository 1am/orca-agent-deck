import { beforeEach, describe, expect, it, vi } from 'vitest';

type Host = 'elgato' | 'opendeck' | 'unknown';
type FakeAction = {
  id: string;
  device: { id: string };
  isKey: () => boolean;
  coordinates?: unknown;
};

/** Just enough of the SDK's Enumerable for PaneSlot. */
class List<T> {
  private readonly items: T[];
  constructor(items: T[]) {
    this.items = items;
  }
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
  filter(p: (x: T) => boolean) {
    return new List(this.items.filter(p));
  }
  some(p: (x: T) => boolean) {
    return this.items.some(p);
  }
  find(p: (x: T) => boolean) {
    return this.items.find(p);
  }
  toArray() {
    return [...this.items];
  }
}

const key = (id: string, device: string): FakeAction => ({
  id,
  device: { id: device },
  isKey: () => true,
});

/** Fifine Control Deck as seen on a user's machine: three registration decks, none sent deviceDidConnect. */
function fifine(keysOn: string | null) {
  const ours = keysOn ? [key('k1', keysOn), key('k2', keysOn)] : [];
  const dev = (id: string, isConnected: boolean, columns: number, rows: number, type: number) => ({
    id,
    isConnected,
    type,
    size: { columns, rows },
    actions: new List(ours.filter((a) => a.device.id === id)),
  });
  return {
    actions: ours,
    devices: [
      dev('D6', false, 3, 2, 7),
      dev('D6-Pro', false, 3, 2, 7),
      dev('D6-5x3', false, 5, 3, 0),
      // The virtual 1x1 device named after the plugin UUID: connected, none of our keys.
      dev('pl.uuid', true, 1, 1, 0),
    ],
  };
}

async function deckState(host: Host, setup: ReturnType<typeof fifine>) {
  vi.doMock('@elgato/streamdeck', () => ({
    default: { ui: {}, logger: { info: vi.fn() }, devices: setup.devices },
    action: () => (target: unknown) => target,
    SingletonAction: class {},
  }));
  vi.doMock('../host.ts', () => ({ currentHost: () => ({ host }) }));
  const { PaneSlot } = await import('./pane-slot.ts');
  const slot = new PaneSlot(async () => ({}) as never);
  Object.defineProperty(slot, 'actions', { value: new List(setup.actions) });
  return slot.deckState();
}

beforeEach(() => vi.resetModules());

// The first import of pane-slot.ts (and core) is slow on a cold runner.
describe('the deck the Orca panel shows', { timeout: 20_000 }, () => {
  it('unknown host (Fifine): the registration deck with our keys, not the virtual 1x1 device', async () => {
    const s = await deckState('unknown', fifine('D6'));
    expect(s).toMatchObject({ connected: true, cols: 3, rows: 2 });
  });

  it('unknown host (Fifine): no deck with our keys is not connected', async () => {
    const s = await deckState('unknown', fifine(null));
    expect(s).toMatchObject({ connected: false, model: null, cols: 0, rows: 0 });
  });

  it('elgato: a deck the SDK marks not connected is not shown, even with keys on it', async () => {
    const s = await deckState('elgato', fifine('D6'));
    expect(s.connected).toBe(false);
  });
});
