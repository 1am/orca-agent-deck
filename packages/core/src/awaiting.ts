/**
 * "Awaiting reply" classifier: did the agent end its turn by asking the user something?
 * Deterministic and precision-first: a false "asks you" is noisier than a missed one, so an
 * offer ("I can also add tests") never counts; only a real question in the last sentences does. Phrases like "let me know" were tried and
 * dropped: they fired on statements and made the verdict look random.
 * Works on text only; the caller must not keep or log the message (previews can quote terminals).
 */

export interface AwaitingVerdict {
  asks: boolean;
  /** Which rule fired; null when `asks` is false. */
  why: 'question-mark' | null;
}

const NO: AwaitingVerdict = { asks: false, why: null };

/** Remove what must never decide the verdict: fenced and inline code, markdown noise, urls. */
function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[*_~>#]+/g, '')
    .replace(/\r/g, '');
}

/** Last non-empty paragraph, skipping a trailing signature-like line ("Thanks!", an emoji, "---"). */
function lastParagraph(text: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^[-=_.\s]*$/.test(p));
  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i] ?? '';
    // A bare "Thanks!" / "Done." line is not the point of the message; look one paragraph up.
    if (p.length <= 14 && !/\?/.test(p) && i > 0) continue;
    return p;
  }
  return '';
}

/** Last sentence of a paragraph, tolerant of trailing quotes, brackets and emoji. */
function lastSentence(par: string): string {
  const flat = par.replace(/\s+/g, ' ').trim();
  // Split on sentence enders followed by space+capital/digit/bullet; keep the final piece.
  const parts = flat.split(/(?<=[.!?…])\s+(?=[A-Z0-9À-ſ"'([-])/);
  return (parts[parts.length - 1] ?? flat).trim();
}

/** Sentences that follow a question as options for the answer ("I can pick up the next task, or ..."). */
const OFFER_TAIL =
  /^(?:(?:I|we)(?:'ll|'d| can| could| would| will| might)\b|or\b|otherwise\b|happy to\b|ready to\b|just say\b|(?:ja\s+)?mog[eę]\b|mo[zż]emy\b)/i;

/** Open-ended "what next?" prompts end every turn and block nothing: they never count as asking. */
const GENERIC_PROMPT =
  /\b(?:what (?:would|do|did) you (?:like|want|wish|need)(?: me)? to (?:work on|do|tackle|build|try|change)(?: next| now| today)?|what(?:'s| is) on your mind|how can i (?:help|assist)|what can i (?:help|do)(?: for you)?|anything else|what(?:'s| is) next|where (?:should|shall|do) (?:we|i) (?:start|go)|what are we (?:doing|working on))\b|(?<![\p{L}])(?:w czym|czym) (?:mog[eę] )?pom[oó[c]|co (?:chcesz|chcia[lł]by[sś]) (?:zrobi[cć]|robi[cć])|co dalej(?![\p{L}])/iu;

function sentences(par: string): string[] {
  return par
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9À-ſ"'([-])/);
}

const endsWithQuestion = (s: string) =>
  /[?？]["'”’)\]\s\p{Extended_Pictographic}️]*$/u.test(s.trim());

/** A bulleted/numbered final paragraph is usually a summary list, not a question to the user. */
const isListItem = (s: string) => /^\s*(?:[-*•]|\d+[.)])\s/.test(s);

export function classifyFinalMessage(text: string | null | undefined): AwaitingVerdict {
  if (!text || !text.trim()) return NO;
  const par = lastParagraph(clean(text));
  if (!par) return NO;
  const lines = par.split('\n');
  const lastLine = (lines[lines.length - 1] ?? '').trim();
  if (isListItem(lastLine) && !endsWithQuestion(lastLine)) return NO;
  const sentence = lastSentence(par);
  if (endsWithQuestion(sentence)) {
    if (GENERIC_PROMPT.test(sentence)) return NO;
    // "?" inside a quoted string only ("the error says 'why?'") is not a question to the user.
    if (/^["“'‘][^"”'’]*[?？]["”'’]$/.test(sentence)) return NO;
    return { asks: true, why: 'question-mark' };
  }
  // "What do you want to work on? I can do X, or Y.": the question is followed only by offers.
  const parts = sentences(par);
  const q = parts.map((x) => endsWithQuestion(x)).lastIndexOf(true);
  if (q >= 0 && q < parts.length - 1 && parts.length - 1 - q <= 2) {
    if (GENERIC_PROMPT.test(parts[q] ?? '')) return NO;
    const quoted = /^["“'‘][^"”'’]*[?？]["”'’]$/.test(parts[q] ?? '');
    if (!quoted && parts.slice(q + 1).every((x) => OFFER_TAIL.test(x))) {
      return { asks: true, why: 'question-mark' };
    }
  }
  return NO;
}

/** Kinds of "waiting for the user" the adapter can report on top of Orca's raw state. */
export type AwaitingKind = 'question' | 'text';
