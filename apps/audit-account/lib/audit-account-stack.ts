import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as securitylake from 'aws-cdk-lib/aws-securitylake';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import type { Construct } from 'constructs';
import {
  CUSTOM_SOURCE_BASE_PREFIX,
  CUSTOM_SOURCE_NAME,
} from './security-lake-contract';

export interface AuditAccountStackProps extends StackProps {
  /** Validated organization accounts and Region owned by this composition root. */
  readonly config: AuditAccountConfig;
}

/**
 * Foundation deployed in the dedicated audit account before custom-source creation.
 *
 * It enables Security Lake and native CloudTrail management-event collection for
 * the audit account and configured workload accounts. Workload services and the
 * EventBridge-to-Firehose ingestion path are composed elsewhere.
 */
export class AuditAccountStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: AuditAccountStackProps,
  ) {
    super(scope, id, props);

    const metastoreManagerRole = new iam.Role(this, 'MetastoreManagerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows Security Lake to update its Glue metastore',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonSecurityLakeMetastoreManager',
        ),
      ],
      path: '/service-role/',
    });
    const dataLake = new securitylake.CfnDataLake(this, 'DataLake', {
      encryptionConfiguration: { kmsKeyId: 'S3_MANAGED_KEY' },
      lifecycleConfiguration: { expiration: { days: 30 } },
      metaStoreManagerRoleArn: metastoreManagerRole.roleArn,
    });
    const cloudTrailSource = new securitylake.CfnAwsLogSource(
      this,
      'CloudTrailManagementSource',
      {
        accounts: [
          props.config.auditAccountId,
          ...props.config.workloadAccountIds,
        ],
        dataLakeArn: dataLake.attrArn,
        sourceName: 'CLOUD_TRAIL_MGMT',
        sourceVersion: '2.0',
      },
    );
    cloudTrailSource.addResourceDependency(dataLake);

    const crawlerRole = new iam.Role(this, 'CustomSourceCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      description: `Allows Glue to catalogue the ${CUSTOM_SOURCE_NAME} Security Lake source`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSGlueServiceRole',
        ),
      ],
    });
    crawlerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation', 's3:ListBucket'],
      conditions: {
        StringLike: {
          's3:prefix': [
            CUSTOM_SOURCE_BASE_PREFIX,
            `${CUSTOM_SOURCE_BASE_PREFIX}*`,
          ],
        },
      },
      resources: [dataLake.attrS3BucketArn],
    }));
    crawlerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [
        `${dataLake.attrS3BucketArn}/${CUSTOM_SOURCE_BASE_PREFIX}*`,
      ],
    }));

    new CfnOutput(this, 'SecurityLakeArn', {
      description: 'Regional Security Lake data-lake ARN.',
      value: dataLake.attrArn,
    });
    new CfnOutput(this, 'SecurityLakeBucketArn', {
      description: 'Bucket ARN needed by the guarded custom-source handoff.',
      value: dataLake.attrS3BucketArn,
    });
    new CfnOutput(this, 'CustomSourceCrawlerRoleArn', {
      description: 'Crawler role passed to CreateCustomLogSource.',
      value: crawlerRole.roleArn,
    });
  }
}
