import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  action: undefined as { id: string } | undefined,
  sendToPropertyInspector: vi.fn<(payload: unknown) => Promise<void>>(async () => {}),
}));

const direct = vi.hoisted(() =>
  vi.fn<(context: string, payload: object) => Promise<void>>(async () => {}),
);
vi.mock('./pi-send.ts', () => ({ sendToInspectorOf: direct }));

vi.mock('@elgato/streamdeck', () => ({
  default: { ui, logger: { info: vi.fn() } },
  action: () => (target: unknown) => target,
  SingletonAction: class {},
}));

const { PaneSlot } = await import('./pane-slot.ts');
const { StatusKey } = await import('./status.ts');

const ev = (id: string, payload: unknown) => ({ action: { id }, payload }) as never;

describe('Property Inspector routing (OpenDeck mounts a hidden PI per action)', () => {
  beforeEach(() => {
    ui.sendToPropertyInspector.mockClear();
    direct.mockClear();
    ui.action = { id: 'A' };
  });

  describe('pane slot', () => {
    const make = () => {
      const c = {
        configure: vi.fn(),
        clear: vi.fn(),
        listPanes: () => [],
        slotConfig: (id: string) => ({ id }),
        refresh: vi.fn(async () => new Map()),
      };
      return { c, slot: new PaneSlot(async () => c as never) };
    };

    it('the current PI gets its own state, tagged with its context', async () => {
      const { slot } = make();
      await slot.onSendToPlugin(ev('A', { type: 'load' }));
      expect(ui.sendToPropertyInspector).toHaveBeenCalledOnce();
      expect(ui.sendToPropertyInspector).toHaveBeenCalledWith({
        type: 'state',
        panes: [],
        config: { id: 'A' },
        context: 'A',
      });
    });

    it('`load` from a hidden PI sends nothing to the open one', async () => {
      const { slot } = make();
      await slot.onSendToPlugin(ev('B', { type: 'load' }));
      expect(ui.sendToPropertyInspector).not.toHaveBeenCalled();
    });

    it('`configure` and `clear` from a hidden PI change only its own action', async () => {
      const { c, slot } = make();
      await slot.onSendToPlugin(ev('B', { type: 'configure', paneKey: 'p1' }));
      await slot.onSendToPlugin(ev('B', { type: 'clear' }));
      expect(c.configure).toHaveBeenCalledTimes(1);
      expect(c.configure).toHaveBeenCalledWith('B', { paneKey: 'p1' });
      expect(c.clear).toHaveBeenCalledTimes(1);
      expect(c.clear).toHaveBeenCalledWith('B');
      expect(ui.sendToPropertyInspector).not.toHaveBeenCalled();
    });

    it('no PI announced (plugin restarted): `load` is answered to the asking inspector only', async () => {
      ui.action = undefined;
      const { slot } = make();
      await slot.onSendToPlugin(ev('A', { type: 'load' }));
      expect(ui.sendToPropertyInspector).not.toHaveBeenCalled();
      expect(direct).toHaveBeenCalledOnce();
      expect(direct).toHaveBeenCalledWith(
        'A',
        expect.objectContaining({ type: 'state', context: 'A' }),
      );
    });

    it('another inspector being current never gets the direct path', async () => {
      const { slot } = make();
      await slot.onSendToPlugin(ev('B', { type: 'load' }));
      expect(direct).not.toHaveBeenCalled();
    });
  });

  describe('status key', () => {
    const make = () => {
      const c = { refresh: vi.fn(async () => {}) };
      return { c, key: new StatusKey(async () => c as never) };
    };

    it('`load` from a hidden PI neither replies nor refreshes', async () => {
      const { c, key } = make();
      await key.onSendToPlugin(ev('B', { type: 'load' }));
      expect(ui.sendToPropertyInspector).not.toHaveBeenCalled();
      expect(c.refresh).not.toHaveBeenCalled();
      expect(direct).not.toHaveBeenCalled();
    });
  });
});
