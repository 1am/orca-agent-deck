import * as sim from '../sim.ts';
import type { SimState } from '../sim.ts';
import type { Scenario, Step } from './schema.ts';

/** Applies an `orca.*` step to the simulated Orca; false when the step is not one the sim plays. */
export function applyOrca(s: SimState, step: Step): boolean {
  switch (step.do) {
    case 'orca.pane.add':
      sim.addPane(s, step.pane, { agent: step.agent, title: step.title, host: step.host });
      return true;
    case 'orca.pane.remove':
      sim.removePane(s, step.pane);
      return true;
    case 'orca.pane.exit':
      sim.exitPane(s, step.pane, step.cause);
      return true;
    case 'orca.agent':
      sim.setAgent(s, step.pane, step.state, step.toolName ?? null, {
        outcome: step.outcome,
        lastMessage: step.message,
      });
      return true;
    case 'orca.host.add':
      s.hosts.push({ id: step.id, kind: step.kind, name: step.name, connected: true });
      return true;
    case 'orca.host.set':
      sim.setHost(s, step.id, step.connected);
      return true;
    case 'orca.restart':
      sim.restart(s);
      return true;
    case 'orca.plugin':
      s.plugins = (s.plugins ?? []).filter((p) => p.pluginKey !== step.key);
      if (step.status !== 'absent') s.plugins.push({ pluginKey: step.key, status: step.status });
      return true;
    case 'orca.focus': {
      const p = s.panes.find((x) => x.leafId === `leaf-${step.pane}`);
      if (p) sim.focus(s, p.handle);
      return true;
    }
    default:
      return false;
  }
}

/** Plays only the `orca.*` steps on the virtual clock; `onStep` sees the state after each one. */
export function play(sc: Scenario, onStep?: (s: SimState) => void): SimState {
  const s = sim.newState();
  const t0 = s.now;
  for (const step of sc.steps) {
    sim.advance(s, step.at - (s.now - t0));
    if (applyOrca(s, step)) onStep?.(s);
  }
  return s;
}
