/**
 * Tests for the operator CLI's argument handling and command table: what runs offline,
 * what needs --execute, and which options each command accepts. No AWS calls.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCliArguments } from '../src/cli-arguments';
import { runCli } from '../src/cli';
import { saveRecord } from '../src/record-file';
import { sampleRecord } from '../src/sample';

let directory: string;
let recordPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sandbox-cli-'));
  recordPath = join(directory, 'record.json');
  saveRecord(recordPath, sampleRecord(new Date()), true);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('parseCliArguments', () => {
  it('reads the command, path options and --execute', () => {
    expect(parseCliArguments(['cleanup', '--record', '/private/r.json', '--execute'])).toEqual({
      command: 'cleanup',
      recordPath: '/private/r.json',
      execute: true,
    });
  });

  it.each([
    [['inspect', '--record', '/a', '--record', '/b'], 'One --record path required'],
    [['inspect', '--record', '--execute'], 'One --record path required'],
    [['inspect', '--execute', '--execute'], 'Duplicate --execute'],
    [['inspect', '--profile', 'admin'], 'Unknown sandbox option'],
  ])('rejects %j', (args, error) => {
    expect(() => parseCliArguments(args)).toThrow(error);
  });
});

describe('runCli', () => {
  it('lists every command in the help text', async () => {
    const output: string[] = [];

    expect(await runCli(['--help'], (message) => output.push(message))).toBe(0);

    for (const command of [
      'sample',
      'prepare',
      'render-config',
      'inspect',
      'check',
      'check-configuration',
      'create',
      'status',
      'admit',
      'cleanup',
      'capture-controls',
      'finalize-controls',
      'retire',
    ]) {
      expect(output.join('')).toMatch(new RegExp(`^  ${command} +`, 'm'));
    }
  });

  it.each(['deploy', 'constructor', 'toString'])('rejects unknown command %s', async (command) => {
    await expect(runCli([command, '--record', recordPath], () => {})).rejects.toThrow(
      'Unknown sandbox command',
    );
  });

  it('refuses --execute on offline commands', async () => {
    await expect(
      runCli(['inspect', '--record', recordPath, '--execute'], () => {}),
    ).rejects.toThrow('inspect is offline only');
  });

  it('accepts --inputs and --out only for render-config', async () => {
    await expect(
      runCli(['inspect', '--record', recordPath, '--out', join(directory, 'x.json')], () => {}),
    ).rejects.toThrow('only valid for render-config');
  });

  it('only previews an AWS command without --execute', async () => {
    const output: string[] = [];

    expect(
      await runCli(['create', '--record', recordPath], (message) => output.push(message)),
    ).toBe(0);

    expect(output.join('')).toContain('create has not executed');
  });

  it('check exits 2 while blockers remain; inspect exits 0', async () => {
    expect(await runCli(['check', '--record', recordPath], () => {})).toBe(2);
    expect(await runCli(['inspect', '--record', recordPath], () => {})).toBe(0);
  });

  it('keeps check-configuration as an alias for check', async () => {
    const output: string[] = [];

    expect(
      await runCli(['check-configuration', '--record', recordPath], (message) =>
        output.push(message),
      ),
    ).toBe(2);

    expect(JSON.parse(output[0])).toMatchObject({ accountState: 'planned' });
  });
});
