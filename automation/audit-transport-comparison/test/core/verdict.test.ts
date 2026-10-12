import { isExpectedStatus, utcDaysBetween } from '../../src/core/verdict';

describe('verdict rules', () => {
  it('queries every UTC day from the first login to now, across midnight', () => {
    expect(utcDaysBetween(new Date('2026-10-12T23:59:00Z'), new Date('2026-10-13T00:05:00Z')))
      .toEqual([new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T00:00:00Z')]);
  });

  it.each([
    ['accepted', 200, true],
    ['accepted', 401, false],
    ['rejected', 401, true],
    ['rejected', 302, false],
    ['rejected', null, false],
  ] as const)('%s login with HTTP %s is expected: %s', (expectedOutcome, httpStatus, expected) => {
    expect(isExpectedStatus({
      requestId: 'r', expectedOutcome, sentAt: new Date(0), responseMs: 0, httpStatus, auditEventId: null, error: null,
    })).toBe(expected);
  });
});
