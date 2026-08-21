import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { ArtifactFoundationStack } from '../lib/artifact-foundation-stack';

const TEST_TARGET = {
  account: '111111111111',
  region: 'eu-central-1',
} as const;

interface SynthesizedResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface SynthesizedOutput {
  readonly Value: unknown;
}

function createStack(): ArtifactFoundationStack {
  const app = new cdk.App();

  return new ArtifactFoundationStack(app, 'TestArtifactFoundationStack', {
    env: TEST_TARGET,
  });
}

function repositoryResource(template: Template): SynthesizedResource {
  const repositories = Object.values(
    template.findResources('AWS::ECR::Repository'),
  ) as SynthesizedResource[];

  expect(repositories).toHaveLength(1);
  return repositories[0];
}

test('creates the persistent immutable reservation-service repository', () => {
  const stack = createStack();
  const template = Template.fromStack(stack);

  expect(stack.terminationProtection).toBe(true);
  template.resourceCountIs('AWS::ECR::Repository', 1);
  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'movie-reservation-service',
    EncryptionConfiguration: {
      EncryptionType: 'AES256',
    },
    ImageScanningConfiguration: {
      ScanOnPush: false,
    },
    ImageTagMutability: 'IMMUTABLE',
    EmptyOnDelete: false,
  });

  const repository = repositoryResource(template);
  expect(repository.Properties).not.toHaveProperty('ImageTagMutabilityExclusionFilters');
  expect(repository).toMatchObject({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('expires only untagged images older than seven days', () => {
  const template = Template.fromStack(createStack());
  const repository = repositoryResource(template);
  const lifecyclePolicy = repository.Properties?.LifecyclePolicy as {
    readonly LifecyclePolicyText: string;
  };

  expect(JSON.parse(lifecyclePolicy.LifecyclePolicyText)).toEqual({
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
        action: {
          type: 'expire',
        },
      },
    ],
  });
});

test('applies the approved ownership and lifecycle tags without an environment tag', () => {
  const template = Template.fromStack(createStack());
  const repository = repositoryResource(template);
  const tags = repository.Properties?.Tags as Array<{
    readonly Key: string;
    readonly Value: string;
  }>;

  expect(Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value]))).toEqual({
    Lifecycle: 'persistent',
    ManagedBy: 'aws-cdk',
    Platform: 'movie-reservation-platform',
    Scope: 'artifact-foundation',
    Service: 'movie-reservation-service',
  });
});

test('publishes stable repository discovery outputs', () => {
  const template = Template.fromStack(createStack());
  const outputs = template.toJSON().Outputs as Record<string, SynthesizedOutput>;

  template.hasOutput('MovieReservationServiceRepositoryName', {
    Value: {
      Ref: Match.stringLikeRegexp('MovieReservationServiceRepository'),
    },
  });
  template.hasOutput('MovieReservationServiceRepositoryUri', Match.anyValue());
  template.hasOutput('MovieReservationServiceRepositoryArn', {
    Value: {
      'Fn::GetAtt': [Match.stringLikeRegexp('MovieReservationServiceRepository'), 'Arn'],
    },
  });

  const repositoryUri = JSON.stringify(outputs.MovieReservationServiceRepositoryUri.Value);
  expect(repositoryUri).toContain('MovieReservationServiceRepository');
  expect(repositoryUri).toContain('AWS::URLSuffix');

  expect(Object.keys(outputs).sort()).toEqual(
    [
      'MovieReservationServiceRepositoryArn',
      'MovieReservationServiceRepositoryName',
      'MovieReservationServiceRepositoryUri',
    ].sort(),
  );
});

test('contains no IAM, OIDC, or unrelated infrastructure resources', () => {
  const template = Template.fromStack(createStack());
  const resources = Object.values(template.toJSON().Resources ?? {}) as SynthesizedResource[];

  expect(resources.map(({ Type }) => Type)).toEqual(['AWS::ECR::Repository']);
  template.resourceCountIs('AWS::IAM::Role', 0);
  template.resourceCountIs('AWS::IAM::Policy', 0);
  template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
});
