import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { ObservabilityStack } from '../lib/observability-stack';
import { resolveObservabilityConfig } from '../lib/config/foundation-config';
import { APPLICATION_COMPONENT_INPUTS } from '../lib/config/platform-config';

interface Resource {
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
}

function resources(template: Template, type: string): Resource[] {
  return Object.values(template.findResources(type)) as Resource[];
}

function actions(statement: { readonly Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

describe('ObservabilityStack (default configuration)', () => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(new ObservabilityStack(new cdk.App(), 'ObservabilityTest', {
      env: { account: '111111111111', region: 'eu-central-1' },
      config: resolveObservabilityConfig({ allowedIngressPrefixListId: 'pl-0123456789abcdef0' }),
    }));
  });

  describe('log groups', () => {
    it('uses separate disposable one-week logs for every component, ADOT, metrics, and Container Insights', () => {
      const logGroups = resources(template, 'AWS::Logs::LogGroup');
      expect(logGroups).toHaveLength(10);
      const names = logGroups.map(({ Properties }) => Properties?.LogGroupName);
      for (const component of APPLICATION_COMPONENT_INPUTS) {
        expect(names).toContain(`/movie-platform/aws-demo/${component.componentId}/app`);
      }
      expect(names).toEqual(
        expect.arrayContaining([
          '/movie-platform/aws-demo/adot',
          '/movie-platform/aws-demo/metrics',
          '/aws/ecs/containerinsights/movie-reservation-platform-aws-demo/performance',
        ]),
      );
      for (const logGroup of logGroups) {
        expect(logGroup.Properties?.RetentionInDays).toBe(7);
        expect(logGroup.DeletionPolicy).toBe('Delete');
      }
    });
  });

  describe('Grafana', () => {
    it('keeps Grafana read-only while granting approved AMP, metric, bounded log, and X-Ray reads', () => {
      template.hasResourceProperties('AWS::Grafana::Workspace', {
        AccountAccessType: 'CURRENT_ACCOUNT',
        DataSources: ['CLOUDWATCH', 'PROMETHEUS', 'XRAY'],
        PermissionType: 'CUSTOMER_MANAGED',
        PluginAdminEnabled: true,
      });
      const policies = resources(template, 'AWS::IAM::Policy');
      const grafanaPolicy = policies.find(({ Properties }) =>
        String(Properties?.PolicyName).includes('GrafanaDataAccessPolicy'),
      );
      const document = grafanaPolicy?.Properties?.PolicyDocument as {
        readonly Statement: Array<{ readonly Action: string | string[]; readonly Resource: unknown }>;
      };
      const allActions = document.Statement.flatMap(actions);
      expect(allActions).toEqual(
        expect.arrayContaining([
          'aps:QueryMetrics',
          'cloudwatch:GetMetricData',
          'logs:StartQuery',
          'logs:GetQueryResults',
          'xray:BatchGetTraces',
          'xray:GetTraceSummaries',
        ]),
      );
      expect(allActions.some((action) => /Put|Create|Delete|Update/.test(action))).toBe(false);
      expect(allActions.some((action) => action.includes('*'))).toBe(false);
      const scopedLogs = document.Statement.find(({ Action }) => actions({ Action }).includes('logs:StartQuery'));
      expect(JSON.stringify(scopedLogs?.Resource)).toContain('/movie-platform/aws-demo/reservation-agent/app');
      expect(scopedLogs?.Resource).not.toBe('*');
      const xray = document.Statement.find(({ Action }) => actions({ Action }).includes('xray:BatchGetTraces'));
      expect(xray?.Resource).toBe('*');
      expect(xray).toMatchObject({ Effect: 'Allow' });
      const xrayActions = allActions.filter((action) => action.startsWith('xray:'));
      expect(xrayActions.sort()).toEqual([
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
      ].sort());
      expect(xray).toMatchObject({ Action: expect.arrayContaining(['xray:GetGroups']) });
    });
  });
});
