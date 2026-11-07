/**
 * Tests for the shared control-state schemas: launch requests, lease and watch rows,
 * cleanup requests, and the fixed cleanup blocker texts.
 */

import {
  CLEANUP_BLOCKERS,
  parseCleanupRequest,
  parseLaunchRequest,
  parseLeaseRow,
  parseWatchRow,
} from '../src';

/** A lease row as the operator's `admit` installs it, before any launch. */
function installedLease(): Record<string, unknown> {
  return {
    experimentId: 'exp-demo',
    version: 0,
    expiresAt: '2030-01-01T04:00:00Z',
    rejectNewWorkAt: '2030-01-01T03:00:00Z',
    disabled: false,
    total: 0,
    requests: {},
  };
}

describe('parseLaunchRequest', () => {
  it('accepts a registered case and step', () => {
    expect(
      parseLaunchRequest({ experimentId: 'exp-demo', caseId: 'bad', stepId: 'watch' }),
    ).toEqual({ experimentId: 'exp-demo', caseId: 'bad', stepId: 'watch' });
  });

  it('rejects extra fields, so a caller cannot smuggle an image or command override', () => {
    expect(() =>
      parseLaunchRequest({
        experimentId: 'exp-demo',
        caseId: 'good',
        stepId: 'gate',
        image: 'attacker/image:latest',
      }),
    ).toThrow('launchRequest contains unknown key image');
  });
});

describe('parseLeaseRow', () => {
  it('accepts the lease the operator installs', () => {
    expect(parseLeaseRow(installedLease()).version).toBe(0);
  });

  it('accepts a lease with a reserved, started step', () => {
    const lease = {
      ...installedLease(),
      version: 3,
      total: 1,
      requests: {
        'good:gate': {
          token: 'abc',
          status: 'RUNNING',
          taskArn: 'task-1',
          taskDefinitionArn: 'td-1',
        },
      },
    };

    expect(parseLeaseRow(lease).requests['good:gate'].status).toBe('RUNNING');
  });

  it.each([
    ['a negative version', { version: -1 }, /^version:/],
    ['a version stored as text', { version: '0' }, /^version:/],
    ['a timestamp without a zone', { expiresAt: '2030-01-01T04:00:00' }, /^expiresAt:/],
    [
      'an unknown task status',
      { requests: { 'good:gate': { token: 'abc', status: 'DONE' } } },
      /^requests\.good:gate\.status:/,
    ],
  ])('rejects %s', (_problem, change, error) => {
    expect(() => parseLeaseRow({ ...installedLease(), ...change })).toThrow(error);
  });
});

describe('parseWatchRow', () => {
  it('keeps the fields the launcher decides on and drops the rest', () => {
    const row = {
      experimentId: 'exp-demo#good#watch',
      ready: true,
      heartbeatAt: 1_900_000_000_000,
      verdict: 'OK',
      candidateVerdict: 'PENDING',
    };

    expect(parseWatchRow(row)).toEqual({
      ready: true,
      heartbeatAt: 1_900_000_000_000,
      verdict: 'OK',
    });
  });

  it('rejects a heartbeat that is not a number', () => {
    expect(() => parseWatchRow({ ready: true, heartbeatAt: 'now', verdict: 'OK' })).toThrow(
      /^heartbeatAt:/,
    );
  });
});

describe('parseCleanupRequest', () => {
  it('accepts operator and schedule requests', () => {
    expect(parseCleanupRequest({ experimentId: 'exp-demo' })).toEqual({ experimentId: 'exp-demo' });

    expect(parseCleanupRequest({ experimentId: 'exp-demo', scheduled: true }).scheduled).toBe(true);
  });

  it('rejects a schedule flag that is not true', () => {
    expect(() => parseCleanupRequest({ experimentId: 'exp-demo', scheduled: false })).toThrow(
      /^scheduled:/,
    );
  });
});

describe('CLEANUP_BLOCKERS', () => {
  it('stays the fixed vocabulary the operator record accepts', () => {
    expect(Object.values(CLEANUP_BLOCKERS)).toEqual([
      'Unable to disable launch admission',
      'Workload provisioning is still active; retry cleanup',
      'AWS cleanup operation failed; inspect inventory and retry',
    ]);
  });
});
