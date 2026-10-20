/**
 * Which ECS deployment-safety behaviour a spike run exercises.
 *
 * - `halt`: deployment alarms fail the deployment without an ECS rollback.
 * - `revert`: deployment alarms fail the deployment and ECS rolls it back.
 * - `breaker`: like `revert`, plus the deployment circuit breaker without
 *   rollback.
 */
export type SpikeProfile = 'halt' | 'revert' | 'breaker';

/** CloudWatch `TreatMissingData` for the watch-verdict bridge alarm. */
export type BridgeMissingData = 'notBreaching' | 'breaching' | 'missing';

/** Whether ECS watches the rollback composite as well as its member alarms. */
export type DeploymentAlarmSet = 'all' | 'members';

/**
 * `activeTaskDefinitionArn` value for the very first deploy only: the service
 * starts on the recipe. On an existing stack it would reset the service to
 * the recipe's image, so only `infra-deploy.sh bootstrap` passes it.
 */
export const BOOTSTRAP_RECIPE = 'bootstrap-recipe';

/** An ECS task definition ARN with a revision number. */
export const TASK_DEFINITION_ARN_PATTERN =
  /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_-]+:[0-9]+$/;

export interface EcsCanarySpikeConfig {
  readonly allowedIngressPrefixListId: string;
  readonly profile: SpikeProfile;
  readonly bridgeMissingData: BridgeMissingData;
  readonly deploymentAlarmSet: DeploymentAlarmSet;
  /** Calendar date (YYYY-MM-DD) recorded in the `ExpiresOn` teardown tag. */
  readonly expiresOn: string;
  /**
   * Cluster tag value. Changing it is an infra change that leaves the recipe
   * task definition alone (run R5c-3, first half).
   */
  readonly infraRevision: string;
  /**
   * Container environment value. Changing it changes the recipe task
   * definition, which must trigger a release (run R5c-3, second half).
   */
  readonly recipeRevision: string;
  /**
   * The task definition the service must run: the revision ECS runs now, or
   * `BOOTSTRAP_RECIPE`. Synth-time context, not a CloudFormation parameter,
   * so no deploy can silently reuse a stale value. `undefined` makes the
   * service stack fail validation (see EcsCanarySpikeServiceStack).
   */
  readonly activeTaskDefinitionArn: string | undefined;
  /**
   * Adds a resource that fails after the service update, so the stack rolls
   * back (run R5c-4).
   */
  readonly failInfraDeploy: boolean;
}

/** Expected configuration failure, safe to show at the CDK CLI boundary. */
export class EcsCanarySpikeConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EcsCanarySpikeConfigError';
  }
}

const SPIKE_PROFILES: readonly SpikeProfile[] = ['halt', 'revert', 'breaker'];
const BRIDGE_MISSING_DATA: readonly BridgeMissingData[] = ['notBreaching', 'breaching', 'missing'];
const DEPLOYMENT_ALARM_SETS: readonly DeploymentAlarmSet[] = ['all', 'members'];

/**
 * Validate untrusted CDK context once and return typed spike configuration.
 *
 * Context arrives as `unknown` because `-c key=value` and `cdk.json` are
 * operator input. TypeScript types do not exist at runtime, so every value is
 * checked here before the stacks use it.
 *
 * @param readContext reads one CDK context key, for example
 *   `(key) => app.node.tryGetContext(key)`
 */
export function parseEcsCanarySpikeConfig(
  readContext: (key: string) => unknown,
): EcsCanarySpikeConfig {
  return {
    allowedIngressPrefixListId: parsePrefixListId(readContext('allowedIngressPrefixListId')),
    profile: parseChoice(readContext('spikeProfile'), 'spikeProfile', SPIKE_PROFILES, 'halt'),
    bridgeMissingData: parseChoice(
      readContext('bridgeMissingData'),
      'bridgeMissingData',
      BRIDGE_MISSING_DATA,
      'notBreaching',
    ),
    deploymentAlarmSet: parseChoice(
      readContext('deploymentAlarmSet'),
      'deploymentAlarmSet',
      DEPLOYMENT_ALARM_SETS,
      'all',
    ),
    expiresOn: parseExpiresOn(readContext('expiresOn')),
    infraRevision: parseRevision(readContext('infraRevision'), 'infraRevision'),
    recipeRevision: parseRevision(readContext('recipeRevision'), 'recipeRevision'),
    activeTaskDefinitionArn: parseActiveTaskDefinitionArn(readContext('activeTaskDefinitionArn')),
    failInfraDeploy: parseFlag(readContext('failInfraDeploy'), 'failInfraDeploy'),
  };
}

function parsePrefixListId(value: unknown): string {
  if (typeof value !== 'string' || !/^pl-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value)) {
    throw new EcsCanarySpikeConfigError(
      'CDK context value "allowedIngressPrefixListId" must start with pl- and contain exactly 8 or 17 lowercase hexadecimal characters.',
    );
  }
  return value;
}

function parseChoice<T extends string>(
  value: unknown,
  key: string,
  choices: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    throw new EcsCanarySpikeConfigError(
      `CDK context value "${key}" must be one of: ${choices.join(', ')}.`,
    );
  }
  return value as T;
}

function parseExpiresOn(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new EcsCanarySpikeConfigError(
      'CDK context value "expiresOn" must be a YYYY-MM-DD date for the teardown tag.',
    );
  }
  return value;
}

function parseRevision(value: unknown, key: string): string {
  if (value === undefined) {
    return '1';
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(value)) {
    throw new EcsCanarySpikeConfigError(
      `CDK context value "${key}" must be 1-32 letters, digits, or hyphens.`,
    );
  }
  return value;
}

function parseActiveTaskDefinitionArn(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string'
    || (value !== BOOTSTRAP_RECIPE && !TASK_DEFINITION_ARN_PATTERN.test(value))) {
    throw new EcsCanarySpikeConfigError(
      `CDK context value "activeTaskDefinitionArn" must be a task definition ARN with a revision, or ${BOOTSTRAP_RECIPE}.`,
    );
  }
  return value;
}

/** `-c key=true` arrives as a string; cdk.json can hold a real boolean. */
function parseFlag(value: unknown, key: string): boolean {
  if (value === undefined || value === false || value === 'false') {
    return false;
  }
  if (value === true || value === 'true') {
    return true;
  }
  throw new EcsCanarySpikeConfigError(`CDK context value "${key}" must be true or false.`);
}
