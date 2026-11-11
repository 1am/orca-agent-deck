import type { DeckState } from './status.ts';
import { naturalMode, orcaIconArt, type IconMode } from './agent-icon-art.ts';
import { ORCA_ICONS } from './agent-icons.generated.ts';

/** Everything the key renderer needs; produced by DeckController. */
export interface KeyModel {
  state: DeckState;
  /** Last known state shown with a link-broken badge. */
  stale?: boolean;
  label: string;
  line2: string;
  /** claude | codex | pi | other agent name. */
  agent?: string | null;
  /** Short host name for remote panes (top-right badge). */
  host?: string | null;
  /** Formatted key number (see formatKeyNumber), prefixed to the label as `5: title`. */
  keyNumber?: string | null;
  /** Pairing mode: the key number drawn large, with the label as one small line below. */
  bigNumber?: string | null;
  /** The pane Orca has selected right now: colours inverted, with a frame and a bold label. */
  focused?: boolean;
}

/** Positions of the working arc per turn. */
export const SPIN_STEPS = 8;

/** Spinning keys up to which the spinner advances on every 250 ms repaint tick (4 fps). */
const FULL_RATE_KEYS = 2;

/**
 * Does the spinner advance on this repaint tick (250 ms apart)? Elgato asks plugins to keep to
 * about 10 image updates per second (https://docs.elgato.com/guidelines/streamdeck/plugins/images-and-layouts),
 * which reads as a total, not per key. Up to 2 spinning keys turn at 4 fps (8 updates per second,
 * inside the guideline). With more, every other tick advances (2 fps): that is above the guideline
 * from 6 keys on (a full 32-key deck sends 64 per second) but no more than the quarter turn every
 * 500 ms the spinner made before, which hardware and Stream Deck Mobile have carried.
 */
export function spinnerAdvances(tick: number, workingCount: number): boolean {
  return workingCount <= FULL_RATE_KEYS || tick % 2 === 0;
}

export interface RenderOptions {
  /** Output size in px; the drawing is always 144 units wide so it stays crisp at 72 and 144. */
  size?: 72 | 144;
  highContrast?: boolean;
  /**
   * Spinner rotation in eighth turns (taken modulo `SPIN_STEPS`), advanced by the caller for
   * 'working' keys at the pace `spinnerAdvances` allows.
   */
  spin?: number;
}

/** Colour-blind-safe default palette (blue / amber / green / red differ in lightness and icon shape). */
const PALETTE: Record<DeckState, { bg: string; fg: string }> = {
  unmapped: { bg: '#2b2b2b', fg: '#9a9a9a' },
  offline: { bg: '#4a4a4a', fg: '#d0d0d0' },
  unreachable: { bg: '#4a4a4a', fg: '#d0d0d0' },
  idle: { bg: '#9aa3b0', fg: '#12161c' },
  working: { bg: '#7fb0ff', fg: '#0b1f3a' },
  needs_input: { bg: '#ffd166', fg: '#2b1d00' },
  awaiting_reply: { bg: '#ffa64d', fg: '#2e1500' },
  completed: { bg: '#86e3a6', fg: '#0a2e1a' },
  error: { bg: '#ff9a9a', fg: '#3a0a0a' },
  cancelled: { bg: '#bdb6dc', fg: '#1e1a33' },
};

const FOCUS_BG = '#f4f4f4';

const HIGH_CONTRAST: Partial<Record<DeckState, { bg: string; fg: string }>> = {
  idle: { bg: '#000000', fg: '#ffffff' },
  working: { bg: '#0000cc', fg: '#ffffff' },
  needs_input: { bg: '#ffd400', fg: '#000000' },
  awaiting_reply: { bg: '#ff8c00', fg: '#000000' },
  completed: { bg: '#006400', fg: '#ffffff' },
  error: { bg: '#cc0000', fg: '#ffffff' },
};

