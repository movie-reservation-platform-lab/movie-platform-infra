#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GoldenPathDemoStack } from '../lib/infra-stack';
import { resolvePlatformConfig } from '../lib/config/platform-config';

const app = new cdk.App();

const platformConfig = resolvePlatformConfig({
  allowedIngressCidr: app.node.tryGetContext('allowedIngressCidr'),
  enableEcsExec: app.node.tryGetContext('enableEcsExec'),
});

new GoldenPathDemoStack(app, 'GoldenPathDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  platformConfig,
});
