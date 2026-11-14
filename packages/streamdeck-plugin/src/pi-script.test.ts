import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(
  new URL('../pl.1am.orca-agent-deck.sdPlugin/ui/pi.js', import.meta.url),
  'utf8',
);

/** Runs ui/pi.js against a fake socket; returns what `connect` (the app's entry point) makes of replies. */
function inspector(
  uuid: string,
  actionInfo: string | undefined,
  onReply: (m: unknown) => void = () => {},
) {
  const hint = { textContent: '' };
  const logged: string[] = [];
  const sockets: { onmessage?: (e: { data: string }) => void; sent: string[] }[] = [];
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      sockets.push(this);
    }
    send(m: string) {
      this.sent.push(m);
    }
  }
  const win: Record<string, unknown> = {};
  runInNewContext(script, {
    window: win,
    WebSocket,
    setInterval,
    clearInterval,
    document: { getElementById: () => hint },
    console: { log: (m: string) => logged.push(m) },
  });
  const got = vi.fn(onReply);
  (win.connectPi as (t: string, f: (m: unknown) => void) => unknown)('state', got);
  (win.connectElgatoStreamDeckSocket as (...a: unknown[]) => void)(
    1,
    uuid,
    'register',
    '{}',
    actionInfo,
  );
  const reply = (context: string) =>
    sockets[0]!.onmessage!({
      data: JSON.stringify({
        event: 'sendToPropertyInspector',
        payload: { type: 'state', context, panes: [] },
      }),
    });
  const raw = (data: string) => sockets[0]!.onmessage!({ data });
  return { got, reply, raw, hint, logged };
}

describe('Property Inspector script', () => {
  it('takes a reply tagged with its uuid (OpenDeck)', () => {
    const { got, reply } = inspector('ctx-1', undefined);
    reply('ctx-1');
    expect(got).toHaveBeenCalledOnce();
  });

  it('takes a reply tagged with the action context when the app gives the inspector another uuid (Elgato)', () => {
    const { got, reply } = inspector('pi-uuid', JSON.stringify({ action: 'a', context: 'ctx-1' }));
    reply('ctx-1');
    expect(got).toHaveBeenCalledOnce();
  });

  it('drops a reply for another action', () => {
    const { got, reply } = inspector('pi-uuid', JSON.stringify({ context: 'ctx-1' }));
    reply('ctx-2');
    expect(got).not.toHaveBeenCalled();
  });

  it('logs why a frame was dropped', () => {
    const { got, raw, reply, logged } = inspector('pi-uuid', JSON.stringify({ context: 'ctx-1' }));
    raw(JSON.stringify({ event: 'didReceiveSettings' }));
    raw(JSON.stringify({ event: 'sendToPropertyInspector', payload: { type: 'checks' } }));
    reply('ctx-2');
    expect(got).not.toHaveBeenCalled();
    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain('event didReceiveSettings');
    expect(logged[1]).toContain('type checks, want state');
    expect(logged[2]).toContain('context ctx-2, mine pi-uuid | ctx-1');
  });

  it('shows a reply that fails to render in the hint line instead of dropping it silently', () => {
    const { reply, hint, logged } = inspector('ctx-1', undefined, () => {
      throw new Error('boom');
    });
    reply('ctx-1');
    expect(hint.textContent).toBe('Inspector error: boom');
    expect(logged[0]).toContain('reply failed');
  });
});
