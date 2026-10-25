import * as path from 'node:path';

import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

import { SandboxConfig, SandboxResourceNames, sandboxResourceNames } from './config';
import {
  ControlPermissionScope,
  createWorkloadDeletionRole,
  grantCleanupAccess,
  grantLauncherAccess,
} from './control-permissions';

/** The three control Lambdas, all built from `runtime/aws-handlers.ts`. */
interface ControlHandlers {
  /** Starts trial tasks; the only thing the Harness delegate may invoke. */
  readonly launcher: NodejsFunction;
  /** Tears the workload down after expiry. */
  readonly cleanup: NodejsFunction;
  /** Checks the admitted lease before any workload resource is created. */
  readonly admission: NodejsFunction;
}

/** What {@link ExperimentControlStack} publishes as stack outputs. */
interface ControlOutputParts {
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  readonly handlers: ControlHandlers;
  readonly expirySchedule: events.Rule;
  readonly alertTopic: sns.Topic;
}

/**
 * Protected control plane for one experiment. It outlives the workload stack and
 * owns the things that must not be deleted by a broken workload:
 *
 * - the experiment state table and the inventory bucket
 * - the admission check every workload resource waits for
 * - the launcher Lambda the Harness delegate calls to start trial tasks
 * - the scheduled cleanup that deletes the workload after expiry, using a
 *   CloudFormation service role that can only remove resources
 *
 * Every IAM permission lives in `control-permissions.ts`.
 */
export class ExperimentControlStack extends Stack {
  readonly state: dynamodb.Table;
  readonly inventory: s3.Bucket;
  readonly launcher: NodejsFunction;
  readonly admission: NodejsFunction;
  readonly admissionProvider: cr.Provider;

  constructor(scope: Construct, id: string, config: SandboxConfig, props: StackProps = {}) {
    super(scope, id, props);

    const names = sandboxResourceNames(config);

    this.tagAsProtectedControl(config);

    this.state = this.createStateTable();
    this.inventory = this.createInventoryBucket();

    const permissionScope = this.permissionScope(config, names);
    const deletionRole = createWorkloadDeletionRole(permissionScope);

    const handlers = this.createHandlers(config, names, permissionScope.clusterArn, deletionRole);

    this.launcher = handlers.launcher;
    this.admission = handlers.admission;
    this.admissionProvider = this.createAdmissionProvider(handlers.admission, deletionRole);

    grantLauncherAccess(permissionScope, handlers.launcher, this.state);

    grantCleanupAccess(
      permissionScope,
      handlers.cleanup,
      { state: this.state, inventory: this.inventory },
      deletionRole,
    );

    const expirySchedule = this.scheduleCleanup(handlers.cleanup, config);
    const alertTopic = this.createCleanupAlerts(handlers.cleanup, config);

    // Must run after every construct above: it patches resources that exist now.
    this.adoptImplicitProviderResources(config);

    this.exportOutputs({ config, names, handlers, expirySchedule, alertTopic });
  }

  /** Tags every resource in the stack; the deletion role cannot touch `ProtectedControl` roles. */
  private tagAsProtectedControl(config: SandboxConfig): void {
    Tags.of(this).add('ExperimentId', config.experimentId);
    Tags.of(this).add('ProtectedControl', 'true');
  }

