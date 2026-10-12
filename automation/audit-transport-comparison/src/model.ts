/** Result document version; bump on any breaking change to its shape. */
export const RESULT_SCHEMA = 'audit-transport-comparison/v1' as const;

export type LoginOutcome = 'accepted' | 'rejected';
export type StoreName = 'securityLake' | 'legacy';

/** Athena location of the legacy FireLens -> Firehose -> S3 audit table. */
export interface LegacyStoreConfig {
  readonly workGroup: string;
  readonly database: string;
  readonly table: string;
}

/** Security Lake custom source, located through its Glue crawler. */
export interface SecurityLakeStoreConfig {
  readonly workGroup: string;
  readonly crawlerName: string;
  /** Start the crawler once so new eventday partitions become queryable. */
  readonly refreshCatalog: boolean;
}

export interface DeliveryHealthConfig {
  readonly deadLetterQueueUrl: string;
  readonly alarmNamePrefix: string;
}

/** Validated run file written by the private environments repository. */
export interface RunConfig {
  readonly endpoint: URL;
  /** Login route behind the endpoint; the demo web proxy by default. */
  readonly loginPath: string;
  readonly credentialsFile: string;
  readonly attempts: Readonly<Record<LoginOutcome, number>>;
  readonly workloadTargetFile: string;
  readonly auditTargetFile: string;
  readonly legacyStore: LegacyStoreConfig;
  readonly securityLakeStore: SecurityLakeStoreConfig;
  readonly deliveryHealth: DeliveryHealthConfig;
  readonly timeoutSeconds: number;
  readonly pollIntervalSeconds: number;
  /** Wait after the last login before starting the crawler (one buffer interval plus margin). */
  readonly catalogRefreshDelaySeconds: number;
  readonly output: string;
}

export interface DemoCredentials {
  readonly username: string;
  readonly password: string;
}

export interface LoginRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly httpStatus: number;
  /** Absent when the primary publisher did not accept the event (fail open). */
  readonly auditEventId: string | null;
}

export interface LoginAttempt {
  readonly requestId: string;
  readonly expectedOutcome: LoginOutcome;
  readonly sentAt: Date;
  readonly responseMs: number;
  readonly httpStatus: number;
  readonly auditEventId: string | null;
}

/** Fully qualified, validated Athena table. */
export interface AthenaTable {
  readonly workGroup: string;
  readonly database: string;
  readonly table: string;
}

/** Partition restriction for one bounded lookup. */
export interface LookupWindow {
  /** UTC days the events can be partitioned under. */
  readonly days: readonly Date[];
  /** Workload account whose Security Lake partition holds the events. */
  readonly workloadAccountId: string;
  readonly region: string;
}

/** Port: find which of the given audit event IDs are queryable in one store. */
export interface AuditStoreReader {
  findEventIds(ids: readonly string[], window: LookupWindow, deadline: Date): Promise<ReadonlySet<string>>;
}

/** Port: the Security Lake crawler and the table it materializes. */
export interface SecurityLakeCatalog {
  resolveTable(): Promise<{ readonly database: string; readonly table: string }>;
  startCrawler(): Promise<void>;
}

export interface DeliveryHealth {
  readonly deadLetterMessages: number;
  readonly alarmsInAlarm: readonly string[];
}

/** Delivery health as reported; counts are null when it could not be read. */
export interface DeliveryHealthResult {
  readonly deadLetterMessages: number | null;
  readonly alarmsInAlarm: readonly string[];
  readonly error: string | null;
}

/** Port: audit-account delivery health at the end of the run. */
export interface DeliveryHealthReader {
  read(): Promise<DeliveryHealth>;
}

/** Port: the reservation-service demo login endpoint. */
export interface LoginClient {
  login(request: LoginRequest): Promise<LoginResponse>;
}

/** Port: time, injectable so polling is deterministic in tests. */
export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface StoreObservation {
  readonly status: 'complete' | 'incomplete' | 'error';
  readonly error: string | null;
  /** First poll that saw each event ID. */
  readonly firstSeen: ReadonlyMap<string, Date>;
}

export interface EventComparison {
  readonly auditEventId: string;
  readonly expectedOutcome: LoginOutcome;
  readonly securityLake: EventPresence;
  readonly legacy: EventPresence;
}

export interface EventPresence {
  readonly found: boolean;
  /** Seconds from the login to the first poll that saw the event. */
  readonly delaySeconds: number | null;
}

export interface ComparisonResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly runId: string;
  readonly status: 'passed' | 'failed';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settings: {
    readonly attempts: Readonly<Record<LoginOutcome, number>>;
    readonly timeoutSeconds: number;
    readonly pollIntervalSeconds: number;
  };
  readonly logins: readonly SerializedLogin[];
  readonly stores: Readonly<Record<StoreName, SerializedStore>>;
  readonly events: readonly EventComparison[];
  readonly unauditedLogins: readonly string[];
  readonly deliveryHealth: DeliveryHealthResult;
  readonly notes: readonly string[];
}

export interface SerializedLogin {
  readonly requestId: string;
  readonly expectedOutcome: LoginOutcome;
  readonly sentAt: string;
  readonly responseMs: number;
  readonly httpStatus: number;
  readonly auditEventId: string | null;
}

export interface SerializedStore {
  readonly status: StoreObservation['status'];
  readonly error: string | null;
  readonly catalogRefreshStartedAt?: string | null;
}
