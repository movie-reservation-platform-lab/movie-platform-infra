import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuditAccountStack } from '../lib/audit-account-stack';

test('keeps the foundation stack empty until the ingestion design is proven', () => {
  const app = new App();
  const stack = new AuditAccountStack(app, 'AuditAccountStack', {
    env: {
      account: '222222222222',
      region: 'eu-central-1',
    },
  });

  expect(Template.fromStack(stack).toJSON().Resources).toBeUndefined();
});
