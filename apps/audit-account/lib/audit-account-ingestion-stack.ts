import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { AuditIngestion } from '@movie-platform/audit-ingestion';
import type { Construct } from 'constructs';
import { AuditDeliveryAlarms } from './audit-delivery-alarms';
import type { SecurityLakeCustomSourceResponse } from './security-lake-custom-source-response';

/** Fixed name so operators and the comparison runner can select it directly. */
export const AUDIT_INVESTIGATION_WORKGROUP = 'movie-platform-audit-investigation';

export interface AuditAccountIngestionStackProps extends StackProps {
  /** Validated organization accounts and Region owned by this composition root. */
  readonly config: AuditAccountConfig;
  /** Private provider role and destination returned by CreateCustomLogSource. */
  readonly customSource: SecurityLakeCustomSourceResponse;
}

/**
 * Central delivery path deployed in the audit account after custom-source creation.
 *
 * Configured workload accounts publish to its EventBridge bus. The reusable
 * `AuditIngestion` package routes those events through Firehose into the Security
 * Lake destination returned by `CreateCustomLogSource`.
 *
 * The current proof of concept publishes directly from each workload account to
 * this central bus. Revisit a workload-local bus with cross-account forwarding
 * when independent buffering, replay, or a smaller central-service blast radius
 * justifies the additional infrastructure and operational ownership.
 */
export class AuditAccountIngestionStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: AuditAccountIngestionStackProps,
  ) {
    super(scope, id, props);

    const ingestion = new AuditIngestion(this, 'AuditIngestion', {
      destination: props.customSource.destination,
      // Matches the legacy stream's 60 s buffer so the transport comparison
      // measures transports, not buffer settings.
      bufferInterval: Duration.seconds(60),
      producers: props.config.workloadAccountIds.map((workloadAccountId) => ({
        workloadAccountId,
      })),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    ingestion.eventBus.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      principals: props.config.workloadAccountIds.map(
        (accountId) => new iam.AccountPrincipal(accountId),
      ),
      resources: [ingestion.eventBus.eventBusArn],
      sid: 'AllowConfiguredWorkloadAccounts',
    }));

    // Athena keeps query results in managed storage, so the audit account needs
    // no result bucket. Enforced: queries cannot redirect results elsewhere.
    const investigationWorkGroup = new athena.CfnWorkGroup(this, 'AuditInvestigationWorkGroup', {
      description: 'Queries over the Security Lake audit custom source',
      name: AUDIT_INVESTIGATION_WORKGROUP,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        managedQueryResultsConfiguration: { enabled: true },
        publishCloudWatchMetricsEnabled: true,
      },
    });

    const deliveryAlarms = new AuditDeliveryAlarms(this, 'AuditDeliveryAlarms', {
      producers: ingestion.producers,
    });

    new CfnOutput(this, 'AuditEventBusArn', {
      description: 'Exact central event-bus ARN consumed by workload composition.',
      exportName: 'MoviePlatformAuditEventBusArn',
      value: ingestion.eventBus.eventBusArn,
    });
    new CfnOutput(this, 'AuditEventBusName', {
      description: 'Central event-bus name used by operational tooling.',
      exportName: 'MoviePlatformAuditEventBusName',
      value: ingestion.eventBus.eventBusName,
    });
    new CfnOutput(this, 'AuditInvestigationWorkGroupName', {
      description: 'Athena workgroup for Security Lake audit queries and the transport comparison.',
      value: investigationWorkGroup.ref,
    });
    new CfnOutput(this, 'AuditDeliveryAlarmTopicArn', {
      description: 'Unsubscribed delivery-alarm topic for a future incident-provider subscription.',
      value: deliveryAlarms.alarmTopic.topicArn,
    });
  }
}
