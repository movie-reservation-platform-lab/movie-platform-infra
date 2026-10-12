import type {
  AuditStoreReader,
  Clock,
  DeliveryHealth,
  LoginRequest,
  LoginResponse,
  LookupWindow,
  RunConfig,
} from '../src/model';
import type { ComparisonDependencies } from '../src/comparison';

export const START = new Date('2026-10-12T21:00:00.000Z');

export const TEST_CONFIG: RunConfig = Object.freeze({
  endpoint: new URL('http://demo.example.test'),
  loginPath: '/audit-demo/reservation/login',
  credentialsFile: '/private/auth.json',
  attempts: { accepted: 1, rejected: 1 },
  workloadTargetFile: '/private/workload-target.json',
  auditTargetFile: '/private/audit-target.json',
  legacyStore: { workGroup: 'movie-platform-audit', database: 'movie_platform_audit', table: 'authentication' },
  securityLakeStore: { workGroup: 'movie-platform-audit-investigation', crawlerName: 'security-lake-crawler', refreshCatalog: true },
  deliveryHealth: {
    deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/222222222222/dlq',
    alarmNamePrefix: 'AuditAccountIngestionStack-AuditDeliveryAlarms',
  },
  timeoutSeconds: 600,
  pollIntervalSeconds: 30,
  catalogRefreshDelaySeconds: 90,
  output: '/private/result.json',
});

export const TEST_CONTEXT = Object.freeze({
  credentials: { username: 'demo-user', password: 'demo-password' },
  workloadAccountId: '333333333333',
  region: 'eu-central-1',
});

/** Deterministic clock: time advances only through sleep (and a fixed tick per call to tick()). */
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

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

export const ID_ACCEPTED = '11111111-1111-4111-8111-111111111111';
export const ID_REJECTED = '22222222-2222-4222-8222-222222222222';

/** Store that reveals each ID once the clock passes its availability time. */
export class FakeStore implements AuditStoreReader {
  public readonly calls: Array<{ ids: readonly string[]; window: LookupWindow }> = [];
  public error: Error | null = null;

  public constructor(
    private readonly clock: FakeClock,
    private readonly availableAt: ReadonlyMap<string, Date>,
  ) {}

  public async findEventIds(ids: readonly string[], window: LookupWindow): Promise<ReadonlySet<string>> {
    this.calls.push({ ids, window });
    if (this.error !== null) {
      throw this.error;
    }
    const now = this.clock.now();
    return new Set(ids.filter((id) => {
      const at = this.availableAt.get(id);
      return at !== undefined && at <= now;
    }));
  }
}

export function after(seconds: number): Date {
  return new Date(START.getTime() + seconds * 1000);
}

export function loginResponses(...responses: LoginResponse[]) {
  const requests: LoginRequest[] = [];
  return {
    requests,
    client: {
      login: async (request: LoginRequest): Promise<LoginResponse> => {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response === undefined) {
          throw new Error('unexpected login');
        }
        return response;
      },
    },
  };
}

export function dependencies(
  clock: FakeClock,
  overrides: Partial<ComparisonDependencies> = {},
  health: DeliveryHealth = { deadLetterMessages: 0, alarmsInAlarm: [] },
): ComparisonDependencies & { crawlerStarts: Date[] } {
  const crawlerStarts: Date[] = [];
  return {
    clock,
    login: loginResponses(
      { httpStatus: 200, auditEventId: ID_ACCEPTED },
      { httpStatus: 401, auditEventId: ID_REJECTED },
    ).client,
    stores: {
      securityLake: new FakeStore(clock, new Map([[ID_ACCEPTED, after(120)], [ID_REJECTED, after(120)]])),
      legacy: new FakeStore(clock, new Map([[ID_ACCEPTED, after(60)], [ID_REJECTED, after(60)]])),
    },
    securityLakeCatalog: {
      resolveTable: async () => ({ database: 'db', table: 'table' }),
      startCrawler: async () => {
        crawlerStarts.push(clock.now());
      },
    },
    deliveryHealth: { read: async () => health },
    newRunId: () => 'run12345',
    crawlerStarts,
    ...overrides,
  };
}
