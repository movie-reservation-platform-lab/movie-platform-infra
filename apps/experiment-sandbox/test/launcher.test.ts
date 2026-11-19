/**
 * Unit tests for the launcher's decisions, using an in-memory fake of DynamoDB and ECS.
 * No AWS calls: `runtime/launcher-handler.ts` connects these ports to AWS.
 */

import { launch, LauncherPorts, Lease, parseLaunchRequestFor } from '../runtime/launcher';

const EXPERIMENT_ID = 'exp-test';
const NOW = Date.parse('2030-01-01T00:00:00Z');

const GOOD_GATE = { experimentId: EXPERIMENT_ID, caseId: 'good', stepId: 'gate' } as const;
const GOOD_RELEASE = { experimentId: EXPERIMENT_ID, caseId: 'good', stepId: 'release' } as const;
const BAD_GATE = { experimentId: EXPERIMENT_ID, caseId: 'bad', stepId: 'gate' } as const;

/** A request the fake ECS received, reduced to the fields the tests check. */
interface LaunchedRequest {
  readonly clientToken: string;
  readonly count: number;
  readonly taskDefinition: string;
}

/**
 * An admitted lease with nothing launched yet, plus fake ports that behave like
 * DynamoDB (versioned compare-and-swap) and ECS (records every RunTask request).
 */
function fakeSandbox() {
  let lease: Lease = {
    experimentId: EXPERIMENT_ID,
    version: 0,
    expiresAt: '2030-01-01T04:00:00Z',
    rejectNewWorkAt: '2030-01-01T03:00:00Z',
    disabled: false,
    total: 0,
    requests: {},
  };

  const launchedRequests: LaunchedRequest[] = [];

  const ports: LauncherPorts = {
    readLease: async () => structuredClone(lease),
    compareAndSwap: async (previousVersion, next) => {
      if (lease.version !== previousVersion) {
        return false;
      }

      lease = structuredClone(next);

      return true;
    },
    observeTask: async () => ({ status: 'SUCCEEDED', taskDefinitionArn: 'trusted' }),
    readWatch: async () => ({ ready: true, verdict: 'OK', heartbeatAt: NOW }),
    resolveTaskRecipe: async () => ({
      cluster: 'fixed-cluster',
      taskDefinition: 'trusted',
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['fixed'],
          securityGroups: ['fixed'],
          assignPublicIp: 'ENABLED',
        },
      },
    }),
    runTask: async (request) => {
      launchedRequests.push(request);

      return 'task-1';
    },
    deriveClientToken: (reservationKey) => reservationKey,
    now: () => NOW,
  };

  return {
    ports,
    launchedRequests,
    get lease() {
      return lease;
    },
  };
}

describe('parseLaunchRequestFor', () => {
  it('rejects a forged success flag sent alongside the IDs', () => {
    expect(() => parseLaunchRequestFor({ ...GOOD_RELEASE, passed: true }, EXPERIMENT_ID)).toThrow(
      'launchRequest contains unknown key passed',
    );
  });

  it('rejects another experiment ID', () => {
    expect(() =>
      parseLaunchRequestFor({ ...GOOD_GATE, experimentId: 'exp-other' }, EXPERIMENT_ID),
    ).toThrow('launch request is for another experiment');
  });

  it('rejects an unregistered case', () => {
    expect(() => parseLaunchRequestFor({ ...GOOD_GATE, caseId: 'ugly' }, EXPERIMENT_ID)).toThrow(
      /^caseId:/,
    );
  });

  it.each(['caseId', 'stepId'] as const)(
    'rejects a single-element array for %s instead of coercing it to a string',
    (field) => {
      expect(() =>
        parseLaunchRequestFor({ ...GOOD_GATE, [field]: [GOOD_GATE[field]] }, EXPERIMENT_ID),
      ).toThrow(new RegExp(`^${field}:`));
    },
  );
});

