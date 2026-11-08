import {
  runCase,
  type CaseId,
  type CaseResult,
  type LaunchRequest,
  type LaunchStatus,
  type Scheduler,
  type StepId,
} from './run-case';
import {
  releaseCandidate,
  type ReleaseObservation,
  type ReleasePort,
  type ReleaseResult,
} from './release';

/** Deterministic local contract exercise. This creates no live/artifact observation. */
export async function evaluateOffline(): Promise<Record<string, unknown>> {
  const cases: OfflineCaseReport[] = [];

  for (const caseId of ['good', 'blocked', 'bad'] as const) {
    cases.push(await evaluateOfflineCase(caseId));
  }

  const badReleaseSimulation = await verifyOfflineRollback();

  return {
    mode: 'offline',
    verification: 'PASS',
    liveStatus: 'NOT_RUN',
    artifactVerification: 'NOT_RUN',
    cases,
    badReleaseSimulation: {
      outcome: badReleaseSimulation.outcome,
      reverted: badReleaseSimulation.reverted,
    },
    note: 'Synthetic contract verification only; no AWS resources, service images, endpoints or Harness executions observed.',
  };
}

export function parseCase(value: string): CaseId {
  if (value !== 'good' && value !== 'blocked' && value !== 'bad') {
    throw new Error('case must be good, blocked or bad');
  }

  return value;
}

/**
 * Exercises an active candidate failure followed by restoration of the original revision.
 * Uses a fake clock and scripted deployment observations; no AWS operations are performed.
 *
 * @returns the simulated failed release with verified rollback evidence
 * @throws Error when the release does not report both FAIL and reverted
 */
async function verifyOfflineRollback(): Promise<ReleaseResult> {
  let clock = 0;
  let index = 0;

  const original: ReleaseObservation = {
    state: 'COMPLETED',
    taskDefinitionArn: 'synthetic-old',
    digest: 'synthetic-old',
  };

  const timeline: ReleaseObservation[] = [
    { state: 'ACTIVE', taskDefinitionArn: 'synthetic-new', digest: 'synthetic-new' },
    { ...original, state: 'REVERTED' },
  ];

  const port: ReleasePort = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    watch: async () => ({ ready: true, heartbeatAt: clock, alarmStates: { synthetic: 'OK' } }),
    alarms: async () => ({ synthetic: 'OK' }),
    register: async () => 'synthetic-new',
    update: async () => {},
    observe: async () => timeline[index++],
    verdict: async () => 'FAIL',
  };

  const result = await releaseCandidate(port, 'synthetic-new', original);

  if (result.outcome !== 'FAIL' || !result.reverted) {
    throw new Error('offline bad case did not observe expected simulated revert');
  }

  return result;
}

/** Runs one synthetic case and checks its outcome and exact requested step sequence. */
async function evaluateOfflineCase(caseId: CaseId): Promise<OfflineCaseReport> {
  const { scheduler, calls } = createSimulatedScheduler(caseId);
  const observed = await runCase(caseId, 'synthetic-offline', scheduler);
  const expectedOutcome = caseId === 'good' ? 'PASS' : 'FAIL';
  const expectedSteps: StepId[] = caseId === 'blocked' ? ['gate'] : ['gate', 'watch', 'release'];
  const steps = calls.map((call) => call.stepId);

  const stepsMatch =
    steps.length === expectedSteps.length &&
    steps.every((step, index) => step === expectedSteps[index]);

  if (observed.outcome !== expectedOutcome || !stepsMatch) {
    throw new Error(`offline ${caseId} contract mismatch`);
  }

  return {
    caseId,
    expectedOutcome,
    simulatedOutcome: observed.outcome,
    verification: 'PASS',
    steps,
  };
}

/** Creates a fresh fake clock and records launcher calls without contacting AWS. */
function createSimulatedScheduler(caseId: CaseId): SimulatedScheduler {
  let clock = 0;
  const calls: LaunchRequest[] = [];

  const scheduler: Scheduler = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    invoke: async (request) => {
      calls.push(request);

      return {
        ...request,
        taskArn: `synthetic-task/${caseId}/${request.stepId}`,
        status: simulateStepStatus(request),
      };
    },
  };

  return { scheduler, calls };
}

/** Supplies the scripted gate, watcher and release outcomes for each offline scenario. */
function simulateStepStatus(request: LaunchRequest): LaunchStatus['status'] {
  if (request.stepId === 'gate' && request.caseId === 'blocked') {
    return 'FAILED';
  }

  if (request.stepId === 'watch') {
    return 'RUNNING';
  }

  if (request.stepId === 'release' && request.caseId === 'bad') {
    return 'FAILED';
  }

  return 'SUCCEEDED';
}

/** Synthetic case evidence; verification passes when the observed outcome matches expectations. */
interface OfflineCaseReport {
  caseId: CaseId;
  expectedOutcome: CaseResult['outcome'];
  simulatedOutcome: CaseResult['outcome'];
  verification: 'PASS';
  steps: StepId[];
}

/** Test transport and its ordered requests, retained for checking orchestration behavior. */
interface SimulatedScheduler {
  scheduler: Scheduler;
  calls: LaunchRequest[];
}
