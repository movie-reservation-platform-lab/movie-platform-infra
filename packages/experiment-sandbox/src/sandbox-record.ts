import { z } from 'zod';

import {
  absolutePathSchema,
  awsAccountIdSchema,
  boundedTextSchema,
  isoTimestampSchema,
  nonNegativeNumberSchema,
  textMatching,
} from './field-schemas';
import { HOUR_MS, SANDBOX_LIMITS } from './sandbox-limits';

// The schemas below are the single source of truth: each exported type is
// inferred from its schema, so the runtime check and the compile-time type
// cannot drift apart. Rules within one object live on that object's schema;
// rules that compare two parts of the record live in `parse-record.ts`.

const DIGEST_IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9/_.-]*@sha256:[a-f0-9]{64}$/;

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

/**
 * Whether `value` is a registry image pinned by `sha256` digest, never by a
 * mutable tag. Shared by the record schema and the CDK app's config check.
 */
export function isDigestImageReference(value: string): boolean {
  return DIGEST_IMAGE_REFERENCE.test(value);
}

/** Lifecycle of the sandbox account, from planned creation to confirmed closure. */
export const SANDBOX_ACCOUNT_STATES = [
  'planned',
  'submitting',
  'unknown',
  'requested',
  'ready',
  'failed',
  'closure-intent',
  'closure-unknown',
  'closure-requested',
  'closed',
] as const;

/** Progress of the protected cleanup, as last observed by the operator. */
export const cleanupStatusSchema = z.enum([
  'WAITING_FOR_EXPIRY',
  'DELETING',
  'BLOCKED',
  'COMPLETE',
]);

/**
 * The dedicated AWS account that hosts one experiment. `name` must end with
 * `correlationId`, so a lost create response can be matched to its request.
 * The `*VerifiedAt` and `*Evidence` pairs record pre-allocation checks.
 */
export const sandboxAccountSchema = z
  .strictObject({
    email: textMatching(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
    name: textMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/),
    correlationId: textMatching(/^[a-z0-9][a-z0-9-]{7,63}$/),
    state: z.enum(SANDBOX_ACCOUNT_STATES),
    /** Deadline after which an unfinished account preparation must be recovered. */
    preparationExpiresAt: isoTimestampSchema,
    /** AWS Organizations create-account request ID. */
    requestId: textMatching(/^car-[a-z0-9-]+$/).optional(),
    accountId: awsAccountIdSchema.optional(),
    capacityVerifiedAt: isoTimestampSchema.optional(),
    capacityEvidence: boundedTextSchema.optional(),
    recoveryVerifiedAt: isoTimestampSchema.optional(),
    recoveryEvidence: boundedTextSchema.optional(),
  })
  .superRefine((account, context) => {
    if (!account.name.endsWith(account.correlationId)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'must end with unique correlationId',
      });
    }

    if (account.state === 'ready' && !account.accountId) {
      context.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'ready account requires accountId',
      });
    }
  })
  .readonly();

/** The two recommendation-service images the trial deploys: one healthy, one broken. */
export const trialImagesSchema = z
  .strictObject({
    good: boundedTextSchema,
    bad: boundedTextSchema,
    verifiedAt: isoTimestampSchema.optional(),
    verificationEvidence: boundedTextSchema.optional(),
  })
  .superRefine((images, context) => {
    const bothPinned = isDigestImageReference(images.good) && isDigestImageReference(images.bad);

    if (!bothPinned || images.good === images.bad) {
      context.addIssue({
        code: 'custom',
        message: 'images require distinct immutable digest references',
      });
    }
  })
  .readonly();

/**
 * Evidence about the Harness plan ("entitlement") used for the trial. It
 * covers the Harness side of the cost only; AWS spend is in {@link costForecastSchema}.
 */
export const harnessEntitlementSchema = z
  .strictObject({
    /** The plan costs nothing, for example a free tier or free trial. */
    zeroCharge: z.boolean(),
    /** When the free plan ends; it must last at least until the lease expires. */
    expiresAt: isoTimestampSchema,
    verifiedAt: isoTimestampSchema.optional(),
    evidence: boundedTextSchema.optional(),
  })
  .readonly();

