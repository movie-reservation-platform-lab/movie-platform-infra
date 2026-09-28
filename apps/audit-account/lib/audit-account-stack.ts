import { Stack, Validations, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Stable audit-account deployment boundary.
 *
 * This stack intentionally contains no resources until the Security Lake
 * feasibility checkpoint has validated the proposed ingestion path.
 */
export class AuditAccountStack extends Stack {
  public constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::F0001',
      reason: 'This PR establishes the app boundary before adding account resources.',
    });
  }
}
