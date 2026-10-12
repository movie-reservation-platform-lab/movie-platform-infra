import { REJECTED_PASSWORD, runComparison, utcDaysBetween } from '../src/comparison';
import {
  FakeClock,
  FakeStore,
  ID_ACCEPTED,
  ID_REJECTED,
  START,
  TEST_CONFIG,
  TEST_CONTEXT,
  after,
  dependencies,
  loginResponses,
} from './test-support';

describe('runComparison', () => {
  it('passes when every event reaches both stores and reports detection delays', async () => {
    const clock = new FakeClock();
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(clock));

    expect(result.status).toBe('passed');
    expect(result.schema).toBe('audit-transport-comparison/v1');
    expect(result.events).toEqual([
      { auditEventId: ID_ACCEPTED, expectedOutcome: 'accepted', securityLake: { found: true, delaySeconds: 120 }, legacy: { found: true, delaySeconds: 60 } },
      { auditEventId: ID_REJECTED, expectedOutcome: 'rejected', securityLake: { found: true, delaySeconds: 120 }, legacy: { found: true, delaySeconds: 60 } },
    ]);
    expect(result.stores.securityLake.status).toBe('complete');
    expect(result.stores.legacy.status).toBe('complete');
  });

  it('sends accepted logins with the real password and rejected ones with a fixed wrong password', async () => {
    const clock = new FakeClock();
    const logins = loginResponses(
      { httpStatus: 200, auditEventId: ID_ACCEPTED },
      { httpStatus: 401, auditEventId: ID_REJECTED },
    );
    await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(clock, { login: logins.client }));

    expect(logins.requests.map(({ password }) => password)).toEqual(['demo-password', REJECTED_PASSWORD]);
    expect(logins.requests.map(({ requestId }) => requestId)).toEqual(['run12345-1', 'run12345-2']);
    expect(new Set(logins.requests.map(({ correlationId }) => correlationId))).toEqual(
      new Set(['transport-comparison-run12345']),
    );
  });

  it('fails at the deadline and names the store that never received an event', async () => {
    const clock = new FakeClock();
    const deps = dependencies(clock, {
      stores: {
        securityLake: new FakeStore(clock, new Map([[ID_ACCEPTED, after(60)], [ID_REJECTED, after(60)]])),
        legacy: new FakeStore(clock, new Map([[ID_ACCEPTED, after(60)]])),
      },
    });
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, deps);

    expect(result.status).toBe('failed');
    expect(result.stores.legacy.status).toBe('incomplete');
    expect(result.events[1]?.legacy).toEqual({ found: false, delaySeconds: null });
    expect(clock.now().getTime() - START.getTime()).toBe(TEST_CONFIG.timeoutSeconds * 1000);
    expect(clock.sleeps.every((milliseconds) => milliseconds <= 30_000)).toBe(true);
  });

  it('counts a login without a receipt as unaudited instead of tracking it', async () => {
    const clock = new FakeClock();
    const deps = dependencies(clock, {
      login: loginResponses(
        { httpStatus: 200, auditEventId: null },
        { httpStatus: 401, auditEventId: ID_REJECTED },
      ).client,
    });
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, deps);

    expect(result.status).toBe('failed');
    expect(result.unauditedLogins).toEqual(['run12345-1']);
    expect(result.events.map(({ auditEventId }) => auditEventId)).toEqual([ID_REJECTED]);
  });

  it('stops polling a store after a query error and reports it', async () => {
    const clock = new FakeClock();
    const securityLake = new FakeStore(clock, new Map());
    securityLake.error = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(clock, {
      stores: { securityLake, legacy: new FakeStore(clock, new Map([[ID_ACCEPTED, after(0)], [ID_REJECTED, after(0)]])) },
    }));

    expect(result.status).toBe('failed');
    expect(result.stores.securityLake).toMatchObject({ status: 'error', error: 'AccessDeniedException: not authorized' });
    expect(securityLake.calls).toHaveLength(1);
  });

  it('starts the crawler once, only after the refresh delay and only while Security Lake lags', async () => {
    const clock = new FakeClock();
    const deps = dependencies(clock, {
      stores: {
        securityLake: new FakeStore(clock, new Map([[ID_ACCEPTED, after(300)], [ID_REJECTED, after(300)]])),
        legacy: new FakeStore(clock, new Map([[ID_ACCEPTED, after(60)], [ID_REJECTED, after(60)]])),
      },
    });
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, deps);

    expect(deps.crawlerStarts).toEqual([after(90)]);
    expect(result.stores.securityLake.catalogRefreshStartedAt).toBe(after(90).toISOString());
  });

  it('never starts the crawler when refreshCatalog is off', async () => {
    const clock = new FakeClock();
    const deps = dependencies(clock);
    await runComparison(
      { ...TEST_CONFIG, securityLakeStore: { ...TEST_CONFIG.securityLakeStore, refreshCatalog: false } },
      TEST_CONTEXT,
      deps,
    );

    expect(deps.crawlerStarts).toEqual([]);
  });

  it('fails on DLQ messages, delivery alarms, or unexpected HTTP statuses', async () => {
    const unhealthy = await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(
      new FakeClock(),
      {},
      { deadLetterMessages: 1, alarmsInAlarm: ['AuditAccountIngestionStack-AuditDeliveryAlarmsX'] },
    ));
    const clock = new FakeClock();
    const wrongStatus = await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(clock, {
      login: loginResponses(
        { httpStatus: 401, auditEventId: ID_ACCEPTED },
        { httpStatus: 401, auditEventId: ID_REJECTED },
      ).client,
    }));

    expect(unhealthy.status).toBe('failed');
    expect(wrongStatus.status).toBe('failed');
  });

  it('records unreadable delivery health as an error, not as healthy', async () => {
    const result = await runComparison(TEST_CONFIG, TEST_CONTEXT, dependencies(new FakeClock(), {
      deliveryHealth: { read: async () => { throw new Error('throttled'); } },
    }));

    expect(result.status).toBe('failed');
    expect(result.deliveryHealth).toEqual({ deadLetterMessages: null, alarmsInAlarm: [], error: 'throttled' });
  });

  it('queries every UTC day from the first login to now, across midnight', () => {
    expect(utcDaysBetween(new Date('2026-10-12T23:59:00Z'), new Date('2026-10-13T00:05:00Z')))
      .toEqual([new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T00:00:00Z')]);
  });
});
