/**
 * Ports: what the comparison needs from the outside world. The core owns these
 * interfaces; `adapters/` implements them and `cli/` wires the implementations.
 */

/** Partition restriction for one bounded store lookup. */
export interface LookupWindow {
  /** Every UTC day the events can be partitioned under. */
  readonly days: readonly Date[];
  /** Workload account whose Security Lake partition holds the events. */
  readonly workloadAccountId: string;
  readonly region: string;
}

/** Find which of the given audit event IDs are queryable in one store. */
export interface AuditStoreReader {
  /** @throws {QueryDeadlineExceededError} when the lookup cannot finish before `deadline`. */
  findEventIds(ids: readonly string[], window: LookupWindow, deadline: Date): Promise<ReadonlySet<string>>;
}

/**
 * The run deadline passed while a lookup was still running. Not a store
 * failure: the events simply were not seen in time.
 */
export class QueryDeadlineExceededError extends Error {
  public constructor() {
    super('the lookup did not finish before the run deadline');
    this.name = 'QueryDeadlineExceededError';
  }
}

/** Makes newly delivered Security Lake partitions visible to queries. */
export interface CatalogRefresher {
  startCrawler(): Promise<void>;
}

export interface DeliveryHealth {
  readonly deadLetterMessages: number;
  readonly alarmsInAlarm: readonly string[];
}

/** Audit-account delivery health: target DLQ depth and delivery alarms in ALARM. */
export interface DeliveryHealthReader {
  read(): Promise<DeliveryHealth>;
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

/** The reservation-service demo login route. Rejects only on transport failure. */
export interface LoginClient {
  login(request: LoginRequest): Promise<LoginResponse>;
}

/** Time, injectable so polling is deterministic in tests. */
export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
