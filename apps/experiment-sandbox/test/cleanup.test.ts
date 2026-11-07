/**
 * Unit tests for cleanup's decisions, using fake ports that record each destructive
 * step. No AWS calls: `runtime/cleanup-handler.ts` connects these ports to AWS.
 */

import { parseCleanupResult } from '@movie-platform/experiment-sandbox';

import { cleanup, CleanupPorts, CleanupStep } from '../runtime/cleanup';

const EXPERIMENT_ID = 'exp-test';

/**
 * A workload stack that still exists, plus fake ports that record each destructive
 * step in order. `removeWorkload` makes later discovery find nothing left.
 */
function fakeWorkload() {
  const steps: string[] = [];
  const failures: { step: CleanupStep; errorName: string }[] = [];
  let workloadExists = true;

  const ports: CleanupPorts = {
    disableAdmission: async () => {
      steps.push('disable admission');
    },
    inventory: async () => ['recorded-resource'],
    discover: async () => ({
      resources: workloadExists ? ['resource-missing-from-inventory'] : [],
      stackExists: workloadExists,
      provisioning: false,
    }),
    stopTasks: async () => {
      steps.push('stop tasks');
    },
    cancelStackUpdate: async () => {
      steps.push('cancel stack update');
    },
    deleteStack: async () => {
      steps.push('delete stack');
    },
    removeExternalTaskDefinitions: async () => {},
    save: async () => {},
    reportFailure: (step, error) => {
      failures.push({ step, errorName: error instanceof Error ? error.name : String(error) });
    },
  };

  return {
    ports,
    steps,
    failures,
    removeWorkload: () => {
      workloadExists = false;
    },
  };
}

describe('cleanup', () => {
  it('returns a result the operator CLI accepts', async () => {
    const state = await cleanup(EXPERIMENT_ID, fakeWorkload().ports);

    expect(parseCleanupResult(state)).toEqual(state);
  });

  it('disables admission before it stops tasks and deletes the workload stack', async () => {
    const workload = fakeWorkload();

    await cleanup(EXPERIMENT_ID, workload.ports);

    expect(workload.steps).toEqual(['disable admission', 'stop tasks', 'delete stack']);
  });

  it('does not report the workload removed when the delete request is only accepted', async () => {
    const workload = fakeWorkload();

    const state = await cleanup(EXPERIMENT_ID, workload.ports);

    expect(state.status).toBe('DELETING');
    expect(state.workloadsRemoved).toBe(false);
  });

  it('reports complete only after a later run finds nothing left', async () => {
    const workload = fakeWorkload();

    await cleanup(EXPERIMENT_ID, workload.ports);
    workload.removeWorkload();

    const state = await cleanup(EXPERIMENT_ID, workload.ports);

    expect(state.status).toBe('COMPLETE');
    expect(state.workloadsRemoved).toBe(true);
  });

  it('saves a blocked state that a later run can retry when stack deletion fails', async () => {
    const workload = fakeWorkload();
    const save = jest.fn();

    workload.ports.save = save;

    workload.ports.deleteStack = async () => {
      throw new Error('dependency');
    };

    expect((await cleanup(EXPERIMENT_ID, workload.ports)).status).toBe('BLOCKED');

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ accessRevoked: true, workloadsRemoved: false }),
    );
  });

  it('reports which step failed and why, while saving only the safe blocker text', async () => {
    const workload = fakeWorkload();
    const save = jest.fn();

    const accessDenied = Object.assign(new Error('not authorized'), {
      name: 'AccessDeniedException',
    });

    workload.ports.save = save;

    workload.ports.deleteStack = async () => {
      throw accessDenied;
    };

    await cleanup(EXPERIMENT_ID, workload.ports);

    expect(workload.failures).toEqual([
      { step: 'delete stack', errorName: 'AccessDeniedException' },
    ]);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        blockers: ['AWS cleanup operation failed; inspect inventory and retry'],
      }),
    );
  });

  it('only cancels a running update and reports blocked while the stack is provisioning', async () => {
    const workload = fakeWorkload();

    workload.ports.discover = async () => ({
      resources: ['still-creating'],
      stackExists: true,
      provisioning: true,
    });

    const state = await cleanup(EXPERIMENT_ID, workload.ports);

    expect(state.status).toBe('BLOCKED');
    expect(state.blockers).toEqual(['Workload provisioning is still active; retry cleanup']);
    expect(workload.steps).toEqual(['disable admission', 'cancel stack update']);
  });

  it('deletes nothing when it cannot disable admission first', async () => {
    const workload = fakeWorkload();

    workload.ports.disableAdmission = async () => {
      throw new Error('DynamoDB unavailable');
    };

    expect((await cleanup(EXPERIMENT_ID, workload.ports)).status).toBe('BLOCKED');
    expect(workload.steps).toEqual([]);
  });
});
