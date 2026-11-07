/**
 * Messages and rows exchanged through the control stack. The Harness delegate sends
 * launch requests, the operator writes the lease row, the watch task writes the watch
 * row, and the control Lambdas read all of them. Each reader validates what it reads:
 * a DynamoDB item or a Lambda event is untrusted input, not a typed value.
 */

import { z } from 'zod';

import { experimentIdSchema, isoTimestampSchema } from './field-schemas';
import { cleanupStatusSchema } from './sandbox-record';
import { SANDBOX_CASE_IDS, SANDBOX_STEP_IDS } from './identifiers';
import { parseWithSchema } from './schema-parse';

/** Lifecycle of one trial task, as the launcher last observed it. */
export const TASK_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;

/** The only input the launcher accepts: which registered case and step to run. */
export const launchRequestSchema = z.strictObject({
  experimentId: experimentIdSchema,
  caseId: z.enum(SANDBOX_CASE_IDS),
  stepId: z.enum(SANDBOX_STEP_IDS),
});

/**
 * The exact ECS RunTask request the launcher stores before starting a task, so a
 * retry after a lost response sends the same request with the same client token.
 */
export const fixedTaskRequestSchema = z.object({
  cluster: z.string().min(1),
  taskDefinition: z.string().min(1),
  launchType: z.literal('FARGATE'),
  count: z.literal(1),
  /** Idempotency token: ECS starts at most one task per token. */
  clientToken: z.string().min(1),
  /** Shown on the task in ECS; derived from the client token. */
  startedBy: z.string().min(1),
  networkConfiguration: z.object({
    awsvpcConfiguration: z.object({
      subnets: z.array(z.string().min(1)),
      securityGroups: z.array(z.string().min(1)),
      assignPublicIp: z.literal('ENABLED'),
    }),
  }),
});

/** One reserved launch of a case step, stored in the lease row under `<caseId>:<stepId>`. */
export const reservationSchema = z.object({
  token: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  /** Set once ECS confirmed the task; absent while the launch is only reserved. */
  taskArn: z.string().min(1).optional(),
  taskDefinitionArn: z.string().min(1).optional(),
  request: fixedTaskRequestSchema.optional(),
});

/**
 * The experiment's lease row in the control state table. The operator installs it
 * with `admit`; the launcher updates it with optimistic `version` checks; cleanup sets
 * `disabled` when the lease ends.
 */
export const leaseRowSchema = z.object({
  experimentId: experimentIdSchema,
  /** Incremented on every write; a write only succeeds if the version is unchanged. */
  version: z.number().int().nonnegative(),
  expiresAt: isoTimestampSchema,
  /** After this time no new reservation is accepted; started steps may finish. */
  rejectNewWorkAt: isoTimestampSchema,
  /** Set by cleanup; a disabled lease never launches again. */
  disabled: z.boolean(),
  /** Reservations accepted over the whole lease, counted against the total launch cap. */
  total: z.number().int().nonnegative(),
  requests: z.record(z.string(), reservationSchema),
});

/** The watch task's latest report for one case, keyed `<experimentId>#<caseId>#watch`. */
export const watchRowSchema = z.object({
  /** The watcher has a healthy baseline and may observe a release. */
  ready: z.boolean(),
  /** Epoch milliseconds of the watcher's latest write. */
  heartbeatAt: z.number().int().nonnegative(),
  verdict: z.enum(['OK', 'FAIL']),
});

/** Input of the cleanup Lambda: from the expiry schedule, or from the operator. */
export const cleanupRequestSchema = z.strictObject({
  experimentId: experimentIdSchema,
  /** Present only on schedule runs, which wait for lease expiry. */
  scheduled: z.literal(true).optional(),
});

/**
 * The only blocker texts cleanup reports. The operator stores nothing else, so raw AWS
 * errors and task output never reach the operator record; details go to the protected
 * cleanup log instead.
 */
export const CLEANUP_BLOCKERS = Object.freeze({
  admissionNotDisabled: 'Unable to disable launch admission',
  provisioningActive: 'Workload provisioning is still active; retry cleanup',
  awsOperationFailed: 'AWS cleanup operation failed; inspect inventory and retry',
} as const);

/**
 * What the cleanup Lambda returns to its caller: the result of one teardown pass, or
 * `WAITING_FOR_EXPIRY` for a schedule run before the lease ends.
 */
export const cleanupResultSchema = z.object({
  experimentId: experimentIdSchema,
  status: cleanupStatusSchema,
  /** Texts from {@link CLEANUP_BLOCKERS}; the operator replaces anything else. */
  blockers: z.array(z.string()),
  /** Workload resources still observed after the pass. */
  resources: z.array(z.string()),
  accessRevoked: z.boolean(),
  workloadsRemoved: z.boolean(),
});

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export type FixedTaskRequest = z.infer<typeof fixedTaskRequestSchema>;

export type Reservation = z.infer<typeof reservationSchema>;

export type LeaseRow = z.infer<typeof leaseRowSchema>;

export type WatchRow = z.infer<typeof watchRowSchema>;

export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;

export type CleanupResult = z.infer<typeof cleanupResultSchema>;

/**
 * The lease row the operator's `admit` installs: nothing launched yet, version 0.
 * The launcher and cleanup Lambdas then read and update it.
 */
export function newLeaseRow(
  experimentId: string,
  lease: { readonly expiresAt: string; readonly rejectNewWorkAt: string },
): LeaseRow {
  return {
    experimentId,
    version: 0,
    expiresAt: lease.expiresAt,
    rejectNewWorkAt: lease.rejectNewWorkAt,
    disabled: false,
    total: 0,
    requests: {},
  };
}

/** The input the expiry schedule sends to the cleanup Lambda every five minutes. */
export function scheduledCleanupRequest(experimentId: string): CleanupRequest {
  return { experimentId, scheduled: true };
}

/**
 * Validates a launch request.
 *
 * @throws Error naming each invalid field; unknown keys are listed first
 */
export function parseLaunchRequest(value: unknown): LaunchRequest {
  return parseWithSchema(launchRequestSchema, value, 'launchRequest');
}

/**
 * Validates a lease row read from the control state table.
 *
 * @throws Error naming each invalid field
 */
export function parseLeaseRow(value: unknown): LeaseRow {
  return parseWithSchema(leaseRowSchema, value, 'lease');
}

/**
 * Validates a watch row read from the control state table.
 *
 * @throws Error naming each invalid field
 */
export function parseWatchRow(value: unknown): WatchRow {
  return parseWithSchema(watchRowSchema, value, 'watch');
}

/**
 * Validates the cleanup Lambda's response.
 *
 * @throws Error naming each invalid field
 */
export function parseCleanupResult(value: unknown): CleanupResult {
  return parseWithSchema(cleanupResultSchema, value, 'cleanupResult');
}

/**
 * Validates a cleanup Lambda event.
 *
 * @throws Error naming each invalid field; unknown keys are listed first
 */
export function parseCleanupRequest(value: unknown): CleanupRequest {
  return parseWithSchema(cleanupRequestSchema, value, 'cleanupRequest');
}
