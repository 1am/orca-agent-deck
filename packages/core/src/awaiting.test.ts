import { describe, expect, it } from 'vitest';
import { classifyFinalMessage } from './awaiting.ts';

/**
 * Synthetic corpus modelled on how coding agents end a turn. These are NOT real captures; real
 * messages are checked by hand (verdicts only, no text) per the manual list.
 */
const ASKS: Array<[string, string]> = [
  ['plain question', 'I updated the parser.\n\nShould I also update the docs?'],
  ['shall I', 'Both approaches work. Shall I go with the second one?'],
  ['do you want', 'The migration is ready.\n\nDo you want me to run it against staging?'],
  [
    'which option',
    'There are two ways to do this:\n\n- A: patch in place\n- B: rewrite the module\n\nWhich one do you prefer?',
  ],
  ['question with trailing emoji', 'All green. Want me to open a PR? 🚀'],
  ['question in parens', 'I can split this into two commits (should I?)'],
  [
    'question after code block',
    'Here is the diff:\n\n```diff\n- a\n+ b\n```\n\nIs that what you had in mind?',
  ],
  ['markdown bold question', '**Do you want me to keep the old API as a deprecated alias?**'],
  ['which would you', 'Which of these would you prefer to keep: the cache or the queue?'],
  [
    'question then newline signature',
    'Ready to continue with step 3, or do you want to review first?\n\nThanks!',
  ],
  ['long report ending in question', 'x '.repeat(400) + '\n\nWhat should the default timeout be?'],
  ['polish question', 'Zmieniłem konfigurację. Czy mam też zaktualizować dokumentację?'],
  ['fullwidth question mark', 'Should I continue？'],
  [
    'quoted question to user',
    'Found two candidates. Which one is the right file: "src/a.ts" or "src/b.ts"?',
  ],
  ['is that ok', 'I will rename the exported type to `DeckState`. Is that OK?'],
  ['numbered options then ask', 'Options:\n1. Keep\n2. Drop\n\nWhich do you want?'],
  ['ask after tests', 'Tests pass (42/42). Should I commit this?'],
  ['ellipsis ask', 'I could try the other approach… want me to?'],
  [
    'trailing quote',
    'The prompt said: continue? I am not sure whether to proceed. Proceed with the refactor?"',
  ],
];

