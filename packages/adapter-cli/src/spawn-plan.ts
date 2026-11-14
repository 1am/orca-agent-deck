/**
 * What to run for `<bin> <args>`. A `.cmd` / `.bat` launcher cannot be started by `execFile` on Windows since Node
 * 20.12 (CVE-2024-27980: EINVAL), and shell metacharacters in an argument would be interpreted by cmd.exe. So a
 * batch launcher is run through `cmd.exe /d /s /c` with one verbatim command line, and only when the launcher path
 * and every argument are made of characters cmd.exe treats literally; anything else is refused, never escaped.
 */
export interface SpawnPlan {
  file: string;
  args: string[];
  /** `windowsVerbatimArguments` for execFile: the one command line is passed as it is. */
  verbatim: boolean;
}

const BATCH = /\.(cmd|bat)$/i;
/** Letters, digits and the punctuation of ids, flags, paths and `key:value` pairs; no space, quote, % & | < > ^ ( ) !. */
const LITERAL_ARG = /^[A-Za-z0-9_@.,:=+\\/-]+$/;
const LITERAL_PATH = /^[^"%&|<>^()!\r\n]+$/;

export function spawnPlan(
  file: string,
  args: string[],
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): SpawnPlan {
  if (platform !== 'win32' || !BATCH.test(file)) return { file, args, verbatim: false };
  if (!LITERAL_PATH.test(file))
    throw new Error(`refusing to run a launcher whose path has shell characters: ${file}`);
  const bad = args.find((a) => !LITERAL_ARG.test(a));
  if (bad !== undefined)
    throw new Error('refusing to pass an argument with shell characters to a .cmd launcher');
  const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe';
  // `/s` strips the outer quotes of the single command line, the inner ones keep a path with spaces together.
  return {
    file: comspec,
    args: ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`],
    verbatim: true,
  };
}
