/** One independently published application artifact in the temporary demo task. */
export type ApplicationComponentId =
  | 'reservation-service'
  | 'reservation-web'
  | 'reservation-agent'
  | 'reservation-mcp'
  | 'recommendation-mcp'
  | 'recommendation-service';

/** Validated immutable image input consumed by the ECR image resolver. */
export interface ApplicationImageConfig {
  readonly kind: 'ecr-image';
  readonly componentId: ApplicationComponentId;
  readonly imageReference: string;
  readonly registryAccount: string;
  readonly registryRegion: string;
  readonly repositoryName: string;
  readonly imageDigest: string;
  readonly serviceVersion: string;
}

export type ApplicationImagesConfig = Readonly<
  Record<ApplicationComponentId, ApplicationImageConfig>
>;

/** Concrete AWS account and Region selected for the CDK stack. */
export interface DeploymentTarget {
  readonly account?: string;
  readonly region?: string;
}

/** Fully validated configuration passed to the workload stack. */
export interface PlatformConfig {
  readonly platformName: 'movie-reservation-platform';
  readonly serviceName: 'movie-platform-demo';
  readonly environmentName: 'aws-demo';
  readonly allowedIngressPrefixListId: string;
  readonly applicationImages: ApplicationImagesConfig;
  readonly vpcMaxAzs: 2;
  readonly workloadAzCount: 1;
  readonly enableEcsExec: boolean;
  readonly metricsExportIntervalSeconds: number;
  readonly demoAuthEnabled: boolean;
  readonly demoAuthSecretArn?: string;
}

/** Untrusted values accepted from CDK context at the application boundary. */
export interface PlatformConfigContext {
  readonly allowedIngressPrefixListId?: unknown;
  // Retain the established reservation-service keys for compatibility.
  readonly applicationImageReference?: unknown;
  readonly applicationServiceVersion?: unknown;
  readonly reservationWebImageReference?: unknown;
  readonly reservationWebServiceVersion?: unknown;
  readonly reservationAgentImageReference?: unknown;
  readonly reservationAgentServiceVersion?: unknown;
  readonly reservationMcpImageReference?: unknown;
  readonly reservationMcpServiceVersion?: unknown;
  readonly recommendationMcpImageReference?: unknown;
  readonly recommendationMcpServiceVersion?: unknown;
  readonly recommendationServiceImageReference?: unknown;
  readonly recommendationServiceVersion?: unknown;
  readonly enableEcsExec?: unknown;
  readonly metricsExportIntervalSeconds?: unknown;
  readonly demoAuthEnabled?: unknown;
  readonly demoAuthSecretArn?: unknown;
}

interface ComponentInputDefinition {
  readonly componentId: ApplicationComponentId;
  readonly repositoryName: string;
  readonly imageReferenceKey: keyof PlatformConfigContext;
  readonly serviceVersionKey: keyof PlatformConfigContext;
}

export const APPLICATION_COMPONENT_INPUTS = [
  {
    componentId: 'reservation-service',
    repositoryName: 'movie-reservation-service',
    imageReferenceKey: 'applicationImageReference',
    serviceVersionKey: 'applicationServiceVersion',
  },
  {
    componentId: 'reservation-web',
    repositoryName: 'movie-reservation-web',
    imageReferenceKey: 'reservationWebImageReference',
    serviceVersionKey: 'reservationWebServiceVersion',
  },
  {
    componentId: 'reservation-agent',
    repositoryName: 'movie-reservation-agent',
    imageReferenceKey: 'reservationAgentImageReference',
    serviceVersionKey: 'reservationAgentServiceVersion',
  },
  {
    componentId: 'reservation-mcp',
    repositoryName: 'movie-reservation-mcp',
    imageReferenceKey: 'reservationMcpImageReference',
    serviceVersionKey: 'reservationMcpServiceVersion',
  },
  {
    componentId: 'recommendation-mcp',
    repositoryName: 'movie-recommendation-mcp',
    imageReferenceKey: 'recommendationMcpImageReference',
    serviceVersionKey: 'recommendationMcpServiceVersion',
  },
  {
    componentId: 'recommendation-service',
    repositoryName: 'movie-recommendation-service',
    imageReferenceKey: 'recommendationServiceImageReference',
    serviceVersionKey: 'recommendationServiceVersion',
  },
] as const satisfies readonly ComponentInputDefinition[];

const PRIVATE_ECR_IMAGE_REFERENCE_PATTERN =
  /^(?<registryAccount>\d{12})\.dkr\.ecr\.(?<registryRegion>[a-z]{2}(?:-[a-z0-9]+)+-\d)\.amazonaws\.com\/(?<repositoryName>(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)@(?<imageDigest>sha256:[0-9a-fA-F]{64})$/;
const AWS_ACCOUNT_PATTERN = /^\d{12}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const EC2_PREFIX_LIST_ID_PATTERN = /^pl-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;

function parseRequiredString(value: unknown, key: string, exampleValue?: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const example = exampleValue === undefined ? '' : ` Example: -c ${key}=${exampleValue}`;
    throw new Error(`CDK context value "${key}" is required.${example}`);
  }
  return value.trim();
}

