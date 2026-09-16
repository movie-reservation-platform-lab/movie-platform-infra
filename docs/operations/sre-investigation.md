# Recommendation failures: investigation guide

Audience: investigation-only participant. Use synthetic demo data and your named
account. Propose mitigations; the operator performs approved changes. Do not
restart services, change IAM, retrieve secrets, deploy, or delete resources.

## Establish impact

1. Record alert time, environment, service, dashboard link and current state.
2. Inspect recommendation request volume, HTTP status distribution, error estimate
   and latency over the same interval. Confirm telemetry is fresh. A green health
   endpoint does not prove the user workflow is healthy; NoData is not recovery.
3. Establish which user flows fail and which still succeed. Avoid repeated booking
   attempts that could create duplicate synthetic reservations. Ask the operator
   for a bounded reproduction and record its request/correlation ID if available.

## Follow evidence

1. Open trace search for the failing time window and service. Compare a failing
   request with a successful one. Follow parent/child spans and inspect status,
   duration and dependency boundaries rather than assuming the root span identifies
   the root cause. Missing spans can mean instrumentation or sampling gaps.
2. Search operational logs using the actual trace ID. Where a component lacks a
   trace ID, use the same request/correlation ID and time window. Do not invent or
   truncate identifiers. Compare errors across the agent, MCP and dependency API.
3. Inspect permitted ECS task/service health and recent deployment information.
   Multiple application containers share one task, so task replacement can affect
   the whole demo and its in-memory state. Distinguish platform and application
   evidence; do not restart the task simply because an alert is red.
4. Consult the public source at the demonstrated revision. Form a hypothesis with
   observations supporting it, observations contradicting it, and a safe next check.

## Recommend and verify

Explain likely user impact, failure boundary, evidence, a reversible mitigation
and its risks. Ask the operator to execute an agreed change. Confirm the user
workflow succeeds, telemetry remains fresh, and the error window clears to Normal.
An alert disappearing because telemetry stopped is not a successful mitigation.
Summarize the timeline, diagnosis confidence and one longer-term improvement.
