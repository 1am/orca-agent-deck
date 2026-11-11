import { envHostId, isLocalHost, isRuntimeHostId, runtimeHostId } from './host-id.ts';

/** What one listing says about the hosts it covered and the ones it left out (Orca's `hostScope`). */
export type ListingHostScope = {
  hostIds?: readonly string[];
  omittedHostIds?: readonly string[];
};

/**
 * Hosts no listing could reach. Orca's `hostScope` reports the hosts a listing covered (`hostIds`)
 * and the ones it left out (`omittedHostIds`). A host one listing covered answered that query, even
 * when the other had nothing to report for it: an SSH host with worktrees but no terminals appears
 * only in the terminal listing's gaps.
 *
 * This drives the "hosts down" count only. `omittedHostIds` stays the union of both listings, so a
 * key keeps its last known state for every host a listing could not see.
 */
export function unreachableHostIds(
  terminalScope: ListingHostScope | undefined,
  worktreeScope: ListingHostScope | undefined,
): string[] {
  const scopes = [terminalScope, worktreeScope].filter(
    (scope): scope is ListingHostScope => scope !== undefined,
  );
  const covered = new Set(scopes.flatMap((scope) => scope.hostIds ?? []));
  const omitted = new Set(scopes.flatMap((scope) => scope.omittedHostIds ?? []));
  // `local` answered the call it came from.
  return [...omitted].filter((id) => !isLocalHost(id) && !covered.has(id));
}

/** Hosts a read could not see (`omitted`, keep their last known state) and the ones counted down. */
export interface HostCensus {
  omitted: readonly string[];
  down: readonly string[];
}

/**
 * Our census from the local listings and one answer per paired server. `census` is null when the
 * server could not be read (or the host list was unknown): it is then omitted and down as
 * `env:<id>`. A paired server's `runtime:` entry in the local listings is that server itself, so
 * it is dropped (it is read directly instead). Its own `runtime:` peers belong to its control
 * plane: they stay in `omitted` for state but do not count as down.
 */
export function mergeHostCensus(
  local: HostCensus,
  paired: readonly { id: string; census: HostCensus | null }[],
): HostCensus {
  const omitted = new Set(local.omitted);
  const down = new Set(local.down);
  for (const env of paired) {
    omitted.delete(runtimeHostId(env.id));
    down.delete(runtimeHostId(env.id));
    if (!env.census) {
      omitted.add(envHostId(env.id));
      down.add(envHostId(env.id));
      continue;
    }
    for (const h of env.census.omitted) omitted.add(h);
    for (const h of env.census.down) if (!isRuntimeHostId(h)) down.add(h);
  }
  return { omitted: [...omitted], down: [...down] };
}