  /** Lease and launch state for the experiment, keyed by `experimentId`. */
  private createStateTable(): dynamodb.Table {
    return new dynamodb.Table(this, 'State', {
      partitionKey: { name: 'experimentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
  }

  /** Versioned bucket where cleanup records what it observed and removed. */
  private createInventoryBucket(): s3.Bucket {
    return new s3.Bucket(this, 'Inventory', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true,
      autoDeleteObjects: true,
    });
  }

  /** ARNs of the workload stack's cluster and stack, which every permission refers to. */
  private permissionScope(
    config: SandboxConfig,
    names: SandboxResourceNames,
  ): ControlPermissionScope {
    const clusterArn = this.formatArn({
      service: 'ecs',
      resource: 'cluster',
      resourceName: names.cluster,
    });

    const workloadStackArn = this.formatArn({
      service: 'cloudformation',
      resource: 'stack',
      resourceName: `${names.workloadStack}/*`,
    });

    return { stack: this, config, names, clusterArn, workloadStackArn };
  }

  /**
   * The three control Lambdas. They share one bundle and one environment; each runs a
   * different exported handler.
   */
  private createHandlers(
    config: SandboxConfig,
    names: SandboxResourceNames,
    clusterArn: string,
    deletionRole: iam.IRole,
  ): ControlHandlers {
    const environment = {
      EXPERIMENT_ID: config.experimentId,
      STATE_TABLE: this.state.tableName,
      INVENTORY_BUCKET: this.inventory.bucketName,
      WORKLOAD_STACK: names.workloadStack,
      CLUSTER_ARN: clusterArn,
      EXPIRES_AT: config.expiresAt,
      LAUNCH_CUTOFF_AT: config.launchCutoffAt,
      WORKLOAD_DELETION_ROLE: deletionRole.roleArn,
    };

    const launcher = this.createHandler('Launcher', 'launcherHandler', environment);
    const cleanup = this.createHandler('Cleanup', 'cleanupHandler', environment);
    const admission = this.createHandler('Admission', 'admissionHandler', environment);

    this.state.grantReadData(admission);

    return { launcher, cleanup, admission };
  }

  /**
   * The provider behind the workload stack's admission custom resource.
   *
   * Deleting the workload stack deletes that custom resource too, and CloudFormation
   * invokes the provider for it with the deletion role, so that role may invoke it.
   */
  private createAdmissionProvider(admission: NodejsFunction, deletionRole: iam.Role): cr.Provider {
    const provider = new cr.Provider(this, 'AdmissionProvider', {
      onEventHandler: admission,
      logGroup: new logs.LogGroup(this, 'AdmissionProviderLogs', {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    deletionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [provider.serviceToken],
      }),
    );

    return provider;
  }

  /**
   * Runs cleanup every five minutes. Before expiry the handler returns at once; after
   * expiry each run moves teardown forward until the workload is gone.
   */
  private scheduleCleanup(cleanup: NodejsFunction, config: SandboxConfig): events.Rule {
    return new events.Rule(this, 'ExpirySchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(cleanup, {
          event: events.RuleTargetInput.fromObject({
            experimentId: config.experimentId,
            scheduled: true,
          }),
          retryAttempts: 2,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });
  }

  /**
   * Stack outputs the operator CLI reads to verify and drive the control plane.
   *
   * `ControlLogGroupNames` lists every log group in the stack, so call this last.
   */
  private exportOutputs(parts: ControlOutputParts): void {
    const { config, names, handlers, expirySchedule, alertTopic } = parts;

    const controlLogGroupNames = this.node
      .findAll()
      .filter((construct): construct is logs.LogGroup => construct instanceof logs.LogGroup)
      .map((group) => group.logGroupName);

    const outputs: Record<string, string> = {
      ControlLogGroupNames: JSON.stringify(controlLogGroupNames),
      ExperimentId: config.experimentId,
      StateTableName: this.state.tableName,
      InventoryBucketName: this.inventory.bucketName,
      LauncherArn: handlers.launcher.functionArn,
      AdmissionArn: handlers.admission.functionArn,
      CleanupArn: handlers.cleanup.functionArn,
      WorkloadStackName: names.workloadStack,
      CleanupScheduleName: expirySchedule.ruleName,
      CleanupAlertTopicArn: alertTopic.topicArn,
    };

    for (const [key, value] of Object.entries(outputs)) {
      new CfnOutput(this, key, { value });
    }
  }

  /** One Lambda function per exported handler in `runtime/aws-handlers.ts`. */
  private createHandler(
    constructId: string,
    handler: string,
    environment: Record<string, string>,
  ): NodejsFunction {
    return new NodejsFunction(this, constructId, {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../runtime/aws-handlers.ts'),
      handler,
      timeout: Duration.minutes(3),
      memorySize: 256,
      environment,
      bundling: { externalModules: [], minify: false, sourceMap: true },
      logGroup: new logs.LogGroup(this, `${constructId}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
  }

  /** Alerts when cleanup errors or reports that it is blocked. */
  private createCleanupAlerts(cleanup: NodejsFunction, config: SandboxConfig): sns.Topic {
    const topic = new sns.Topic(this, 'CleanupAlerts');

    const failureAlarm = cleanup
      .metricErrors({ period: Duration.minutes(5) })
      .createAlarm(this, 'CleanupFailureAlarm', {
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    failureAlarm.addAlarmAction(new actions.SnsAction(topic));

    // The cleanup handler logs `{ "status": "BLOCKED" }` when it cannot proceed safely.
    const metricNamespace = `Experiment/${config.experimentId}`;

    new logs.MetricFilter(this, 'CleanupBlockedMetric', {
      logGroup: cleanup.logGroup,
      filterPattern: logs.FilterPattern.literal('{ $.status = "BLOCKED" }'),
      metricNamespace,
      metricName: 'CleanupBlocked',
      metricValue: '1',
    });

    const blockedAlarm = new cloudwatch.Alarm(this, 'CleanupBlockedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'CleanupBlocked',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    blockedAlarm.addAlarmAction(new actions.SnsAction(topic));

    return topic;
  }

  /**
   * Brings resources that CDK creates implicitly under this stack's control:
   *
   * - CDK's singleton provider functions (for example S3 auto-delete) would
   *   otherwise create a log group outside CloudFormation. Each one gets an
   *   owned log group, so stack deletion removes it.
   * - CDK's raw provider IAM roles get the ProtectedControl tag, which keeps
   *   them out of reach of the workload deletion role.
   *
   * It only sees constructs that exist when it runs, so call it last.
   */
  private adoptImplicitProviderResources(config: SandboxConfig): void {
    let providerLogIndex = 0;

    for (const construct of this.node.findAll()) {
      if (!(construct instanceof CfnResource)) {
        continue;
      }

      const isFunctionWithoutLogging =
        construct.cfnResourceType === 'AWS::Lambda::Function' &&
        (!(construct instanceof lambda.CfnFunction) || !construct.loggingConfig);

      if (isFunctionWithoutLogging) {
        const group = new logs.LogGroup(this, `ProviderLogs${providerLogIndex}`, {
          logGroupName: `/experiment/${config.experimentId}/control/provider-${providerLogIndex}`,
          removalPolicy: RemovalPolicy.DESTROY,
          retention: logs.RetentionDays.ONE_WEEK,
        });

        construct.addPropertyOverride('LoggingConfig.LogGroup', group.logGroupName);
        construct.addResourceDependency(group.node.defaultChild as CfnResource);
        providerLogIndex += 1;
      }

      const isUntaggedRawRole =
        construct.cfnResourceType === 'AWS::IAM::Role' && !(construct instanceof iam.CfnRole);

      if (isUntaggedRawRole) {
        construct.addPropertyOverride('Tags', [
          { Key: 'ExperimentId', Value: config.experimentId },
          { Key: 'ProtectedControl', Value: 'true' },
        ]);
      }
    }
  }
}
