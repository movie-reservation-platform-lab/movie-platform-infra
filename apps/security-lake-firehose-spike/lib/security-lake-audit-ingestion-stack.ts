import {
  Arn,
  Aws,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { AUDIT_CONVERSION_COLUMNS } from './audit-conversion-schema';
import { buildFirehosePartitioning } from './firehose-partitioning';
import type { SecurityLakeSourceConfig } from './security-lake-source-config';

export interface SecurityLakeAuditIngestionStackProps extends StackProps {
  readonly sourceConfig: SecurityLakeSourceConfig;
}

/** Disposable delivery stack used only by the issue #71 feasibility checkpoint. */
export class SecurityLakeAuditIngestionStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: SecurityLakeAuditIngestionStackProps,
  ) {
    super(scope, id, props);

    const conversionDatabase = new glue.CfnDatabase(this, 'ConversionDatabase', {
      catalogId: this.account,
      databaseInput: { description: 'Disposable Firehose conversion schema for issue 71' },
    });
    const conversionTable = new glue.CfnTable(this, 'ConversionTable', {
      catalogId: this.account,
      databaseName: conversionDatabase.ref,
      tableInput: {
        description: 'platform-audit/1 OCSF Authentication conversion schema',
        name: 'platform_audit_v1_authentication_conversion',
        tableType: 'EXTERNAL_TABLE',
        parameters: { classification: 'json' },
        storageDescriptor: {
          columns: [...AUDIT_CONVERSION_COLUMNS],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          location: props.sourceConfig.sourceLocation,
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
        },
      },
    });

    const deliveryLogs = new logs.LogGroup(this, 'DeliveryLogs', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const deliveryLogStream = new logs.LogStream(this, 'DeliveryLogStream', {
      logGroup: deliveryLogs,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const providerRolePolicy = new iam.CfnPolicy(this, 'ProviderRolePolicy', {
      policyName: 'security-lake-firehose-spike',
      roles: [props.sourceConfig.providerRoleName],
      policyDocument: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
            resources: [
              Arn.format({ service: 'glue', resource: 'catalog' }, this),
              Arn.format({
                service: 'glue',
                resource: 'database',
                resourceName: conversionDatabase.ref,
              }, this),
              Arn.format({
                service: 'glue',
                resource: 'table',
                resourceName: `${conversionDatabase.ref}/${conversionTable.ref}`,
              }, this),
            ],
          }),
          new iam.PolicyStatement({
            actions: ['logs:PutLogEvents'],
            resources: [
              `${deliveryLogs.logGroupArn}:log-stream:${deliveryLogStream.logStreamName}`,
            ],
          }),
        ],
      }),
    });

    // TODO(PR 5): Select an explicit multi-account routing strategy. The
    //  platform-audit/1 payload has no source account or Region, so this
    //  feasibility checkpoint intentionally configures one workload account.
    const partitioning = buildFirehosePartitioning(
      props.sourceConfig.sourcePrefix,
      this.region,
      props.sourceConfig.sourceAccountId,
    );
    const stream = new firehose.CfnDeliveryStream(this, 'DeliveryStream', {
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
      extendedS3DestinationConfiguration: {
        bucketArn: Arn.format({
          partition: Aws.PARTITION,
          service: 's3',
          region: '',
          account: '',
          resource: props.sourceConfig.bucketName,
        }),
        roleArn: props.sourceConfig.providerRoleArn,
        bufferingHints: { intervalInSeconds: 300, sizeInMBs: 64 },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: deliveryLogs.logGroupName,
          logStreamName: deliveryLogStream.logStreamName,
        },
        compressionFormat: 'UNCOMPRESSED',
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: {
            deserializer: { openXJsonSerDe: { caseInsensitive: false } },
          },
          outputFormatConfiguration: {
            serializer: {
              parquetSerDe: {
                compression: 'SNAPPY',
                enableDictionaryCompression: true,
                pageSizeBytes: 1_048_576,
                writerVersion: 'V2',
              },
            },
          },
          schemaConfiguration: {
            catalogId: this.account,
            databaseName: conversionDatabase.ref,
            region: this.region,
            roleArn: props.sourceConfig.providerRoleArn,
            tableName: conversionTable.ref,
            versionId: 'LATEST',
          },
        },
        dynamicPartitioningConfiguration: partitioning.dynamicPartitioningConfiguration,
        errorOutputPrefix: partitioning.errorOutputPrefix,
        prefix: partitioning.prefix,
        processingConfiguration: partitioning.processingConfiguration,
      },
    });
    stream.addResourceDependency(providerRolePolicy);
  }
}
