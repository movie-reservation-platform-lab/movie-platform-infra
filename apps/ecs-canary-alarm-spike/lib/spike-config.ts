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

export interface EcsCanarySpikeConfig {
  readonly allowedIngressPrefixListId: string;
  readonly profile: SpikeProfile;
  readonly bridgeMissingData: BridgeMissingData;
  readonly deploymentAlarmSet: DeploymentAlarmSet;
  /** Calendar date (YYYY-MM-DD) recorded in the `ExpiresOn` teardown tag. */
  readonly expiresOn: string;
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