describe('launch', () => {
  describe('lease limits', () => {
    it.each([
      {
        limit: 'a disabled lease',
        change: (lease: Lease) => ({ ...lease, disabled: true }),
        error: 'Lease is disabled or expired',
      },
      {
        limit: 'an expired lease',
        change: (lease: Lease) => ({ ...lease, expiresAt: '2029-12-31T00:00:00Z' }),
        error: 'Lease is disabled or expired',
      },
      {
        limit: 'a reached new-work cutoff',
        change: (lease: Lease) => ({ ...lease, rejectNewWorkAt: '2029-12-31T00:00:00Z' }),
        error: 'New work cutoff reached',
      },
      {
        limit: 'the total launch cap',
        change: (lease: Lease) => ({ ...lease, total: 16 }),
        error: 'Launch ceiling reached',
      },
      {
        limit: 'the concurrent task cap',
        change: (lease: Lease) => ({
          ...lease,
          requests: Object.fromEntries(
            ['1', '2', '3', '4'].map((key) => [key, { token: key, status: 'PENDING' as const }]),
          ),
        }),
        error: 'Launch ceiling reached',
      },
    ])('refuses to launch past $limit', async ({ change, error }) => {
      const sandbox = fakeSandbox();
      const lease = await sandbox.ports.readLease();

      await sandbox.ports.compareAndSwap(lease.version, change(lease));

      await expect(launch(GOOD_GATE, sandbox.ports)).rejects.toThrow(error);
      expect(sandbox.launchedRequests).toHaveLength(0);
    });

    it('starts each step once even when eight callers read the same lease version', async () => {
      const sandbox = fakeSandbox();

      await Promise.all(Array.from({ length: 8 }, () => launch(GOOD_GATE, sandbox.ports)));

      expect(sandbox.lease.total).toBe(1);
      expect(new Set(sandbox.launchedRequests.map((request) => request.clientToken)).size).toBe(1);
    });
  });

  describe('step order', () => {
    it('refuses a release before the gate has run', async () => {
      const sandbox = fakeSandbox();

      await expect(launch(GOOD_RELEASE, sandbox.ports)).rejects.toThrow(
        'Observed successful gate is required',
      );

      expect(sandbox.launchedRequests).toHaveLength(0);
    });

    it('refuses a release after a failed gate', async () => {
      const sandbox = fakeSandbox();

      sandbox.lease.requests['good:gate'] = {
        token: 'gate',
        taskArn: 'task-gate',
        taskDefinitionArn: 'trusted',
        status: 'FAILED',
      };

      await expect(launch(GOOD_RELEASE, sandbox.ports)).rejects.toThrow(
        'Observed successful gate is required',
      );

      expect(sandbox.launchedRequests).toHaveLength(0);
    });

    it('refuses a release while the watcher heartbeat is stale', async () => {
      const sandbox = fakeSandbox();

      sandbox.lease.requests['good:gate'] = {
        token: 'gate',
        taskArn: 'task-gate',
        taskDefinitionArn: 'trusted',
        status: 'SUCCEEDED',
      };

      sandbox.lease.requests['good:watch'] = { token: 'watch', status: 'RUNNING' };
      sandbox.ports.readWatch = async () => ({ ready: true, verdict: 'OK', heartbeatAt: 0 });

      await expect(launch(GOOD_RELEASE, sandbox.ports)).rejects.toThrow(
        'Fresh healthy watcher is required',
      );

      expect(sandbox.launchedRequests).toHaveLength(0);
    });

    it('lets one case own the run, including the gap after its successful gate', async () => {
      const sandbox = fakeSandbox();

      await launch(GOOD_GATE, sandbox.ports);

      await expect(launch(BAD_GATE, sandbox.ports)).rejects.toThrow(
        'Only one case may own the active run',
      );

      expect(sandbox.launchedRequests).toHaveLength(1);
    });
  });

  describe('lost responses', () => {
    it('keeps the reservation and ECS client token when a RunTask response is lost', async () => {
      const sandbox = fakeSandbox();
      const runTask = sandbox.ports.runTask;
      let responseLost = true;

      sandbox.ports.runTask = async (request) => {
        if (responseLost) {
          responseLost = false;
          throw new Error('response lost');
        }

        return runTask(request);
      };

      await expect(launch(GOOD_GATE, sandbox.ports)).rejects.toThrow('response lost');

      const reservedToken = sandbox.lease.requests['good:gate'].token;

      await launch(GOOD_GATE, sandbox.ports);

      expect(sandbox.lease.total).toBe(1);

      expect(sandbox.launchedRequests).toEqual([
        expect.objectContaining({
          clientToken: reservedToken,
          count: 1,
          taskDefinition: 'trusted',
        }),
      ]);
    });
  });
});
