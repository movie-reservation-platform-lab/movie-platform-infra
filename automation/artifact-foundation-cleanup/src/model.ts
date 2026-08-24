import type {
  ArtifactFoundationRepositoryDefinition,
  ArtifactKind,
} from '../../../lib/artifact-foundation-repositories';

export type { ArtifactKind };

export const ARTIFACT_FOUNDATION_STACK_NAME = 'ArtifactFoundationStack';
export const WORKLOAD_STACK_NAME = 'MovieReservationWorkloadStack';

export type ArtifactRepositoryDefinition = ArtifactFoundationRepositoryDefinition;

/** Catalog port for retained artifact destinations managed by the foundation. */
export interface ArtifactRepositoryCatalog {
  readonly listArtifactRepositories: () => readonly ArtifactRepositoryDefinition[];
}

/** Validated AWS target selected for the artifact-foundation cleanup check. */
export interface CleanupTarget {
  readonly profile: string;
  readonly region: string;
  readonly accountId: string;
  readonly expectedRoleName: string;
}

/** Local use-case input copied from the preflight result at the CLI boundary. */
export interface CleanupInspectionAccess {
  readonly target: CleanupTarget;
  readonly permissionSet: string;
}

/** Read-only CloudFormation state required by the cleanup safety decision. */
export interface StackInspection {
  readonly name: string;
  readonly status: string;
  readonly terminationProtection: boolean;
  readonly outputs: Readonly<Record<string, string>>;
}

/** One immutable ECR digest and every human-readable tag currently attached to it. */
export interface ImageInspection {
  readonly digest: string;
  readonly tags: readonly string[];
}

/** Read-only ECR state required to identify and explain the cleanup target. */
export interface RepositoryInspection {
  readonly componentId: string;
  readonly displayName: string;
  readonly artifactKind: ArtifactKind;
  readonly registryId: string;
  readonly name: string;
  readonly arn: string;
  readonly uri: string;
  readonly tagMutability: string;
  readonly tagMutabilityExclusions: readonly string[];
  readonly scanOnPush?: boolean;
  readonly encryptionType: string;
  readonly encryptionKey?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly lifecyclePolicyText?: string;
  readonly images: readonly ImageInspection[];
}

/** One configured artifact destination paired with its optional live AWS state. */
export interface ArtifactRepositoryInspection {
  readonly definition: ArtifactRepositoryDefinition;
  readonly repository?: RepositoryInspection;
}

/** Only read methods are available to the inspection workflow. */
export interface ArtifactFoundationReader {
  readonly verifyIdentity: () => Promise<void>;
  readonly inspectStack: (stackName: string) => Promise<StackInspection | undefined>;
  readonly inspectRepository: (
    definition: ArtifactRepositoryDefinition,
  ) => Promise<RepositoryInspection | undefined>;
}

/** Exact live ECR identity approved for one destructive repository deletion. */
export interface RepositoryCleanupTarget {
  readonly componentId: string;
  readonly registryId: string;
  readonly name: string;
}

/** Mutating AWS operations available only to the guarded execution workflow. */
export interface ArtifactFoundationCleaner {
  readonly verifyIdentity: () => Promise<void>;
  readonly disableStackTerminationProtection: (stackName: string) => Promise<void>;
  readonly deleteStack: (stackName: string) => Promise<void>;
  readonly waitForStackDeletion: (stackName: string) => Promise<void>;
  readonly deleteRepository: (repository: RepositoryCleanupTarget) => Promise<void>;
}

/** Typed operations derived from current inspected state, never from report text. */
export interface CleanupExecutionPlan {
  readonly target: CleanupTarget;
  readonly foundationStack?: {
    readonly name: string;
    readonly disableTerminationProtection: boolean;
  };
  readonly repositories: readonly RepositoryCleanupTarget[];
}

export const CLEANUP_EXECUTION_OUTCOME = {
  CLEANED: 'CLEANED',
  NOTHING_TO_CLEAN: 'NOTHING_TO_CLEAN',
} as const;

