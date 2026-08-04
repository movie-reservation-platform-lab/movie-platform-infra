/**
 * Validated application-image input consumed by the image resolver.
 *
 * The CDK context boundary carries every parsed value required to import an
 * immutable externally built application image.
 */
export interface ApplicationImageConfig {
  /** Deploy an existing private ECR image rather than building application source. */
  readonly kind: 'ecr-image';
  /** Complete, trimmed ECR URI supplied by the caller for traceability. */
  readonly imageReference: string;
  /** Twelve-digit AWS account parsed from the ECR registry hostname. */
  readonly registryAccount: string;
  /** AWS Region parsed from the ECR registry hostname. */
  readonly registryRegion: string;
  /** Repository path parsed from the ECR URI. */
  readonly repositoryName: string;
  /** Immutable `sha256:<64-hex-characters>` image digest. */
  readonly imageDigest: string;
  /** Opaque release identifier exposed to the service and telemetry. */
  readonly serviceVersion: string;
}

/** Concrete AWS account and Region selected for the CDK stack. */
export interface DeploymentTarget {
  /** AWS account selected by the CDK CLI, if the stack is environment-specific. */
  readonly account?: string;
  /** AWS Region selected by the CDK CLI, if the stack is environment-specific. */
  readonly region?: string;
}

/**
 * Fully resolved infrastructure settings consumed by `GoldenPathDemoStack`.
 *
 * Fixed literal values document deliberate Wave 2 architecture decisions and
 * keep them out of caller-controlled CDK context.
 */
export interface PlatformConfig {
  /** Stable platform identifier used in resource names, tags, and telemetry. */
  readonly platformName: 'movie-reservation-platform';
  /** Stable workload identifier used in ECS and observability configuration. */
  readonly serviceName: 'movie-reservation-service';
  /** Deployment-environment identifier for this disposable AWS demo. */
  readonly environmentName: 'aws-demo';
  /** Trusted IPv4 CIDR allowed to reach the public load balancer. */
  readonly allowedIngressCidr: string;
  /** Validated immutable-ECR image selection. */
  readonly applicationImage: ApplicationImageConfig;
  /** Number of Availability Zones used when defining the VPC. */
  readonly vpcMaxAzs: 2;
  /** Number of isolated workload subnets used by the ECS service. */
  readonly workloadAzCount: 1;
  /** Whether ECS Exec and its supporting endpoint and IAM permissions are enabled. */
  readonly enableEcsExec: boolean;
  /** Application and collector metric export interval, in seconds. */
  readonly metricsExportIntervalSeconds: number;
}

/**
 * Untrusted CDK context values accepted at the application entrypoint.
 * `resolvePlatformConfig` validates and normalizes these values once before
 * the typed configuration is passed into the stack.
 */
export interface PlatformConfigContext {
  /** Required IPv4 CIDR accepted from `-c allowedIngressCidr=...`. */
  readonly allowedIngressCidr?: unknown;
  /** Optional complete private ECR URI; must be paired with a service version. */
  readonly applicationImageReference?: unknown;
  /** Optional opaque release identifier; must be paired with an ECR URI. */
  readonly applicationServiceVersion?: unknown;
  /** Optional boolean or `"true"`/`"false"` string controlling ECS Exec. */
  readonly enableEcsExec?: unknown;
  /** Optional integer export interval accepted as a number or numeric string. */
  readonly metricsExportIntervalSeconds?: unknown;
}

/**
 * Accepted external-image shape for the initial contract: a standard private
 * ECR hostname, repository path, and full SHA-256 digest with no mutable tag.
 */
