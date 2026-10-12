import {
  RESULT_SCHEMA,
  type AuditStoreReader,
  type Clock,
  type ComparisonResult,
  type DeliveryHealthReader,
  type DeliveryHealthResult,
  type DemoCredentials,
  type EventComparison,
  type EventPresence,
  type LoginAttempt,
  type LoginClient,
  type LoginOutcome,
  type LookupWindow,
  type RunConfig,
  type SecurityLakeCatalog,
  type StoreName,
  type StoreObservation,
} from './model';

/** Deliberately wrong password for rejected attempts; not a secret. */
export const REJECTED_PASSWORD = 'transport-comparison-intentionally-wrong';

/** Every external dependency of one run, wired by the CLI. */
export interface ComparisonDependencies {
  readonly clock: Clock;
  readonly login: LoginClient;
  readonly stores: Readonly<Record<StoreName, AuditStoreReader>>;
  readonly securityLakeCatalog: SecurityLakeCatalog;
  readonly deliveryHealth: DeliveryHealthReader;
  readonly newRunId: () => string;
}

/** Context resolved before the run: preflighted workload account and credentials. */
export interface ComparisonContext {
  readonly credentials: DemoCredentials;
  readonly workloadAccountId: string;
  readonly region: string;
}

const COMPARABILITY_NOTES = [
  'Delay is detection time: login to the first poll that saw the event, so it is bounded by the poll interval.',
  'Security Lake delay includes Parquet conversion and crawler partition registration; legacy delay does not.',
  'Both Firehose streams buffer for 60 s only when the audit-account stack is deployed with the comparison buffer.',
  'Request-path publish latency per transport comes from audit_publish_duration_ms in Grafana, not from this runner.',
] as const;

/**
 * Send the controlled logins, then poll both audit stores until every returned
 * event ID is found or the deadline passes. Never retries a login and never
 * polls past the deadline.
 */
export async function runComparison(
  config: RunConfig,
  context: ComparisonContext,
  dependencies: ComparisonDependencies,
): Promise<ComparisonResult> {
  const { clock } = dependencies;
  const runId = dependencies.newRunId();
  const startedAt = clock.now();
  const deadline = new Date(startedAt.getTime() + config.timeoutSeconds * 1000);

  const logins = await sendLogins(config, context, dependencies, runId);
  const ids = logins.flatMap(({ auditEventId }) => (auditEventId === null ? [] : [auditEventId]));
  const lastLoginAt = logins.at(-1)?.sentAt ?? startedAt;

  const observations = new Map<StoreName, MutableObservation>([
    ['securityLake', newObservation()],
    ['legacy', newObservation()],
  ]);
  let catalogRefreshStartedAt: Date | null = null;

  for (;;) {
    const window = lookupWindow(logins, startedAt, clock.now(), context);
    for (const [store, observation] of observations) {
      await pollStore(dependencies.stores[store], observation, ids, window, deadline, clock);
    }
    const now = clock.now();
    if (allSettled(observations, ids) || now >= deadline) {
      break;
    }
    if (
      config.securityLakeStore.refreshCatalog
      && catalogRefreshStartedAt === null
      && isMissing(observations.get('securityLake'), ids)
      && now.getTime() - lastLoginAt.getTime() >= config.catalogRefreshDelaySeconds * 1000
    ) {
      catalogRefreshStartedAt = now;
      await refreshCatalog(dependencies.securityLakeCatalog, observations.get('securityLake'));
    }
    await clock.sleep(Math.min(config.pollIntervalSeconds * 1000, deadline.getTime() - now.getTime()));
  }

  const deliveryHealth = await readDeliveryHealth(dependencies.deliveryHealth);
  const stores = finalizeObservations(observations, ids);
  const events = logins
    .filter((login): login is LoginAttempt & { auditEventId: string } => login.auditEventId !== null)
    .map((login) => compareEvent(login, stores));
  const unauditedLogins = logins
    .filter(({ auditEventId }) => auditEventId === null)
    .map(({ requestId }) => requestId);

  const passed = events.every(({ securityLake, legacy }) => securityLake.found && legacy.found)
    && unauditedLogins.length === 0
    && logins.every(isExpectedStatus)
    && deliveryHealth.error === null
    && deliveryHealth.deadLetterMessages === 0
    && deliveryHealth.alarmsInAlarm.length === 0;

  return {
    schema: RESULT_SCHEMA,
    runId,
    status: passed ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: clock.now().toISOString(),
    settings: {
      attempts: config.attempts,
      timeoutSeconds: config.timeoutSeconds,
      pollIntervalSeconds: config.pollIntervalSeconds,
    },
    logins: logins.map((login) => ({ ...login, sentAt: login.sentAt.toISOString() })),
    stores: {
      securityLake: {
        status: stores.get('securityLake')?.status ?? 'error',
        error: stores.get('securityLake')?.error ?? null,
        catalogRefreshStartedAt: catalogRefreshStartedAt?.toISOString() ?? null,
      },
      legacy: {
        status: stores.get('legacy')?.status ?? 'error',
        error: stores.get('legacy')?.error ?? null,
      },
    },
    events,
    unauditedLogins,
    deliveryHealth,
    notes: COMPARABILITY_NOTES,
  };
}

