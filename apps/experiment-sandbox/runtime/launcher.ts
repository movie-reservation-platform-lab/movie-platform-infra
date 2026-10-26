/**
 * The launcher: the only way the Harness pipeline can start anything in the sandbox.
 *
 * What it launches: the trial's step tasks. A trial runs three cases (`good`,
 * `blocked`, `bad`), each in three steps (`gate`, `watch`, `release`). Each of the nine
 * case/step pairs is a fixed ECS Fargate task definition in the workload stack, with
 * its command (`task <step> --case <case>`), image and IAM role baked in at deploy time:
 *
 * - `gate` decides whether the case's release may start at all;
 * - `watch` probes the recommendation service and feeds the alarm that rolls a bad
 *   canary back;
 * - `release` deploys the case's image to the service and follows the canary to its end.
 *
 * Why it exists: the Harness delegate runs third-party code with internet access, so it
 * gets no ECS or IAM permissions. Its role may only invoke this Lambda, and the only
 * input accepted is `{ experimentId, caseId, stepId }`: no image, command, role or
 * network. The launcher then enforces the experiment's rules before it starts anything:
 *
 * - the lease is open: admitted, not disabled, not expired, before the new-work cutoff;
 * - launch caps: at most `SANDBOX_LIMITS.maxConcurrentTasks` at once and
 *   `maxTotalLaunches` in total;
 * - one case at a time, and steps in order: watch and release need a successful gate,
 *   and release also needs a running watcher with a fresh, healthy heartbeat;
 * - each step starts at most once: the reservation is stored in the lease row before
 *   ECS is called, and a retry reuses the same ECS client token, so a lost response
 *   never starts a second task. Calling again with the same IDs just reports the step's
 *   status, which is how the pipeline waits for a step to finish.
 *
 * This file holds those decisions without any AWS calls, so tests run them against
 * fakes. `launcher-handler.ts` is the Lambda entry point that connects the ports below
 * to DynamoDB (the lease row) and ECS (RunTask, DescribeTasks).
 */

import {
  parseLaunchRequest,
  SANDBOX_CASE_IDS,
  SANDBOX_LIMITS,
  type FixedTaskRequest,
  type LaunchRequest,
  type LeaseRow,
  type Reservation,
  type SandboxCaseId,
  type SandboxStepId,
  type TaskStatus,
  type WatchRow,
} from '@movie-platform/experiment-sandbox';

/** Optimistic-lock attempts before giving up on a lease row that keeps changing. */
const MAX_LEASE_WRITE_ATTEMPTS = 12;

/** ECS accepts at most 36 characters in `startedBy`. */
const ECS_STARTED_BY_MAX_LENGTH = 36;

const WATCH_HEARTBEAT_MAX_AGE_MS = SANDBOX_LIMITS.watchHeartbeatMaxAgeSeconds * 1000;

/** The lease row as the launcher reads and rewrites it. */
export type Lease = LeaseRow;

/** What a launch call reports back: the step's current status and, once started, its task. */
export interface LaunchResult extends LaunchRequest {
  readonly status: TaskStatus;
  readonly taskArn?: string;
}

/** A trial task as ECS currently reports it. */
export interface TaskObservation {
  readonly status: TaskStatus;
  /** Lets the launcher reject a task that is not running the expected recipe. */
  readonly taskDefinitionArn: string;
}

/** The trusted parts of a RunTask request, read from the workload stack's outputs. */
export type TaskRecipe = Omit<FixedTaskRequest, 'clientToken' | 'startedBy'>;

/** Everything the launcher needs from AWS, so its decisions can be tested with fakes. */
export interface LauncherPorts {
  /** Reads the lease row with a strongly consistent read. */
  readLease(): Promise<Lease>;
  /**
   * Writes `lease` only if the stored version still equals `previousVersion` and the
   * lease is not disabled.
   *
   * @returns false when another writer won, so the caller should re-read and retry
   */
  compareAndSwap(previousVersion: number, lease: Lease): Promise<boolean>;
  observeTask(taskArn: string): Promise<TaskObservation>;
  /** The case's watch row, or undefined while the watcher has not written one. */
  readWatch(caseId: SandboxCaseId): Promise<WatchRow | undefined>;
  resolveTaskRecipe(request: LaunchRequest): Promise<TaskRecipe>;
  /** Starts the task; ECS starts at most one task per client token. */
  runTask(request: FixedTaskRequest): Promise<string>;
  /** Derives the same client token for the same reservation key on every call. */
  deriveClientToken(reservationKey: string): string;
  /** Current time in epoch milliseconds. */
  now(): number;
}