const PRIVATE_ECR_IMAGE_REFERENCE_PATTERN =
  /^(?<registryAccount>\d{12})\.dkr\.ecr\.(?<registryRegion>[a-z]{2}(?:-[a-z0-9]+)+-\d)\.amazonaws\.com\/(?<repositoryName>(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)@(?<imageDigest>sha256:[0-9a-fA-F]{64})$/;

/** Offline syntax checks for concrete CDK deployment targets. */
const AWS_ACCOUNT_PATTERN = /^\d{12}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;

/** Returns a trimmed required CDK context string or fails at the boundary. */
function parseRequiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CDK context value "${key}" is required. Example: -c ${key}=203.0.113.10/32`);
  }

  return value.trim();
}

/**
 * Resolves the public ALB ingress boundary and rejects internet-wide access.
 *
 * Full CIDR syntax is validated later by the CDK networking construct.
 */
function parseAllowedIngressCidr(value: unknown): string {
  const cidr = parseRequiredString(value, 'allowedIngressCidr');

  if (cidr === '0.0.0.0/0') {
    throw new Error(
      'CDK context value "allowedIngressCidr" must not be 0.0.0.0/0. Use your current public IP with a /32 mask.',
    );
  }

  return cidr;
}

/**
 * Validates the required immutable ECR pair and returns parsed fields safe for
 * internal use.
 *
 * Validation is deliberately offline: it proves syntax and target matching,
 * not that the repository or digest exists in AWS.
 */
function parseApplicationImageConfig(
  context: PlatformConfigContext,
  deploymentTarget: DeploymentTarget,
): ApplicationImageConfig {
  const imageReferenceIsPresent = context.applicationImageReference !== undefined;
  const serviceVersionIsPresent = context.applicationServiceVersion !== undefined;

  if (!imageReferenceIsPresent) {
    throw new Error(
      'CDK context value "applicationImageReference" is required. Supply a private ECR image URI pinned by digest.',
    );
  }

  if (!serviceVersionIsPresent) {
    throw new Error(
      'CDK context value "applicationServiceVersion" is required. Supply the release identifier for the image.',
    );
  }

  const imageReference = parseNonEmptyContextString(
    context.applicationImageReference,
    'applicationImageReference',
  );
  const serviceVersion = parseNonEmptyContextString(
    context.applicationServiceVersion,
    'applicationServiceVersion',
  );
  const match = PRIVATE_ECR_IMAGE_REFERENCE_PATTERN.exec(imageReference);

  if (match?.groups === undefined) {
    throw new Error(
      'CDK context value "applicationImageReference" must be a complete private ECR image URI pinned by a sha256 digest.',
    );
  }

  const { registryAccount, registryRegion, repositoryName, imageDigest } = match.groups;

  if (repositoryName.length < 2 || repositoryName.length > 256) {
    throw new Error(
      'CDK context value "applicationImageReference" must contain an ECR repository name from 2 through 256 characters.',
    );
  }

  assertMatchingDeploymentTarget(deploymentTarget, registryAccount, registryRegion);

  return {
    kind: 'ecr-image',
    imageReference,
    registryAccount,
    registryRegion,
    repositoryName,
    imageDigest,
    serviceVersion,
  };
}

/** Returns a trimmed, non-empty context string without applying domain rules. */
function parseNonEmptyContextString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CDK context value "${key}" must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Requires ECR mode to target the same concrete account and Region encoded in
 * the registry URI, preventing accidental cross-account or cross-Region use.
 */
function assertMatchingDeploymentTarget(
  deploymentTarget: DeploymentTarget,
  registryAccount: string,
  registryRegion: string,
): void {
  const { account, region } = deploymentTarget;

  if (account === undefined || !AWS_ACCOUNT_PATTERN.test(account)) {
    throw new Error(
      'ECR application image mode requires CDK_DEFAULT_ACCOUNT to be a concrete 12-digit AWS account.',
    );
  }

  if (region === undefined || !AWS_REGION_PATTERN.test(region)) {
    throw new Error('ECR application image mode requires CDK_DEFAULT_REGION to be a concrete AWS Region.');
  }

  if (registryAccount !== account) {
    throw new Error(
      `ECR registry account "${registryAccount}" must match deployment account "${account}".`,
    );
  }

  if (registryRegion !== region) {
    throw new Error(`ECR registry Region "${registryRegion}" must match deployment Region "${region}".`);
  }
}

/** Parses an optional boolean context value, defaulting to `false`. */
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

/**
 * Parses an optional integer context value and enforces its inclusive range.
 * Numeric strings are accepted because CDK `-c` arguments arrive as strings.
 */
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

/**
 * Validates all untrusted CDK inputs once and returns the complete stack config.
 *
 * The standalone infrastructure repository consumes immutable external
 * application artifacts. It requires a concrete target matching the supplied
 * private ECR registry.
 */
export function resolvePlatformConfig(
  context: PlatformConfigContext,
  deploymentTarget: DeploymentTarget = {},
): PlatformConfig {
  return {
    platformName: 'movie-reservation-platform',
    serviceName: 'movie-reservation-service',
    environmentName: 'aws-demo',
    allowedIngressCidr: parseAllowedIngressCidr(context.allowedIngressCidr),
    applicationImage: parseApplicationImageConfig(context, deploymentTarget),
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
