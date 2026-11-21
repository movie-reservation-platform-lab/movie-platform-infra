import { assertWatchReady } from '../src/watch';
import { cli, CliIo, safeError } from '../src/cli';

function output() {
  const lines: string[] = [];

  const io: CliIo = {
    env: {},
    readJson: async () => {
      throw new Error('no file expected');
    },
    write: (value) => lines.push(value),
  };

  return { io, lines };
}

test('evaluate verifies exact simulated failures and explicitly denies live artifact evidence', async () => {
  const f = output();

  expect(await cli(['evaluate'], f.io)).toBe(0);

  const result = JSON.parse(f.lines[0]);

  expect(result).toMatchObject({
    mode: 'offline',
    verification: 'PASS',
    liveStatus: 'NOT_RUN',
    artifactVerification: 'NOT_RUN',
  });

  expect(result.cases.map((c: { expectedOutcome: string }) => c.expectedOutcome)).toEqual([
    'PASS',
    'FAIL',
    'FAIL',
  ]);

  expect(result.badReleaseSimulation).toEqual({ outcome: 'FAIL', reverted: true });
});

test('doctor and help work without credentials or file reads', async () => {
  const f = output();

  expect(await cli(['doctor'], f.io)).toBe(0);
  expect(await cli(['--help'], f.io)).toBe(0);
  expect(f.lines[0]).toContain('NOT_RUN');
});

test('unsupported overrides and duplicate arguments fail before file/cloud access', async () => {
  const f = output();

  for (const args of [
    ['good', '--command', 'sh'],
    ['good', '--record', 'a', '--record', 'b'],
    ['evaluate', '--success', 'true'],
  ]) {
    await expect(cli(args, f.io)).rejects.toThrow();
  }
});

test('task command cannot execute with ambient human credentials and output redacts provider secrets', async () => {
  const f = output();

  await expect(cli(['task', 'release', '--case', 'good'], f.io)).rejects.toThrow(
    'container credentials',
  );

  expect(safeError(new Error('TOKEN=super-secret'))).not.toContain('super-secret');
});

test('a rejected watcher heartbeat has a specific safe diagnostic', () => {
  const report = { ready: true, heartbeatAt: 0, alarmStates: { probe: 'OK' } };

  try {
    assertWatchReady(report, 33_000);
  } catch (error) {
    expect(safeError(error)).toContain('watcher is missing or stale');

    return;
  }

  throw new Error('expected stale heartbeat rejection');
});
