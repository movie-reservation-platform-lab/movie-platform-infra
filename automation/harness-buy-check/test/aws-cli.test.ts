import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { awsCli } from '../src/aws-cli';

describe('AWS CLI process output', () => {
  const originalPath = process.env.PATH;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'trial-aws-cli-'));
    process.env.PATH = directory + delimiter + originalPath;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  const call = () => awsCli('eu-central-1')('cloudwatch', 'put-metric-data', []);

  it.each([
    ['exit 0', {}],
    ['echo', {}],
    ['echo \'{"ok":true}\'', { ok: true }],
  ] as const)('handles successful stdout from %s', async (command, expected) => {
    await writeFile(join(directory, 'aws'), '#!/bin/sh\n' + command, { mode: 0o700 });
    await expect(call()).resolves.toEqual(expected);
  });

  it.each(['echo malformed', 'exit 1'])('reports failure for %s', async (command) => {
    await writeFile(join(directory, 'aws'), '#!/bin/sh\n' + command, { mode: 0o700 });
    await expect(call()).rejects.toThrow('AWS cloudwatch put-metric-data failed');
  });
});
