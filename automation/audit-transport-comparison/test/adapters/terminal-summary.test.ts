import { renderSummary } from '../../src/adapters/terminal-summary';
import { runComparison } from '../../src/core/run-comparison';
import { FakeClock, TEST_CONTEXT, TEST_SETTINGS, fakeComparisonDependencies, scriptedLogins, ID_REJECTED } from '../support/fakes';

describe('renderSummary', () => {
  it('shows each event per store with its delay, and the overall verdict', async () => {
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(new FakeClock()));

    expect(renderSummary(result)).toBe([
      'Audit transport comparison run12345: PASSED',
      '',
      'event     outcome   security-lake  legacy',
      '11111111  accepted  found +120s    found +60s',
      '22222222  rejected  found +120s    found +60s',
      '',
      'Security Lake store: complete',
      'Legacy store:        complete',
      'Unaudited logins (no receipt): 0',
      'Unexpected HTTP results: 0',
      'Delivery health: DLQ messages 0, alarms in ALARM 0',
      '',
    ].join('\n'));
  });

  it('marks missing events and counts unaudited logins', async () => {
    const clock = new FakeClock();
    const result = await runComparison(TEST_SETTINGS, TEST_CONTEXT, fakeComparisonDependencies(clock, {
      login: scriptedLogins({ httpStatus: 200, auditEventId: null }, { httpStatus: 401, auditEventId: ID_REJECTED }).client,
    }));

    expect(renderSummary(result)).toContain('FAILED');
    expect(renderSummary(result)).toContain('Unaudited logins (no receipt): 1');
  });
});
