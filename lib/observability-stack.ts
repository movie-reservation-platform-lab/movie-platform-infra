import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { ObservabilityConfig } from './config/foundation-config';
import { COMPONENTS as APPLICATION_COMPONENTS, foundationOutput } from './stack-bindings';

const AMP_QUERY_ACTIONS = ['aps:GetLabels', 'aps:GetMetricMetadata', 'aps:GetSeries', 'aps:QueryMetrics'];
const CLOUDWATCH_METRIC_READ_ACTIONS = ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'];
const CLOUDWATCH_LOG_GLOBAL_READ_ACTIONS = [
  'logs:DescribeLogGroups',
  'logs:GetQueryResults',
  'logs:StopQuery',
];
const CLOUDWATCH_LOG_SCOPED_READ_ACTIONS = [
  'logs:GetLogEvents',
  'logs:GetLogGroupFields',
  'logs:StartQuery',
];
const XRAY_READ_ACTIONS = [
  'xray:BatchGetTraces',
  'xray:GetGroups',
  'xray:GetInsight',
  'xray:GetInsightEvents',
  'xray:GetInsightImpactGraph',
  'xray:GetInsightSummaries',
  'xray:GetServiceGraph',
  'xray:GetTimeSeriesServiceStatistics',
  'xray:GetTraceGraph',
  'xray:GetTraceSummaries',
];

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: ObservabilityConfig;
}

