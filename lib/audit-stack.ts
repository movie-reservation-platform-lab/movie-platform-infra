import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { AuditConfig } from './config/foundation-config';
import { ENVIRONMENT_NAME, PLATFORM_NAME, foundationOutput } from './stack-bindings';

export interface AuditStackProps extends cdk.StackProps {
  readonly config: AuditConfig;
}

/** Delivery and retained evidence survive an ordinary workload teardown. */
export class AuditStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuditStackProps) {
    super(scope, id, props);
    const { config } = props;
    cdk.Tags.of(this).add('Platform', PLATFORM_NAME);
    cdk.Tags.of(this).add('Environment', ENVIRONMENT_NAME);
    const bucket = (name: string, retentionDays: number): s3.Bucket => new s3.Bucket(this, name, {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.allowAuditDataDeletion ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: config.allowAuditDataDeletion,
      lifecycleRules: [{
        expiration: cdk.Duration.days(retentionDays),
        noncurrentVersionExpiration: cdk.Duration.days(retentionDays),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
    });
    const archive = bucket('AuditArchive', config.auditRetentionDays);
    const accessLogs = bucket('AlbAccessLogs', config.auditRetentionDays);
    const results = bucket('AthenaResults', 7);

    // ALB cannot update a bucket policy owned by a different stack. Install the
    // delivery permission here; workload only sets the ALB logging attributes.
    accessLogs.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [accessLogs.arnForObjects(`alb/AWSLogs/${this.account}/*`)],
      conditions: { ArnLike: { 'aws:SourceArn': this.formatArn({
        service: 'elasticloadbalancing', resource: 'loadbalancer', resourceName: '*',
      }) } },
    }));

    const deliveryLogs = new logs.LogGroup(this, 'DeliveryLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deliveryLogStream = new logs.LogStream(this, 'DeliveryLogStream', {
      logGroup: deliveryLogs,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deliveryRole = new iam.Role(this, 'FirehoseDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', {
        // Firehose supplies the destination account as ExternalId when assuming
        // its delivery role (AWS's documented Firehose-to-S3 trust contract).
        conditions: { StringEquals: { 'sts:ExternalId': this.account } },
      }),
      description: 'Writes audit batches to S3; cannot delete archived records',
    });
    deliveryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
      resources: [archive.bucketArn],
    }));
    deliveryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      resources: [archive.arnForObjects('audit/*'), archive.arnForObjects('delivery-errors/*')],
    }));
    deliveryLogs.grantWrite(deliveryRole);

    const stream = new firehose.CfnDeliveryStream(this, 'AuditDeliveryStream', {
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
      extendedS3DestinationConfiguration: {
        bucketArn: archive.bucketArn,
        roleArn: deliveryRole.roleArn,
        prefix: 'audit/!{timestamp:yyyy-MM-dd}/',
        errorOutputPrefix: 'delivery-errors/!{firehose:error-output-type}/!{timestamp:yyyy-MM-dd}/',
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 1 },
        compressionFormat: 'GZIP',
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: deliveryLogs.logGroupName,
          logStreamName: deliveryLogStream.logStreamName,
        },
        // The pinned Fluent Bit output already appends a newline to each JSON
        // record. No transform or second delimiter processor is needed.
      },
    });
    stream.node.addDependency(deliveryRole);

    // This is AWS control-plane evidence, not an application request trace.
    const trail = new cloudtrail.Trail(this, 'ControlPlaneTrail', {
      trailName: 'movie-platform-aws-demo-control-plane',
      bucket: archive,
      s3KeyPrefix: 'cloudtrail',
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: false,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.WRITE_ONLY,
    });

    const database = new glue.CfnDatabase(this, 'AuditDatabase', {
      catalogId: this.account,
      databaseInput: { name: 'movie_platform_audit' },
    });
    new glue.CfnTable(this, 'AuthenticationTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'authentication',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'ingest_date', type: 'string' }],
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.ingest_date.type': 'date',
          'projection.ingest_date.format': 'yyyy-MM-dd',
          'projection.ingest_date.range': '2026-01-01,NOW',
          'projection.ingest_date.interval': '1',
          'projection.ingest_date.interval.unit': 'DAYS',
          'storage.location.template': `s3://${archive.bucketName}/audit/\${ingest_date}/`,
        },
        storageDescriptor: {
          location: `s3://${archive.bucketName}/audit/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
          columns: [
            ...['activity_id', 'category_uid', 'class_uid', 'type_uid', 'severity_id', 'status_id']
              .map(name => ({ name, type: 'int' })),
            { name: 'activity_name', type: 'string' },
            { name: 'status_detail', type: 'string' },
            { name: 'time', type: 'bigint' },
            { name: 'metadata', type: 'struct<version:string,uid:string,correlation_uid:string,product:struct<name:string,vendor_name:string,version:string>>' },
            { name: 'service', type: 'struct<name:string,version:string>' },
            { name: 'user', type: 'struct<name:string,type_id:int>' },
            { name: 'unmapped', type: 'struct<platform:struct<schema_version:string,environment:string,request_id:string,trace_id:string,span_id:string,aws_alb_trace_id:string,aws_cloudfront_request_id:string,route:string,auth_boundary:string>>' },
          ],
        },
      },
    });
    const awsLogParameters = (location: string): Record<string, string> => ({
      'projection.enabled': 'true',
      'projection.log_date.type': 'date',
      'projection.log_date.format': 'yyyy/MM/dd',
      'projection.log_date.range': '2026/01/01,NOW',
      'projection.log_date.interval': '1',
      'projection.log_date.interval.unit': 'DAYS',
      'storage.location.template': `${location}\${log_date}/`,
    });
    const albLocation = `s3://${accessLogs.bucketName}/alb/AWSLogs/${this.account}/elasticloadbalancing/${this.region}/`;
    new glue.CfnTable(this, 'AlbAccessLogTable', {
      catalogId: this.account, databaseName: database.ref,
      tableInput: {
        name: 'alb_access', tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'log_date', type: 'string' }],
        parameters: awsLogParameters(albLocation),
        storageDescriptor: {
          location: albLocation,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.RegexSerDe',
            parameters: { 'input.regex': '(.*)' },
          },
          // Keeping the original line avoids a brittle positional schema as
          // AWS appends ALB log columns; investigation SQL extracts the trace.
          columns: [{ name: 'line', type: 'string' }],
        },
      },
    });
    const trailLocation = `s3://${archive.bucketName}/cloudtrail/AWSLogs/${this.account}/CloudTrail/${this.region}/`;
    new glue.CfnTable(this, 'CloudTrailTable', {
      catalogId: this.account, databaseName: database.ref,
      tableInput: {
        name: 'cloudtrail_management', tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'log_date', type: 'string' }],
        parameters: awsLogParameters(trailLocation),
        storageDescriptor: {
          location: trailLocation,
          inputFormat: 'com.amazon.emr.cloudtrail.CloudTrailInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'com.amazon.emr.hive.serde.CloudTrailSerde' },
          columns: [
            ...['eventtime', 'eventsource', 'eventname', 'awsregion', 'eventid', 'requestid', 'requestparameters', 'responseelements']
              .map(name => ({ name, type: 'string' })),
            { name: 'useridentity', type: 'struct<type:string,arn:string,accountid:string,principalid:string,sessioncontext:struct<sessionissuer:struct<arn:string,username:string>>>' },
          ],
        },
      },
    });
    const workgroup = new athena.CfnWorkGroup(this, 'AuditWorkGroup', {
      name: 'movie-platform-audit',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1024 * 1024 * 1024,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${results.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    const analystPolicy = new iam.ManagedPolicy(this, 'AuditAnalystPolicy', {
      description: 'Read audit/ALB/CloudTrail evidence and run bounded Athena queries; no archive writes or deletes',
      statements: [
        new iam.PolicyStatement({
          actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup'],
          resources: [this.formatArn({ service: 'athena', resource: 'workgroup', resourceName: workgroup.name })],
        }),
        new iam.PolicyStatement({
          actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions', 'glue:BatchGetPartition'],
          resources: [
            this.formatArn({ service: 'glue', resource: 'catalog' }),
            this.formatArn({ service: 'glue', resource: 'database', resourceName: database.ref }),
            this.formatArn({ service: 'glue', resource: 'table', resourceName: `${database.ref}/*` }),
          ],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetBucketLocation', 's3:ListBucket'],
          resources: [archive.bucketArn, accessLogs.bucketArn, results.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [archive.arnForObjects('*'), accessLogs.arnForObjects('*'), results.arnForObjects('results/*')],
        }),
        new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [results.arnForObjects('results/*')] }),
      ],
    });
    new cloudwatch.Alarm(this, 'AuditDeliveryFreshnessAlarm', {
      alarmDescription: 'Audit delivery is over five minutes behind; inspect Firehose and router logs.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Firehose', metricName: 'DeliveryToS3.DataFreshness',
        dimensionsMap: { DeliveryStreamName: stream.ref }, statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 300, evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    foundationOutput(this, 'AuditDeliveryStreamName', stream.ref);
    foundationOutput(this, 'AuditDeliveryStreamArn', stream.attrArn);
    foundationOutput(this, 'AuditArchiveBucketName', archive.bucketName);
    foundationOutput(this, 'AlbAccessLogBucketName', accessLogs.bucketName);
    foundationOutput(this, 'AthenaResultsBucketName', results.bucketName);
    foundationOutput(this, 'AuditDatabaseName', database.ref);
    foundationOutput(this, 'AuditWorkGroupName', workgroup.name);
    foundationOutput(this, 'AuditAnalystPolicyArn', analystPolicy.managedPolicyArn);
    foundationOutput(this, 'ControlPlaneTrailArn', trail.trailArn);
    new cdk.CfnOutput(this, 'AuditDataDeletionEnabled', { value: String(config.allowAuditDataDeletion) });
  }
}
