import type { AwsTarget, ValidatedAwsAccess } from '../../aws-account-preflight/src';
import { ARTIFACT_FOUNDATION_REPOSITORIES } from '../../../lib/artifact-foundation-repositories';
import {
  ARTIFACT_FOUNDATION_STACK_NAME,
  WORKLOAD_STACK_NAME,
  type ArtifactRepositoryCatalog,
  type ArtifactFoundationReader,
  type CleanupInspectionAccess,
  type RepositoryInspection,
  type StackInspection,
} from '../src/model';

export const TEST_DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const TEST_DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const RESERVATION_SERVICE_REPOSITORY_DEFINITION = ARTIFACT_FOUNDATION_REPOSITORIES[0];

export const TEST_ARTIFACT_REPOSITORY_CATALOG = Object.freeze({
  listArtifactRepositories: () => ARTIFACT_FOUNDATION_REPOSITORIES,
} satisfies ArtifactRepositoryCatalog);

export const TEST_TARGET = Object.freeze({
  profile: 'movie-platform-demo',
  region: 'eu-central-1',
  accountId: '111111111111',
  expectedRoleName: 'AWSReservedSSO_AdministratorAccess_0123456789abcdef',
} as const satisfies AwsTarget);

export const TEST_ACCESS = Object.freeze({
  target: TEST_TARGET,
  permissionSet: 'AdministratorAccess',
  configFiles: Object.freeze({
    configFilepath: '/test-home/.aws/config',
    credentialsFilepath: '/test-home/.aws/credentials',
  }),
} satisfies ValidatedAwsAccess);

export const TEST_INSPECTION_ACCESS = Object.freeze({
  target: TEST_TARGET,
  permissionSet: TEST_ACCESS.permissionSet,
} satisfies CleanupInspectionAccess);

export const EXPECTED_LIFECYCLE_POLICY = JSON.stringify({
  rules: [
    {
      rulePriority: 1,
      description: 'Expire untagged images after seven days',
      selection: {
        tagStatus: 'untagged',
        countType: 'sinceImagePushed',
        countNumber: 7,
        countUnit: 'days',
      },
      action: { type: 'expire' },
    },
  ],
});

export const FOUNDATION_STACK = Object.freeze({
  name: 'ArtifactFoundationStack',
  status: 'CREATE_COMPLETE',
  terminationProtection: true,
  outputs: Object.freeze({
    [RESERVATION_SERVICE_REPOSITORY_DEFINITION.outputNames.name]:
      RESERVATION_SERVICE_REPOSITORY_DEFINITION.repositoryName,
    [RESERVATION_SERVICE_REPOSITORY_DEFINITION.outputNames.arn]:
      'arn:aws:ecr:eu-central-1:111111111111:repository/movie-reservation-service',
    [RESERVATION_SERVICE_REPOSITORY_DEFINITION.outputNames.uri]:
      '111111111111.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service',
  }),
} satisfies StackInspection);

export const WORKLOAD_STACK = Object.freeze({
  name: 'MovieReservationWorkloadStack',
  status: 'CREATE_COMPLETE',
  terminationProtection: false,
  outputs: Object.freeze({}),
} satisfies StackInspection);

export const REPOSITORY = Object.freeze({
  componentId: RESERVATION_SERVICE_REPOSITORY_DEFINITION.componentId,
  displayName: RESERVATION_SERVICE_REPOSITORY_DEFINITION.displayName,
  artifactKind: RESERVATION_SERVICE_REPOSITORY_DEFINITION.artifactKind,
  registryId: TEST_TARGET.accountId,
  name: RESERVATION_SERVICE_REPOSITORY_DEFINITION.repositoryName,
  arn: FOUNDATION_STACK.outputs[RESERVATION_SERVICE_REPOSITORY_DEFINITION.outputNames.arn],
  uri: FOUNDATION_STACK.outputs[RESERVATION_SERVICE_REPOSITORY_DEFINITION.outputNames.uri],
  tagMutability: 'IMMUTABLE',
  tagMutabilityExclusions: Object.freeze([]),
  scanOnPush: false,
  encryptionType: 'AES256',
  tags: Object.freeze({ ...RESERVATION_SERVICE_REPOSITORY_DEFINITION.expectedTags }),
  lifecyclePolicyText: EXPECTED_LIFECYCLE_POLICY,
  images: Object.freeze([
    Object.freeze({ digest: TEST_DIGEST_A, tags: Object.freeze(['release-1']) }),
    Object.freeze({ digest: TEST_DIGEST_B, tags: Object.freeze([]) }),
  ]),
} satisfies RepositoryInspection);

export interface ReaderState {
  readonly workloadStack?: StackInspection;
  readonly foundationStack?: StackInspection;
  readonly repositories?: readonly RepositoryInspection[];
}

export function createReader(state: ReaderState): ArtifactFoundationReader {
  const repositoriesByComponentId = new Map(
    (state.repositories ?? []).map((repository) => [repository.componentId, repository]),
  );

  return {
    verifyIdentity: async () => undefined,
    inspectStack: async (stackName) => {
      if (stackName === WORKLOAD_STACK_NAME) {
        return state.workloadStack;
      }
      if (stackName === ARTIFACT_FOUNDATION_STACK_NAME) {
        return state.foundationStack;
      }
      throw new Error(`Unexpected test stack name: ${stackName}`);
    },
    inspectRepository: async (definition) =>
      repositoriesByComponentId.get(definition.componentId),
  };
}