/** Operational telemetry has a separate lifecycle from ECS and audit evidence. */
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const platformConfig = props.config;
    cdk.Tags.of(this).add('Platform', platformConfig.platformName);
    cdk.Tags.of(this).add('Environment', platformConfig.environmentName);
    const tagServiceResource = (resource: Construct): void => {
      cdk.Tags.of(resource).add('Service', platformConfig.serviceName);
    };
    const ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', {
      alias: `${platformConfig.platformName}-${platformConfig.environmentName}`,
      workspaceConfiguration: {
        retentionPeriodInDays: 7,
      },
    });
    ampWorkspace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    tagServiceResource(ampWorkspace);

    const componentLogGroupNames = Object.fromEntries(
      APPLICATION_COMPONENTS.map((componentId) => [
        componentId,
        `/movie-platform/${platformConfig.environmentName}/${componentId}/app`,
      ]),
    ) as Record<(typeof APPLICATION_COMPONENTS)[number], string>;
    const adotLogGroupName = `/movie-platform/${platformConfig.environmentName}/adot`;
    const applicationMetricsLogGroupName = `/movie-platform/${platformConfig.environmentName}/metrics`;
    const grafanaReadableLogGroupArns = [
      ...Object.values(componentLogGroupNames),
      adotLogGroupName,
      applicationMetricsLogGroupName,
      `/movie-platform/${platformConfig.environmentName}/audit-router`,
    ].map((logGroupName) =>
      cdk.Stack.of(this).formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: `${logGroupName}:*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      }),
    );

    let grafanaId = 'disabled';
    let grafanaUrl = 'disabled';
    if (platformConfig.enableGrafana) {
      // The workspace ARN is deliberately wildcarded in the trust policy to
      // avoid a CloudFormation cycle: Grafana needs this role ARN while creating
      // the workspace. SourceAccount and the same-account workspace ARN pattern
      // still prevent another service or account from assuming the role.
      const grafanaWorkspaceSourceArn = cdk.Fn.join('', [
        'arn:',
        cdk.Aws.PARTITION,
        ':grafana:',
        cdk.Aws.REGION,
        ':',
        cdk.Aws.ACCOUNT_ID,
        ':/workspaces/*',
      ]);
      const grafanaDataAccessRole = new iam.Role(this, 'GrafanaDataAccessRole', {
        description: 'Allows Managed Grafana to read demo metrics, logs, and traces',
        assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com', {
          conditions: {
            ArnLike: {
              'aws:SourceArn': grafanaWorkspaceSourceArn,
            },
            StringEquals: {
              'aws:SourceAccount': cdk.Aws.ACCOUNT_ID,
            },
          },
        }),
      });
      const grafanaDataAccessPolicy = new iam.Policy(this, 'GrafanaDataAccessPolicy', {
        roles: [grafanaDataAccessRole],
        statements: [
          new iam.PolicyStatement({
            actions: AMP_QUERY_ACTIONS,
            resources: [ampWorkspace.attrArn],
          }),
          new iam.PolicyStatement({
            // These metric discovery/query and Region discovery APIs do not
            // support useful resource-level scoping.
            actions: [...CLOUDWATCH_METRIC_READ_ACTIONS, 'ec2:DescribeRegions'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            actions: CLOUDWATCH_LOG_GLOBAL_READ_ACTIONS,
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            actions: CLOUDWATCH_LOG_SCOPED_READ_ACTIONS,
            resources: grafanaReadableLogGroupArns,
          }),
          new iam.PolicyStatement({
            // X-Ray read APIs do not support resource-level permissions.
            actions: XRAY_READ_ACTIONS,
            resources: ['*'],
          }),
        ],
      });

      const grafanaWorkspace = new grafana.CfnWorkspace(this, 'GrafanaWorkspace', {
        accountAccessType: 'CURRENT_ACCOUNT',
        authenticationProviders: ['AWS_SSO'],
        dataSources: ['CLOUDWATCH', 'PROMETHEUS', 'XRAY'],
        description: 'Managed metrics, logs, and traces for the movie reservation AWS demo',
        name: `${platformConfig.platformName}-${platformConfig.environmentName}`,
        networkAccessControl: {
          prefixListIds: [platformConfig.allowedIngressPrefixListId],
          vpceIds: [],
        },
        permissionType: 'CUSTOMER_MANAGED',
        pluginAdminEnabled: true,
        roleArn: grafanaDataAccessRole.roleArn,
      });
      // roleArn creates a dependency on the role itself, not on its separately
      // synthesized AWS::IAM::Policy. Wait for both before Grafana validates and
      // starts using the customer-managed role.
      grafanaWorkspace.node.addDependency(grafanaDataAccessPolicy);
      grafanaWorkspace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      tagServiceResource(grafanaWorkspace);
      grafanaId = grafanaWorkspace.attrId;
      grafanaUrl = cdk.Fn.join('', ['https://', grafanaWorkspace.attrEndpoint]);
    }

    const componentLogGroups = Object.fromEntries(
      APPLICATION_COMPONENTS.map((componentId) => {
        const constructId = `${componentId
          .split('-')
          .map((part) => part[0].toUpperCase() + part.slice(1))
          .join('')}LogGroup`;
        const logGroup = new logs.LogGroup(this, constructId, {
          logGroupName: componentLogGroupNames[componentId],
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        tagServiceResource(logGroup);
        return [componentId, logGroup];
      }),
    ) as Record<(typeof APPLICATION_COMPONENTS)[number], logs.LogGroup>;
    const adotLogGroup = new logs.LogGroup(this, 'AdotLogGroup', {
      logGroupName: adotLogGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(adotLogGroup);
    const applicationMetricsLogGroup = new logs.LogGroup(this, 'ApplicationMetricsLogGroup', {
      logGroupName: applicationMetricsLogGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(applicationMetricsLogGroup);


    const routerLogGroup = new logs.LogGroup(this, 'AuditRouterLogGroup', {
      logGroupName: `/movie-platform/${platformConfig.environmentName}/audit-router`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const rejectedAuditMetric = new logs.MetricFilter(this, 'RejectedAuditEvents', {
      logGroup: routerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'audit_router.rejected'),
      metricNamespace: 'MoviePlatform/AuditRouter', metricName: 'RejectedEvents', metricValue: '1',
    });
    new cloudwatch.Alarm(this, 'RejectedAuditEventsAlarm', {
      alarmDescription: 'Audit router rejected an invalid event; inspect producer schema tests and router diagnostics.',
      metric: rejectedAuditMetric.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
      threshold: 1, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new logs.LogGroup(this, 'ContainerInsightsLogGroup', {
      logGroupName: `/aws/ecs/containerinsights/${platformConfig.platformName}-${platformConfig.environmentName}/performance`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    for (const [component, group] of Object.entries(componentLogGroups)) {
      const name = component.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
      foundationOutput(this, `${name}LogGroupName`, group.logGroupName);
    }
    foundationOutput(this, 'AdotLogGroupName', adotLogGroup.logGroupName);
    foundationOutput(this, 'AuditRouterLogGroupName', routerLogGroup.logGroupName);
    foundationOutput(this, 'ApplicationMetricsLogGroupName', applicationMetricsLogGroup.logGroupName);
    foundationOutput(this, 'AmpWorkspaceId', ampWorkspace.attrWorkspaceId);
    foundationOutput(this, 'AmpWorkspaceArn', ampWorkspace.attrArn);
    foundationOutput(this, 'AmpPrometheusEndpoint', ampWorkspace.attrPrometheusEndpoint);
    foundationOutput(this, 'GrafanaWorkspaceId', grafanaId);
    foundationOutput(this, 'GrafanaWorkspaceUrl', grafanaUrl);
  }
}
