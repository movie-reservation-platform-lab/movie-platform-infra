import {
  Arn,
  Aws,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
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
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
        },
      },
    });

    const conversionSchemaRole = new iam.Role(this, 'ConversionSchemaRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Allows Firehose to read the disposable conversion schema',
      inlinePolicies: {
        SchemaRead: new iam.PolicyDocument({
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
          ],
        }),
      },
    });
    const conversionDatabaseAccess = new lakeformation.CfnPrincipalPermissions(
      this,
      'ConversionDatabaseAccess',
      {
        permissions: ['DESCRIBE'],
        permissionsWithGrantOption: [],
        principal: {
          dataLakePrincipalIdentifier: conversionSchemaRole.roleArn,
        },
        resource: {
          database: {
            catalogId: this.account,
            name: conversionDatabase.ref,
          },
        },
      },
    );
    const conversionTableAccess = new lakeformation.CfnPrincipalPermissions(
      this,
      'ConversionTableAccess',
      {
        permissions: ['DESCRIBE'],
        permissionsWithGrantOption: [],
        principal: {
          dataLakePrincipalIdentifier: conversionSchemaRole.roleArn,
        },
        resource: {
          table: {
            catalogId: this.account,
            databaseName: conversionDatabase.ref,
            name: conversionTable.ref,
          },
        },
      },
    );

    // TODO(PR 5): Select an explicit multi-account routing strategy. The
    //  platform-audit/1 payload has no source account or Region, so this
    //  feasibility checkpoint intentionally configures one workload account.
    const partitioning = buildFirehosePartitioning(
      props.sourceConfig.sourcePrefix,
      this.region,
      props.sourceConfig.sourceAccountId,
    );
    const providerErrorOutputPolicy = new iam.CfnPolicy(
      this,
      'ProviderErrorOutputPolicy',
      {
        policyName: 'security-lake-firehose-error-output',
        roles: [props.sourceConfig.providerRoleName],
        policyDocument: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:PutObject'],
              resources: [
                Arn.format(
                  {
                    partition: Aws.PARTITION,
                    service: 's3',
                    region: '',
                    account: '',
                    resource: props.sourceConfig.bucketName,
                    resourceName: `${partitioning.errorObjectPrefix}*`,
                  },
                  this,
                ),
              ],
            }),
          ],
        }),
      },
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
            roleArn: conversionSchemaRole.roleArn,
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
    stream.addResourceDependency(conversionDatabaseAccess);
    stream.addResourceDependency(conversionTableAccess);
    stream.addResourceDependency(providerErrorOutputPolicy);
  }
}
