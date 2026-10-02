import {
  Arn,
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { AUDIT_CONVERSION_COLUMNS } from './audit-conversion-schema';
import { buildAuthenticationEventPattern } from './authentication-routing';
import { buildFirehosePartitioning } from './firehose-partitioning';
import { ReliableFirehoseTarget } from './reliable-firehose-target';
import {
  AUDIT_EVENTBRIDGE_DETAIL_TYPE,
  AUDIT_EVENTBRIDGE_ENVELOPE_VERSION,
  AUDIT_EVENTBRIDGE_SOURCES,
} from './transport-contract';

/** Identifies one trusted workload account that may publish audit envelopes. */
export interface AuditProducerBinding {
  /** AWS account ID matched from EventBridge's trusted outer envelope. */
  readonly workloadAccountId: string;
}

/** Existing Security Lake custom-source destination supplied by account composition. */
export interface SecurityLakeDestination {
  /** Name of the Security Lake S3 bucket that owns the custom-source prefix. */
  readonly bucketName: string;
  /** ARN assumed by Firehose when it writes records to Security Lake. */
  readonly providerRoleArn: string;
  /** Name of the provider role to which quarantine write permission is attached. */
  readonly providerRoleName: string;
  /** Versioned prefix assigned to this custom source, including trailing slash. */
  readonly sourcePrefix: string;
}

/** Configuration for the reusable audit ingestion construct. */
export interface AuditIngestionProps {
  /** How long EventBridge retains accepted envelopes for replay. Defaults to 7 days. */
  readonly archiveRetention?: Duration;
  /** How long exhausted EventBridge deliveries remain in each target DLQ. Defaults to 14 days. */
  readonly deadLetterRetention?: Duration;
  /** Pre-existing Security Lake destination created by audit-account composition. */
  readonly destination: SecurityLakeDestination;
  /** Maximum age of an EventBridge delivery attempt. Defaults to 24 hours. */
  readonly maxEventAge?: Duration;
  /** Workload accounts receiving isolated rules, streams, partitions, and DLQs. */
  readonly producers: readonly AuditProducerBinding[];
  /** Lifecycle policy for disposable resources owned by this construct. Defaults to DESTROY. */
  readonly removalPolicy?: RemovalPolicy;
  /** Maximum EventBridge target retries before DLQ delivery. Defaults to 185. */
  readonly retryAttempts?: number;
}

/** Operational metrics for one workload account's ingestion path. */
export interface AuditIngestionMetrics {
  /** Age in seconds of the oldest record waiting for successful S3 delivery. */
  readonly deliveryFreshness: cloudwatch.Metric;
  /** EventBridge rule invocations that exhausted or could not reach the target. */
  readonly failedInvocations: cloudwatch.Metric;
  /** Records accepted by the workload account's Firehose stream. */
  readonly incomingRecords: cloudwatch.Metric;
  /** EventBridge target failures currently visible in the account-specific DLQ. */
  readonly targetDeadLetterMessages: cloudwatch.Metric;
  /** Firehose records delayed because the delivery stream throttled ingestion. */
  readonly throttledRecords: cloudwatch.Metric;
}

/** Resources and metrics created for one configured workload producer account. */
export interface AuditProducerResources {
  /** Queue containing EventBridge target deliveries that exhausted their retry policy. */
  readonly deadLetterQueue: sqs.Queue;
  /** Firehose stream that converts and partitions this account's OCSF records. */
  readonly deliveryStream: firehose.CfnDeliveryStream;
  /** Metrics callers can use to build account-level alarms and dashboards. */
  readonly metrics: AuditIngestionMetrics;
  /** Rule accepting supported Authentication envelopes from this workload account. */
  readonly rule: events.Rule;
  /** AWS account ID bound to these resources and their fixed Security Lake partition. */
  readonly workloadAccountId: string;
}

/** Glue catalog resources shared by every producer delivery stream. */
interface ConversionCatalogResources {
  readonly database: glue.CfnDatabase;
  readonly table: glue.CfnTable;
}

/** Shared schema resources and both layers of catalog authorization. */
interface ConversionSchemaResources extends ConversionCatalogResources {
  readonly databaseAccess: lakeformation.CfnPrincipalPermissions;
  readonly role: iam.Role;
  readonly tableAccess: lakeformation.CfnPrincipalPermissions;
}

/** Dependencies required to assemble one account-isolated ingestion path. */
interface ProducerResourceOptions {
  readonly conversionSchema: ConversionSchemaResources;
  readonly deadLetterRetention?: Duration;
  readonly destination: SecurityLakeDestination;
  readonly eventBus: events.EventBus;
  readonly index: number;
  readonly maxEventAge?: Duration;
  readonly producer: AuditProducerBinding;
  readonly quarantinePolicy: iam.CfnPolicy;
  readonly removalPolicy: RemovalPolicy;
  readonly retryAttempts?: number;
  readonly stack: Stack;
}

/** Inputs that bind one Firehose stream to one trusted workload account. */
interface DeliveryStreamOptions {
  readonly conversionSchema: ConversionSchemaResources;
  readonly destination: SecurityLakeDestination;
  readonly producer: AuditProducerBinding;
  readonly stack: Stack;
}

/** Reusable EventBridge-to-Firehose ingestion path for Authentication audit events. */
export class AuditIngestion extends Construct {
  /** Replay archive for supported envelopes accepted by the dedicated event bus. */
  public readonly archive: events.Archive;
  /** Dedicated bus to which workload accounts publish audit envelopes. */
  public readonly eventBus: events.EventBus;
  /** Account-specific routing, delivery, failure, and metric resources. */
  public readonly producers: readonly AuditProducerResources[];

  public constructor(scope: Construct, id: string, props: AuditIngestionProps) {
    super(scope, id);
    validateProps(props);

    const stack = Stack.of(this);
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    this.eventBus = new events.EventBus(this, 'EventBus');
    this.archive = createAuditArchive(
      this,
      this.eventBus,
      props.producers,
      props.archiveRetention,
      removalPolicy,
    );

    const conversionSchema = createConversionSchema(this, stack);
    const quarantinePolicy = createProviderQuarantinePolicy(
      this,
      stack,
      props.destination,
    );
    this.producers = props.producers.map((producer, index) =>
      createProducerResources(this, {
        conversionSchema,
        deadLetterRetention: props.deadLetterRetention,
        destination: props.destination,
        eventBus: this.eventBus,
        index,
        maxEventAge: props.maxEventAge,
        producer,
        quarantinePolicy,
        removalPolicy,
        retryAttempts: props.retryAttempts,
        stack,
      }),
    );
  }
}

/** Create the replay boundary for every supported producer account. */
function createAuditArchive(
  scope: Construct,
  eventBus: events.EventBus,
  producers: readonly AuditProducerBinding[],
  retention: Duration | undefined,
  removalPolicy: RemovalPolicy,
): events.Archive {
  const archive = new events.Archive(scope, 'Archive', {
    description: 'Replay archive for supported platform Authentication audit envelopes',
    eventPattern: {
      account: producers.map(({ workloadAccountId }) => workloadAccountId),
      source: [...AUDIT_EVENTBRIDGE_SOURCES],
      detailType: [AUDIT_EVENTBRIDGE_DETAIL_TYPE],
      detail: { envelope_version: [AUDIT_EVENTBRIDGE_ENVELOPE_VERSION] },
    },
    retention: retention ?? Duration.days(7),
    sourceEventBus: eventBus,
  });
  archive.applyRemovalPolicy(removalPolicy);
  return archive;
}

/** Create the shared Glue schema and grant Firehose read-only catalog access. */
function createConversionSchema(
  scope: Construct,
  stack: Stack,
): ConversionSchemaResources {
  const catalog = createConversionCatalog(scope, stack);
  const role = createConversionSchemaRole(scope, stack, catalog);
  const lakeFormationAccess = createLakeFormationAccess(
    scope,
    stack,
    catalog,
    role,
  );

  return { ...catalog, ...lakeFormationAccess, role };
}

/** Define the JSON-to-Parquet conversion shape in the Glue Data Catalog. */
function createConversionCatalog(
  scope: Construct,
  stack: Stack,
): ConversionCatalogResources {
  const database = new glue.CfnDatabase(scope, 'ConversionDatabase', {
    catalogId: stack.account,
    databaseInput: {
      description: 'Firehose conversion schema for platform audit events',
    },
  });
  const table = new glue.CfnTable(scope, 'ConversionTable', {
    catalogId: stack.account,
    databaseName: database.ref,
    tableInput: {
      description: 'platform-audit/1 OCSF Authentication conversion schema',
      name: 'platform_audit_v1_authentication_conversion',
      parameters: { classification: 'json' },
      storageDescriptor: {
        columns: [...AUDIT_CONVERSION_COLUMNS],
        inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
        outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
        serdeInfo: {
          serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
        },
      },
      tableType: 'EXTERNAL_TABLE',
    },
  });

  return { database, table };
}

/** Give Firehose the narrow Glue read permissions required for conversion. */
function createConversionSchemaRole(
  scope: Construct,
  stack: Stack,
  catalog: ConversionCatalogResources,
): iam.Role {
  const role = new iam.Role(scope, 'ConversionSchemaRole', {
    assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    description: 'Allows Firehose to read the platform audit conversion schema',
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
    resources: [
      Arn.format({ service: 'glue', resource: 'catalog' }, stack),
      Arn.format({
        service: 'glue',
        resource: 'database',
        resourceName: catalog.database.ref,
      }, stack),
      Arn.format({
        service: 'glue',
        resource: 'table',
        resourceName: `${catalog.database.ref}/${catalog.table.ref}`,
      }, stack),
    ],
  }));

  return role;
}

