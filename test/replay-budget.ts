import { cpus, loadavg } from 'node:os';

/** How long a replay wait may take before it is a failure, for every scenario of the replay suites. */
const BASE_MS = 12_000;
/** The load factor stops here: a hung run must fail in about a minute, not after 3 minutes. */
const MAX_SCALE = 5;

export interface ReplayBudget {
  ms: number;
  /** For the failure message: how the deadline came about. */
  note: string;
}

/**
 * One budget for all waits. A wait ends when its state arrives, so the deadline only has to outlast
 * a starved machine: it grows with the load average per core (other sessions, parallel suites) up
 * to MAX_SCALE times the base. `REPLAY_TIMEOUT_SCALE=<n>` sets the factor by hand, uncapped.
 */
export function replayBudget(): ReplayBudget {
  const forced = Number(process.env['REPLAY_TIMEOUT_SCALE']);
  if (forced > 0)
    return { ms: BASE_MS * forced, note: `${BASE_MS / 1000} s x ${forced} (REPLAY_TIMEOUT_SCALE)` };
  const perCore = loadavg()[0]! / Math.max(1, cpus().length);
  const scale = Math.min(MAX_SCALE, Math.max(1, Math.ceil(perCore)));
  const capped =
    perCore > MAX_SCALE ? `, capped at ${MAX_SCALE}x (load is ${perCore.toFixed(1)} per core)` : '';
  return { ms: BASE_MS * scale, note: `${BASE_MS / 1000} s x ${scale}${capped}` };
}
