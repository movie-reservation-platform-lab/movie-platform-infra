import {
  RESULT_SCHEMA,
  type ComparisonResult,
  type DeliveryHealthEvidence,
  type LoginAttempt,
  type LoginOutcome,
  type StoreName,
} from './comparison-result';
import {
  QueryDeadlineExceededError,
  type AuditStoreReader,
  type CatalogRefresher,
  type Clock,
  type DeliveryHealthReader,
  type LoginClient,
  type LookupWindow,
} from './ports';
import { describeError } from './redaction';
import type { ComparisonContext, ComparisonSettings } from './settings';
import { compareEvent, isAudited, isExpectedStatus, isPassed, storeStatus, utcDaysBetween } from './verdict';

/** Deliberately wrong password for rejected attempts; not a secret. */
export const REJECTED_PASSWORD = 'transport-comparison-intentionally-wrong';

export const COMPARABILITY_NOTES = [
  'Delay is detection time: login to the first poll that saw the event, so it is bounded by the poll interval.',
  'Security Lake delay includes Parquet conversion and crawler partition registration; legacy delay does not.',
  'Both Firehose streams buffer for 60 s only when the audit-account stack is deployed with the comparison buffer.',
  'Request-path publish latency per transport comes from audit_publish_duration_ms in Grafana, not from this runner.',
] as const;

/** Everything a run talks to, wired by `cli/production-dependencies.ts`. */
export interface ComparisonDependencies {
  readonly clock: Clock;
  readonly login: LoginClient;
  readonly stores: Readonly<Record<StoreName, AuditStoreReader>>;
  readonly catalog: CatalogRefresher;
  readonly deliveryHealth: DeliveryHealthReader;
  readonly newRunId: () => string;
}

/** Polling state of one store. */
interface StorePoll {
  error: string | null;
  readonly firstSeen: Map<string, Date>;
}

/**
 * The use case: send the controlled logins, then poll both audit stores until
 * every returned event ID is found or the deadline passes. Never retries a
 * login and never sleeps past the deadline. Failures of individual logins,
 * queries, or health reads are recorded in the result rather than thrown, so
 * evidence is always produced once logins have been sent.
 */
export async function runComparison(
  settings: ComparisonSettings,
  context: ComparisonContext,
  dependencies: ComparisonDependencies,
): Promise<ComparisonResult> {
  const { clock } = dependencies;
  const runId = dependencies.newRunId();
  const startedAt = clock.now();
  const deadline = new Date(startedAt.getTime() + settings.timeoutSeconds * 1000);

  const logins = await sendLogins(settings, context, dependencies, runId);
  const audited = logins.filter(isAudited);
  const ids = audited.map(({ auditEventId }) => auditEventId);
  const polls: Record<StoreName, StorePoll> = {
    securityLake: { error: null, firstSeen: new Map() },
    legacy: { error: null, firstSeen: new Map() },
  };
  const catalogRefresh = { startedAt: null as Date | null, error: null as string | null };

  for (;;) {
    const window = {
      days: utcDaysBetween(logins[0]?.sentAt ?? startedAt, clock.now()),
      workloadAccountId: context.workloadAccountId,
      region: context.region,
    };
    for (const store of ['securityLake', 'legacy'] as const) {
      await pollStore(dependencies.stores[store], polls[store], ids, window, deadline, clock);
    }
    const now = clock.now();
    if (!Object.values(polls).some((poll) => isAwaitingEvents(poll, ids)) || now >= deadline) {
      break;
    }
    if (shouldRefreshCatalog(settings, catalogRefresh.startedAt, polls.securityLake, ids, logins, now)) {
      catalogRefresh.startedAt = now;
      catalogRefresh.error = await startCrawler(dependencies.catalog);
    }
    await clock.sleep(Math.min(settings.pollIntervalSeconds * 1000, deadline.getTime() - now.getTime()));
  }

  const deliveryHealth = await readDeliveryHealth(dependencies.deliveryHealth);
  const firstSeen = { securityLake: polls.securityLake.firstSeen, legacy: polls.legacy.firstSeen };
  const events = audited.map((login) => compareEvent(login, firstSeen));

  return {
    schema: RESULT_SCHEMA,
    runId,
    status: isPassed(logins, events, deliveryHealth) ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: clock.now().toISOString(),
    settings: {
      attempts: settings.attempts,
      timeoutSeconds: settings.timeoutSeconds,
      pollIntervalSeconds: settings.pollIntervalSeconds,
    },
    logins: logins.map((login) => ({
      ...login,
      sentAt: login.sentAt.toISOString(),
      expectedStatus: isExpectedStatus(login),
    })),
    stores: {
      securityLake: {
        status: storeStatus(polls.securityLake.error, polls.securityLake.firstSeen, ids),
        error: polls.securityLake.error,
        catalogRefreshStartedAt: catalogRefresh.startedAt?.toISOString() ?? null,
        catalogRefreshError: catalogRefresh.error,
      },
      legacy: {
        status: storeStatus(polls.legacy.error, polls.legacy.firstSeen, ids),
        error: polls.legacy.error,
      },
    },
    events,
    unauditedLogins: logins.filter((login) => !isAudited(login)).map(({ requestId }) => requestId),
    deliveryHealth,
    notes: COMPARABILITY_NOTES,
  };
}