/** Authorize the conversion role through Lake Formation as well as IAM. */
function createLakeFormationAccess(
  scope: Construct,
  stack: Stack,
  catalog: ConversionCatalogResources,
  role: iam.Role,
): Pick<ConversionSchemaResources, 'databaseAccess' | 'tableAccess'> {
  const databaseAccess = new lakeformation.CfnPrincipalPermissions(
    scope,
    'ConversionDatabaseAccess',
    {
      permissions: ['DESCRIBE'],
      permissionsWithGrantOption: [],
      principal: { dataLakePrincipalIdentifier: role.roleArn },
      resource: {
        database: {
          catalogId: stack.account,
          name: catalog.database.ref,
        },
      },
    },
  );
  const tableAccess = new lakeformation.CfnPrincipalPermissions(
    scope,
    'ConversionTableAccess',
    {
      permissions: ['DESCRIBE'],
      permissionsWithGrantOption: [],
      principal: { dataLakePrincipalIdentifier: role.roleArn },
      resource: {
        table: {
          catalogId: stack.account,
          databaseName: catalog.database.ref,
          name: catalog.table.ref,
        },
      },
    },
  );

  return { databaseAccess, tableAccess };
}

/** Allow the Security Lake provider role to write malformed conversion output. */
function createProviderQuarantinePolicy(
  scope: Construct,
  stack: Stack,
  destination: SecurityLakeDestination,
): iam.CfnPolicy {
  const errorObjectPrefix = `${destination.sourcePrefix.slice(0, -1)}-errors/`;
  return new iam.CfnPolicy(scope, 'ProviderQuarantinePolicy', {
    policyDocument: new iam.PolicyDocument({
      statements: [new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [Arn.format(
          {
            account: '',
            partition: Aws.PARTITION,
            region: '',
            resource: destination.bucketName,
            resourceName: `${errorObjectPrefix}*`,
            service: 's3',
          },
          stack,
        )],
      })],
    }),
    policyName: 'movie-platform-audit-quarantine-write',
    roles: [destination.providerRoleName],
  });
}

