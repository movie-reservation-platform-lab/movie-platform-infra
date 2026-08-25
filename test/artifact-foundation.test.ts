import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { ArtifactFoundationStack } from '../lib/artifact-foundation-stack';
import { ARTIFACT_FOUNDATION_REPOSITORIES } from '../lib/artifact-foundation-repositories';

const TEST_TARGET = { account: '111111111111', region: 'eu-central-1' } as const;

function template(): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new ArtifactFoundationStack(app, 'TestArtifactFoundationStack', { env: TEST_TARGET }),
  );
}

test('creates one retained immutable repository for every demo component', () => {
  const synthesized = template();
  const repositories = Object.values(
    synthesized.findResources('AWS::ECR::Repository'),
  ) as Array<{
    readonly Properties: Record<string, unknown>;
    readonly DeletionPolicy: string;
    readonly UpdateReplacePolicy: string;
  }>;

  expect(repositories).toHaveLength(6);
  expect(repositories.map(({ Properties }) => Properties.RepositoryName).sort()).toEqual(
    ARTIFACT_FOUNDATION_REPOSITORIES.map(({ repositoryName }) => repositoryName).sort(),
  );
  for (const repository of repositories) {
    expect(repository.Properties).toMatchObject({
      EncryptionConfiguration: { EncryptionType: 'AES256' },
      ImageScanningConfiguration: { ScanOnPush: false },
      ImageTagMutability: 'IMMUTABLE',
      EmptyOnDelete: false,
    });
    expect(repository.DeletionPolicy).toBe('Retain');
    expect(repository.UpdateReplacePolicy).toBe('Retain');
    expect(repository.Properties).not.toHaveProperty('ImageTagMutabilityExclusionFilters');
  }
});

test('expires only untagged images after seven days and applies persistent ownership tags', () => {
  const repositories = Object.values(
    template().findResources('AWS::ECR::Repository'),
  ) as Array<{ readonly Properties: Record<string, unknown> }>;

  for (const repository of repositories) {
    const policy = repository.Properties.LifecyclePolicy as { readonly LifecyclePolicyText: string };
    expect(JSON.parse(policy.LifecyclePolicyText)).toEqual({
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
    const tags = repository.Properties.Tags as Array<{ readonly Key: string; readonly Value: string }>;
    expect(Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value]))).toMatchObject({
      Lifecycle: 'persistent',
      ManagedBy: 'aws-cdk',
      Platform: 'movie-reservation-platform',
      Scope: 'artifact-foundation',
    });
    expect(Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value]))).not.toHaveProperty(
      'Environment',
    );
  }
});

test('publishes name, URI, and ARN outputs for all six repositories', () => {
  const outputs = template().toJSON().Outputs as Record<string, unknown>;
  const expected = ARTIFACT_FOUNDATION_REPOSITORIES.flatMap(({ outputNames }) =>
    Object.values(outputNames),
  ).sort();
  expect(Object.keys(outputs).sort()).toEqual(expected);
});

test('contains no IAM, OIDC, or workload resources', () => {
  const synthesized = template();
  synthesized.resourceCountIs('AWS::IAM::Role', 0);
  synthesized.resourceCountIs('AWS::IAM::Policy', 0);
  synthesized.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  synthesized.resourceCountIs('AWS::ECS::Service', 0);
});