/** State icons on a 40 x 40 grid, drawn in the foreground colour (shape differs per state). */
const ICONS: Record<DeckState, string> = {
  unmapped:
    '<circle cx="20" cy="20" r="12" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="4 5"/>',
  offline: '<path d="M8 8 L32 32 M32 8 L8 32" stroke="currentColor" stroke-width="4" fill="none"/>',
  unreachable:
    '<path d="M8 8 L32 32 M32 8 L8 32" stroke="currentColor" stroke-width="4" fill="none"/>',
  idle: '<circle cx="20" cy="20" r="9" fill="currentColor"/>',
  working: '<path d="M20 5 A15 15 0 1 1 5 20" stroke="currentColor" stroke-width="5" fill="none"/>',
  needs_input:
    '<path d="M20 4 L37 34 L3 34 Z" fill="currentColor"/><path d="M20 14 V25 M20 29 V31" stroke="var(--bg)" stroke-width="4" fill="none"/>',
  awaiting_reply:
    '<path d="M4 6 H36 V28 H22 L12 37 V28 H4 Z" fill="currentColor"/><path d="M16 13 Q16 9 20 9 Q24 9 24 13 Q24 16 20 18 V20 M20 24 V26" stroke="var(--bg)" stroke-width="3" fill="none"/>',
  completed: '<path d="M6 21 L16 31 L34 9" stroke="currentColor" stroke-width="6" fill="none"/>',
  error:
    '<path d="M13 3 H27 L37 13 V27 L27 37 H13 L3 27 V13 Z" fill="currentColor"/><path d="M13 13 L27 27 M27 13 L13 27" stroke="var(--bg)" stroke-width="4" fill="none"/>',
  cancelled: '<rect x="9" y="9" width="22" height="22" rx="3" fill="currentColor"/>',
};

/**
 * Harness pictograms on a 24x24 grid, drawn as strokes in the badge's background colour.
 * Simplified original glyphs (no vendor artwork): spark for Claude Code, prompt for Codex,
 * pi for Pi, "#" for a plain shell, a split window for tmux without a detected agent. Agents
 * without a glyph show their first letter (see `harnessLabel`).
 */
const PICTOGRAM: Record<string, string> = {
  claude: '<path d="M12 5v14M5 12h14M7.1 7.1l9.8 9.8M16.9 7.1l-9.8 9.8"/>',
  codex: '<path d="M7 8.5l4.5 3.5L7 15.5M13 16h4.5"/>',
  pi: '<path d="M6.5 8.5h11M10 8.5l-.8 8.5M14.5 8.5v6.8q0 1.7 2 1.7"/>',
  shell: '<path d="M10 6.5l-1.2 11M15.2 6.5L14 17.5M6.5 10h11M6 14h11"/>',
  tmux: '<path d="M5 6.5h14v11H5zM12 6.5v11M12 12h7"/>',
  opencode: '<path d="M9.5 8L5.5 12l4 4M14.5 8l4 4-4 4"/>',
  droid: '<path d="M6.5 9.5h11v8h-11zM12 9.5v-3.5M9.5 13v1M14.5 13v1"/>',
  devin: '<path d="M12 5.5l5.5 3.2v6.6L12 18.5l-5.5-3.2V8.7zM12 12h.01"/>',
  gemini: '<path d="M12 5q1 5.5 7 7-6 1.5-7 7-1-5.5-7-7 6-1.5 7-7z"/>',
  copilot:
    '<path d="M4.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M12.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M11.5 12h1"/>',
  cursor: '<path d="M7.5 5.5l10 7-4.5 1-2 4.5z"/>',
  amp: '<path d="M13 5l-5 8h4l-1 6 5-8h-4z"/>',
};

/**
 * Per agent, how its badge is drawn when Orca has an icon for it (checked by eye in the render gallery at 72 and 144
 * px): `own` keeps our pictogram, `mask` tints Orca's icon with the key's colour, `chip` shows it as it is on the badge
 * disc. An agent not listed gets the natural mode (`naturalMode`).
 */
export const ICON_OVERRIDES: Readonly<Record<string, 'own' | IconMode>> = {
  // Round or filled logos on a transparent background: tinted they would be a plain disc.
  goose: 'chip',
  openclaude: 'chip',
  openclaw: 'chip',
  'qwen-code': 'chip',
};