/** AWS cost forecast in US dollars against the fixed experiment allowance in {@link SANDBOX_LIMITS}. */
export const costForecastSchema = z
  .strictObject({
    operatingUsd: nonNegativeNumberSchema,
    contingencyUsd: nonNegativeNumberSchema,
    allowanceUsd: z.literal(SANDBOX_LIMITS.allowanceUsd),
    forecastAt: isoTimestampSchema.optional(),
    evidence: boundedTextSchema.optional(),
    complete: z.boolean(),
  })
  .readonly();

const LEASE_CAPS_MESSAGE = `lease task/runtime caps must be ${SANDBOX_LIMITS.maxConcurrentTasks}/${SANDBOX_LIMITS.maxTotalLaunches}/${SANDBOX_LIMITS.maxRunMinutes}`;

const LEASE_WINDOW_MESSAGE = `lease must expire within ${SANDBOX_LIMITS.maxLeaseHours}h and reject new work within ${SANDBOX_LIMITS.maxNewWorkHours}h`;

/**
 * The time-boxed permission to use the sandbox, like a rental agreement: when
 * it starts and ends, when new work stops, and how many trial tasks may run.
 * The caps must equal {@link SANDBOX_LIMITS}: changing them is a contract
 * change, not an operator input. The launcher enforces the lease live.
 */
export const sandboxLeaseSchema = z
  .strictObject({
    startsAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    /** After this time the launcher refuses new tasks; running ones may finish. */
    rejectNewWorkAt: isoTimestampSchema,
    maxConcurrentTasks: z.literal(SANDBOX_LIMITS.maxConcurrentTasks, LEASE_CAPS_MESSAGE),
    maxTotalLaunches: z.literal(SANDBOX_LIMITS.maxTotalLaunches, LEASE_CAPS_MESSAGE),
    maxRunMinutes: z.literal(SANDBOX_LIMITS.maxRunMinutes, LEASE_CAPS_MESSAGE),
  })
  .superRefine((lease, context) => {
    const start = Date.parse(lease.startsAt);
    const end = Date.parse(lease.expiresAt);
    const cutoff = Date.parse(lease.rejectNewWorkAt);

    const leaseFits = end > start && end - start <= SANDBOX_LIMITS.maxLeaseHours * HOUR_MS;

    const cutoffFits =
      cutoff > start && cutoff <= end && cutoff - start <= SANDBOX_LIMITS.maxNewWorkHours * HOUR_MS;

    if (!leaseFits || !cutoffFits) {
      context.addIssue({
        code: 'custom',
        message: LEASE_WINDOW_MESSAGE,
      });
    }
  })
  .readonly();

const REQUIRED_CONTROL_CLASSES = [
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::Logs::LogGroup',
] as const;

const controlResourceBase = {
  logicalId: textMatching(/^[A-Za-z][A-Za-z0-9]{0,254}$/),
  arn: boundedTextSchema,
  /** When the operator last observed this resource as deleted. */
  absentObservedAt: isoTimestampSchema.optional(),
};

/**
 * One retained resource of a deleted control stack. Its ARN must match the
 * ARN derived from `physicalId`; `parse-record.ts` checks that binding.
 */
