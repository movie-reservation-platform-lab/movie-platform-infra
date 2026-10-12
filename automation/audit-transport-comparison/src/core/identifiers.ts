/**
 * Shapes of values that end up inside Athena SQL. Athena offers no bind
 * parameters for these queries, so each value must match one of these
 * patterns before it is interpolated.
 */

/** An audit receipt: the OCSF `metadata.uid` UUID. */
export const AUDIT_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Glue database or table name, quoted as `"name"` in queries. */
export const ATHENA_IDENTIFIER = /^[a-z0-9_]{1,255}$/;

export const AWS_ACCOUNT_ID = /^[0-9]{12}$/;

export const AWS_REGION = /^[a-z]{2}-[a-z]+-[0-9]$/;
