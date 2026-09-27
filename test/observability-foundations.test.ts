import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ObservabilityStack } from '../lib/observability-stack';
import { resolveObservabilityConfig } from '../lib/config/foundation-config';

const env = { account: '111111111111', region: 'eu-central-1' };

test('observability has no workload or audit imports and optional Grafana is truly disabled', () => {
  const template = Template.fromStack(new ObservabilityStack(new cdk.App(), 'ObservabilityTest', {
    env, config: resolveObservabilityConfig({
      allowedIngressPrefixListId: 'pl-0123456789abcdef0',
      enableGrafana: false,
    }),
  }));
  template.resourceCountIs('AWS::APS::Workspace', 1);
  template.resourceCountIs('AWS::Logs::LogGroup', 10);
  template.resourceCountIs('AWS::Grafana::Workspace', 0);
  template.resourceCountIs('AWS::ECS::Service', 0);
  expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
});

test('observability settings reject ambiguous ingress', () => {
  expect(() => resolveObservabilityConfig({ allowedIngressPrefixListId: '*' })).toThrow();
});
