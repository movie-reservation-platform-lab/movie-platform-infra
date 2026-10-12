import type {
  AuditedLogin,
  DeliveryHealthEvidence,
  EventComparison,
  EventPresence,
  LoginAttempt,
  StoreEvidence,
  StoreName,
} from './comparison-result';

/** Pure rules that turn observations into the run's verdict. */

/** Accepted logins must return 200 and rejected ones 401; anything else is a finding. */
export function isExpectedStatus({ expectedOutcome, httpStatus }: LoginAttempt): boolean {
  return httpStatus === (expectedOutcome === 'accepted' ? 200 : 401);
}

export function isAudited(login: LoginAttempt): login is AuditedLogin {
  return login.auditEventId !== null;
}

/** When each store first showed each event ID. */
export type FirstSeen = Readonly<Record<StoreName, ReadonlyMap<string, Date>>>;

export function compareEvent(login: AuditedLogin, firstSeen: FirstSeen): EventComparison {
  const presence = (store: StoreName): EventPresence => {
    const seenAt = firstSeen[store].get(login.auditEventId);
    return seenAt === undefined
      ? { found: false, delaySeconds: null }
      : { found: true, delaySeconds: Math.round((seenAt.getTime() - login.sentAt.getTime()) / 1000) };
  };
  return {
    auditEventId: login.auditEventId,
    expectedOutcome: login.expectedOutcome,
    securityLake: presence('securityLake'),
    legacy: presence('legacy'),
  };
}

export function storeStatus(error: string | null, seen: ReadonlyMap<string, Date>, ids: readonly string[]): StoreEvidence['status'] {
  if (error !== null) {
    return 'error';
  }
  return ids.every((id) => seen.has(id)) ? 'complete' : 'incomplete';
}

export function isPassed(
  logins: readonly LoginAttempt[],
  events: readonly EventComparison[],
  health: DeliveryHealthEvidence,
): boolean {
  return logins.every((login) => isExpectedStatus(login) && isAudited(login))
    && events.every(({ securityLake, legacy }) => securityLake.found && legacy.found)
    && health.error === null
    && health.deadLetterMessages === 0
    && health.alarmsInAlarm.length === 0;
}

/** Every UTC day from `from` to `to`: events and deliveries can cross midnight. */
export function utcDaysBetween(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (day.getTime() <= to.getTime()) {
    days.push(new Date(day));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}
