import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { ARTIFACT_FOUNDATION_REPOSITORIES } from './artifact-foundation-repositories';
import type {
  GitHubOidcIdentityConfig,
  GitHubOidcTrustConfig,
} from './config/github-oidc-trust-config';

export interface GitHubOidcTrustStackProps extends cdk.StackProps {
  readonly trustConfig: GitHubOidcTrustConfig;
}

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
const AWS_STS_AUDIENCE = 'sts.amazonaws.com';

export class GitHubOidcTrustStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcTrustStackProps) {
    super(scope, id, props);

    if (cdk.Token.isUnresolved(this.account) || cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        'GitHub OIDC trust synthesis requires concrete CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION values.',
      );
    }

    // Use the native CloudFormation resource. The L2 installs a Lambda-backed
    // custom resource with account-wide provider-management permissions.
    const provider = new iam.CfnOIDCProvider(this, 'GitHubActionsOidcProvider', {
      url: GITHUB_OIDC_URL,
      clientIdList: [AWS_STS_AUDIENCE],
    });

    const admissionRole = this.createGitHubRole(
      'ArtifactAdmissionRole',
      provider,
      props.trustConfig.admission,
      'Copies and verifies approved reservation artifacts in the trusted ECR repository',
    );
    this.addAdmissionPermissions(admissionRole);

    const deploymentRole = this.createGitHubRole(
      'WorkloadDeploymentRole',
      provider,
      props.trustConfig.deployment,
      'Starts reviewed CDK workload deployments through the selected bootstrap roles',
    );
    this.addDeploymentPermissions(deploymentRole, props.trustConfig.bootstrapQualifier);

    new cdk.CfnOutput(this, 'ArtifactAdmissionRoleArn', {
      description: 'ARN of the GitHub OIDC role authorized for exact artifact admission',
      value: admissionRole.roleArn,
    });
    new cdk.CfnOutput(this, 'WorkloadDeploymentRoleArn', {
      description: 'ARN of the separate GitHub OIDC role authorized to start CDK deployments',
      value: deploymentRole.roleArn,
    });
  }

  private createGitHubRole(
    constructId: string,
    provider: iam.CfnOIDCProvider,
    identity: GitHubOidcIdentityConfig,
    description: string,
  ): iam.Role {
    return new iam.Role(this, constructId, {
      description,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.FederatedPrincipal(
        provider.attrArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: AWS_STS_AUDIENCE,
            [`${GITHUB_OIDC_HOST}:sub`]: identity.subject,
            [`${GITHUB_OIDC_HOST}:repository`]: identity.repository,
            [`${GITHUB_OIDC_HOST}:repository_id`]: identity.repositoryId,
            [`${GITHUB_OIDC_HOST}:repository_owner_id`]: identity.repositoryOwnerId,
            [`${GITHUB_OIDC_HOST}:workflow`]: identity.workflow,
            [`${GITHUB_OIDC_HOST}:ref`]: identity.ref,
            [`${GITHUB_OIDC_HOST}:environment`]: identity.environment,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
  }

  private addAdmissionPermissions(role: iam.Role): void {
    const reservationRepository = ARTIFACT_FOUNDATION_REPOSITORIES.find(
      ({ componentId }) => componentId === 'reservation-service',
    );
    if (reservationRepository === undefined) {
      throw new Error('The artifact foundation catalog must define the reservation-service repository.');
    }

    const repositoryArn = this.formatArn({
      service: 'ecr',
      resource: 'repository',
      resourceName: reservationRepository.repositoryName,
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadAndWriteTrustedArtifactRepository',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: [repositoryArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RequestEcrAuthorizationToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
  }

  private addDeploymentPermissions(role: iam.Role, bootstrapQualifier: string): void {
    const bootstrapRoleDescriptions = [
      'deploy',
      'file-publishing',
      'image-publishing',
      'lookup',
    ] as const;
    const bootstrapRoleArns = bootstrapRoleDescriptions.map((description) =>
      this.formatArn({
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: `cdk-${bootstrapQualifier}-${description}-role-${this.account}-${this.region}`,
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeSelectedCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoleArns,
      }),
    );
  }
}
