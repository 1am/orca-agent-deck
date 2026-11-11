import { expect, it } from 'vitest';
import {
  harnessLabel,
  layoutLabel,
  renderInfoKey,
  renderKey,
  textWidth,
  type KeyModel,
} from './render.ts';
import type { DeckState } from './status.ts';

const STATES: DeckState[] = [
  'unmapped',
  'offline',
  'unreachable',
  'idle',
  'working',
  'needs_input',
  'awaiting_reply',
  'completed',
  'error',
  'cancelled',
];

it('renders every state at both sizes with its label', () => {
  for (const state of STATES) {
    const m: KeyModel = { state, label: 'main', line2: state.slice(0, 8) };
    for (const size of [72, 144] as const) {
      const svg = renderKey(m, { size });
      expect(svg).toContain(`width="${size}"`);
      expect(svg).toContain('viewBox="0 0 144 144"');
      expect(svg).toContain('>main<');
    }
  }
});

it('uses a different icon shape per attention state, not only colour', () => {
  const icon = (state: DeckState) => renderKey({ state, label: 'x', line2: 'y' }).split('<g ')[1];
  const shapes = new Set(
    ['needs_input', 'awaiting_reply', 'completed', 'error', 'working'].map((s) =>
      icon(s as DeckState),
    ),
  );
  expect(shapes.size).toBe(5);
});

it('awaiting_reply has its own colour, distinct from needs_input, in both palettes', () => {
  const bg = (state: DeckState, highContrast = false) =>
    /<rect[^>]*fill="(#[0-9a-f]{6})"/i.exec(
      renderKey({ state, label: 'x', line2: 'asks you' }, { highContrast }),
    )?.[1];
  expect(bg('awaiting_reply')).toBeDefined();
  expect(bg('awaiting_reply')).not.toBe(bg('needs_input'));
  expect(bg('awaiting_reply', true)).not.toBe(bg('needs_input', true));
});

it('escapes label text', () => {
  expect(renderKey({ state: 'idle', label: '<b>&"', line2: '' })).toContain('&lt;b&gt;&amp;&quot;');
});

it('picks the biggest font that fits: 20 for short names, down to 12 for long ones', () => {
  expect(layoutLabel('main')).toEqual({ lines: ['main'], size: 20 });
  const mid = layoutLabel('agent-deck/feature/very-long-branch-name');
  expect(mid.lines.join('')).toBe('agent-deck/feature/very-long-branch-name');
  expect(mid.size).toBeLessThan(20);
  expect(mid.size).toBeGreaterThanOrEqual(10);
  expect(layoutLabel('ab '.repeat(40)).size).toBeLessThan(layoutLabel('ab '.repeat(5)).size);
});

it('cuts labels at 128 characters and ellipsises what does not fit', () => {
  const l = layoutLabel('word '.repeat(100));
  expect(l.size).toBe(12);
  expect(l.lines.join(' ').length).toBeLessThanOrEqual(128);
  expect(l.lines.at(-1)?.endsWith('…')).toBe(true);
  expect(renderKey({ state: 'idle', label: 'y'.repeat(300), line2: '' })).not.toContain(
    'y'.repeat(129),
  );
});

it('shows agent and host badges, link-broken marker; only the working icon spins', () => {
  const m: KeyModel = {
    state: 'working',
    label: 'a',
    line2: 'b',
    agent: 'claude',
    host: 'devbox',
    stale: true,
  };
  const svg = renderKey(m, { spin: 0 });
  expect(svg).toContain('M12 5v14');
  expect(renderKey({ ...m, agent: 'pi' })).toContain('M6.5 8.5h11');
  expect(renderKey({ ...m, agent: null })).toContain('M10 6.5l-1.2 11');
  expect(renderKey({ ...m, agent: 'kimi' })).toContain('>K</text>');
  expect(renderKey({ ...m, agent: null, state: 'unmapped' })).not.toContain('stroke-width="2.2"');
  expect(svg).toContain('devbox');
  expect(renderKey(m, { spin: 1 })).toContain('rotate(45 20 20)');
  expect(renderKey(m, { spin: 8 })).toBe(renderKey(m, { spin: 0 }));
  expect(renderKey({ ...m, state: 'completed' }, { spin: 1 })).toBe(
    renderKey({ ...m, state: 'completed' }, { spin: 0 }),
  );
});

