import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuditStack } from '../lib/audit-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { resolveAuditConfig, resolveObservabilityConfig } from '../lib/config/foundation-config';

const env = { account: '111111111111', region: 'eu-central-1' };
const audit = (disposable = false): Template => Template.fromStack(new AuditStack(new cdk.App(), 'AuditTest', {
  env, config: resolveAuditConfig({ allowAuditDataDeletion: disposable }),
}));

test('audit foundation is independent of workload networking, images and observability', () => {
  const template = audit();
  for (const type of ['AWS::ECS::Service', 'AWS::EC2::VPC', 'AWS::APS::Workspace', 'AWS::Grafana::Workspace', 'AWS::SQS::Queue', 'AWS::Lambda::Function']) {
    template.resourceCountIs(type, 0);
  }
  expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
  template.resourceCountIs('AWS::Glue::Table', 3);
  template.resourceCountIs('AWS::S3::Bucket', 3);
});

test('audit buckets are private, encrypted, versioned and retained unless explicitly disposable', () => {
  const template = audit();
  for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
    expect(bucket).toMatchObject({
      DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: {
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      },
    });
    expect(JSON.stringify(bucket)).toContain('AES256');
    expect(JSON.stringify(bucket)).toContain('NoncurrentVersionExpiration');
  }
  const disposable = audit(true);
  disposable.resourceCountIs('Custom::S3AutoDeleteObjects', 3);
  for (const bucket of Object.values(disposable.findResources('AWS::S3::Bucket'))) {
    expect(bucket.DeletionPolicy).toBe('Delete');
  }
});

test('Firehose archives gzip JSONL with no Lambda processor and exposes freshness alarm', () => {
  const template = audit();
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([
      Match.objectLike({ Principal: { Service: 'firehose.amazonaws.com' }, Condition: { StringEquals: { 'sts:ExternalId': env.account } } }),
    ]) }),
  });
  template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
    DeliveryStreamType: 'DirectPut',
    DeliveryStreamEncryptionConfigurationInput: { KeyType: 'AWS_OWNED_CMK' },
    ExtendedS3DestinationConfiguration: Match.objectLike({
      CompressionFormat: 'GZIP',
      BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 1 },
      ProcessingConfiguration: Match.absent(),
    }),
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/Firehose', MetricName: 'DeliveryToS3.DataFreshness', Threshold: 300,
  });
  const roles = template.findResources('AWS::IAM::Policy');
  const deliveryPolicy = Object.entries(roles).find(([key]) => key.includes('FirehoseDeliveryRole'))?.[1];
  expect(JSON.stringify(deliveryPolicy)).toContain('s3:PutObject');
  expect(JSON.stringify(deliveryPolicy)).not.toContain('s3:DeleteObject');
});

test('Athena scans projected date partitions with a one GiB per-query ceiling', () => {
  const template = audit();
  template.hasResourceProperties('AWS::Athena::WorkGroup', {
    WorkGroupConfiguration: Match.objectLike({ BytesScannedCutoffPerQuery: 1073741824, EnforceWorkGroupConfiguration: true }),
  });
  template.hasResourceProperties('AWS::Glue::Table', {
    TableInput: Match.objectLike({
      Name: 'authentication',
      Parameters: Match.objectLike({ 'projection.enabled': 'true', 'projection.ingest_date.format': 'yyyy-MM-dd' }),
      StorageDescriptor: Match.objectLike({ Columns: Match.arrayWith([
        Match.objectLike({ Name: 'unmapped', Type: Match.stringLikeRegexp('aws_alb_trace_id:string') }),
      ]) }),
    }),
  });
});

test('CloudTrail captures write management evidence, not a made-up per-login Firehose receipt', () => {
  audit().hasResourceProperties('AWS::CloudTrail::Trail', {
    IsMultiRegionTrail: false, IncludeGlobalServiceEvents: false, EnableLogFileValidation: true,
    EventSelectors: [{ IncludeManagementEvents: true, ReadWriteType: 'WriteOnly' }],
  });
});

test('observability has no workload or audit imports and optional Grafana is truly disabled', () => {
  const template = Template.fromStack(new ObservabilityStack(new cdk.App(), 'ObservabilityTest', {
    env, config: resolveObservabilityConfig({ allowedIngressPrefixListId: 'pl-0123456789abcdef0', enableGrafana: false }),
  }));
  template.resourceCountIs('AWS::APS::Workspace', 1);
  template.resourceCountIs('AWS::Logs::LogGroup', 10);
  template.resourceCountIs('AWS::Grafana::Workspace', 0);
  template.resourceCountIs('AWS::ECS::Service', 0);
  expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
});

test('foundation settings reject accidental cleanup and invalid retention', () => {
  expect(resolveAuditConfig({})).toEqual({ allowAuditDataDeletion: false, auditRetentionDays: 30 });
  expect(() => resolveAuditConfig({ allowAuditDataDeletion: 'yes' })).toThrow();
  expect(() => resolveAuditConfig({ auditRetentionDays: 0 })).toThrow();
  expect(() => resolveAuditConfig({ auditRetentionDays: 3651 })).toThrow();
  expect(() => resolveObservabilityConfig({ allowedIngressPrefixListId: '*' })).toThrow();
});
