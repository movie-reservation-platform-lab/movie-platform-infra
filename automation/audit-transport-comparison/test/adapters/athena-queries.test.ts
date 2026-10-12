import { legacyLookupQuery, securityLakeLookupQuery } from '../../src/adapters/athena-queries';
import { ID_ACCEPTED, ID_REJECTED } from '../support/fakes';

const WINDOW = {
  days: [new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T00:00:00Z')],
  workloadAccountId: '333333333333',
  region: 'eu-central-1',
};

describe('Athena lookup queries', () => {
  it('prunes the legacy table by UTC delivery date', () => {
    expect(legacyLookupQuery('movie_platform_audit', 'authentication', [ID_ACCEPTED, ID_REJECTED], WINDOW)).toBe([
      'SELECT DISTINCT metadata.uid AS uid FROM "movie_platform_audit"."authentication"',
      "WHERE ingest_date IN ('2026-10-12', '2026-10-13')",
      `AND metadata.uid IN ('${ID_ACCEPTED}', '${ID_REJECTED}')`,
    ].join('\n'));
  });

  it('prunes Security Lake by Region, workload account, and UTC event day', () => {
    expect(securityLakeLookupQuery('sl_db', 'sl_table', [ID_ACCEPTED], WINDOW)).toBe([
      'SELECT DISTINCT metadata.uid AS uid FROM "sl_db"."sl_table"',
      "WHERE region = 'eu-central-1'",
      "AND accountid = '333333333333'",
      "AND eventday IN ('20261012', '20261013')",
      `AND metadata.uid IN ('${ID_ACCEPTED}')`,
    ].join('\n'));
  });

  it.each([
    ['a non-UUID event ID', () => legacyLookupQuery('db', 'table', ["x' OR '1'='1"], WINDOW), 'UUIDs'],
    ['an empty ID list', () => legacyLookupQuery('db', 'table', [], WINDOW), 'non-empty'],
    ['a non-identifier table', () => securityLakeLookupQuery('db', 'Table-1', [ID_ACCEPTED], WINDOW), 'plain lowercase identifiers'],
    ['a forged account', () => securityLakeLookupQuery('db', 'table', [ID_ACCEPTED], { ...WINDOW, workloadAccountId: "1' OR '1" }), 'invalid account or Region'],
  ])('refuses %s', (_label, build, message) => {
    expect(build).toThrow(message);
  });
});
