import { describe, expect, it, vi } from 'vitest';

vi.mock('@elgato/streamdeck', () => ({
  default: { ui: {}, logger: { info: vi.fn() }, devices: [] },
  action: () => (target: unknown) => target,
  SingletonAction: class {},
}));

const { PaneSlot } = await import('./pane-slot.ts');

describe('deck gestures that change the Orca panel bring Orca to the front', () => {
  const make = (picker: { selecting: boolean; pick: boolean; open: boolean | 'hidden' }) => {
    const c = { press: vi.fn(async () => 'focused'), slotHost: () => null, refresh: vi.fn() };
    const raise = vi.fn(async () => {});
    const slot = new PaneSlot(
      async () => c as never,
      {
        selecting: () => picker.selecting,
        pick: () => picker.pick,
        open: async () => picker.open,
      },
      raise,
    );
    vi.spyOn(slot, 'keyOfSlot').mockReturnValue(3);
    const tap = async () => {
      const a = { action: { id: 'slot-1', showAlert: vi.fn() } } as never;
      slot.onKeyDown(a);
      await slot.onKeyUp(a);
    };
    return { c, raise, slot, tap };
  };

  it('a tap that selects a key in the panel raises Orca once and focuses nothing', async () => {
    const { c, raise, tap } = make({ selecting: true, pick: true, open: false });
    await tap();
    expect(raise).toHaveBeenCalledOnce();
    expect(c.press).not.toHaveBeenCalled();
  });

  it('a hold that opens the panel raises Orca once', async () => {
    const { raise, slot } = make({ selecting: false, pick: false, open: true });
    await (slot as never as { onHold(s: string): Promise<void> }).onHold('slot-1');
    expect(raise).toHaveBeenCalledOnce();
  });

  it('a hold that hid the sidebar (panel already in view) does not raise Orca', async () => {
    const { raise, slot } = make({ selecting: false, pick: false, open: 'hidden' });
    await (slot as never as { onHold(s: string): Promise<void> }).onHold('slot-1');
    expect(raise).not.toHaveBeenCalled();
  });

  it('a hold that could not open the panel does not raise', async () => {
    const { raise, slot } = make({ selecting: false, pick: false, open: false });
    await (slot as never as { onHold(s: string): Promise<void> }).onHold('slot-1');
    expect(raise).not.toHaveBeenCalled();
  });

  it('a plain focus press is left to the controller (it raises itself)', async () => {
    const { c, raise, tap } = make({ selecting: false, pick: false, open: false });
    await tap();
    expect(c.press).toHaveBeenCalledOnce();
    expect(raise).not.toHaveBeenCalled();
  });
});
