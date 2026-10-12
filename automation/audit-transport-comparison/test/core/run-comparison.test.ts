import { REJECTED_PASSWORD, runComparison } from '../../src/core/run-comparison';
import {
  FakeClock,
  ID_ACCEPTED,
  ID_REJECTED,
  START,
  TEST_CONTEXT,
  TEST_SETTINGS,
  after,
  availableAfter,
  fakeComparisonDependencies,
  scriptedLogins,
} from '../support/fakes';

describe('runComparison', () => {
  it('passes when every event reaches both stores and reports detection delays', async () => {
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock()));

    expect(result.status).toBe('passed');
    expect(result.events).toEqual([
      { auditEventId: ID_ACCEPTED, expectedOutcome: 'accepted', securityLake: { found: true, delaySeconds: 120 }, legacy: { found: true, delaySeconds: 60 } },
      { auditEventId: ID_REJECTED, expectedOutcome: 'rejected', securityLake: { found: true, delaySeconds: 120 }, legacy: { found: true, delaySeconds: 60 } },
    ]);
    expect(result.stores.securityLake.status).toBe('complete');
    expect(result.stores.legacy.status).toBe('complete');
    expect(result.logins.every(({ expectedStatus }) => expectedStatus)).toBe(true);
  });

  it('sends accepted logins with the real password and rejected ones with a fixed wrong password', async () => {
    const logins = scriptedLogins(
      { httpStatus: 200, auditEventId: ID_ACCEPTED },
      { httpStatus: 401, auditEventId: ID_REJECTED },
    );
    await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), { login: logins.client }));

    expect(logins.requests.map(({ password }) => password)).toEqual(['demo-password', REJECTED_PASSWORD]);
    expect(logins.requests.map(({ requestId }) => requestId)).toEqual(['run12345-1', 'run12345-2']);
    expect(new Set(logins.requests.map(({ correlationId }) => correlationId))).toEqual(new Set(['transport-comparison-run12345']));
  });

  it('reports a store that is still missing events at the deadline as incomplete, not as an error', async () => {
    const clock = new FakeClock();
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(clock, {
      stores: {
        securityLake: availableAfter(clock, { [ID_ACCEPTED]: 60, [ID_REJECTED]: 60 }),
        legacy: availableAfter(clock, { [ID_ACCEPTED]: 60 }),
      },
    }));

    expect(result.status).toBe('failed');
    expect(result.stores.legacy).toEqual({ status: 'incomplete', error: null });
    expect(result.events[1]?.legacy).toEqual({ found: false, delaySeconds: null });
  });

  it('never sleeps past the deadline or longer than one poll interval', async () => {
    const clock = new FakeClock();
    await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(clock, {
      stores: { securityLake: availableAfter(clock, {}), legacy: availableAfter(clock, {}) },
    }));

    expect(clock.now()).toEqual(after(TEST_SETTINGS.timeoutSeconds));
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(TEST_SETTINGS.pollIntervalSeconds * 1000);
  });

  it('counts a login without a receipt as unaudited instead of tracking it', async () => {
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), {
      login: scriptedLogins({ httpStatus: 200, auditEventId: null }, { httpStatus: 401, auditEventId: ID_REJECTED }).client,
    }));

    expect(result.status).toBe('failed');
    expect(result.unauditedLogins).toEqual(['run12345-1']);
    expect(result.events.map(({ auditEventId }) => auditEventId)).toEqual([ID_REJECTED]);
  });

  it('records a login transport failure with a redacted error and still produces evidence', async () => {
    const failure = new TypeError('fetch failed: connect ECONNREFUSED http://internal-alb.example:80');
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), {
      login: scriptedLogins(failure, { httpStatus: 401, auditEventId: ID_REJECTED }).client,
    }));

    expect(result.status).toBe('failed');
    expect(result.logins[0]).toMatchObject({ httpStatus: null, auditEventId: null, expectedStatus: false });
    expect(result.logins[0]?.error).toBe('TypeError: fetch failed: connect ECONNREFUSED <url>');
  });

  it('stops polling a store after a query error and keeps the error', async () => {
    const clock = new FakeClock();
    const securityLake = availableAfter(clock, {});
    securityLake.failure = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(clock, {
      stores: { securityLake, legacy: availableAfter(clock, { [ID_ACCEPTED]: 0, [ID_REJECTED]: 0 }) },
    }));

    expect(result.status).toBe('failed');
    expect(result.stores.securityLake).toMatchObject({ status: 'error', error: 'AccessDeniedException: not authorized' });
    expect(securityLake.calls).toHaveLength(1);
  });

  describe('Security Lake crawler', () => {
    it('starts once, after the refresh delay, while Security Lake lags', async () => {
      const clock = new FakeClock();
      const dependencies = fakeComparisonDependencies(clock, {
        stores: {
          securityLake: availableAfter(clock, { [ID_ACCEPTED]: 300, [ID_REJECTED]: 300 }),
          legacy: availableAfter(clock, { [ID_ACCEPTED]: 60, [ID_REJECTED]: 60 }),
        },
      });
      const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, dependencies);

      expect(dependencies.crawlerStarts).toEqual([after(90)]);
      expect(result.stores.securityLake.catalogRefreshStartedAt).toBe(after(90).toISOString());
    });

    it('is not started when Security Lake already has every event', async () => {
      const clock = new FakeClock();
      const dependencies = fakeComparisonDependencies(clock, {
        stores: {
          securityLake: availableAfter(clock, { [ID_ACCEPTED]: 30, [ID_REJECTED]: 30 }),
          legacy: availableAfter(clock, { [ID_ACCEPTED]: 300, [ID_REJECTED]: 300 }),
        },
      });
      await runComparison(TEST_SETTINGS, TEST_CONTEXT, dependencies);

      expect(dependencies.crawlerStarts).toEqual([]);
    });

    it('is never started when refreshCatalog is off', async () => {
      const dependencies = fakeComparisonDependencies(new FakeClock());
      await runComparison({ ...TEST_SETTINGS, refreshCatalog: false }, TEST_CONTEXT, dependencies);

      expect(dependencies.crawlerStarts).toEqual([]);
    });

    it('records a failed start but keeps polling, because existing partitions stay readable', async () => {
      const clock = new FakeClock();
      const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(clock, {
        stores: {
          securityLake: availableAfter(clock, { [ID_ACCEPTED]: 150, [ID_REJECTED]: 150 }),
          legacy: availableAfter(clock, { [ID_ACCEPTED]: 60, [ID_REJECTED]: 60 }),
        },
        catalog: { startCrawler: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); } },
      }));

      expect(result.stores.securityLake).toMatchObject({ status: 'complete', catalogRefreshError: 'AccessDeniedException: denied' });
      expect(result.status).toBe('passed');
    });
  });

  describe('delivery health', () => {
    it.each([
      ['a DLQ message', { deadLetterMessages: 1, alarmsInAlarm: [] }],
      ['a delivery alarm in ALARM', { deadLetterMessages: 0, alarmsInAlarm: ['AuditAccountIngestionStack-X'] }],
    ])('fails the run on %s', async (_label, health) => {
      const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), {}, health));

      expect(result.status).toBe('failed');
    });

    it('records unreadable health as an error, not as healthy', async () => {
      const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), {
        deliveryHealth: { read: async () => { throw new Error('throttled'); } },
      }));

      expect(result.status).toBe('failed');
      expect(result.deliveryHealth).toEqual({ deadLetterMessages: null, alarmsInAlarm: [], error: 'throttled' });
    });
  });

  it('fails the run when a login gets the wrong HTTP status', async () => {
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock(), {
      login: scriptedLogins({ httpStatus: 401, auditEventId: ID_ACCEPTED }, { httpStatus: 401, auditEventId: ID_REJECTED }).client,
    }));

    expect(result.status).toBe('failed');
    expect(result.logins.map(({ expectedStatus }) => expectedStatus)).toEqual([false, true]);
    expect(result.startedAt).toBe(START.toISOString());
  });
});