/**
 * Validates a launch request and checks that it targets this experiment.
 *
 * @throws Error when a field is missing, unknown or unregistered, or the experiment differs
 */
export function parseLaunchRequestFor(value: unknown, experimentId: string): LaunchRequest {
  const request = parseLaunchRequest(value);

  if (request.experimentId !== experimentId) {
    throw new Error('launch request is for another experiment');
  }

  return request;
}

/**
 * Whether the watcher is ready, reports OK, and wrote within the heartbeat window.
 * A heartbeat from the future also counts as unhealthy.
 */
export function isWatchHealthy(watch: WatchRow | undefined, now: number): boolean {
  if (!watch?.ready || watch.verdict !== 'OK') {
    return false;
  }

  const age = now - watch.heartbeatAt;

  return age >= 0 && age <= WATCH_HEARTBEAT_MAX_AGE_MS;
}

/**
 * Starts one trial step, or reports the status of the step already started.
 *
 * The reservation is written to the lease before ECS is called, and a retry with the
 * same IDs reuses the stored request and client token. So a lost response never starts
 * a second task, and calling again simply polls the step.
 *
 * @throws Error when the lease is closed or a rule refuses the step; the message names the rule
 */
export async function launch(request: LaunchRequest, ports: LauncherPorts): Promise<LaunchResult> {
  const key = reservationKey(request.caseId, request.stepId);

  for (let attempt = 0; attempt < MAX_LEASE_WRITE_ATTEMPTS; attempt++) {
    const lease = await ports.readLease();
    const now = ports.now();

    assertLeaseOpen(lease, request.experimentId, now);
    await refreshActiveTasks(lease, ports);

    const reservation = lease.requests[key] ?? (await reserveLaunch(lease, request, ports, now));
    const previousVersion = lease.version;

    lease.version = previousVersion + 1;

    if (!(await ports.compareAndSwap(previousVersion, lease))) {
      continue;
    }

    if (!reservation.taskArn && reservation.status === 'PENDING') {
      return startReservedTask(request, reservation, ports);
    }

    return { ...request, status: reservation.status, taskArn: reservation.taskArn };
  }

  throw new Error('Concurrent state update; retry the same IDs');
}

/** Key of a step's reservation in the lease row, such as `good:gate`. */
function reservationKey(caseId: SandboxCaseId, stepId: SandboxStepId): string {
  return `${caseId}:${stepId}`;
}

function isActive(reservation: Reservation): boolean {
  return reservation.status === 'PENDING' || reservation.status === 'RUNNING';
}

function assertLeaseOpen(lease: Lease, experimentId: string, now: number): void {
  if (lease.experimentId !== experimentId || lease.disabled || now >= Date.parse(lease.expiresAt)) {
    throw new Error('Lease is disabled or expired');
  }
}

/** Updates the status of every started, unfinished task from ECS. Mutates `lease`. */
async function refreshActiveTasks(lease: Lease, ports: LauncherPorts): Promise<void> {
  for (const reservation of Object.values(lease.requests)) {
    if (!reservation.taskArn || !isActive(reservation)) {
      continue;
    }

    const observed = await ports.observeTask(reservation.taskArn);

    if (observed.taskDefinitionArn !== reservation.taskDefinitionArn) {
      throw new Error('Observed task recipe mismatch');
    }

    reservation.status = observed.status;
  }
}

/**
 * Checks every rule for a new step, then adds its reservation to `lease` and counts it
 * against the total launch cap. Mutates `lease`; the caller persists it.
 */
async function reserveLaunch(
  lease: Lease,
  request: LaunchRequest,
  ports: LauncherPorts,
  now: number,
): Promise<Reservation> {
  assertCaseOwnsRun(lease, request.caseId);

  if (now >= Date.parse(lease.rejectNewWorkAt)) {
    throw new Error('New work cutoff reached');
  }

  assertBelowLaunchCaps(lease);
  await assertStepOrder(lease, request, ports, now);

  const key = reservationKey(request.caseId, request.stepId);
  const token = ports.deriveClientToken(`${lease.experimentId}:${key}`);
  const recipe = await ports.resolveTaskRecipe(request);

  const reservation: Reservation = {
    token,
    status: 'PENDING',
    taskDefinitionArn: recipe.taskDefinition,
    request: {
      ...recipe,
      clientToken: token,
      startedBy: token.slice(0, ECS_STARTED_BY_MAX_LENGTH),
    },
  };

  lease.requests[key] = reservation;
  lease.total += 1;

  return reservation;
}

