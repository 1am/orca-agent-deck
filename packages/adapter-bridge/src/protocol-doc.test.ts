import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messageFromA, messageFromB } from './protocol.ts';

const doc = readFileSync(new URL('../../../docs/bridge-protocol.md', import.meta.url), 'utf8');

/** Message types listed in the first column of the table under `## <heading>`. */
function documented(heading: string): string[] {
  const section = doc.split(/^## /m).find((s) => s.startsWith(heading));
  if (!section) throw new Error(`docs/bridge-protocol.md has no "${heading}" section`);
  return [...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1] as string);
}

function types(schema: { options: readonly unknown[] }): string[] {
  // pairResult is an intersection (base object + ok/reason union): the type literal is on the left.
  type Node = { shape?: { type: { value: string } }; _def: { left?: Node } };
  const typeOf = (o: Node): string => (o.shape ? o.shape.type.value : typeOf(o._def.left as Node));
  return (schema.options as Node[]).map(typeOf);
}

describe('docs/bridge-protocol.md', () => {
  it('lists exactly the A -> B message types of protocol.ts', () => {
    expect(documented('Messages A -> B').sort()).toEqual(types(messageFromA).sort());
  });

  it('lists exactly the B -> A message types of protocol.ts', () => {
    expect(documented('Messages B -> A').sort()).toEqual(types(messageFromB).sort());
  });
});
