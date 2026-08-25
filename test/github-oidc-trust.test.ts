import { readFileSync } from 'node:fs';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { parseGitHubOidcTrustConfig } from '../lib/config/github-oidc-trust-config';
import { GitHubOidcTrustStack } from '../lib/github-oidc-trust-stack';

const TEST_TARGET = {
  account: '111111111111',
  region: 'eu-central-1',
} as const;

const VALID_CONFIG = parseGitHubOidcTrustConfig(
  JSON.parse(readFileSync('test/fixtures/github-oidc-trust-config.json', 'utf8')) as unknown,
);

interface SynthesizedResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
}

interface PolicyStatement {
  readonly Sid: string;
  readonly Action: string | string[];
  readonly Resource: unknown;
}

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new GitHubOidcTrustStack(app, 'TestGitHubOidcTrustStack', {
    env: TEST_TARGET,
    trustConfig: VALID_CONFIG,
  });
  return Template.fromStack(stack);
}

function cloneConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VALID_CONFIG)) as Record<string, unknown>;
}

function policyStatements(template: Template): PolicyStatement[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as SynthesizedResource[];
  return policies.flatMap((policy) => {
    const document = policy.Properties?.PolicyDocument as {
      readonly Statement: PolicyStatement[];
    };
    return document.Statement;
  });
}

function resolveTestArn(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const join = value as {
    readonly 'Fn::Join'?: readonly [string, readonly unknown[]];
  };
  if (join['Fn::Join'] === undefined) {
    throw new Error('Expected a literal ARN or Fn::Join expression.');
  }

  const [separator, fragments] = join['Fn::Join'];
  return fragments
    .map((fragment) => {
      if (typeof fragment === 'string') {
        return fragment;
      }
      const reference = fragment as { readonly Ref?: string };
      if (reference.Ref === 'AWS::Partition') {
        return 'aws';
      }
      throw new Error('Unexpected token in ARN expression.');
    })
    .join(separator);
}

test('accepts exact separate admission and deployment identities', () => {
  expect(parseGitHubOidcTrustConfig(VALID_CONFIG)).toEqual(VALID_CONFIG);
});

test('accepts an exact subject without coupling the parser to one GitHub subject format', () => {
  const config = cloneConfig();
  (config.admission as Record<string, unknown>).subject =
    'repository_id:1000001:environment:artifact-admission-test';

  expect(parseGitHubOidcTrustConfig(config).admission.subject).toBe(
    'repository_id:1000001:environment:artifact-admission-test',
  );
});

test.each([
  ['unknown top-level key', (config: Record<string, unknown>): void => {
    config.extra = true;
  }],
  ['placeholder value', (config: Record<string, unknown>) => {
    (config.admission as Record<string, unknown>).repository = 'your-org/your-repository';
  }],
  ['wildcard subject', (config: Record<string, unknown>) => {
    (config.admission as Record<string, unknown>).subject = 'repo:test-org/*';
  }],
  ['non-main ref', (config: Record<string, unknown>) => {
    (config.deployment as Record<string, unknown>).ref = 'refs/heads/release';
  }],
  ['malformed repository ID', (config: Record<string, unknown>) => {
    (config.admission as Record<string, unknown>).repositoryId = 'repo-1';
  }],
  ['different control repository', (config: Record<string, unknown>) => {
    const deployment = config.deployment as Record<string, unknown>;
    deployment.repository = 'test-org/other-private-control';
    deployment.repositoryId = '2000001';
  }],
  ['different repository owner', (config: Record<string, unknown>) => {
    (config.deployment as Record<string, unknown>).repositoryOwnerId = '2000000';
  }],
  ['shared workflow', (config: Record<string, unknown>) => {
    (config.deployment as Record<string, unknown>).workflow = 'Artifact Admission Test';
  }],
  ['shared environment', (config: Record<string, unknown>) => {
    (config.deployment as Record<string, unknown>).environment = 'artifact-admission-test';
  }],
] as const)('rejects %s', (_name, mutate) => {
  const config = cloneConfig();
  mutate(config);
  expect(() => parseGitHubOidcTrustConfig(config)).toThrow();
});