export type CleanupExecutionOutcome =
  (typeof CLEANUP_EXECUTION_OUTCOME)[keyof typeof CLEANUP_EXECUTION_OUTCOME];

/** Result emitted only after final absence verification succeeds. */
export interface CleanupExecutionResult {
  readonly outcome: CleanupExecutionOutcome;
  readonly foundationStackDeleted: boolean;
  readonly deletedRepositories: readonly RepositoryCleanupTarget[];
}

/** Stable cleanup outcomes rendered by the CLI and consumed by tests. */
export const CLEANUP_READINESS = {
  BLOCKED: 'BLOCKED',
  NOTHING_TO_CLEAN: 'NOTHING_TO_CLEAN',
  READY: 'READY',
} as const;

export type CleanupReadiness = (typeof CLEANUP_READINESS)[keyof typeof CLEANUP_READINESS];

/** Stable blocker codes for machine-readable cleanup safety failures. */
export const CLEANUP_BLOCKER_CODES = {
  FOUNDATION_OPERATION_IN_PROGRESS: 'FOUNDATION_OPERATION_IN_PROGRESS',
  FOUNDATION_OUTPUT_MISMATCH: 'FOUNDATION_OUTPUT_MISMATCH',
  FOUNDATION_REPOSITORY_ABSENT: 'FOUNDATION_REPOSITORY_ABSENT',
  WORKLOAD_STACK_PRESENT: 'WORKLOAD_STACK_PRESENT',
} as const;

export type CleanupBlockerCode =
  (typeof CLEANUP_BLOCKER_CODES)[keyof typeof CLEANUP_BLOCKER_CODES];

/** Stable warning codes for drift and resumable partial-cleanup states. */
export const CLEANUP_WARNING_CODES = {
  FOUNDATION_TERMINATION_PROTECTION_DISABLED: 'FOUNDATION_TERMINATION_PROTECTION_DISABLED',
  REPOSITORY_ENCRYPTION_DRIFT: 'REPOSITORY_ENCRYPTION_DRIFT',
  REPOSITORY_LIFECYCLE_POLICY_DRIFT: 'REPOSITORY_LIFECYCLE_POLICY_DRIFT',
  REPOSITORY_SCAN_CONFIGURATION_DRIFT: 'REPOSITORY_SCAN_CONFIGURATION_DRIFT',
  REPOSITORY_SCAN_CONFIGURATION_UNKNOWN: 'REPOSITORY_SCAN_CONFIGURATION_UNKNOWN',
  REPOSITORY_TAG_MUTABILITY_DRIFT: 'REPOSITORY_TAG_MUTABILITY_DRIFT',
  REPOSITORY_TAG_MUTABILITY_EXCLUSIONS_PRESENT: 'REPOSITORY_TAG_MUTABILITY_EXCLUSIONS_PRESENT',
  REPOSITORY_TAGS_DRIFT: 'REPOSITORY_TAGS_DRIFT',
  RETAINED_REPOSITORY_WITHOUT_STACK: 'RETAINED_REPOSITORY_WITHOUT_STACK',
} as const;

export type CleanupWarningCode =
  (typeof CLEANUP_WARNING_CODES)[keyof typeof CLEANUP_WARNING_CODES];

/** Machine-readable issue code paired with human-readable report text. */
export interface InspectionIssue<Code extends string> {
  readonly code: Code;
  readonly componentId?: string;
  readonly message: string;
}

/** Complete dry-run result rendered for the human operator. */
export interface ArtifactFoundationInspection {
  readonly target: CleanupTarget;
  readonly permissionSet: string;
  readonly workloadStack?: StackInspection;
  readonly foundationStack?: StackInspection;
  readonly repositories: readonly ArtifactRepositoryInspection[];
  readonly readiness: CleanupReadiness;
  readonly blockers: readonly InspectionIssue<CleanupBlockerCode>[];
  readonly warnings: readonly InspectionIssue<CleanupWarningCode>[];
}
