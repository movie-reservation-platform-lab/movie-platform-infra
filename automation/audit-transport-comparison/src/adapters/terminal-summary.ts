import type { ComparisonResult, EventPresence } from '../core/comparison-result';

/** Short human summary for the terminal; the JSON evidence file is the record. */
export function renderSummary(result: ComparisonResult): string {
  const { securityLake, legacy } = result.stores;
  const lines = [
    `Audit transport comparison ${result.runId}: ${result.status.toUpperCase()}`,
    '',
    'event     outcome   security-lake  legacy',
    ...result.events.map((event) => [
      event.auditEventId.slice(0, 8).padEnd(9),
      event.expectedOutcome.padEnd(9),
      presence(event.securityLake).padEnd(14),
      presence(event.legacy),
    ].join(' ')),
    '',
    `Security Lake store: ${securityLake.status}${detail(securityLake.error)}`,
    ...(securityLake.catalogRefreshError === null ? [] : [`Crawler start failed: ${securityLake.catalogRefreshError}`]),
    `Legacy store:        ${legacy.status}${detail(legacy.error)}`,
    `Unaudited logins (no receipt): ${result.unauditedLogins.length}`,
    `Unexpected HTTP results: ${result.logins.filter(({ expectedStatus }) => !expectedStatus).length}`,
    deliveryHealthLine(result.deliveryHealth),
  ];
  return `${lines.join('\n')}\n`;
}

function presence({ found, delaySeconds }: EventPresence): string {
  return found ? `found +${delaySeconds}s` : 'MISSING';
}

function detail(error: string | null): string {
  return error === null ? '' : ` (${error})`;
}

function deliveryHealthLine(health: ComparisonResult['deliveryHealth']): string {
  if (health.error !== null) {
    return `Delivery health: unknown (${health.error})`;
  }
  return `Delivery health: DLQ messages ${health.deadLetterMessages}, alarms in ALARM ${health.alarmsInAlarm.length}`;
}