/** Agent types Orca reports that have no pictogram, so a first letter is ambiguous between them. */
const LETTER_AGENTS = ['kimi', 'cline', 'qwen', 'goose', 'crush', 'aider'];

/** Letters for the badge of an agent without a pictogram (`kind` lower-case): two when another such agent starts alike. */
export function harnessLabel(kind: string): string {
  const first = kind.slice(0, 1).toUpperCase();
  const clash = LETTER_AGENTS.some(
    (a) => a !== kind && a.startsWith(kind.slice(0, 1).toLowerCase()),
  );
  return clash && kind.length > 1 ? first + kind.slice(1, 2).toLowerCase() : first;
}

/**
 * Liberation Sans has Arial's metrics, so a Linux host that has it (or Windows with Arial) lays
 * text out as `textWidth` expects; DejaVu Sans (often fontconfig's pick) is about 10% wider.
 */
const FONT_STACK = 'Helvetica, Arial, Liberation Sans, DejaVu Sans, sans-serif';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const ellipsis = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Approximate glyph width in em for a medium-weight sans font (Helvetica/Arial class). */
function glyphWidth(c: string): number {
  if (c === 'm' || c === 'M') return 0.86;
  if (c === 'W') return 0.98;
  if (c === 'w') return 0.74;
  if ('il.,\'":;!|`'.includes(c)) return 0.3;
  if (c === ' ') return 0.28;
  if ('tfrIj()[]{}/\\-'.includes(c)) return 0.36;
  if (c === '…') return 1;
  if (c >= 'A' && c <= 'Z') return 0.68;
  if (c >= '0' && c <= '9') return 0.56;
  return 0.54;
}

export const textWidth = (s: string, size: number): number =>
  [...s].reduce((w, c) => w + glyphWidth(c), 0) * size;

const TOKEN = /[^\s/_.-]+[/_.-]?|\s+/g;

