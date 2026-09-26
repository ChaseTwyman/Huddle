import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard: scripted edits have twice turned a regex "\b" into a literal backspace (0x08), which silently breaks
 * matching (the first time it hid a declined penalty; the second time college field positions). Fail loudly instead.
 */
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : files(p);
    return /\.(ts|tsx|json|css)$/.test(e.name) ? [p] : [];
  });
}

describe('source hygiene', () => {
  it('has no control characters (like a mangled \b) in source or data files', () => {
    const bad = ['server', 'shared', 'web/src', 'scripts', 'tests', 'data']
      .flatMap((d) => files(d))
      .filter((f) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
