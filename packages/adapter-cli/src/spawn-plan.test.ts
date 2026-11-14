import { describe, expect, it } from 'vitest';
import { spawnPlan } from './spawn-plan.ts';

const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

describe('spawnPlan', () => {
  it('runs anything but a Windows batch launcher as it is', () => {
    expect(spawnPlan('/usr/bin/orca', ['status', '--json'], 'darwin')).toEqual({
      file: '/usr/bin/orca',
      args: ['status', '--json'],
      verbatim: false,
    });
    expect(spawnPlan('C:\\Orca\\orca.exe', ['status'], 'win32', env).verbatim).toBe(false);
    // A .cmd path on another OS is just a file name.
    expect(spawnPlan('/tmp/orca.cmd', ['status'], 'linux').file).toBe('/tmp/orca.cmd');
  });

  it('runs a .cmd through cmd.exe with one verbatim command line', () => {
    const p = spawnPlan(
      'C:\\Users\\Ann Lee\\bin\\orca.cmd',
      ['terminal', 'list', '--json'],
      'win32',
      env,
    );
    expect(p).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Users\\Ann Lee\\bin\\orca.cmd" terminal list --json"'],
      verbatim: true,
    });
  });

  it.each(['a b', 'a&b', 'a|b', '%PATH%', 'a"b', 'a^b', 'a>b', 'a\nb', ''])(
    'refuses the argument %j for a .cmd launcher instead of escaping it',
    (arg) => {
      expect(() => spawnPlan('C:\\o\\orca.cmd', ['x', arg], 'win32', env)).toThrow(/refusing/);
    },
  );

  it('refuses a launcher path with shell characters', () => {
    expect(() => spawnPlan('C:\\a&b\\orca.cmd', ['x'], 'win32', env)).toThrow(/refusing/);
  });

  it('accepts the arguments the adapter really sends', () => {
    const args = [
      'terminal',
      'switch',
      '--terminal',
      'term_abc-123',
      '--environment',
      'env.1:x',
      '--json',
    ];
    expect(() => spawnPlan('C:\\o\\orca.bat', args, 'win32', env)).not.toThrow();
  });
});
