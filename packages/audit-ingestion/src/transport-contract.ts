/** EventBridge transport values released with the platform-audit/1 contract. */
export const AUDIT_EVENTBRIDGE_SOURCES = [
  'movie-platform.reservation-service.audit',
  'movie-platform.reservation-agent.audit',
  'movie-platform.recommendation-service.audit',
] as const;

export const AUDIT_EVENTBRIDGE_DETAIL_TYPE = 'ocsf.authentication.v1' as const;
export const AUDIT_EVENTBRIDGE_ENVELOPE_VERSION = '1' as const;