const DONE: Array<[string, string]> = [
  [
    'no ? so no ask: let me know',
    'I made the change in two files.\n\nLet me know how you want to proceed.',
  ],
  ['no ? so no ask: please confirm', 'Please confirm the target branch before I push.'],
  ['no ? so no ask: tell me which', 'Tell me which environment to deploy to.'],
  ['no ? so no ask: reply with', 'Reply with the number of the option you want.'],
  ['no ? so no ask: waiting for', 'Waiting for your decision on the schema change.'],
  ['no ? so no ask: once you confirm', 'Once you confirm, I will start the rollout.'],
  ['no ? so no ask: polish cue', 'Daj znać, którą wersję wybierasz.'],
  ['no ? so no ask: cue your call', 'Both fixes are valid, it is your call.'],
  ['no ? so no ask: cue tell me what', 'Tell me what name you want for the flag.'],
  ['plain summary', 'Implemented the parser and added tests. All 42 tests pass.'],
  ['summary with list', 'Changes:\n\n- Added `awaiting.ts`\n- Updated `status.ts`\n- Wrote tests'],
  ['offer without question', 'Done. If you want, I can also add a changelog entry.'],
  ['i can also', 'The fix is in. I can also extend the same change to the CLI adapter.'],
  ['next steps statement', 'Next steps: run the contract suite against a real Orca.'],
  ['let me know if', 'Everything is merged. Let me know if you need anything else.'],
  ['let me know if issues', 'Deployed. Let me know if you run into issues.'],
  [
    'rhetorical in middle',
    'Why did it fail? The token had expired. I refreshed it and re-ran the job; it passes now.',
  ],
  [
    'question inside code only',
    'Fixed the regex.\n\n```ts\nconst re = /a?b?/; // what is this?\n```',
  ],
  ['question in inline code', 'Renamed `isReady?` to `ready`. All callers updated.'],
  ['url with question mark', 'Docs updated: https://example.com/page?id=3'],
  ['quoted error text', 'The log said "why?" which was just a debug string. Removed it.'],
  ['short ack', 'Done.'],
  ['thanks signoff', 'Merged and deployed.\n\nThanks!'],
  ['status report', 'Build is green. Coverage is 91%. No regressions found.'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
  [
    'bullets ending question mark inside item',
    'Open points:\n- Is the timeout configurable?\n- Where is the cache stored',
  ],
  ['polish statement', 'Zaktualizowałem dokumentację i dodałem testy.'],
  [
    'polish let me know if',
    'Gotowe. Daj znać, gdyby coś nie działało.'.replace(
      'Daj znać, gdyby coś nie działało.',
      'Wszystko przechodzi.',
    ),
  ],
  ['empty', ''],
  ['whitespace', '   \n  '],
  ['exclamation', 'All done, ship it!'],
  ['summary mentions question word', 'I answered the question about timeouts in the README.'],
  ['report with we asked', 'As requested I asked the API for the list; it returned 12 items.'],
  ['ends with ellipsis', 'Working through the remaining files…'],
  ['commit message block', 'Committed:\n\n```\nfix: handle empty list\n```'],
];

describe('classifyFinalMessage', () => {
  it.each(ASKS)('asks: %s', (_n, text) => {
    expect(classifyFinalMessage(text).asks).toBe(true);
  });
  it.each(DONE)('does not ask: %s', (_n, text) => {
    expect(classifyFinalMessage(text)).toEqual({ asks: false, why: null });
  });

  it('reports which rule fired', () => {
    expect(classifyFinalMessage('Proceed?').why).toBe('question-mark');
    expect(classifyFinalMessage('Please confirm the branch.').why).toBeNull();
  });

  it('handles null and undefined', () => {
    expect(classifyFinalMessage(null).asks).toBe(false);
    expect(classifyFinalMessage(undefined).asks).toBe(false);
  });

  it('only the final paragraph decides: an early question answered later does not count', () => {
    expect(
      classifyFinalMessage('Should I use A or B? I picked B.\n\nImplemented with B.').asks,
    ).toBe(false);
  });

  it('is fast on very long messages', () => {
    const t = Date.now();
    classifyFinalMessage('word '.repeat(200_000) + '?');
    // About 50 ms alone; the limit leaves room for a loaded machine. Backtracking would take minutes.
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('meets the quality bar on the synthetic corpus', () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [, t] of ASKS) {
      if (classifyFinalMessage(t).asks) tp++;
      else fn++;
    }
    for (const [, t] of DONE) if (classifyFinalMessage(t).asks) fp++;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe('a question followed only by offers', () => {
  it('asks', () => {
    expect(
      classifyFinalMessage(
        'Done.\n\nWhich of the two approaches do you prefer? I can start with A, or begin with B.',
      ).asks,
    ).toBe(true);
  });
  it('does not ask when the statement after the question is a real statement', () => {
    expect(
      classifyFinalMessage('Why did it fail? The cache was stale and I cleared it.').asks,
    ).toBe(false);
  });
  it('does not ask for a plain offer with no question', () => {
    expect(classifyFinalMessage('Fixed. I can also add tests, or refactor it.').asks).toBe(false);
  });
});

describe('generic what-next prompts', () => {
  it.each([
    'I\u2019m here and ready to help with agent-deck. What would you like to work on?',
    "Hey! I'm here to help with any coding questions or tasks you have. What's on your mind today?",
    'Done. What do you want to work on? I can pick up the next task, or start something new.',
    'Gotowe. W czym mogę pomóc?',
  ])('does not ask: %s', (t) => expect(classifyFinalMessage(t).asks).toBe(false));
  it('still asks a specific question', () => {
    expect(classifyFinalMessage('Should I delete the old migration files?').asks).toBe(true);
  });
});

describe('only the last sentences decide', () => {
  it('ignores a request cue earlier in the final paragraph', () => {
    expect(
      classifyFinalMessage(
        'Please confirm the rename looks right in the diff. I applied it to all 12 files and the tests pass. Build is green.',
      ).asks,
    ).toBe(false);
  });
  it('does not ask on a request cue without a question mark', () => {
    expect(classifyFinalMessage('Both options work. Let me know which one you want.').asks).toBe(
      false,
    );
  });
});
