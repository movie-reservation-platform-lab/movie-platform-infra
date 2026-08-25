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
  {
    componentId: 'reservation-web',
    displayName: 'Reservation Web',
    artifactKind: 'container-image',
    constructId: 'MovieReservationWebRepository',
    repositoryName: 'movie-reservation-web',
    outputNames: {
      arn: 'MovieReservationWebRepositoryArn',
      name: 'MovieReservationWebRepositoryName',
      uri: 'MovieReservationWebRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-reservation-web',
    },
  },
  {
    componentId: 'reservation-agent',
    displayName: 'Reservation Agent',
    artifactKind: 'container-image',
    constructId: 'MovieReservationAgentRepository',
    repositoryName: 'movie-reservation-agent',
    outputNames: {
      arn: 'MovieReservationAgentRepositoryArn',
      name: 'MovieReservationAgentRepositoryName',
      uri: 'MovieReservationAgentRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-reservation-agent',
    },
  },
  {
    componentId: 'reservation-mcp',
    displayName: 'Reservation MCP',
    artifactKind: 'container-image',
    constructId: 'MovieReservationMcpRepository',
    repositoryName: 'movie-reservation-mcp',
    outputNames: {
      arn: 'MovieReservationMcpRepositoryArn',
      name: 'MovieReservationMcpRepositoryName',
      uri: 'MovieReservationMcpRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-reservation-mcp',
    },
  },
  {
    componentId: 'recommendation-mcp',
    displayName: 'Recommendation MCP',
    artifactKind: 'container-image',
    constructId: 'MovieRecommendationMcpRepository',
    repositoryName: 'movie-recommendation-mcp',
    outputNames: {
      arn: 'MovieRecommendationMcpRepositoryArn',
      name: 'MovieRecommendationMcpRepositoryName',
      uri: 'MovieRecommendationMcpRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-recommendation-mcp',
    },
  },
  {
    componentId: 'recommendation-service',
    displayName: 'Recommendation Service',
    artifactKind: 'container-image',
    constructId: 'MovieRecommendationServiceRepository',
    repositoryName: 'movie-recommendation-service',
    outputNames: {
      arn: 'MovieRecommendationServiceRepositoryArn',
      name: 'MovieRecommendationServiceRepositoryName',
      uri: 'MovieRecommendationServiceRepositoryUri',
    },
    expectedTags: {
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
      Service: 'movie-recommendation-service',
    },
  },
] as const satisfies readonly ArtifactFoundationRepositoryDefinition[];
