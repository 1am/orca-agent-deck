import { z } from 'zod';

// All schemas are tolerant of unknown fields (zod objects strip extras by default).
const envelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({ id: z.string().optional(), ok: z.literal(true), result });

/**
 * A field Orca may leave out or send as null (zod's `.default()` covers only undefined): both read as
 * `value`, and the inferred output type stays non-nullable.
 */
const nullishDefault = <T extends z.ZodTypeAny>(schema: T, value: z.output<T>) =>
  schema.nullish().transform((v): z.output<T> => v ?? value);

/** Items dropped by `lenientArray` since the last `takeSchemaIssues()`. */
const schemaIssues: string[] = [];

/** Takes (and clears) the issues `lenientArray` found while parsing: the caller logs them. */
export function takeSchemaIssues(): string[] {
  return schemaIssues.splice(0);
}

/**
 * An array whose bad items are dropped, not fatal: one terminal Orca describes oddly must not hide
 * the rest. Each drop is recorded as `<list>[i] (<id>): <zod path> <code>`. Only the path and the
 * code are kept, never a value: items carry message text.
 */
const lenientArray = <T extends z.ZodTypeAny>(list: string, item: T, idKey: string) =>
  z.array(z.unknown()).transform((raw): z.output<T>[] => {
    const out: z.output<T>[] = [];
    raw.forEach((r, i) => {
      const parsed = item.safeParse(r);
      if (parsed.success) return out.push(parsed.data);
      const id = (r as Record<string, unknown> | null)?.[idKey];
      const where = typeof id === 'string' ? ` (${id})` : '';
      const why = parsed.error.issues.map((x) => `${x.path.join('.') || '<item>'} ${x.code}`);
      schemaIssues.push(`${list}[${i}]${where}: ${why.join('; ')}`);
    });
    return out;
  });

export const hostScope = z.object({
  hostIds: nullishDefault(z.array(z.string()), []),
  omittedHostIds: nullishDefault(z.array(z.string()), []),
});

export const terminal = z.object({
  handle: z.string(),
  worktreeId: z.string(),
  tabId: z.string(),
  leafId: z.string(),
  title: nullishDefault(z.string(), ''),
  paneTitle: z.string().nullish(),
  connected: z.boolean(),
  exitCause: z.enum(['crash', 'nonzero', 'clean']).nullish(),
  executionHostId: nullishDefault(z.string(), 'local'),
  agentIdentity: z.string().nullish(),
  worktreePath: z.string().nullish(),
  branch: z.string().nullish(),
  orphaned: z.boolean().nullish(),
  recordedPaneKey: z.string().nullish(),
  lastOutputAt: z.number().nullish(),
});

export const terminalListResponse = envelope(
  z.object({
    terminals: lenientArray('terminals', terminal, 'handle'),
    hostScope: hostScope.optional(),
    visualLayouts: z.array(z.object({ root: z.unknown() }).passthrough()).optional(),
  }),
);

export const terminalShowResponse = envelope(
  z.object({ terminal: z.object({ tabId: z.string(), leafId: z.string() }) }),
);

export const agentEntry = z.object({
  paneKey: z.string(),
  state: z.string(),
  agentType: z.string().nullish(),
  toolName: z.string().nullish(),
  interrupted: nullishDefault(z.boolean(), false),
  // Content fields: used only to decide `awaiting`, never stored or logged.
  lastAssistantMessage: z.string().nullish(),
  lastAssistantMessageIsToolOutput: z.boolean().nullish(),
  /** JSON string: `{questions: [...]}` for AskUserQuestion, `{approval: ...}` for a permission request. */
  interactivePrompt: z.string().nullish(),
  stateStartedAt: z.number(),
  mainAgent: z
    .object({ state: z.string(), outcome: z.string().nullish(), stateStartedAt: z.number() })
    .nullish(),
});

export const worktreePsResponse = envelope(
  z.object({
    worktrees: lenientArray(
      'worktrees',
      z.object({
        worktreeId: z.string(),
        repo: z.string().nullish(),
        branch: z.string().nullish(),
        hostId: nullishDefault(z.string(), 'local'),
        /** True for the worktree the Orca window currently shows. */
        isActive: z.boolean().optional(),
        agents: nullishDefault(lenientArray('agents', agentEntry, 'paneKey'), []),
      }),
      'worktreeId',
    ),
    hostScope: hostScope.optional(),
  }),
);

/** Collects tabId -> title from the (arbitrarily nested) visual layout tree. */
export function tabTitles(layouts: { root?: unknown }[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (typeof o['tabId'] === 'string' && typeof o['title'] === 'string' && 'panes' in o) {
      out.set(o['tabId'], o['title']);
    }
    for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
  };
  for (const l of layouts ?? []) walk(l.root);
  return out;
}

/**
 * The pane the user is looking at, from Orca's layout tree: the group's `activeTabId` names the
 * selected tab and that tab's `activeLeafId` the selected pane. `terminal show` cannot be used for
 * this, it resolves to the first tab of the worktree. Null when the tree carries no active tab.
 */
export function activePaneKey(
  layouts: { worktreeId?: unknown; root?: unknown }[] | undefined,
  worktreeId?: string,
): string | null {
  const find = (n: unknown): string | null => {
    if (!n || typeof n !== 'object') return null;
    const o = n as Record<string, unknown>;
    if (typeof o['activeTabId'] === 'string' && Array.isArray(o['tabs'])) {
      const tab = (o['tabs'] as Record<string, unknown>[]).find(
        (t) => t['tabId'] === o['activeTabId'],
      );
      if (tab && typeof tab['activeLeafId'] === 'string') {
        return `${o['activeTabId']}:${tab['activeLeafId']}`;
      }
    }
    for (const v of Object.values(o)) {
      const r = typeof v === 'object' ? find(v) : null;
      if (r) return r;
    }
    return null;
  };
  for (const l of layouts ?? []) {
    if (worktreeId && l.worktreeId !== worktreeId) continue;
    const r = find(l.root);
    if (r) return r;
  }
  return null;
}

export const host = z.object({
  id: z.string(),
  kind: z.enum(['local', 'ssh', 'environment']),
  name: z.string(),
  /** Set by the runtime route for a paired server on an SSH target: that connection's name. */
  label: z.string().optional(),
  connected: z.boolean().optional(),
});

export const environmentListResponse = envelope(
  z.object({
    environments: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        orcadDeployment: z.object({ sshTargetId: z.string().optional() }).partial().optional(),
      }),
    ),
  }),
);

export const hostListResponse = envelope(z.object({ hosts: z.array(host) }));

export const statusResponse = envelope(
  z.object({
    app: z.object({ running: z.boolean() }),
    runtime: z.object({ state: z.string(), appVersion: z.string().nullish() }),
  }),
);

export const switchResponse = envelope(
  z.object({ focus: z.object({ navigated: z.boolean() }).optional() }),
);

/** `terminal.reveal` on this Orca: shows a pane of a paired server in the window. */
export const revealResponse = envelope(z.object({ reveal: z.object({ navigated: z.boolean() }) }));
