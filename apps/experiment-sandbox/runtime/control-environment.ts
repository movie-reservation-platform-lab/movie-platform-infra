/**
 * The environment variables of the control Lambdas, validated once into a typed object.
 */

import { z } from 'zod';

/**
 * Settings the control stack passes to all three Lambdas as environment variables
 * (`createHandlers` in `lib/control-stack.ts`). Validated once per Lambda instance, so a
 * missing or empty variable fails at the first call instead of halfway through cleanup.
 */
export interface ControlEnvironment {
  readonly experimentId: string;
  readonly stateTableName: string;
  readonly inventoryBucketName: string;
  readonly workloadStackName: string;
  readonly clusterArn: string;
  /** Lease expiry; the schedule starts cleanup only after this time. */
  readonly expiresAt: string;
  readonly launchCutoffAt: string;
  /** CloudFormation service role cleanup passes to DeleteStack. */
  readonly workloadDeletionRoleArn: string;
}

const requiredText = z.string().min(1);

const environmentSchema = z
  .object({
    EXPERIMENT_ID: requiredText,
    STATE_TABLE: requiredText,
    INVENTORY_BUCKET: requiredText,
    WORKLOAD_STACK: requiredText,
    CLUSTER_ARN: requiredText,
    EXPIRES_AT: z.iso.datetime(),
    LAUNCH_CUTOFF_AT: z.iso.datetime(),
    WORKLOAD_DELETION_ROLE: requiredText,
  })
  .transform((variables): ControlEnvironment => ({
    experimentId: variables.EXPERIMENT_ID,
    stateTableName: variables.STATE_TABLE,
    inventoryBucketName: variables.INVENTORY_BUCKET,
    workloadStackName: variables.WORKLOAD_STACK,
    clusterArn: variables.CLUSTER_ARN,
    expiresAt: variables.EXPIRES_AT,
    launchCutoffAt: variables.LAUNCH_CUTOFF_AT,
    workloadDeletionRoleArn: variables.WORKLOAD_DELETION_ROLE,
  }));

let cachedEnvironment: ControlEnvironment | undefined;

/**
 * Reads and validates the Lambda environment on first use, then returns the cached result.
 *
 * @throws Error naming the missing or invalid variables, never their values
 */
export function controlEnvironment(): ControlEnvironment {
  if (cachedEnvironment) {
    return cachedEnvironment;
  }

  const result = environmentSchema.safeParse(process.env);

  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join('.')).join(', ');

    throw new Error(`Invalid control Lambda environment: ${names}`);
  }

  cachedEnvironment = result.data;

  return cachedEnvironment;
}
