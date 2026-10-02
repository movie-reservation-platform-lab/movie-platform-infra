import type {EventPattern} from 'aws-cdk-lib/aws-events';
import {
  AUDIT_EVENTBRIDGE_DETAIL_TYPE,
  AUDIT_EVENTBRIDGE_ENVELOPE_VERSION,
  AUDIT_EVENTBRIDGE_SOURCES,
} from './transport-contract';

/** Select supported Authentication events from one configured workload account. */
export function buildAuthenticationEventPattern(
  workloadAccountId: string,
): EventPattern {
  return {
    account: [workloadAccountId],
    source: [...AUDIT_EVENTBRIDGE_SOURCES],
    detailType: [AUDIT_EVENTBRIDGE_DETAIL_TYPE],
    detail: {
      envelope_version: [AUDIT_EVENTBRIDGE_ENVELOPE_VERSION],
    },
  };
}