export const retiredControlResourceSchema = z.discriminatedUnion(
  'resourceClass',
  [
    z
      .strictObject({
        ...controlResourceBase,
        resourceClass: z.literal('AWS::DynamoDB::Table'),
        physicalId: textMatching(/^[A-Za-z0-9_.-]{3,255}$/),
      })
      .readonly(),
    z
      .strictObject({
        ...controlResourceBase,
        resourceClass: z.literal('AWS::S3::Bucket'),
        physicalId: textMatching(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
      })
      .readonly(),
    z
      .strictObject({
        ...controlResourceBase,
        resourceClass: z.literal('AWS::Logs::LogGroup'),
        physicalId: textMatching(/^[-_.#A-Za-z0-9/]{1,512}$/),
      })
      .readonly(),
  ],
  { error: 'Unknown control resource class blocks retirement' },
);

/**
 * Manifest of control-stack resources captured before the stack was deleted.
 * It lets cleanup remove retained remnants and later prove they are gone.
 * Timestamps alone never prove absence; the operator re-checks live state.
 */
export const retiredControlsSchema = z
  .strictObject({
    /** CloudFormation stack ARN; bound to the record's account, region and stack name. */
    stackId: boundedTextSchema,
    capturedAt: isoTimestampSchema,
    templateSha256: textMatching(/^[a-f0-9]{64}$/),
    resources: z
      .array(retiredControlResourceSchema)
      .min(3, 'Complete bounded control manifest required')
      .max(1000, 'Complete bounded control manifest required')
      .readonly(),
    /** Set only when every resource has an `absentObservedAt`. */
    verifiedAbsentAt: isoTimestampSchema.optional(),
  })
  .superRefine((manifest, context) => {
    const classes = new Set(manifest.resources.map((resource) => resource.resourceClass));

    const hasEveryClass = REQUIRED_CONTROL_CLASSES.every((resourceClass) =>
      classes.has(resourceClass),
    );

    if (!hasEveryClass) {
      context.addIssue({
        code: 'custom',
        path: ['resources'],
        message: 'Control manifest must include state table, versioned inventory bucket and logs',
      });
    }

    const logicalIds = manifest.resources.map((resource) => resource.logicalId);

    if (new Set(logicalIds).size !== logicalIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['resources'],
        message: 'Control manifest identity mismatch or duplicate',
      });
    }

    const everyAbsenceObserved = manifest.resources.every((resource) => resource.absentObservedAt);

    if (manifest.verifiedAbsentAt && !everyAbsenceObserved) {
      context.addIssue({
        code: 'custom',
        path: ['verifiedAbsentAt'],
        message: 'Control absence needs every resource observation',
      });
    }
  })
  .readonly();

/** What the operator has deployed and how far cleanup has progressed. */
export const sandboxInventorySchema = z
  .strictObject({
    stackName: textMatching(STACK_NAME).optional(),
    controlStackName: textMatching(STACK_NAME).optional(),
    resources: z.array(boundedTextSchema).max(1000).readonly(),
    cleanupStatus: cleanupStatusSchema.optional(),
    cleanupBlockers: z.array(boundedTextSchema.max(256)).max(20).readonly().optional(),
    cleanupInstalled: z.boolean(),
    cleanupVerified: z.boolean(),
    accessRevoked: z.boolean(),
    workloadsRemoved: z.boolean(),
    observedAt: isoTimestampSchema.optional(),
    retiredControls: retiredControlsSchema.optional(),
  })
  .readonly();

/**
 * The operator's private record for one experiment. Operator-owned data only:
 * never place credentials or tokens in it. Unknown keys are rejected at every
 * level, so a stray `token` field fails instead of being carried along.
 */
export const sandboxRecordSchema = z
  .strictObject({
    version: z.literal(1),
    id: textMatching(/^exp-[a-z0-9-]{3,24}$/),
    owner: boundedTextSchema,
    region: z.literal(SANDBOX_LIMITS.region),
    managementTargetFile: absolutePathSchema,
    managementAccountId: awsAccountIdSchema,
    sandboxTargetFile: absolutePathSchema.optional(),
    account: sandboxAccountSchema,
    images: trialImagesSchema,
    entitlement: harnessEntitlementSchema,
    cost: costForecastSchema,
    lease: sandboxLeaseSchema,
    inventory: sandboxInventorySchema,
  })
  .readonly();

export type SandboxAccountState = (typeof SANDBOX_ACCOUNT_STATES)[number];

export type CleanupStatus = z.infer<typeof cleanupStatusSchema>;

export type SandboxAccount = z.infer<typeof sandboxAccountSchema>;

export type TrialImages = z.infer<typeof trialImagesSchema>;

export type HarnessEntitlement = z.infer<typeof harnessEntitlementSchema>;

export type CostForecast = z.infer<typeof costForecastSchema>;

export type SandboxLease = z.infer<typeof sandboxLeaseSchema>;

export type RetiredControlResource = z.infer<typeof retiredControlResourceSchema>;

export type RetiredControls = z.infer<typeof retiredControlsSchema>;

export type SandboxInventory = z.infer<typeof sandboxInventorySchema>;

export type SandboxRecord = z.infer<typeof sandboxRecordSchema>;
