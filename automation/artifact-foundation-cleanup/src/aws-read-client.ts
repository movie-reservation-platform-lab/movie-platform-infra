import {
  CloudFormationClient,
  DescribeStacksCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeRepositoriesCommand,
  ECRClient,
  GetLifecyclePolicyCommand,
  ImageStatusFilter,
  ListImagesCommand,
  ListTagsForResourceCommand,
  type ImageIdentifier,
  type Repository,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  validateAwsCallerIdentity,
  type AwsTarget,
  type ValidatedAwsAccess,
} from '../../aws-account-preflight/src';
import { createPinnedAwsCredentials } from './aws-client-config';
import { failInspection } from './inspection-error';
import {
  type ArtifactFoundationReader,
  type ArtifactRepositoryDefinition,
  type ImageInspection,
  type RepositoryInspection,
  type StackInspection,
} from './model';

type CloudFormationReadClient = Pick<CloudFormationClient, 'send'>;
type EcrReadClient = Pick<ECRClient, 'send'>;
type StsReadClient = Pick<STSClient, 'send'>;

const MAX_IMAGE_PAGES = 1_000;

/**
 * Builds a read-only AWS SDK reader for the exact profile and Region approved
 * by preflight. The ambient default credential chain is intentionally bypassed.
 */
export function createAwsSdkReader(access: ValidatedAwsAccess): ArtifactFoundationReader {
  const { target } = access;
  const credentials = createPinnedAwsCredentials(access);

  return new AwsSdkArtifactFoundationReader(
    target,
    new CloudFormationClient({ region: target.region, credentials }),
    new ECRClient({ region: target.region, credentials }),
    new STSClient({ region: target.region, credentials }),
  );
}

/**
 * Read-only SDK adapter kept injectable so tests can inspect every command
 * without credentials or network access.
 */
export class AwsSdkArtifactFoundationReader implements ArtifactFoundationReader {
  constructor(
    private readonly target: AwsTarget,
    private readonly cloudFormation: CloudFormationReadClient,
    private readonly ecr: EcrReadClient,
    private readonly sts: StsReadClient,
  ) {}

  /**
   * Re-checks the SDK caller with STS so every later read is tied to the
   * account and role that preflight approved.
   */
  async verifyIdentity(): Promise<void> {
    let response;
    try {
      response = await this.sts.send(new GetCallerIdentityCommand({}));
    } catch {
      failInspection('unable to verify the SDK caller identity');
    }

    if (response.Account === undefined || response.Arn === undefined) {
      failInspection('STS returned an unexpected caller identity shape');
    }
    validateAwsCallerIdentity(this.target, response.Account, response.Arn);
  }

  /**
   * Reads one CloudFormation stack and returns undefined only when AWS says the
   * stack is absent. Any other failure aborts the inspection.
   */
  async inspectStack(stackName: string): Promise<StackInspection | undefined> {
    let response;
    try {
      response = await this.cloudFormation.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );
    } catch (error: unknown) {
      if (isMissingStackError(error)) {
        return undefined;
      }
      failInspection('unable to inspect the CloudFormation stack');
    }

    const stacks = response.Stacks ?? [];
    if (stacks.length !== 1) {
      failInspection('CloudFormation returned an unexpected stack result');
    }

