import { cpus, loadavg } from 'node:os';

/** How long a replay wait may take before it is a failure, for every scenario of the A and B suites. */
const BASE_MS = 12_000;

/**
 * One budget for all waits. A wait ends when its state arrives, so the deadline only has to outlast
 * a starved machine: it grows with the load average per core (other sessions, parallel suites) and
 * `REPLAY_TIMEOUT_SCALE` overrides the factor (a busy CI runner).
 */
export function replayTimeoutMs(): number {
  const forced = Number(process.env['REPLAY_TIMEOUT_SCALE']);
  const load =
    forced > 0 ? forced : Math.max(1, Math.ceil(loadavg()[0]! / Math.max(1, cpus().length)));
  return BASE_MS * load;
}
