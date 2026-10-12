import { ATHENA_IDENTIFIER, AUDIT_EVENT_ID, AWS_ACCOUNT_ID, AWS_REGION } from '../core/identifiers';
import type { LookupWindow } from '../core/ports';

/**
 * SQL for the bounded per-poll lookups. Athena offers no bind parameters for
 * these queries, so every interpolated value is re-validated here, even when
 * the caller validated it already.
 */

/** Legacy table: partitioned by UTC *delivery* date (`ingest_date`, YYYY-MM-DD). */
export function legacyLookupQuery(database: string, table: string, ids: readonly string[], window: LookupWindow): string {
  const days = window.days.map((day) => quote(day.toISOString().slice(0, 10)));
  return [
    `SELECT DISTINCT metadata.uid AS uid FROM ${qualified(database, table)}`,
    `WHERE ingest_date IN (${days.join(', ')})`,
    `AND metadata.uid IN (${eventIdList(ids)})`,
  ].join('\n');
}

/** Security Lake custom source: partitioned by Region, account, and UTC *event* day (`eventday`, YYYYMMDD). */
export function securityLakeLookupQuery(database: string, table: string, ids: readonly string[], window: LookupWindow): string {
  if (!AWS_ACCOUNT_ID.test(window.workloadAccountId) || !AWS_REGION.test(window.region)) {
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
  if (!ATHENA_IDENTIFIER.test(database) || !ATHENA_IDENTIFIER.test(table)) {
    throw new Error('Athena database and table must be plain lowercase identifiers');
  }
  return `"${database}"."${table}"`;
}

function eventIdList(ids: readonly string[]): string {
  if (ids.length === 0 || ids.some((id) => !AUDIT_EVENT_ID.test(id))) {
    throw new Error('audit event IDs must be a non-empty list of UUIDs');
  }
  return ids.map(quote).join(', ');
}

function quote(value: string): string {
  return `'${value}'`;
}