it('draws a distinct pictogram per known agent and two letters where first letters clash', () => {
  const m: KeyModel = { state: 'idle', label: 'a', line2: 'b' };
  const glyphs = ['opencode', 'droid', 'devin', 'gemini', 'copilot', 'cursor', 'amp'].map(
    (agent) => {
      const svg = renderKey({ ...m, agent });
      expect(svg).not.toContain('text-anchor="middle"');
      return svg;
    },
  );
  expect(new Set(glyphs).size).toBe(glyphs.length);
  expect(harnessLabel('cline')).toBe('Cl');
  expect(harnessLabel('crush')).toBe('Cr');
  expect(harnessLabel('kimi')).toBe('K');
  expect(harnessLabel('mystery')).toBe('M');
  expect(renderKey({ ...m, agent: 'cline' })).toContain('>Cl</text>');
  expect(renderKey({ ...m, agent: 'crush' })).toContain('>Cr</text>');
});

it('asks for a metric-compatible font before DejaVu Sans', () => {
  const stack = 'font-family="Helvetica, Arial, Liberation Sans, DejaVu Sans, sans-serif"';
  expect(renderKey({ state: 'idle', label: 'a', line2: 'b' })).toContain(stack);
  expect(renderInfoKey({ tone: 'idle', value: '1', caption: 'a' })).toContain(stack);
});

it('high-contrast theme changes the palette', () => {
  const m: KeyModel = { state: 'needs_input', label: 'a', line2: 'b' };
  expect(renderKey(m, { highContrast: true })).not.toBe(renderKey(m));
});

it('keeps every line, including a trailing ellipsis, inside the name box', () => {
  const samples = [
    'he gap came from where the first line of text was placed. Its baseline was a fixed distance down',
    'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm WWWWWWWWWWWWWW',
    'word '.repeat(100),
    'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii',
  ];
  for (const s of samples) {
    const { lines, size } = layoutLabel(s);
    for (const l of lines) expect(textWidth(l, size)).toBeLessThanOrEqual(110.5);
  }
});

it('status and attention info keys', async () => {
  const { statusInfo, attentionInfo, renderInfoKey } = await import('./render.ts');
  expect(
    statusInfo({ mode: 'down', version: null, unsupported: false, hostsDown: 0 }).caption,
  ).toBe('Orca not running');
  expect(
    statusInfo({ mode: 'degraded', version: '1.4.0', unsupported: false, hostsDown: 0 }).caption,
  ).toBe('slow updates 1.4.0');
  expect(attentionInfo(3, 'error')).toMatchObject({ tone: 'error', value: '3', caption: 'errors' });
  expect(attentionInfo(3, 'needs_input', 2).caption).toBe('need you +2');
  expect(renderInfoKey(attentionInfo(0, null))).toContain('all calm');
});

it('draws the focused pane light, with a state-coloured frame and a bold label', () => {
  for (const state of STATES) {
    const m: KeyModel = { state, label: 'main', line2: '' };
    const plain = renderKey(m);
    const framed = renderKey({ ...m, focused: true });
    const bg = (svg: string) => /<rect width="144" height="144" fill="([^"]+)"/.exec(svg)?.[1];
    const fg = (svg: string) => /color="([^"]+)"/.exec(svg)?.[1];
    expect(bg(framed)).toBe('#f4f4f4');
    expect(fg(framed)).toBe(fg(plain));
    expect(framed).toContain(`stroke="${bg(plain)}" stroke-width="10"`);
    expect(plain).not.toContain('data-focus');
    expect(framed).toContain('data-focus');
    expect(framed).toContain('font-weight="700"');
    expect(plain).not.toContain('font-weight="700"');
  }
});

it('draws the host badge for a remote pane, ellipsized to 7 characters', () => {
  const svg = renderKey({ state: 'working', label: 'x', line2: '', host: 'build-server-01' });
  expect(svg).toContain('>build-…</text>');
  expect(renderKey({ state: 'working', label: 'x', line2: '' })).not.toContain('text-anchor="end"');
});

it('pairing mode draws the key number large and the label as one short line', () => {
  const svg = renderKey({
    state: 'unmapped',
    label: 'Assign here: feature-login > claude',
    line2: '',
    bigNumber: '5',
    keyNumber: '5',
  });
  expect(svg).toContain('font-size="72"');
  expect(svg).toContain('>5</text>');
  expect(svg).not.toContain('5: Assign');
});
