#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuditStack } from '../lib/audit-stack';
import { resolveAuditConfig } from '../lib/config/foundation-config';

const app = new cdk.App();
new AuditStack(app, 'AuditStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  config: resolveAuditConfig({
    allowAuditDataDeletion: app.node.tryGetContext('allowAuditDataDeletion'),
    auditRetentionDays: app.node.tryGetContext('auditRetentionDays'),
  }),
});
