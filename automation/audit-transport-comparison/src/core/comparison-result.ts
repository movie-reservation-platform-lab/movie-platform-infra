/**
 * The evidence contract written by every run. Versioned: change
 * `RESULT_SCHEMA` for any breaking change to these shapes.
 */
export const RESULT_SCHEMA = 'audit-transport-comparison/v1' as const;

/** What the login should do: accepted uses the real password, rejected a wrong one. */
export type LoginOutcome = 'accepted' | 'rejected';

/** The two audit stores being compared. */
export type StoreName = 'securityLake' | 'legacy';

/** One controlled login, as sent and as answered. */
export interface LoginAttempt {
  readonly requestId: string;
  readonly expectedOutcome: LoginOutcome;
  readonly sentAt: Date;
  readonly responseMs: number;
  /** `null` when the request failed before any HTTP response arrived. */
  readonly httpStatus: number | null;
  /** The audit receipt; `null` when the service failed open without one. */
  readonly auditEventId: string | null;
  /** Redacted transport error when the request failed, otherwise `null`. */
  readonly error: string | null;
}

/** A login that returned a receipt, so its event can be looked up in both stores. */
export type AuditedLogin = LoginAttempt & { readonly auditEventId: string };

/** Whether one event reached one store, and how long detection took. */
export interface EventPresence {
  readonly found: boolean;
  /**
   * Seconds from the login to the first poll that saw the event, rounded.
   * Detection time, so it is bounded below by the poll interval.
   */
  readonly delaySeconds: number | null;
}

/** One audited login compared across both stores. */
export interface EventComparison {
  readonly auditEventId: string;
  readonly expectedOutcome: LoginOutcome;
  readonly securityLake: EventPresence;
  readonly legacy: EventPresence;
}

/** How polling one store ended. */
export interface StoreEvidence {
  /**
   * `complete`: every audited event was found. `incomplete`: the deadline
   * passed first. `error`: a query failed and polling that store stopped.
   */
  readonly status: 'complete' | 'incomplete' | 'error';
  readonly error: string | null;
}

/** Security Lake also records the optional, single crawler start. */
export interface SecurityLakeStoreEvidence extends StoreEvidence {
  readonly catalogRefreshStartedAt: string | null;
  /** A failed crawler start does not stop polling: existing partitions stay readable. */
  readonly catalogRefreshError: string | null;
}

/** Audit-account delivery health at the end of the run; counts are `null` when unreadable. */
export interface DeliveryHealthEvidence {
  readonly deadLetterMessages: number | null;
  readonly alarmsInAlarm: readonly string[];
  readonly error: string | null;
}

/** A login as serialized into the evidence. */
export type LoginEvidence = Omit<LoginAttempt, 'sentAt'> & {
  readonly sentAt: string;
  /** 200 for accepted and 401 for rejected logins. */
  readonly expectedStatus: boolean;
};

export interface ComparisonResult {
  readonly schema: typeof RESULT_SCHEMA;
  /** Short random ID; every request ID of the run starts with it. */
  readonly runId: string;
  /**
   * `passed` only when every login got its expected status and a receipt, every
   * audited event reached both stores, and delivery health is clean.
   */
  readonly status: 'passed' | 'failed';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settings: {
    readonly attempts: Readonly<Record<LoginOutcome, number>>;
    readonly timeoutSeconds: number;
    readonly pollIntervalSeconds: number;
  };
  readonly logins: readonly LoginEvidence[];
  readonly stores: {
    readonly securityLake: SecurityLakeStoreEvidence;
    readonly legacy: StoreEvidence;
  };
  readonly events: readonly EventComparison[];
  /** Request IDs of logins without a receipt: their audit event was not accepted. */
  readonly unauditedLogins: readonly string[];
  readonly deliveryHealth: DeliveryHealthEvidence;
  /** What is and is not comparable between the two stores. */
  readonly notes: readonly string[];
}