function parseAllowedIngressPrefixListId(value: unknown): string {
  const prefixListId = parseRequiredString(
    value,
    'allowedIngressPrefixListId',
    'pl-0123456789abcdef0',
  );
  if (!EC2_PREFIX_LIST_ID_PATTERN.test(prefixListId)) {
    throw new Error(
      'CDK context value "allowedIngressPrefixListId" must start with pl- and contain exactly 8 or 17 lowercase hexadecimal characters.',
    );
  }
  return prefixListId;
}

function assertConcreteDeploymentTarget(deploymentTarget: DeploymentTarget): asserts deploymentTarget is {
  readonly account: string;
  readonly region: string;
} {
  if (deploymentTarget.account === undefined || !AWS_ACCOUNT_PATTERN.test(deploymentTarget.account)) {
    throw new Error('ECR application image mode requires CDK_DEFAULT_ACCOUNT to be a concrete 12-digit AWS account.');
  }
  if (deploymentTarget.region === undefined || !AWS_REGION_PATTERN.test(deploymentTarget.region)) {
    throw new Error('ECR application image mode requires CDK_DEFAULT_REGION to be a concrete AWS Region.');
  }
}

function parseApplicationImageConfig(
  context: PlatformConfigContext,
  deploymentTarget: { readonly account: string; readonly region: string },
  definition: ComponentInputDefinition,
): ApplicationImageConfig {
  const imageReference = parseRequiredString(
    context[definition.imageReferenceKey],
    definition.imageReferenceKey,
  );
  const serviceVersion = parseRequiredString(
    context[definition.serviceVersionKey],
    definition.serviceVersionKey,
  );
  const match = PRIVATE_ECR_IMAGE_REFERENCE_PATTERN.exec(imageReference);
  if (match?.groups === undefined) {
    throw new Error(
      `CDK context value "${definition.imageReferenceKey}" must be a complete private ECR image URI pinned by a sha256 digest.`,
    );
  }

  const { registryAccount, registryRegion, repositoryName, imageDigest } = match.groups;
  if (repositoryName !== definition.repositoryName) {
    throw new Error(
      `CDK context value "${definition.imageReferenceKey}" must select ECR repository "${definition.repositoryName}", received "${repositoryName}".`,
    );
  }
  if (registryAccount !== deploymentTarget.account) {
    throw new Error(
      `ECR registry account "${registryAccount}" for "${definition.componentId}" must match deployment account "${deploymentTarget.account}".`,
    );
  }
  if (registryRegion !== deploymentTarget.region) {
    throw new Error(
      `ECR registry Region "${registryRegion}" for "${definition.componentId}" must match deployment Region "${deploymentTarget.region}".`,
    );
  }

  return {
    kind: 'ecr-image',
    componentId: definition.componentId,
    imageReference,
    registryAccount,
    registryRegion,
    repositoryName,
    imageDigest,
    serviceVersion,
  };
}

function parseApplicationImages(
  context: PlatformConfigContext,
  deploymentTarget: DeploymentTarget,
): ApplicationImagesConfig {
  assertConcreteDeploymentTarget(deploymentTarget);
  return Object.fromEntries(
    APPLICATION_COMPONENT_INPUTS.map((definition) => [
      definition.componentId,
      parseApplicationImageConfig(context, deploymentTarget, definition),
    ]),
  ) as unknown as ApplicationImagesConfig;
}

function parseBoolean(value: unknown, key: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`CDK context value "${key}" must be true or false.`);
}

function parseIntegerInRange(
  value: unknown,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const parsedValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`CDK context value "${key}" must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsedValue;
}

/** Validate all external context once before constructing any AWS resources. */
export function resolvePlatformConfig(
  context: PlatformConfigContext,
  deploymentTarget: DeploymentTarget = {},
): PlatformConfig {
  const demoAuthEnabled = parseBoolean(context.demoAuthEnabled, 'demoAuthEnabled');
  let demoAuthSecretArn: string | undefined;
  if (demoAuthEnabled) {
    demoAuthSecretArn = parseRequiredString(context.demoAuthSecretArn, 'demoAuthSecretArn');
    const match = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/.exec(demoAuthSecretArn);
    if (!match || match[1] !== deploymentTarget.region || match[2] !== deploymentTarget.account) {
      throw new Error('demoAuthSecretArn must be a complete Secrets Manager ARN in the deployment account and Region.');
    }
  } else if (context.demoAuthSecretArn !== undefined) {
    throw new Error('demoAuthSecretArn requires demoAuthEnabled=true.');
  }
  return {
    platformName: 'movie-reservation-platform',
    serviceName: 'movie-platform-demo',
    environmentName: 'aws-demo',
    allowedIngressPrefixListId: parseAllowedIngressPrefixListId(context.allowedIngressPrefixListId),
    applicationImages: parseApplicationImages(context, deploymentTarget),
    vpcMaxAzs: 2,
    workloadAzCount: 1,
    enableEcsExec: parseBoolean(context.enableEcsExec, 'enableEcsExec'),
    demoAuthEnabled,
    demoAuthSecretArn,
    metricsExportIntervalSeconds: parseIntegerInRange(
      context.metricsExportIntervalSeconds,
      'metricsExportIntervalSeconds',
      30,
      5,
      300,
    ),
  };
}
