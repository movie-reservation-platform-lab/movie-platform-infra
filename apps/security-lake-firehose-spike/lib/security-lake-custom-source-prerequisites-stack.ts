import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { CUSTOM_SOURCE_NAME } from './custom-source-contract';
import type { SecurityLakePrerequisitesConfig } from './security-lake-prerequisites-config';

export interface SecurityLakeCustomSourcePrerequisitesStackProps extends StackProps {
  readonly prerequisitesConfig: SecurityLakePrerequisitesConfig;
}

/** Disposable Glue crawler identity required before creating the custom source. */
export class SecurityLakeCustomSourcePrerequisitesStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: SecurityLakeCustomSourcePrerequisitesStackProps,
  ) {
    super(scope, id, props);

    const crawlerRole = new iam.Role(this, 'CustomSourceCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      description: `Allows Glue to catalogue the ${CUSTOM_SOURCE_NAME} Security Lake source`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });
    crawlerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation', 's3:ListBucket'],
      resources: [props.prerequisitesConfig.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': [
            props.prerequisitesConfig.sourcePrefix,
            `${props.prerequisitesConfig.sourcePrefix}*`,
          ],
        },
      },
    }));
    crawlerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [
        `${props.prerequisitesConfig.bucketArn}/${props.prerequisitesConfig.sourcePrefix}*`,
      ],
    }));

    new CfnOutput(this, 'CrawlerRoleArn', {
      description: 'Pass this role to Security Lake CreateCustomLogSource.',
      value: crawlerRole.roleArn,
    });
  }
}
