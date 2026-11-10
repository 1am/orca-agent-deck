import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deckDataDir } from '@orca-agent-deck/adapter-bridge';
import type { SlotSettings, SlotStorage } from '@orca-agent-deck/core';

type Slots = Record<string, SlotSettings>;

export const defaultMappingsPath = (): string => join(deckDataDir(), 'mappings.json');

/**
 * Slot mappings in `~/.orca-deck/mappings.json`, shared by every Stream Deck host (Elgato app,
 * OpenDeck) so a host switch keeps them. Each slot stores its key position (`pos`), which is what
 * lets a key with a new action context in the other host inherit the mapping (MappingStore.locate).
 * The host's own settings stay as a cache and as the migration source: when the file is missing or
 * unreadable the cache is used and written out.
 */
export class FileSlotStorage implements SlotStorage {
  private readonly path: string;
  private readonly cache: SlotStorage;
  private readonly log: (message: string) => void;

  constructor(path: string, cache: SlotStorage, log: (message: string) => void = () => {}) {
    this.path = path;
    this.cache = cache;
    this.log = log;
  }

  load(): Slots {
    const fromFile = this.read();
    if (fromFile) return fromFile;
    // First run on this machine, or a damaged file: migrate from the host settings.
    const migrated = this.cache.load();
    if (Object.keys(migrated).length > 0) {
      this.log(`mappings: migrated ${Object.keys(migrated).length} slot(s) from host settings`);
      this.write(migrated);
    }
    return migrated;
  }

  save(slots: Slots): void {
    this.cache.save(slots);
    this.write(slots);
  }

  private read(): Slots | null {
    try {
      // The file holds pane keys and labels: only trust our own private regular file.
      const st = lstatSync(this.path);
      if (!st.isFile()) return null;
      if (
        process.platform !== 'win32' &&
        (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      )
        return null;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { v?: unknown; slots?: unknown };
      if (raw.v !== 1 || typeof raw.slots !== 'object' || raw.slots === null) return null;
      return raw.slots as Slots;
    } catch {
      return null;
    }
  }

  private write(slots: Slots): void {
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, slots }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (e) {
      // The host settings cache still has the data; never take the deck down for this.
      this.log(`mappings: could not write ${this.path}: ${String(e)}`);
    }
  }
}
