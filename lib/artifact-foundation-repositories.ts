export type ArtifactKind = 'container-image' | 'static-site-bundle';

export interface ArtifactRepositoryOutputNames {
  readonly arn: string;
  readonly name: string;
  readonly uri: string;
}

/** Infra-owned destination metadata for one retained artifact repository. */
export interface ArtifactFoundationRepositoryDefinition {
  readonly componentId: string;
  readonly displayName: string;
  readonly artifactKind: ArtifactKind;
  readonly constructId: string;
  readonly repositoryName: string;
  readonly outputNames: ArtifactRepositoryOutputNames;
  readonly expectedTags: Readonly<Record<string, string>>;
}

// TODO: Define the checked contract with movie-platform-environments ComponentCatalog
//  before live multi-service onboarding. That repo owns component/source/candidate
//  identity; this module owns ECR destination names, CloudFormation outputs, and
//  retention tags until a dedicated catalog or destination registry is approved.
export const ARTIFACT_FOUNDATION_REPOSITORIES = [
  {
    componentId: 'reservation-service',
    displayName: 'Reservation Service',
    artifactKind: 'container-image',
    constructId: 'MovieReservationServiceRepository',
    repositoryName: 'movie-reservation-service',
    outputNames: {
      arn: 'MovieReservationServiceRepositoryArn',
      name: 'MovieReservationServiceRepositoryName',
      uri: 'MovieReservationServiceRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-reservation-service',
    },
  },
] as const satisfies readonly ArtifactFoundationRepositoryDefinition[];
