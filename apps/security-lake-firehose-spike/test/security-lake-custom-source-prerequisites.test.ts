import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { SecurityLakeCustomSourcePrerequisitesStack } from '../lib/security-lake-custom-source-prerequisites-stack';
import {
  parseSecurityLakePrerequisitesConfigJson,
  SecurityLakePrerequisitesConfigError,
} from '../lib/security-lake-prerequisites-config';

const AUDIT_CONFIG: AuditAccountConfig = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
};
const PREREQUISITES_CONFIG = {
  bucketArn: 'arn:aws:s3:::aws-security-data-lake-eu-central-1-example',
  region: 'eu-central-1',
  sourcePrefix: 'ext/MOVIE_AUTH/',
} as const;

describe('Security Lake custom-source prerequisites', () => {
  it('creates a Glue crawler role scoped to the Authentication source prefix', () => {
    const app = new App();
    const template = Template.fromStack(
      new SecurityLakeCustomSourcePrerequisitesStack(
        app,
        'TestSecurityLakeCustomSourcePrerequisitesStack',
        {
          env: { account: AUDIT_CONFIG.auditAccountId, region: AUDIT_CONFIG.region },
          prerequisitesConfig: PREREQUISITES_CONFIG,
        },
      ),
    );

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'glue.amazonaws.com' },
          }),
        ]),
      },
    });
    const roles = template.findResources('AWS::IAM::Role');
    expect(JSON.stringify(roles)).toContain('AWSGlueServiceRole');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject', 's3:PutObject']),
            Resource: `${PREREQUISITES_CONFIG.bucketArn}/${PREREQUISITES_CONFIG.sourcePrefix}*`,
          }),
        ]),
      },
    });
    template.hasOutput('CrawlerRoleArn', { Value: Match.anyValue() });
  });

  it('parses a data-lake bucket in the configured audit Region', () => {
    expect(parseSecurityLakePrerequisitesConfigJson(JSON.stringify({
      bucketArn: PREREQUISITES_CONFIG.bucketArn,
      region: PREREQUISITES_CONFIG.region,
    }), AUDIT_CONFIG)).toEqual(PREREQUISITES_CONFIG);
  });

  it.each([
    ['another Region', {
      bucketArn: PREREQUISITES_CONFIG.bucketArn,
      region: 'us-east-1',
    }],
    ['an object ARN instead of a bucket ARN', {
      bucketArn: `${PREREQUISITES_CONFIG.bucketArn}/ext/MOVIE_AUTH/`,
      region: PREREQUISITES_CONFIG.region,
    }],
  ])('rejects %s', (_description, value) => {
    expect(() => parseSecurityLakePrerequisitesConfigJson(
      JSON.stringify(value),
      AUDIT_CONFIG,
    )).toThrow(SecurityLakePrerequisitesConfigError);
  });
});
