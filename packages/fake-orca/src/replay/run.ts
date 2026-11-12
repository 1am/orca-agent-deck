import { DeckController, MappingStore } from '@orca-agent-deck/core';
import { CliAdapter, type Exec } from '@orca-agent-deck/adapter-cli';
import { hostList, status, terminalList, worktreePs } from '../render.ts';
import * as sim from '../sim.ts';
import type { SimState } from '../sim.ts';
import { applyOrca } from './play.ts';
import type { Scenario } from './schema.ts';
import { HEADER, row } from './timeline.ts';

/** What `orca` prints for the simulated state, like the real CLI (panes of a down host are left out). */
export const execFor =
  (get: () => SimState): Exec =>
  async (args) => {
    const st = get();
    const [x, y] = args;
    if (x === 'terminal' && y === 'list')
      return JSON.stringify(terminalList({ ...st, panes: st.panes.filter((p) => p.connected) }));
    if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(st));
    if (x === 'host' && y === 'list') return JSON.stringify(hostList(st));
    if (x === 'status') return JSON.stringify(status(st));
    throw new Error(`unsupported ${args.join(' ')}`);
  };

export interface SimResult {
  timeline: string[];
  failures: string[];
  /** Steps of other runners (`deck.*`, `bridge.*`, `orca.event`) that this runner does not play. */
  skippedSteps: number;
}

const SIM_FIELDS = ['state', 'label', 'line2', 'host'] as const;
const slotOf = (k: number | string) => `key-${k}`;

/**
 * The fast determinism path: plays `orca.*` into the simulated Orca and reads the keys through the real
 * DeckController and CliAdapter, so all state derivation is core's. Not a second state model.
 */
export async function replaySim(sc: Scenario): Promise<SimResult> {
  const s = sim.newState();
  const t0 = s.now;
  const adapter = new CliAdapter(
    execFor(() => s),
    () => s.now,
  );
  // Every read is fresh: the virtual clock, not the 4 s CLI throttle, decides what a key shows.
  Object.defineProperty(adapter, 'minReadIntervalMs', { value: 0 });
  const d = new DeckController(adapter, new MappingStore());
  const slots = Object.keys(sc.header.keys).map(slotOf);
  const pinned = new Set<string>();
  const out: SimResult = { timeline: [HEADER], failures: [], skippedSteps: 0 };
  const last = new Map<string, string>();
  let logged = 0;
  let dirty = true;

  /** Reads all keys; the initial layout (`header.keys`) is pinned as soon as its pane exists. */
  const read = async (at: number) => {
    dirty = false;
    let views = await d.refresh(slots);
    const pins = Object.entries(sc.header.keys).filter(
      ([k, pane]) =>
        typeof pane === 'string' && !pinned.has(k) && s.panes.some((p) => p.key === pane),
    );
    for (const [k, pane] of pins) {
      const p = s.panes.find((x) => x.key === pane);
      d.configure(slotOf(k), { paneKey: `${p?.tabId}:${p?.leafId}` });
      pinned.add(k);
    }
    if (pins.length) views = await d.refresh(slots);
    const event = s.log
      .slice(logged)
      .map((l) => l.replace(/^t\+\d+ms /, ''))
      .join('; ');
    logged = s.log.length;
    for (const k of Object.keys(sc.header.keys)) {
      const v = views.get(slotOf(k));
      const sig = v ? `${v.state}|${v.label}|${v.line2}` : '';
      if (last.get(k) === sig) continue;
      last.set(k, sig);
      out.timeline.push(row(at, Number(k), event, v));
    }
    return views;
  };

  const realNow = Date.now;
  Date.now = () => s.now;
  try {
    for (const step of sc.steps) {
      // Everything at one instant is applied together, then read once before the clock moves on.
      if (dirty && step.at > s.now - t0) await read(s.now - t0);
      sim.advance(s, step.at - (s.now - t0));
      if (applyOrca(s, step)) dirty = true;
      else if (step.do === 'expect.key') {
        const bad = Object.keys(step).filter(
          (f) => !['at', 'do', 'key'].includes(f) && !(SIM_FIELDS as readonly string[]).includes(f),
        );
        if (bad.length)
          throw new Error(
            `t=${step.at}: the sim runner cannot evaluate expect.key ${bad.join(', ')}; target side b`,
          );
        const v = (await read(step.at)).get(slotOf(step.key));
        for (const f of SIM_FIELDS) {
          const want = step[f];
          if (want !== undefined && v?.[f] !== want)
            out.failures.push(
              `t=${step.at} key ${step.key} ${f}: expected ${JSON.stringify(want)}, got ${JSON.stringify(v?.[f])}`,
            );
        }
      } else if (
        step.do === 'expect.focus' ||
        step.do === 'expect.reveal' ||
        step.do === 'expect.runtime'
      ) {
        throw new Error(
          `t=${step.at}: the sim runner cannot evaluate ${step.do}; target side a or b`,
        );
      } else out.skippedSteps++;
    }
    if (dirty) await read(s.now - t0);
  } finally {
    Date.now = realNow;
  }
  return out;
}