test('creates one GitHub provider and two exact-claim roles', () => {
  const template = createTemplate();
  const roles = Object.values(template.findResources('AWS::IAM::Role')) as SynthesizedResource[];

  template.hasResourceProperties('AWS::IAM::OIDCProvider', {
    Url: 'https://token.actions.githubusercontent.com',
    ClientIdList: ['sts.amazonaws.com'],
  });
  expect(roles).toHaveLength(2);

  const trustConditions = roles.map((role) => {
    const assumeRolePolicy = role.Properties?.AssumeRolePolicyDocument as {
      readonly Statement: Array<{
        readonly Condition: { readonly StringEquals: Record<string, string> };
      }>;
    };
    expect(role.Properties?.MaxSessionDuration).toBe(3600);
    return assumeRolePolicy.Statement[0].Condition.StringEquals;
  });

  expect(trustConditions).toContainEqual({
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': VALID_CONFIG.admission.subject,
    'token.actions.githubusercontent.com:repository': VALID_CONFIG.admission.repository,
    'token.actions.githubusercontent.com:repository_id': VALID_CONFIG.admission.repositoryId,
    'token.actions.githubusercontent.com:repository_owner_id':
      VALID_CONFIG.admission.repositoryOwnerId,
    'token.actions.githubusercontent.com:workflow': VALID_CONFIG.admission.workflow,
    'token.actions.githubusercontent.com:ref': 'refs/heads/main',
    'token.actions.githubusercontent.com:environment': VALID_CONFIG.admission.environment,
  });
  expect(trustConditions).toContainEqual({
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': VALID_CONFIG.deployment.subject,
    'token.actions.githubusercontent.com:repository': VALID_CONFIG.deployment.repository,
    'token.actions.githubusercontent.com:repository_id': VALID_CONFIG.deployment.repositoryId,
    'token.actions.githubusercontent.com:repository_owner_id':
      VALID_CONFIG.deployment.repositoryOwnerId,
    'token.actions.githubusercontent.com:workflow': VALID_CONFIG.deployment.workflow,
    'token.actions.githubusercontent.com:ref': 'refs/heads/main',
    'token.actions.githubusercontent.com:environment': VALID_CONFIG.deployment.environment,
  });
});

test('scopes artifact admission to the trusted reservation repository', () => {
  const statements = policyStatements(createTemplate());
  const repositoryStatement = statements.find(
    ({ Sid }) => Sid === 'ReadAndWriteTrustedArtifactRepository',
  );

  expect(repositoryStatement).toMatchObject({
    Sid: 'ReadAndWriteTrustedArtifactRepository',
    Effect: 'Allow',
    Action: [
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:CompleteLayerUpload',
      'ecr:DescribeImages',
      'ecr:InitiateLayerUpload',
      'ecr:PutImage',
      'ecr:UploadLayerPart',
    ],
  });
  expect(resolveTestArn(repositoryStatement?.Resource)).toBe(
    'arn:aws:ecr:eu-central-1:111111111111:repository/movie-reservation-service',
  );
  expect(statements).toContainEqual({
    Sid: 'RequestEcrAuthorizationToken',
    Effect: 'Allow',
    Action: 'ecr:GetAuthorizationToken',
    Resource: '*',
  });
});

test('limits deployment to exact CDK bootstrap role assumption', () => {
  const statements = policyStatements(createTemplate());
  const deploymentStatement = statements.find(
    ({ Sid }) => Sid === 'AssumeSelectedCdkBootstrapRoles',
  );

  expect(deploymentStatement).toMatchObject({
    Sid: 'AssumeSelectedCdkBootstrapRoles',
    Effect: 'Allow',
    Action: 'sts:AssumeRole',
  });
  expect(
    (deploymentStatement?.Resource as unknown[]).map((resource) => resolveTestArn(resource)),
  ).toEqual([
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-deploy-role-111111111111-eu-central-1',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-file-publishing-role-111111111111-eu-central-1',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-image-publishing-role-111111111111-eu-central-1',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-lookup-role-111111111111-eu-central-1',
    ]);

  const actions = statements.flatMap(({ Action }) =>
    Array.isArray(Action) ? Action : [Action],
  );
  expect(actions).not.toContain('ecr:DeleteRepository');
  expect(actions).not.toContain('ecr:BatchDeleteImage');
  expect(actions).not.toContain('cloudformation:*');
  expect(actions).not.toContain('iam:PassRole');
});

test('publishes separate role discovery outputs', () => {
  const template = createTemplate();
  template.hasOutput('ArtifactAdmissionRoleArn', {});
  template.hasOutput('WorkloadDeploymentRoleArn', {});
});