/** Create the isolated routing and delivery path for one workload account. */
function createProducerResources(
  scope: Construct,
  options: ProducerResourceOptions,
): AuditProducerResources {
  const {
    conversionSchema,
    deadLetterRetention,
    destination,
    eventBus,
    index,
    maxEventAge,
    producer,
    quarantinePolicy,
    removalPolicy,
    retryAttempts,
    stack,
  } = options;
  const producerScope = new Construct(scope, `Producer${index + 1}`);
  const deadLetterQueue = new sqs.Queue(producerScope, 'TargetDeadLetterQueue', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy,
    retentionPeriod: deadLetterRetention ?? Duration.days(14),
  });
  const deliveryStream = createDeliveryStream(producerScope, {
    conversionSchema,
    destination,
    producer,
    stack,
  });
  deliveryStream.addResourceDependency(conversionSchema.databaseAccess);
  deliveryStream.addResourceDependency(conversionSchema.tableAccess);
  deliveryStream.addResourceDependency(quarantinePolicy);

  const rule = new events.Rule(producerScope, 'AuthenticationRule', {
    eventBus,
    eventPattern: buildAuthenticationEventPattern(producer.workloadAccountId),
  });
  const reliableFirehoseTarget = new ReliableFirehoseTarget(deliveryStream, {
    deadLetterQueue,
    maxEventAge,
    message: events.RuleTargetInput.fromEventPath('$.detail.event'),
    retryAttempts,
  });
  rule.addTarget(reliableFirehoseTarget);

  return {
    deadLetterQueue,
    deliveryStream,
    metrics: createProducerMetrics(eventBus, rule, deliveryStream, deadLetterQueue),
    rule,
    workloadAccountId: producer.workloadAccountId,
  };
}