    return mapStack(stacks[0], stackName, this.target);
  }

  /**
   * Reads one configured ECR repository plus the settings needed for cleanup
   * readiness: identity, tags, lifecycle policy, scanning, encryption, and images.
   */
  async inspectRepository(
    definition: ArtifactRepositoryDefinition,
  ): Promise<RepositoryInspection | undefined> {
    let response;
    try {
      response = await this.ecr.send(
        new DescribeRepositoriesCommand({
          registryId: this.target.accountId,
          repositoryNames: [definition.repositoryName],
        }),
      );
    } catch (error: unknown) {
      if (hasErrorName(error, 'RepositoryNotFoundException')) {
        return undefined;
      }
      failInspection('unable to inspect the ECR repository');
    }

    const repositories = response.repositories ?? [];
    if (repositories.length !== 1) {
      failInspection('ECR returned an unexpected repository result');
    }

    const repository = repositories[0];
    const identity = validateRepositoryIdentity(repository, this.target, definition);
    const [tags, lifecyclePolicyText, images] = await Promise.all([
      this.readRepositoryTags(identity.arn),
      this.readLifecyclePolicy(definition),
      this.readImages(definition),
    ]);

    return Object.freeze({
      componentId: definition.componentId,
      displayName: definition.displayName,
      artifactKind: definition.artifactKind,
      registryId: identity.registryId,
      name: identity.name,
      arn: identity.arn,
      uri: identity.uri,
      tagMutability: repository.imageTagMutability ?? 'UNKNOWN',
      tagMutabilityExclusions: Object.freeze(
        (repository.imageTagMutabilityExclusionFilters ?? [])
          .map(({ filterType, filter }) => `${filterType ?? 'UNKNOWN'}:${filter ?? ''}`)
          .sort(),
      ),
      scanOnPush: repository.imageScanningConfiguration?.scanOnPush,
      encryptionType: repository.encryptionConfiguration?.encryptionType ?? 'UNKNOWN',
      encryptionKey: repository.encryptionConfiguration?.kmsKey,
      tags,
      lifecyclePolicyText,
      images,
    });
  }

  /**
   * Reads repository tags into a deterministic map used by drift checks.
   */
  private async readRepositoryTags(repositoryArn: string): Promise<Readonly<Record<string, string>>> {
    let response;
    try {
      response = await this.ecr.send(
        new ListTagsForResourceCommand({ resourceArn: repositoryArn }),
      );
    } catch {
      failInspection('unable to inspect ECR repository tags');
    }

    const tags: Array<readonly [string, string]> = [];
    for (const tag of response.tags ?? []) {
      if (tag.Key === undefined || tag.Value === undefined) {
        failInspection('ECR returned an unexpected repository tag');
      }
      tags.push([tag.Key, tag.Value]);
    }
    tags.sort(([left], [right]) => left.localeCompare(right));
    return Object.freeze(Object.fromEntries(tags));
  }

  /**
   * Returns the raw ECR lifecycle-policy JSON, or undefined when no policy exists.
   */
  private async readLifecyclePolicy(
    definition: ArtifactRepositoryDefinition,
  ): Promise<string | undefined> {
    try {
      const response = await this.ecr.send(
        new GetLifecyclePolicyCommand({
          registryId: this.target.accountId,
          repositoryName: definition.repositoryName,
        }),
      );
      return response.lifecyclePolicyText;
    } catch (error: unknown) {
      if (hasErrorName(error, 'LifecyclePolicyNotFoundException')) {
        return undefined;
      }
      failInspection('unable to inspect the ECR lifecycle policy');
    }
  }

  /**
   * Inventories every image digest and tag while guarding against broken or
   * unexpectedly huge ECR pagination.
   */
  private async readImages(
    definition: ArtifactRepositoryDefinition,
  ): Promise<readonly ImageInspection[]> {
    const imageIdentifiers: ImageIdentifier[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;

    for (let page = 0; page < MAX_IMAGE_PAGES; page += 1) {
      let response;
      try {
        response = await this.ecr.send(
          new ListImagesCommand({
            registryId: this.target.accountId,
            repositoryName: definition.repositoryName,
            maxResults: 1_000,
            nextToken,
            filter: { imageStatus: ImageStatusFilter.ANY },
          }),
        );
      } catch {
        failInspection('unable to inspect ECR image digests');
      }

      imageIdentifiers.push(...(response.imageIds ?? []));
      nextToken = response.nextToken;
      if (nextToken === undefined) {
        return groupImagesByDigest(imageIdentifiers);
      }
      if (seenTokens.has(nextToken)) {
        failInspection('ECR returned a repeated image pagination token');
      }
      seenTokens.add(nextToken);
    }

    failInspection('ECR image inventory exceeded the safety page limit');
  }
}

/**
 * Validates that CloudFormation returned the requested stack in the pinned AWS
 * target, then normalizes only the fields used by the cleanup policy.
 */
