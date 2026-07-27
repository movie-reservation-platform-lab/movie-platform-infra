/**
 * Fully resolved infrastructure settings consumed by `GoldenPathDemoStack`.
 *
 * Fixed literal values document deliberate Wave 2 architecture decisions and
 * keep them out of caller-controlled CDK context.
 */
export interface PlatformConfig {
  readonly platformName: 'movie-reservation-platform';
  readonly serviceName: 'movie-reservation-service';
  readonly environmentName: 'aws-demo';
  readonly allowedIngressCidr: string;
  readonly vpcMaxAzs: 2;
  readonly workloadAzCount: 1;
  readonly enableEcsExec: boolean;
  readonly metricsExportIntervalSeconds: number;
}

/**
 * Untrusted CDK context values accepted at the application entrypoint.
 * `resolvePlatformConfig` validates and normalizes these values once before
 * the typed configuration is passed into the stack.
 */
export interface PlatformConfigContext {
  readonly allowedIngressCidr?: unknown;
  readonly enableEcsExec?: unknown;
  readonly metricsExportIntervalSeconds?: unknown;
}

function parseRequiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CDK context value "${key}" is required. Example: -c ${key}=203.0.113.10/32`);
  }

  return value.trim();
}

function parseAllowedIngressCidr(value: unknown): string {
  const cidr = parseRequiredString(value, 'allowedIngressCidr');

  if (cidr === '0.0.0.0/0') {
    throw new Error(
      'CDK context value "allowedIngressCidr" must not be 0.0.0.0/0. Use your current public IP with a /32 mask.',
    );
  }

  return cidr;
}

function parseBoolean(value: unknown, key: string): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`CDK context value "${key}" must be true or false.`);
}

function parseIntegerInRange(
  value: unknown,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsedValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsedValue)) {
    throw new Error(`CDK context value "${key}" must be an integer from ${minimum} through ${maximum}.`);
  }

  if (parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`CDK context value "${key}" must be from ${minimum} through ${maximum}.`);
  }

  return parsedValue;
}

export function resolvePlatformConfig(context: PlatformConfigContext): PlatformConfig {
  return {
    platformName: 'movie-reservation-platform',
    serviceName: 'movie-reservation-service',
    environmentName: 'aws-demo',
    allowedIngressCidr: parseAllowedIngressCidr(context.allowedIngressCidr),
    vpcMaxAzs: 2,
    workloadAzCount: 1,
    enableEcsExec: parseBoolean(context.enableEcsExec, 'enableEcsExec'),
    metricsExportIntervalSeconds: parseIntegerInRange(
      context.metricsExportIntervalSeconds,
      'metricsExportIntervalSeconds',
      30,
      5,
      300,
    ),
  };
}