/**
 * Only one case may run at a time. A case keeps ownership from its successful gate
 * until its release has been reserved, so another case cannot slip in between.
 */
function assertCaseOwnsRun(lease: Lease, caseId: SandboxCaseId): void {
  for (const otherCase of SANDBOX_CASE_IDS) {
    if (otherCase === caseId) {
      continue;
    }

    const otherIsActive = Object.entries(lease.requests).some(
      ([key, reservation]) => key.startsWith(`${otherCase}:`) && isActive(reservation),
    );

    const gate = lease.requests[reservationKey(otherCase, 'gate')];
    const release = lease.requests[reservationKey(otherCase, 'release')];
    const awaitingRelease = gate?.status === 'SUCCEEDED' && !release;

    if (otherIsActive || awaitingRelease) {
      throw new Error('Only one case may own the active run');
    }
  }
}

function assertBelowLaunchCaps(lease: Lease): void {
  const activeCount = Object.values(lease.requests).filter(isActive).length;

  if (
    lease.total >= SANDBOX_LIMITS.maxTotalLaunches ||
    activeCount >= SANDBOX_LIMITS.maxConcurrentTasks
  ) {
    throw new Error('Launch ceiling reached');
  }
}

/** Watch and release need a successful gate; release also needs a running, healthy watcher. */
async function assertStepOrder(
  lease: Lease,
  request: LaunchRequest,
  ports: LauncherPorts,
  now: number,
): Promise<void> {
  const gate = lease.requests[reservationKey(request.caseId, 'gate')];

  if (request.stepId !== 'gate' && gate?.status !== 'SUCCEEDED') {
    throw new Error('Observed successful gate is required');
  }

  if (request.stepId !== 'release') {
    return;
  }

  const watchTask = lease.requests[reservationKey(request.caseId, 'watch')];
  const watch = await ports.readWatch(request.caseId);

  if (watchTask?.status !== 'RUNNING' || !isWatchHealthy(watch, now)) {
    throw new Error('Fresh healthy watcher is required');
  }
}

/** Starts a reserved step's task, after re-checking that the lease is still open. */
async function startReservedTask(
  request: LaunchRequest,
  reservation: Reservation,
  ports: LauncherPorts,
): Promise<LaunchResult> {
  const latestLease = await ports.readLease();

  if (latestLease.disabled || ports.now() >= Date.parse(latestLease.expiresAt)) {
    throw new Error('Lease disabled before task launch');
  }

  if (!reservation.request) {
    throw new Error('Fixed request missing from protected reservation');
  }

  const taskArn = await ports.runTask(reservation.request);

  return recordStartedTask(request, reservation, reservation.request, taskArn, ports);
}

/**
 * Stores the started task's ARN in its reservation. Concurrent retries may race here;
 * they describe the same idempotent RunTask request, so the first stored ARN wins.
 */
async function recordStartedTask(
  request: LaunchRequest,
  reservation: Reservation,
  taskRequest: FixedTaskRequest,
  taskArn: string,
  ports: LauncherPorts,
): Promise<LaunchResult> {
  const key = reservationKey(request.caseId, request.stepId);

  for (let attempt = 0; attempt < MAX_LEASE_WRITE_ATTEMPTS; attempt++) {
    const lease = await ports.readLease();
    const stored = lease.requests[key];

    if (!stored || stored.token !== reservation.token) {
      throw new Error('Reservation lost');
    }

    if (stored.taskArn) {
      return { ...request, status: stored.status, taskArn: stored.taskArn };
    }

    stored.taskArn = taskArn;
    stored.taskDefinitionArn = taskRequest.taskDefinition;

    const previousVersion = lease.version;

    lease.version = previousVersion + 1;

    if (await ports.compareAndSwap(previousVersion, lease)) {
      return { ...request, status: stored.status, taskArn };
    }
  }

  throw new Error('Task launched; retry the same IDs to reconcile reservation');
}