/** Configure Firehose conversion and account-bound Security Lake partitioning. */
function createDeliveryStream(
  scope: Construct,
  options: DeliveryStreamOptions,
): firehose.CfnDeliveryStream {
  const { conversionSchema, destination, producer, stack } = options;
  const partitioning = buildFirehosePartitioning(
    destination.sourcePrefix,
    stack.region,
    producer.workloadAccountId,
  );

  return new firehose.CfnDeliveryStream(scope, 'DeliveryStream', {
    deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
    deliveryStreamType: 'DirectPut',
    extendedS3DestinationConfiguration: {
      bucketArn: Arn.format({
        account: '',
        partition: Aws.PARTITION,
        region: '',
        resource: destination.bucketName,
        service: 's3',
      }),
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
          catalogId: stack.account,
          databaseName: conversionSchema.database.ref,
          region: stack.region,
          roleArn: conversionSchema.role.roleArn,
          tableName: conversionSchema.table.ref,
          versionId: 'LATEST',
        },
      },
      dynamicPartitioningConfiguration:
        partitioning.dynamicPartitioningConfiguration,
      errorOutputPrefix: partitioning.errorOutputPrefix,
      prefix: partitioning.prefix,
      processingConfiguration: partitioning.processingConfiguration,
      roleArn: destination.providerRoleArn,
    },
  });
}

/** Define alarm-ready metrics without creating CloudWatch resources. */
function createProducerMetrics(
  eventBus: events.EventBus,
  rule: events.Rule,
  deliveryStream: firehose.CfnDeliveryStream,
  deadLetterQueue: sqs.Queue,
): AuditIngestionMetrics {
  return {
    deliveryFreshness: new cloudwatch.Metric({
      dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
      metricName: 'DeliveryToS3.DataFreshness',
      namespace: 'AWS/Firehose',
      statistic: 'Maximum',
    }),
    failedInvocations: new cloudwatch.Metric({
      dimensionsMap: {
        EventBusName: eventBus.eventBusName,
        RuleName: rule.ruleName,
      },
      metricName: 'FailedInvocations',
      namespace: 'AWS/Events',
      statistic: 'Sum',
    }),
    incomingRecords: new cloudwatch.Metric({
      dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
      metricName: 'IncomingRecords',
      namespace: 'AWS/Firehose',
      statistic: 'Sum',
    }),
    targetDeadLetterMessages:
      deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
    throttledRecords: new cloudwatch.Metric({
      dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
      metricName: 'ThrottledRecords',
      namespace: 'AWS/Firehose',
      statistic: 'Sum',
    }),
  };
}

function validateProps(props: AuditIngestionProps): void {
  if (props.producers.length === 0) {
    throw new Error('AuditIngestion requires at least one producer.');
  }
  const accountIds = props.producers.map(({ workloadAccountId }) => workloadAccountId);
  if (
    accountIds.some((accountId) => !/^[0-9]{12}$/.test(accountId))
    || new Set(accountIds).size !== accountIds.length
  ) {
    throw new Error('AuditIngestion producer account IDs must be unique 12-digit values.');
  }
  if (
    !props.destination.sourcePrefix.startsWith('ext/')
    || !props.destination.sourcePrefix.endsWith('/')
    || props.destination.sourcePrefix.includes('..')
  ) {
    throw new Error('AuditIngestion sourcePrefix must be an assigned ext/ prefix.');
  }
}
