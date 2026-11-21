/**
 * Dispatches a fixed trial step to the gate, watcher or release workflow.
 * Runtime contracts remain re-exported here for existing CLI and test consumers.
 */
import type { CaseId, StepId } from './run-case';
import type { RuntimeConfig } from './runtime-config';
import type { RuntimePorts, TaskResult } from './runtime-types';
import { createTaskAws } from './task-aws';
import { runWatchTask } from './watch-task';
import { runReleaseTask } from './release-task';

export type { RuntimePorts, TaskResult } from './runtime-types';

/**
 * Executes the registered step for a trial case using the supplied configuration and ports.
 * Watcher failures attempt to publish an unhealthy report before propagating.
 *
 * @param stepId - fixed gate, watch or release operation
 * @param caseId - registered healthy, blocked or bad-canary scenario
 * @param config - validated workload and experiment target configuration
 * @param ports - AWS transport, clock, polling delay and HTTP probes
 * @returns task exit code and explanatory evidence; a failed trial remains nonzero
 * @throws Error when a blocked case requests release or a workflow/port operation fails
 */
export async function runTask(
  stepId: StepId,
  caseId: CaseId,
  config: RuntimeConfig,
  ports: RuntimePorts,
): Promise<TaskResult> {
  if (stepId === 'gate') {
    return {
      exitCode: gateExitCode(caseId),
      reason:
        caseId === 'blocked'
          ? 'deterministic pre-release gate FAIL'
          : 'deterministic pre-release gate PASS',
    };
  }

  if (stepId === 'watch') {
    try {
      return await runWatchTask(config, caseId, ports);
    } catch (error) {
      // An observer error revokes readiness but cannot attest to a failed candidate.
      await createTaskAws(config, caseId, ports).publish(false, 'PENDING', 'FAIL');
      throw error;
    }
  }

  if (caseId === 'blocked') {
    throw new Error('blocked case has no release operation');
  }

  return runReleaseTask(config, caseId, ports);
}

/** Returns a nonzero gate exit only for the deliberately blocked scenario. */
export function gateExitCode(caseId: CaseId): number {
  return caseId === 'blocked' ? 1 : 0;
}
