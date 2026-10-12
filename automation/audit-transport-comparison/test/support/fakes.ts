import type { LoginOutcome } from '../../src/core/comparison-result';
import {
  QueryDeadlineExceededError,
  type AuditStoreReader,
  type Clock,
  type DeliveryHealth,
  type LoginRequest,
  type LoginResponse,
  type LookupWindow,
} from '../../src/core/ports';
import type { ComparisonDependencies } from '../../src/core/run-comparison';
import type { ComparisonContext, ComparisonSettings } from '../../src/core/settings';

export const START = new Date('2026-10-12T21:00:00.000Z');
export const ID_ACCEPTED = '11111111-1111-4111-8111-111111111111';
export const ID_REJECTED = '22222222-2222-4222-8222-222222222222';

export const TEST_SETTINGS: ComparisonSettings = Object.freeze({
  attempts: Object.freeze({ accepted: 1, rejected: 1 }),
  timeoutSeconds: 600,
  pollIntervalSeconds: 30,
  refreshCatalog: true,
  catalogRefreshDelaySeconds: 90,
});

export const TEST_CONTEXT: ComparisonContext = Object.freeze({
  credentials: { username: 'demo-user', password: 'demo-password' },
  workloadAccountId: '333333333333',
  region: 'eu-central-1',
});

/** Seconds after START, as a Date. */
export function after(seconds: number): Date {
  return new Date(START.getTime() + seconds * 1000);
}

/** Deterministic clock: time moves only when the code under test sleeps. */
export class FakeClock implements Clock {
  public readonly sleeps: number[] = [];
  private current: number;

  public constructor(start: Date = START) {
    this.current = start.getTime();
  }

  public now(): Date {
    return new Date(this.current);
  }

  public async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.current += milliseconds;
  }
}

/**
 * Store that reveals each ID once the clock reaches its availability time.
 * Like the real Athena reader, a lookup started at or after the deadline
 * throws QueryDeadlineExceededError.
 */
export class FakeStore implements AuditStoreReader {
  public readonly calls: Array<{ ids: readonly string[]; window: LookupWindow }> = [];
  public failure: Error | null = null;

  public constructor(
    private readonly clock: FakeClock,
    private readonly availableAt: ReadonlyMap<string, Date>,
  ) {}

  public async findEventIds(ids: readonly string[], window: LookupWindow, deadline: Date): Promise<ReadonlySet<string>> {
    this.calls.push({ ids, window });
    if (this.failure !== null) {
      throw this.failure;
    }
    const now = this.clock.now();
    if (now >= deadline) {
      throw new QueryDeadlineExceededError();
    }
    return new Set(ids.filter((id) => (this.availableAt.get(id) ?? Infinity) <= now));
  }
}

export function availableAfter(clock: FakeClock, seconds: Record<string, number>): FakeStore {
  return new FakeStore(clock, new Map(Object.entries(seconds).map(([id, delay]) => [id, after(delay)])));
}

/** Login client answering from a script; requests are recorded for assertions. */
export function scriptedLogins(...responses: Array<LoginResponse | Error>) {
  const requests: LoginRequest[] = [];
  return {
    requests,
    client: {
      login: async (request: LoginRequest): Promise<LoginResponse> => {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response === undefined) {
          throw new Error(`no scripted response for login ${requests.length}`);
        }
        if (response instanceof Error) {
          throw response;
        }
        return response;
      },
    },
  };
}

/** A healthy run: each attempt gets its expected status and a receipt; legacy at +60 s, Security Lake at +120 s. */
export function fakeComparisonDependencies(
  clock: FakeClock,
  overrides: Partial<ComparisonDependencies> = {},
  health: DeliveryHealth = { deadLetterMessages: 0, alarmsInAlarm: [] },
): ComparisonDependencies & { readonly crawlerStarts: Date[] } {
  const crawlerStarts: Date[] = [];
  const statusFor: Record<LoginOutcome, number> = { accepted: 200, rejected: 401 };
  return {
    clock,
    login: scriptedLogins(
      { httpStatus: statusFor.accepted, auditEventId: ID_ACCEPTED },
      { httpStatus: statusFor.rejected, auditEventId: ID_REJECTED },
    ).client,
    stores: {
      securityLake: availableAfter(clock, { [ID_ACCEPTED]: 120, [ID_REJECTED]: 120 }),
      legacy: availableAfter(clock, { [ID_ACCEPTED]: 60, [ID_REJECTED]: 60 }),
    },
    catalog: {
      startCrawler: async () => {
        crawlerStarts.push(clock.now());
      },
    },
    deliveryHealth: { read: async () => health },
    newRunId: () => 'run12345',
    ...overrides,
    crawlerStarts,
  };
}