function mapStack(stack: Stack, expectedName: string, target: AwsTarget): StackInspection {
  if (
    stack.StackName !== expectedName ||
    stack.StackId === undefined ||
    !stackArnMatchesTarget(stack.StackId, expectedName, target)
  ) {
    failInspection('CloudFormation returned a stack outside the requested target');
  }

  const outputs: Record<string, string> = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }

  return Object.freeze({
    name: stack.StackName,
    status: stack.StackStatus ?? 'UNKNOWN',
    terminationProtection: stack.EnableTerminationProtection ?? false,
    outputs: Object.freeze(outputs),
  });
}

/** Confirms a CloudFormation stack ARN belongs to the expected account, Region, and stack name. */
function stackArnMatchesTarget(stackId: string, expectedName: string, target: AwsTarget): boolean {
  const match = /^arn:[^:]+:cloudformation:([^:]+):([0-9]{12}):stack\/([^/]+)\/[^/]+$/.exec(
    stackId,
  );
  return (
    match !== null &&
    match[1] === target.region &&
    match[2] === target.accountId &&
    match[3] === expectedName
  );
}

interface RepositoryIdentity {
  readonly registryId: string;
  readonly name: string;
  readonly arn: string;
  readonly uri: string;
}

/**
 * Rejects an ECR response unless the repository identity matches both the
 * configured catalog entry and the pinned AWS target.
 */
function validateRepositoryIdentity(
  repository: Repository,
  target: AwsTarget,
  definition: ArtifactRepositoryDefinition,
): RepositoryIdentity {
  const registryId = repository.registryId;
  const name = repository.repositoryName;
  const arn = repository.repositoryArn;
  const uri = repository.repositoryUri;

  if (
    registryId === undefined ||
    name === undefined ||
    arn === undefined ||
    uri === undefined ||
    registryId !== target.accountId ||
    name !== definition.repositoryName ||
    !repositoryArnMatchesTarget(arn, target, definition) ||
    !repositoryUriMatchesTarget(uri, target, definition)
  ) {
    failInspection('ECR returned a repository outside the pinned target');
  }

  return Object.freeze({ registryId, name, arn, uri });
}

/** Confirms an ECR repository ARN belongs to the expected account, Region, and repository name. */
function repositoryArnMatchesTarget(
  arn: string,
  target: AwsTarget,
  definition: ArtifactRepositoryDefinition,
): boolean {
  const match = /^arn:[^:]+:ecr:([^:]+):([0-9]{12}):repository\/(.+)$/.exec(arn);
  return (
    match !== null &&
    match[1] === target.region &&
    match[2] === target.accountId &&
    match[3] === definition.repositoryName
  );
}

/** Confirms an ECR repository URI points to the expected account, Region, and repository name. */
function repositoryUriMatchesTarget(
  uri: string,
  target: AwsTarget,
  definition: ArtifactRepositoryDefinition,
): boolean {
  return (
    uri.startsWith(`${target.accountId}.dkr.ecr.${target.region}.`) &&
    uri.endsWith(`/${definition.repositoryName}`)
  );
}

/**
 * Collapses ECR's one-row-per-tag image listing into one report row per digest.
 */
function groupImagesByDigest(imageIdentifiers: readonly ImageIdentifier[]): readonly ImageInspection[] {
  const tagsByDigest = new Map<string, Set<string>>();

  for (const image of imageIdentifiers) {
    if (image.imageDigest === undefined || !/^sha256:[0-9a-f]{64}$/.test(image.imageDigest)) {
      failInspection('ECR returned an unexpected image digest');
    }
    const tags = tagsByDigest.get(image.imageDigest) ?? new Set<string>();
    if (image.imageTag !== undefined) {
      tags.add(image.imageTag);
    }
    tagsByDigest.set(image.imageDigest, tags);
  }

  return Object.freeze(
    [...tagsByDigest.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([digest, tags]) => Object.freeze({ digest, tags: Object.freeze([...tags].sort()) })),
  );
}

/** Detects CloudFormation's "stack not found" response without hiding other validation errors. */
function isMissingStackError(error: unknown): boolean {
  return (
    hasErrorName(error, 'ValidationError') &&
    error instanceof Error &&
    error.message.includes('does not exist')
  );
}

/** Checks AWS SDK service exception names while keeping caught errors typed as unknown. */
function hasErrorName(error: unknown, expectedName: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === expectedName
  );
}