/** Sends accepted logins first, then rejected ones, one at a time. */
async function sendLogins(
  settings: ComparisonSettings,
  context: ComparisonContext,
  dependencies: ComparisonDependencies,
  runId: string,
): Promise<LoginAttempt[]> {
  const plan: LoginOutcome[] = [
    ...Array<LoginOutcome>(settings.attempts.accepted).fill('accepted'),
    ...Array<LoginOutcome>(settings.attempts.rejected).fill('rejected'),
  ];
  const attempts: LoginAttempt[] = [];
  for (const [index, expectedOutcome] of plan.entries()) {
    const requestId = `${runId}-${index + 1}`;
    const sentAt = dependencies.clock.now();
    let response: { httpStatus: number | null; auditEventId: string | null; error: string | null };
    try {
      response = {
        ...(await dependencies.login.login({
          requestId,
          correlationId: `transport-comparison-${runId}`,
          username: context.credentials.username,
          password: expectedOutcome === 'accepted' ? context.credentials.password : REJECTED_PASSWORD,
        })),
        error: null,
      };
    } catch (error) {
      response = { httpStatus: null, auditEventId: null, error: describeError(error) };
    }
    const responseMs = dependencies.clock.now().getTime() - sentAt.getTime();
    attempts.push({ requestId, expectedOutcome, sentAt, responseMs, ...response });
  }
  return attempts;
}

async function pollStore(
  reader: AuditStoreReader,
  poll: StorePoll,
  ids: readonly string[],
  window: LookupWindow,
  deadline: Date,
  clock: Clock,
): Promise<void> {
  const missing = ids.filter((id) => !poll.firstSeen.has(id));
  if (poll.error !== null || missing.length === 0) {
    return;
  }
  try {
    const found = await reader.findEventIds(missing, window, deadline);
    const seenAt = clock.now();
    missing.filter((id) => found.has(id)).forEach((id) => poll.firstSeen.set(id, seenAt));
  } catch (error) {
    if (error instanceof QueryDeadlineExceededError) {
      return; // Out of time, not broken: the store stays "incomplete".
    }
    // A failing query (for example AccessDenied) will not heal by polling again.
    poll.error = describeError(error);
  }
}

/** Still polling: no query error yet and at least one event not seen. */
function isAwaitingEvents(poll: StorePoll, ids: readonly string[]): boolean {
  return poll.error === null && ids.some((id) => !poll.firstSeen.has(id));
}

/** Start the crawler at most once, after one buffer interval, and only while Security Lake lags. */
function shouldRefreshCatalog(
  settings: ComparisonSettings,
  refreshStartedAt: Date | null,
  securityLake: StorePoll,
  ids: readonly string[],
  logins: readonly LoginAttempt[],
  now: Date,
): boolean {
  const lastLoginAt = logins.at(-1)?.sentAt ?? now;
  return settings.refreshCatalog
    && refreshStartedAt === null
    && isAwaitingEvents(securityLake, ids)
    && now.getTime() - lastLoginAt.getTime() >= settings.catalogRefreshDelaySeconds * 1000;
}

/** @returns the redacted error, or `null` when the crawler started (or was already running). */
async function startCrawler(catalog: CatalogRefresher): Promise<string | null> {
  try {
    await catalog.startCrawler();
    return null;
  } catch (error) {
    return describeError(error);
  }
}

async function readDeliveryHealth(reader: DeliveryHealthReader): Promise<DeliveryHealthEvidence> {
  try {
    return { ...(await reader.read()), error: null };
  } catch (error) {
    return { deadLetterMessages: null, alarmsInAlarm: [], error: describeError(error) };
  }
}
