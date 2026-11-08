import * as sim from './sim.ts';
import type { SimState } from './sim.ts';

/** Timeline DSL: each step is [delayMs, action]. A virtual clock makes runs deterministic. */
export type Step = [number, (s: SimState) => void];
export interface Scenario {
  name: string;
  steps: Step[];
}

const base = (s: SimState) => {
  sim.addPane(s, 'a');
  sim.addPane(s, 'b');
};

export const scenarios: Scenario[] = [
  {
    name: 'permission-approve-success',
    steps: [
      [0, base],
      [1000, (s) => sim.setAgent(s, 'a', 'working')],
      [2000, (s) => sim.setAgent(s, 'a', 'working', 'Bash')],
      [3000, (s) => sim.setAgent(s, 'a', 'waiting', 'Bash')],
      [5000, (s) => sim.setAgent(s, 'a', 'working', 'Bash')],
      [4000, (s) => sim.setAgent(s, 'a', 'done', 'Bash')],
    ],
  },
  {
    name: 'multi-agent-day',
    steps: [
      [0, (s) => (base(s), sim.addPane(s, 'c', { agent: 'codex', title: 'Codex' }))],
      [500, (s) => sim.setAgent(s, 'a', 'working')],
      [500, (s) => sim.setAgent(s, 'b', 'working')],
      [2000, (s) => sim.setAgent(s, 'b', 'waiting')],
      [1000, (s) => sim.setAgent(s, 'c', 'working')],
      [3000, (s) => sim.setAgent(s, 'a', 'done')],
      [2000, (s) => sim.setAgent(s, 'b', 'done')],
      [1000, (s) => sim.setAgent(s, 'c', 'done')],
    ],
  },
  {
    name: 'orca-restart',
    steps: [
      [0, base],
      [1000, (s) => sim.setAgent(s, 'a', 'working')],
      [1000, sim.restart],
      [1000, (s) => sim.setAgent(s, 'a', 'done')],
    ],
  },
  {
    name: 'pane-closed-restored',
    steps: [
      [0, base],
      [1000, (s) => sim.removePane(s, 'b')],
      [5000, (s) => sim.addPane(s, 'b')],
    ],
  },
  {
    name: 'ssh-drop-reconnect',
    steps: [
      [
        0,
        (s) => (
          s.hosts.push({ id: 'ssh-1', kind: 'ssh', name: 'remote', connected: true }),
          sim.addPane(s, 'r', { host: 'ssh-1' })
        ),
      ],
      [1000, (s) => sim.setHost(s, 'ssh-1', false)],
      [5000, (s) => sim.setHost(s, 'ssh-1', true)],
    ],
  },
];

export function runScenario(name: string, onStep?: (s: SimState) => void): SimState {
  const sc = scenarios.find((x) => x.name === name);
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const s = sim.newState();
  for (const [delay, action] of sc.steps) {
    sim.advance(s, delay);
    action(s);
    onStep?.(s);
  }
  return s;
}
