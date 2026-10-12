import type { ComparisonResult, EventPresence } from './model';

/** Short human summary for the terminal; the JSON file is the evidence. */
export function renderSummary(result: ComparisonResult): string {
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
    `Security Lake store: ${result.stores.securityLake.status}${suffix(result.stores.securityLake.error)}`,
    `Legacy store:        ${result.stores.legacy.status}${suffix(result.stores.legacy.error)}`,
    `Unaudited logins (no receipt): ${result.unauditedLogins.length}`,
    `Unexpected HTTP statuses: ${result.logins.filter(unexpectedStatus).length}`,
    deliveryHealthLine(result),
  ];
  return `${lines.join('\n')}\n`;
}

function presence({ found, delaySeconds }: EventPresence): string {
  return found ? `found +${delaySeconds ?? '?'}s` : 'MISSING';
}

function suffix(error: string | null): string {
  return error === null ? '' : ` (${error})`;
}

function unexpectedStatus({ expectedOutcome, httpStatus }: ComparisonResult['logins'][number]): boolean {
  return expectedOutcome === 'accepted' ? httpStatus !== 200 : httpStatus !== 401;
}

function deliveryHealthLine({ deliveryHealth }: ComparisonResult): string {
  if (deliveryHealth.error !== null) {
    return `Delivery health: unknown (${deliveryHealth.error})`;
  }
  return `Delivery health: DLQ messages ${deliveryHealth.deadLetterMessages}, `
    + `alarms in ALARM ${deliveryHealth.alarmsInAlarm.length}`;
}
