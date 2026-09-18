# Advisory service signal contract

Tracking: [issue #57](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/57).

## Status and intent

This is an advisory `v0` contract for the five telemetry-producing backend and
MCP services in the integrated demo. It defines the minimum operational meaning
the platform needs while allowing each language and OpenTelemetry SDK to retain
its native instrument names and shapes.

The contract is a starting point, not a compatibility gate. Each producer
should follow it where practical and update the documented mapping when local
exporter evidence reveals different names, units, attributes, or SDK behavior.
The first binding baseline, if one is needed, can be defined after all five
producers have supplied observed payload evidence.

This document does not require a universal metric namespace, a shared logging
library, browser instrumentation, or simultaneous service releases.

## Ownership

| Boundary | Owner | Responsibility |
| --- | --- | --- |
| Signal semantics and backend routing expectations | `movie-platform-infra` issue #57 | Maintain this contract, collector mappings, offline compatibility checks, and the evidence matrix. |
| Instrumentation and local payload evidence | Each producer repository | Emit useful signals without changing application behavior when telemetry is unavailable; document observed native output. |
| Dashboard and alert queries | `movie-platform-infra` issue #58 | Consume verified backend names and preserve the zero/idle/stale semantics below. |
| Immutable artifact selection and promotion | Environment composition workflow | Select reviewed digests and record the desired and observed release composition. |

The semantic contract is the stable boundary. Framework-specific instrumentation
is an adapter to that boundary. Straightforward CDK and collector declarations
remain direct; this does not justify new application/domain layers in the
infrastructure repository.

## Canonical resource identity

Deployment configuration owns the identity values and injects them into each
container. Producers attach them to emitted resources; collector normalization
may translate field spelling for a backend but should not conceal mismatches.

| Attribute | Meaning | Example |
| --- | --- | --- |
| `service.name` | Stable deployable identity | `movie-reservation-mcp` |
| `service.namespace` | Stable platform identity | configured platform name |
| `deployment.environment.name` | Deployment environment | `aws-demo` |
| `service.version` | Immutable release identifier selected for the container | repository release/source identifier |

The five service names are:

- `movie-reservation-service`
- `movie-reservation-agent`
- `movie-reservation-mcp`
- `movie-recommendation-mcp`
- `movie-recommendation-service`

## Coverage tiers

### Initial integration

Every producer should provide:

- canonical resource identity;
- W3C trace-context extraction and downstream propagation;
- correlated structured stdout logs;
- one usable traffic, latency, and bounded outcome metric set for its primary
  request or tool boundary;
- local evidence containing the actual exported payload.

### Producer-specific targets

| Producer | Target signals | Implementation owner |
| --- | --- | --- |
| Reservation service | HTTP success/4xx/5xx, GraphQL success/business failure even when HTTP is 200, reservation-worker success/failure and duration | `movie-reservation-service#42` |
| Reservation agent | Native FastAPI request traffic/duration and bounded 4xx/5xx outcomes in deterministic and real runtime modes | `movie-reservation-agent#20` |
| Reservation MCP | Allowlisted tool traffic/duration/outcome, accurate validation/dependency failures, connected downstream reservation spans | `movie-reservation-mcp#6` |
| Recommendation MCP | Corrected tool outcomes and trace parenting with bounded tool/outcome dimensions | `movie-recommendation-mcp#6` |
| Recommendation service | HTTP traffic/duration/outcomes, structured correlation, controlled dependency/failure evidence | `movie-recommendation-service#2` |

### Future improvements

Additional domain, dependency, runtime, tenant, and business signals may be
added when a demonstrated investigation or operating need justifies them. They
do not delay the initial five-producer integration.

## Metric semantics

The contract standardizes meaning rather than requiring identical instrument
names. For every accepted metric family, the evidence matrix records:

- semantic purpose;
- native OpenTelemetry instrument name;
- type, unit, temporality, and export cadence;
- permitted bounded attributes;
- translated AMP series name and CloudWatch identity/dimensions;
- eligible traffic and exclusions;
- zero, idle, and stale behavior.

Do not guess SDK-generated names or translation behavior. Record them from local
exporter output and collector validation. Backend-translated names remain
provisional until the separately authorized live acceptance checks observe them.

### Reconciled producer evidence

The producer PRs supplied credential-free in-memory exporter evidence. The
collector fixture at
`test/fixtures/five-backend-signal-contract.json` binds these exact native names
to five private receivers and verifies offline routing to AMP, CloudWatch,
X-Ray, and optional Tempo without claiming backend queryability.

| Producer evidence | Native metric families | Type and unit | Exact bounded attributes | Zero, idle, and freshness semantics |
| --- | --- | --- | --- | --- |
| [reservation service PR #43](https://github.com/movie-reservation-platform-lab/movie-reservation-service/pull/43) | `http_request_total`, `http_request_duration_ms`; `graphql_operation_total`, `graphql_operation_duration_ms`, `graphql_operation_exceptions_total`; `reservation_request_created_total`, `reservation_processor_claim_total`, `reservation_processor_outcome_total`, `reservation_processor_duration_ms`, `reservation_processor_exceptions_total` | cumulative monotonic sums and histograms; counters have empty OTLP units, durations use `ms` | HTTP: `http_method`, `http_route`, `http_status_code`, `status_family`, `outcome`; GraphQL: `business_operation`, `graphql_operation_type`, `outcome` or `exception_type`; worker: bounded `business_operation`, `outcome`, or `exception_type` | GraphQL and worker outcome sums initialize bounded zero series. HTTP counters start with eligible traffic. Histograms never receive synthetic observations. |
| [reservation agent PR #22](https://github.com/movie-reservation-platform-lab/movie-reservation-agent/pull/22) | `http.server.active_requests`, `http.server.duration`, `http.server.response.size`, `movie_reservation_agent.http.server.requests` | up/down sum `{request}`; cumulative histograms `ms`/`By`; cumulative monotonic sum `{request}` | native bounded method, templated target, integer status; custom `http.request.method`, complete `http.route`, status class, `outcome` | Custom 4xx/5xx series initialize to real zero per eligible route/method. Health/readiness are excluded. Native route targets omit the application router prefix with the locked SDK. |
| [reservation MCP PR #15](https://github.com/movie-reservation-platform-lab/movie-reservation-mcp/pull/15) | `movie_reservation_mcp_tool_calls`, `movie_reservation_mcp_tool_duration` | cumulative monotonic sum `{call}` and cumulative histogram `s` | `mcp.tool.name`, `outcome` | No point exists before a real tool call; no invented calls, error zeros, or durations. |
| [recommendation MCP PR #14](https://github.com/movie-reservation-platform-lab/movie-recommendation-mcp/pull/14) | `axum_tools_mcp_tool_calls_total`, `axum_tools_mcp_tool_duration_ms` | cumulative monotonic sum `{call}` and cumulative histogram `ms` | `mcp.tool.name`, `outcome` | No point exists before a real tool call; no invented calls, error zeros, or durations. |
| [recommendation service PR #18](https://github.com/movie-reservation-platform-lab/movie-recommendation-service/pull/18) | `movie_recommendation_service_http_requests_total`, `movie_recommendation_service_http_request_duration_ms`, `movie_recommendation_service_recommendations_total` | cumulative monotonic sums with no unit and cumulative histogram `ms` | HTTP: `http.route`, `http.status_code`, `http.status_class`, `outcome`; recommendation: `preference.present` | Metrics start with eligible observations. Health/readiness remain observable and must be excluded from user-path queries. |

Every row is **Expected**, **Emitted**, and **Accepted offline**. **Queryable**
remains pending until a coordinated deployment observes the translated series
and freshness in the managed backends. Missing queryable evidence is unknown,
not a healthy zero.

### Collector projection

The machine-readable evidence fixture at
[`test/fixtures/five-backend-signal-contract.json`](../../test/fixtures/five-backend-signal-contract.json)
records every native type, unit, attribute set, producer merge commit, and exact
CloudWatch dimension projection. The collector contract test requires all 21
families to appear once and only once in these declaration groups:

| Signal group | CloudWatch dimensions after fixed identity injection |
| --- | --- |
| Reservation HTTP traffic/latency | `ServiceName`, `Environment`, `http_method`, `http_route`, `status_family` |
| Reservation GraphQL traffic/latency | `ServiceName`, `Environment`, `business_operation`, `graphql_operation_type`, `outcome` |
| Reservation GraphQL exceptions | `ServiceName`, `Environment`, `business_operation`, `exception_type` |
| Reservation creation | `ServiceName`, `Environment`, `business_operation` |
| Reservation processor claims | `ServiceName`, `Environment` |
| Reservation processor outcomes/latency | `ServiceName`, `Environment`, `outcome` |
| Reservation processor exceptions | `ServiceName`, `Environment`, `exception_type` |
| Agent active requests | `ServiceName`, `Environment`, `http.method` |
| Agent native latency/response size | `ServiceName`, `Environment`, `http.method`, `http.target`, `http.status_code` |
| Agent bounded outcome counter | `ServiceName`, `Environment`, `http.request.method`, `http.route`, `http.response.status_class`, `outcome` |
| Both MCP tool families | `ServiceName`, `Environment`, `mcp.tool.name`, `outcome` |
| Recommendation HTTP traffic/latency | `ServiceName`, `Environment`, `http.route`, `http.status_code`, `http.status_class`, `outcome` |
| Recommendation results | `ServiceName`, `Environment`, `preference.present` |

AMP receives every native family through its producer-specific pipeline. The
collector adds only fixed `service_name` and `deployment_environment` labels,
deletes churn-prone `service.instance.id`, disables target/scope metadata series,
and does not add type/unit suffixes. Prometheus sanitization and backend-visible
series names remain a **Queryable**-stage check rather than an offline claim.

### Attribute allowlists

| Signal boundary | Permitted signal-specific attributes |
| --- | --- |
| HTTP server | normalized/templated route, method, bounded HTTP status or status class, bounded outcome |
| GraphQL | bounded operation class and bounded business outcome; never raw query text or caller-selected operation text unless explicitly allowlisted |
| Reservation worker | bounded operation and outcome |
| MCP tool | allowlisted tool name and bounded outcome |

Canonical service and environment identity may also be attached. Request IDs,
trace/span IDs, user IDs, raw URLs, prompts, arbitrary tenant IDs, fault text,
and exception messages are not metric attributes.

`tenant.id` is a deferred metric-cardinality decision, not a permanent ban. If
tenancy is introduced, review tenant count, access controls, cost, and query
needs before adding it to any metric allowlist. Prefer traces, logs, or a
dedicated usage dataset when the tenant set is large or unbounded.

### Active, idle, zero, and stale data

- **Active:** fresh eligible traffic exists.
- **Idle:** telemetry is fresh but no eligible traffic occurred.
- **Missing/stale:** the producer or export path cannot be trusted as healthy.

Bounded error counters may publish a real zero before the first error. Producers
must not invent requests or zero-duration histogram observations. A zero
denominator or missing/stale telemetry must not become a healthy `0%` error
rate. Health and readiness traffic is excluded from user-path health signals.

## Trace contract

Participating backends use W3C `traceparent` and `tracestate`:

1. Extract incoming context before creating the server or MCP span.
2. Make instrumented downstream calls children of the active span.
3. Propagate the resulting active context downstream.
4. Mark validation, dependency, and internal failures accurately without
   changing the service's safe public error contract.
5. Put real trace and span IDs into structured logs when an active context is
   available.

The first instrumented server boundary may start the trace. Browser
instrumentation is not required. X-Ray remains the baseline trace destination;
Tempo is an optional additional destination and must not replace X-Ray routing.

## Structured-log contract

Every producer should emit JSON stdout logs with this small shared envelope:

- timestamp and severity;
- canonical service name and version;
- stable event name or message;
- trace ID and span ID when active;
- request/correlation ID when available.

The following correlation fields are best effort and should be included only
when real context supplies them:

- authenticated/validated `tenant.id`;
- sanitized `aws_alb_trace_id`;
- sanitized `aws_cloudfront_request_id`;
- an AWS SDK request or operation identifier returned by the relevant call.

Optional identifiers are high-cardinality log/span fields, not metric labels.
Bound their length and omit absent values rather than fabricating placeholders.
Do not treat an arbitrary caller header as verified tenant identity. Do not
log credentials, tokens, raw prompts, request bodies, unverified personal data,
or blanket AWS account/resource identifiers.

## Transport and routing

Each producer uses a unique task-local OTLP/HTTP protobuf receiver bound to
`127.0.0.1`. No telemetry receiver is public. Existing receiver ports are
4318-4321; reservation MCP should use the next non-conflicting task-local port,
currently 4322, unless implementation evidence requires a documented change.

| Signal | Required route |
| --- | --- |
| Application metrics | AMP and the existing CloudWatch application-metrics path |
| Traces | X-Ray and optional Tempo when enabled |
| Structured logs | stdout through the existing FireLens/CloudWatch path |

The collector must preserve the Tempo feature toggle and must not silently drop
valid producer metrics through stale include filters.

## Failure behavior

Preserve the current ECS policy:

- application startup waits for a healthy task-local collector;
- after startup the collector is nonessential and applications fail open;
- telemetry export failure never fails an application request;
- queues, retries, elapsed retry time, and timeouts are bounded;
- export failures, dropped data, queue pressure, and collector CPU/memory
  pressure are observable where the collector exposes them.

No new public endpoint, broad IAM permission, or telemetry backend is implied.

## Evidence matrix

Every producer/signal row progresses independently:

| Stage | Required evidence | Unblocks |
| --- | --- | --- |
| Expected | Advisory entry in this document | Producer implementation discussion |
| Emitted | Local exporter payload with exact names, units, attributes, identity, and representative outcomes | Collector mapping work for that producer |
| Accepted | Offline collector/config test proves filters and pipelines preserve and route the payload | Infrastructure PR readiness |
| Queryable | Separately authorized live check in AMP, CloudWatch, X-Ray, and optional Tempo | Release acceptance |

An unknown row is unknown, not a healthy zero. Live evidence must use synthetic
data and must not publish credentials, personal data, private resource IDs, or
account-specific validation output.
