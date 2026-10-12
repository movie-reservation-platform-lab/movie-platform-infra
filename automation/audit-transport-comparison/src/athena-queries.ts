import type { LookupWindow } from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z0-9_]{1,255}$/;

/**
 * Legacy table: partitioned by UTC *delivery* date (`ingest_date`, YYYY-MM-DD).
 * Every interpolated value is validated first; Athena has no bind parameters
 * for this query shape.
 */
export function legacyLookupQuery(
  database: string,
  table: string,
  ids: readonly string[],
  window: LookupWindow,
): string {
  const days = window.days.map((day) => quote(day.toISOString().slice(0, 10)));
  return [
    `SELECT DISTINCT metadata.uid AS uid FROM ${qualified(database, table)}`,
    `WHERE ingest_date IN (${days.join(', ')})`,
    `AND metadata.uid IN (${eventIdList(ids)})`,
  ].join('\n');
}

/**
 * Security Lake custom source: partitioned by Region, workload account, and
 * UTC *event* day (`eventday`, YYYYMMDD).
 */
export function securityLakeLookupQuery(
  database: string,
  table: string,
  ids: readonly string[],
  window: LookupWindow,
): string {
  if (!/^[0-9]{12}$/.test(window.workloadAccountId) || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(window.region)) {
    throw new Error('the lookup window has an invalid account or Region');
  }
  const days = window.days.map((day) => quote(day.toISOString().slice(0, 10).replaceAll('-', '')));
  return [
    `SELECT DISTINCT metadata.uid AS uid FROM ${qualified(database, table)}`,
    `WHERE region = ${quote(window.region)}`,
    `AND accountid = ${quote(window.workloadAccountId)}`,
    `AND eventday IN (${days.join(', ')})`,
    `AND metadata.uid IN (${eventIdList(ids)})`,
  ].join('\n');
}

function qualified(database: string, table: string): string {
  if (!IDENTIFIER.test(database) || !IDENTIFIER.test(table)) {
    throw new Error('Athena database and table must be plain lowercase identifiers');
  }
  return `"${database}"."${table}"`;
}

function eventIdList(ids: readonly string[]): string {
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) {
    throw new Error('audit event IDs must be a non-empty list of UUIDs');
  }
  return ids.map(quote).join(', ');
}

function quote(value: string): string {
  return `'${value}'`;
}
