import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrivateFileError, readPrivateFile, writeNewPrivateFile } from '../../src/adapters/private-files';

const directory = mkdtempSync(join(tmpdir(), 'private-files-'));

describe('readPrivateFile', () => {
  it('reads an owner-only regular file', () => {
    const path = join(directory, 'run.json');
    writeFileSync(path, '{}', { mode: 0o600 });

    expect(readPrivateFile(path, 'run file')).toBe('{}');
  });

  it.each([
    ['readable by others', () => { const p = join(directory, 'open.json'); writeFileSync(p, '{}', { mode: 0o644 }); return p; }, 'must deny all group and other access'],
    ['a symbolic link', () => { const p = join(directory, 'link.json'); symlinkSync(join(directory, 'run.json'), p); return p; }, 'not a symbolic link'],
    ['relative', () => 'run.json', 'must be absolute'],
  ])('refuses a file that is %s, without naming its path', (_label, makePath, message) => {
    const path = makePath();
    expect(() => readPrivateFile(path, 'run file')).toThrow(PrivateFileError);
    expect(() => readPrivateFile(path, 'run file')).toThrow(message);
    expect(() => readPrivateFile(path, 'run file')).not.toThrow(directory);
  });
});

describe('writeNewPrivateFile', () => {
  it('creates the file with mode 600, including missing parent directories', () => {
    const path = join(directory, 'evidence', 'result.json');
    writeNewPrivateFile(path, '{}', 'evidence file');

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing file or to follow a symlink', () => {
    const existing = join(directory, 'existing.json');
    writeFileSync(existing, 'old', { mode: 0o644 });
    const link = join(directory, 'evidence-link.json');
    symlinkSync(join(directory, 'elsewhere.json'), link);

    expect(() => writeNewPrivateFile(existing, '{}', 'evidence file')).toThrow('must not exist yet');
    expect(() => writeNewPrivateFile(link, '{}', 'evidence file')).toThrow('must not exist yet');
  });
});
