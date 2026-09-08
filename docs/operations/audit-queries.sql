-- Run in workgroup movie-platform-audit, database movie_platform_audit.
-- Replace dates and IDs before running. Partitions use DELIVERY date in UTC.

-- 1. Find the event returned by a failed login (duplicates remain visible).
SELECT from_unixtime(time / 1000.0) AS occurred_at,
       metadata.uid AS audit_event_id, service.name AS service,
       service.version AS deployed_version, status_detail,
       metadata.correlation_uid AS action_id,
       unmapped.platform.request_id AS request_id,
       unmapped.platform.trace_id AS trace_id,
       unmapped.platform.span_id AS span_id,
       unmapped.platform.aws_alb_trace_id AS alb_trace
FROM authentication
WHERE ingest_date = '2026-09-08'
  AND metadata.uid = 'REPLACE-WITH-RESPONSE-AUDIT-EVENT-ID';

-- 2. Join that application event to native ALB evidence. The header can include
-- multiple semicolon-delimited fields; compare Root, not the entire header.
WITH selected_event AS (
  SELECT metadata.uid, unmapped.platform.trace_id AS otel_trace_id,
         regexp_extract(unmapped.platform.aws_alb_trace_id, 'Root=([^;]+)', 1) AS alb_root
  FROM authentication
  WHERE ingest_date = '2026-09-08'
    AND metadata.uid = 'REPLACE-WITH-RESPONSE-AUDIT-EVENT-ID'
)
SELECT e.uid, e.otel_trace_id, e.alb_root, a.line AS alb_access_record
FROM selected_event e
JOIN alb_access a
  ON e.alb_root = regexp_extract(a.line, '"Root=([^;" ]+)', 1)
WHERE a.log_date = '2026/09/08' AND e.alb_root <> '';

-- 3. Count rejected credential checks without double-counting delivery retries.
SELECT service.name, status_detail, count(DISTINCT metadata.uid) AS attempts
FROM authentication
WHERE ingest_date = '2026-09-08' AND status_id = 2
GROUP BY service.name, status_detail;

-- 4. Separate AWS lifecycle investigation: who changed ECS, ECR or Firehose?
-- This is deployment evidence, NOT proof a failed login caused a deployment.
SELECT eventtime, eventsource, eventname, useridentity.arn AS caller,
       useridentity.sessioncontext.sessionissuer.arn AS role,
       eventid, requestid, requestparameters
FROM cloudtrail_management
WHERE log_date = '2026/09/08'
  AND eventsource IN ('ecs.amazonaws.com', 'ecr.amazonaws.com',
                      'firehose.amazonaws.com', 'cloudformation.amazonaws.com')
ORDER BY eventtime DESC
LIMIT 50;
