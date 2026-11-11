/**
 * Execution host ids, as Orca spells them: `local`, `ssh:<encoded>` and `runtime:<encoded>` come
 * from Orca (the part after the colon is `encodeURIComponent` of the target or environment id);
 * `env:<id>` is ours, for a paired server we query with `--environment` (id not encoded). The
 * string is the wire and storage form (mappings, bridge, fixtures), so every helper here returns
 * or compares it byte for byte and never re-encodes an id it was given.
 */
export const LOCAL_HOST = 'local';

export const isLocalHost = (hostId: string): boolean => hostId === LOCAL_HOST;

/** Id we give the panes of a paired Orca server (`--environment <id>`). */
export const envHostId = (environmentId: string): string => `env:${environmentId}`;

/** Orca's id of a paired server's runtime, as it appears in `hostScope` and `--execution-host`. */
export const runtimeHostId = (environmentId: string): string =>
  `runtime:${encodeURIComponent(environmentId)}`;

/** A `runtime:` id: a paired server (or one of its own peers) as seen by a listing. */
export const isRuntimeHostId = (hostId: string): boolean => hostId.startsWith('runtime:');

export type HostIdKind = 'local' | 'ssh' | 'runtime' | 'env' | 'unknown';

/** The kind of a host id and the text after the prefix, exactly as given (still encoded). */
export function parseHostId(hostId: string): { kind: HostIdKind; ref: string } {
  if (hostId === LOCAL_HOST) return { kind: 'local', ref: '' };
  for (const kind of ['ssh', 'runtime', 'env'] as const) {
    if (hostId.startsWith(`${kind}:`)) return { kind, ref: hostId.slice(kind.length + 1) };
  }
  return { kind: 'unknown', ref: hostId };
}

/** A host id as a person would read it when Orca gave no name: the decoded id without its prefix. */
export function readableHostId(hostId: string): string {
  const { kind, ref } = parseHostId(hostId);
  if (kind === 'local') return 'This machine';
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}