/** Greedy wrap at separators (space, / - _ .) into lines no wider than `width`; long words are hard-broken. */
function wrap(text: string, size: number, width: number): string[] {
  const fits = (s: string) => textWidth(s, size) <= width;
  const lines: string[] = [];
  let cur = '';
  for (const part of text.match(TOKEN) ?? [text]) {
    let w = part.trim() === '' ? ' ' : part;
    if (cur === '' && w === ' ') continue;
    while (!fits(w)) {
      if (cur) {
        lines.push(cur.trimEnd());
        cur = '';
      }
      let n = w.length - 1;
      while (n > 1 && !fits(w.slice(0, n))) n--;
      lines.push(w.slice(0, n));
      w = w.slice(n);
    }
    if (!fits(cur + w)) {
      lines.push(cur.trimEnd());
      cur = w === ' ' ? '' : w;
    } else cur += w;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/** Cuts a line until it plus an ellipsis fits `width`. */
function truncate(line: string, size: number, width: number): string {
  let l = line.trimEnd();
  while (l.length > 0 && textWidth(`${l}…`, size) > width) l = l.slice(0, -1).trimEnd();
  return `${l}…`;
}

/** Name box: below the top line, 10% bottom margin; everything must stay inside. */
const BOX = { top: 56, bottom: 130, width: 110 };
/** Line height factor and cap height factor: the first line's cap top always sits at BOX.top. */
const LINE = 1.15;
const CAP = 0.72;

const longestWord = (t: string, size: number) =>
  Math.max(0, ...(t.match(TOKEN) ?? []).map((w) => textWidth(w.trim(), size)));

/** Label font range: 12 is the smallest readable size, 20 the largest used for short names. */
const MIN_SIZE = 12;
const MAX_SIZE = 20;
/** Longer labels are cut here and end in an ellipsis. */
const MAX_LABEL_CHARS = 128;

/** Picks the largest font size (20..12) whose wrapped label fits the name box. */
export function layoutLabel(label: string): { lines: string[]; size: number } {
  const text = ellipsis(label.trim(), MAX_LABEL_CHARS);
  const fit = (size: number) => ({
    lines: wrap(text, size, BOX.width),
    max: Math.floor((BOX.bottom - BOX.top - size * 0.95) / (size * LINE)) + 1,
  });
  for (let size = MAX_SIZE; size > MIN_SIZE; size--) {
    const { lines, max } = fit(size);
    // Prefer a smaller font over breaking a word in the middle.
    if (lines.length <= max && longestWord(text, size) <= BOX.width) return { lines, size };
  }
  const { lines, max } = fit(MIN_SIZE);
  if (lines.length <= max) return { lines, size: MIN_SIZE };
  const cut = lines.slice(0, max);
  cut[max - 1] = truncate(`${cut[max - 1] ?? ''} ${lines[max] ?? ''}`, MIN_SIZE, BOX.width);
  return { lines: cut, size: MIN_SIZE };
}

/** Margins: 10% left/right, 15% top/bottom of the 144-unit key. */
const MX = 14;
const MY = 22;
const RIGHT = 144 - MX;

export function renderKey(m: KeyModel, o: RenderOptions = {}): string {
  const size = o.size ?? 144;
  const base = (o.highContrast && HIGH_CONTRAST[m.state]) || PALETTE[m.state];
  // The focused key goes light (never the near-black text colour of the state palette): it stands out
  // from every other key at a glance and keeps its state colour in the frame.
  const pal = m.focused ? { bg: FOCUS_BG, fg: base.fg } : base;
  const { lines, size: fs } = layoutLabel(m.keyNumber ? `${m.keyNumber}: ${m.label}` : m.label);
  // Pairing mode: a big number to find the key by, the label as one short line under it.
  const big = m.bigNumber
    ? `<text x="72" y="100" font-size="${m.bigNumber.length > 2 ? 56 : 72}" font-weight="700" text-anchor="middle">${esc(m.bigNumber)}</text>` +
      `<text x="72" y="130" font-size="14" text-anchor="middle">${esc(ellipsis(m.label, 14))}</text>`
    : '';
  // Pane name fills the box below the top line, top-aligned.
  const text = m.bigNumber
    ? big
    : lines
        .map(
          (l, i) =>
            `<text x="${MX}" y="${(BOX.top + CAP * fs + i * fs * LINE).toFixed(1)}" font-size="${fs}" font-weight="${m.focused ? 700 : 500}">${esc(l)}</text>`,
        )
        .join('');
  // A pane with no detected agent but a live mapping is a plain shell.
  // Orca's agent type, lower-cased once here for the pictogram and letter lookups.
  const kind = (m.agent ? m.agent : m.state === 'unmapped' ? '' : 'shell').toLowerCase();
  // Lookup: an own pictogram where the override table says so, else Orca's icon, else our pictogram, else a letter.
  const override = ICON_OVERRIDES[kind];
  const orca = kind && override !== 'own' ? ORCA_ICONS[kind] : undefined;
  const glyph = orca
    ? ''
    : kind
      ? (PICTOGRAM[kind] ??
        `<text x="12" y="${harnessLabel(kind).length > 1 ? 16 : 17}" font-size="${harnessLabel(kind).length > 1 ? 11 : 14}" font-weight="500" text-anchor="middle" fill="${pal.bg}" stroke="none">${esc(harnessLabel(kind))}</text>`)
      : '';
  const mode: IconMode | null = orca
    ? override === 'mask' || override === 'chip'
      ? override
      : naturalMode(orca)
    : null;
  const badge = orca
    ? `<circle cx="${MX + 12}" cy="${MY + 12}" r="12" fill="${pal.fg}" fill-opacity=".85"/><g transform="translate(${MX} ${MY})">${orcaIconArt(orca, mode!, pal.bg)}</g>`
    : glyph
      ? `<circle cx="${MX + 12}" cy="${MY + 12}" r="12" fill="${pal.fg}" fill-opacity=".85"/><g transform="translate(${MX} ${MY})" fill="none" stroke="${pal.bg}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>`
      : '';
  const host = m.host
    ? `<text x="${RIGHT}" y="${MY + 17}" font-size="12" text-anchor="end">${esc(ellipsis(m.host, 7))}</text>`
    : '';
  // The working arc turns an eighth per step; other icons are static.
  const art = ICONS[m.state].replace(/var\(--bg\)/g, pal.bg);
  const icon =
    m.state === 'working'
      ? `<g transform="rotate(${(((o.spin ?? 0) % SPIN_STEPS) * 360) / SPIN_STEPS} 20 20)">${art}</g>`
      : art;
  // Top line: agent badge, then the state icon; host name on the right.
  const iconX = glyph || orca ? MX + 32 : MX;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" ` +
    `style="--bg:${pal.bg}" font-family="${FONT_STACK}" font-weight="400" color="${pal.fg}" fill="${pal.fg}">` +
    `<rect width="144" height="144" fill="${pal.bg}"/>` +
    badge +
    `<g transform="translate(${iconX} ${MY}) scale(.6)" opacity="${m.state === 'unmapped' ? 0.6 : 1}">${icon}</g>` +
    host +
    text +
    // Frame in the state colour, readable in high contrast too.
    (m.focused
      ? `<rect data-focus="1" x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="${base.bg}" stroke-width="10"/>`
      : '') +
    `</svg>`
  );
}

/** A key that shows one big value (Status / Attention): colour of `tone`, value in the middle, caption below. */
export interface InfoModel {
  tone: DeckState;
  value: string;
  caption: string;
}

export function renderInfoKey(m: InfoModel, o: RenderOptions = {}): string {
  const size = o.size ?? 144;
  const pal = (o.highContrast && HIGH_CONTRAST[m.tone]) || PALETTE[m.tone];
  const { lines, size: fs } = layoutLabel(m.caption);
  const caption = lines
    .slice(0, 2)
    .map(
      (l, i) =>
        `<text x="72" y="${(112 + i * 16).toFixed(1)}" font-size="${Math.min(fs, 16)}" text-anchor="middle">${esc(l)}</text>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" ` +
    `font-family="${FONT_STACK}" font-weight="500" fill="${pal.fg}">` +
    `<rect width="144" height="144" fill="${pal.bg}"/>` +
    `<text x="72" y="84" font-size="${m.value.length > 3 ? 40 : 56}" text-anchor="middle">${esc(m.value)}</text>` +
    caption +
    `</svg>`
  );
}

/** Status key content: health mode and the worst problem. */
export function statusInfo(o: {
  mode: 'live' | 'degraded' | 'down';
  version: string | null;
  unsupported: boolean;
  badResponse?: boolean;
  hostsDown: number;
}): InfoModel {
  if (o.mode === 'down') return { tone: 'offline', value: 'OFF', caption: 'Orca not running' };
  if (o.unsupported) return { tone: 'error', value: '!', caption: `Orca ${o.version} too old` };
  if (o.badResponse) return { tone: 'error', value: '!', caption: 'unexpected Orca response' };
  if (o.hostsDown > 0) {
    return {
      tone: 'idle',
      value: String(o.hostsDown),
      caption: o.hostsDown === 1 ? 'host down' : 'hosts down',
    };
  }
  return o.mode === 'live'
    ? { tone: 'completed', value: 'OK', caption: `live ${o.version ?? ''}`.trim() }
    : { tone: 'idle', value: 'OK', caption: `slow updates ${o.version ?? ''}`.trim() };
}

/**
 * Attention key content: number of urgent panes, coloured by the most urgent state, plus "+N" for
 * the ones that are on no key.
 */
export function attentionInfo(urgent: number, top: DeckState | null, offDeck = 0): InfoModel {
  if (urgent === 0 || !top) return { tone: 'unmapped', value: '0', caption: 'all calm' };
  const caption = top === 'error' ? 'errors' : 'need you';
  return {
    tone: top,
    value: String(urgent),
    caption: offDeck > 0 ? `${caption} +${offDeck}` : caption,
  };
}