interface MutableObservation {
  error: string | null;
  readonly firstSeen: Map<string, Date>;
}

function newObservation(): MutableObservation {
  return { error: null, firstSeen: new Map() };
}

async function sendLogins(
  config: RunConfig,
  context: ComparisonContext,
  dependencies: ComparisonDependencies,
  runId: string,
): Promise<LoginAttempt[]> {
  const plan: LoginOutcome[] = [
    ...Array<LoginOutcome>(config.attempts.accepted).fill('accepted'),
    ...Array<LoginOutcome>(config.attempts.rejected).fill('rejected'),
  ];
  const attempts: LoginAttempt[] = [];
  for (const [index, expectedOutcome] of plan.entries()) {
    const requestId = `${runId}-${index + 1}`;
    const sentAt = dependencies.clock.now();
    const response = await dependencies.login.login({
      requestId,
      correlationId: `transport-comparison-${runId}`,
      username: context.credentials.username,
      password: expectedOutcome === 'accepted' ? context.credentials.password : REJECTED_PASSWORD,
    });
    attempts.push({
      requestId,
      expectedOutcome,
      sentAt,
      responseMs: dependencies.clock.now().getTime() - sentAt.getTime(),
      httpStatus: response.httpStatus,
      auditEventId: response.auditEventId,
    });
  }
  return attempts;
}

async function pollStore(
  reader: AuditStoreReader,
  observation: MutableObservation,
  ids: readonly string[],
  window: LookupWindow,
  deadline: Date,
  clock: Clock,
): Promise<void> {
  const missing = ids.filter((id) => !observation.firstSeen.has(id));
  if (observation.error !== null || missing.length === 0) {
    return;
  }
  try {
    const found = await reader.findEventIds(missing, window, deadline);
    const seenAt = clock.now();
    for (const id of missing) {
      if (found.has(id)) {
        observation.firstSeen.set(id, seenAt);
      }
    }
  } catch (error) {
    // A failed query (for example AccessDenied) will not heal by polling.
    observation.error = describeError(error);
  }
}

async function refreshCatalog(catalog: SecurityLakeCatalog, observation: MutableObservation | undefined): Promise<void> {
  try {
    await catalog.startCrawler();
  } catch (error) {
    if (observation !== undefined) {
      observation.error = `crawler start failed: ${describeError(error)}`;
    }
  }
}

async function readDeliveryHealth(reader: DeliveryHealthReader): Promise<DeliveryHealthResult> {
  try {
    return { ...(await reader.read()), error: null };
  } catch (error) {
    return { deadLetterMessages: null, alarmsInAlarm: [], error: describeError(error) };
  }
}

function lookupWindow(
  logins: readonly LoginAttempt[],
  startedAt: Date,
  now: Date,
  context: ComparisonContext,
): LookupWindow {
  return {
    days: utcDaysBetween(logins[0]?.sentAt ?? startedAt, now),
    workloadAccountId: context.workloadAccountId,
    region: context.region,
  };
}

/** Every UTC day from the first login to now: events and deliveries can cross midnight. */
export function utcDaysBetween(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (day.getTime() <= to.getTime()) {
    days.push(new Date(day));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

function allSettled(observations: ReadonlyMap<StoreName, MutableObservation>, ids: readonly string[]): boolean {
  return [...observations.values()].every((observation) => !isMissing(observation, ids));
}

function isMissing(observation: MutableObservation | undefined, ids: readonly string[]): boolean {
  return observation !== undefined
    && observation.error === null
    && ids.some((id) => !observation.firstSeen.has(id));
}

function finalizeObservations(
  observations: ReadonlyMap<StoreName, MutableObservation>,
  ids: readonly string[],
): Map<StoreName, StoreObservation> {
  return new Map([...observations].map(([store, observation]) => [store, {
    status: observation.error !== null
      ? 'error'
      : ids.every((id) => observation.firstSeen.has(id)) ? 'complete' : 'incomplete',
    error: observation.error,
    firstSeen: observation.firstSeen,
  }]));
}

function compareEvent(
  login: LoginAttempt & { auditEventId: string },
  stores: ReadonlyMap<StoreName, StoreObservation>,
): EventComparison {
  const presence = (store: StoreName): EventPresence => {
    const seenAt = stores.get(store)?.firstSeen.get(login.auditEventId);
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

function isExpectedStatus({ expectedOutcome, httpStatus }: LoginAttempt): boolean {
  return expectedOutcome === 'accepted' ? httpStatus === 200 : httpStatus === 401;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}
