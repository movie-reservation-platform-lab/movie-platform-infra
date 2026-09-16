# Implementation plan: interview symptom alert

Tracking: #53. Implementation authorized; cloud changes are not.

Coordination: [platform rehearsal #15](https://github.com/movie-reservation-platform-lab/.github/issues/15).
Independent companion: #54 (Tempo). Public candidate pack is tracked in
[organization docs #16](https://github.com/movie-reservation-platform-lab/.github/issues/16).

## Summary, goals and non-goals

Render an importable interview dashboard and paused Grafana-managed alert using
existing AMP metrics. The goal is a real, repeatable service-symptom alert visible
in Managed Grafana, with no external notifications. No new collector, application
image, Mimir, Loki, notification integration or deployment automation.

## Current state and requirements

`adot-collector/adot-config.yaml` adds `service_name` and
`deployment_environment`, disables metric suffix addition, and exports to AMP.
Recommendation-service emits `movie_recommendation_service_http_requests_total`
with `http.route`/`http.status_code`, normalized to `http_route`/`http_status_code`.
Its duration histogram is milliseconds. Live AMP labels still need verification.
No existing dashboard covers this incident as a small interview exercise.

Proposed rehearsal defaults: at least three 5xx requests in two minutes, 15-second evaluation,
30-second pending, dashboard/runbook links, and real firing/recovery. Tempo uses
the independently configured `demo-tempo` UID and is optional to this artifact.

## Design and alternatives

Use a pure TypeScript renderer plus stdout-only CLI, not a new deployment client.
Compile-time types describe configuration; runtime checks reject unsafe URL,
identifier and threshold inputs. No filesystem/network dependency in the renderer.
The existing overview dashboard stays unchanged. Generate a dashboard and HTTP
provisioning rule-group payload, not a file-provisioning export mislabeled as API
JSON. Import paused, inspect exact queries, silence the dedicated folder, then
activate manually only after approval. Silencing notifications preserves evaluation.

UI-only creation is quicker but loses repeatability. Full Terraform/Grafana API
automation introduces credentials and ownership beyond this bounded slice.

## Interfaces and data

`npm run --silent render:interview-grafana -- --help` documents input flags.
Output is one JSON object with `dashboard`, `ruleGroup` and `setup` sections.
No credentials, persistent state or schema migration. Stable IDs are
`sre-interview` (dashboard) and `sre-recommendation-errors` (rule).

## Security, reliability and performance

No live writer. New rule is always paused; setup documents silencing both symptom
and generated NoData/Error instances and pausing before silence expiry. No default
contact point is changed. Missing error series means zero only when route telemetry
exists and is fresh; missing/stale route telemetry is NoData, not recovery.
Counter increase needs two samples and extrapolates; warm up and sustain traffic.
Queries are bounded to one environment/service/route and short windows.

## Steps and testing

1. Add `grafana/interview.ts` pure artifact construction and validation.
2. Add `scripts/render-interview-grafana.ts` argument/stdio adapter.
3. Add `test/interview-grafana.test.ts` for selectors, safeguards, thresholds,
   stable IDs, links and unsafe input rejection; wire into existing tooling CI.
4. Add operations setup/rollback and candidate-safe symptom investigation docs.
5. Run build, tooling tests, existing dashboard validation and the actual rendered
   PromQL through digest-pinned promtool synthetic scenarios in CI. Live acceptance
   separately checks metric labels, AMG version, silence coverage and transitions.

## Rollout, risks and done criteria

Import into a dedicated folder, preserve existing dashboards/rules, inspect
notification routes, and confirm silence before unpausing. Recovery must show
fresh route telemetry and successful UI behavior. Pause the rule before teardown
or silence expiry; delete only this rule/group/dashboard if rollback is required.
Neither tests nor JSON rendering proves the actual AMG evaluation interval is
accepted. If 15 seconds is rejected, document the accepted interval and rehearse.

Done offline: build/tests pass, artifacts contain no deployment secrets, docs
state live gates. Done live: Normal → Pending → Firing → Normal, no notifications,
and working dashboard/runbook/Tempo links. No offline check substitutes for this.

Review: requirements, alternatives, ownership, runtime validation, bounded queries,
NoData, notification safety and rollback explicitly covered. KB search found no
focused alerting note; repository metric contracts and official Grafana/AWS docs
are the implementation evidence.

Handoff: implement only this plan and #53, preserve other work, prefix commit/PR
with `[ai]`, and do not deploy or modify live Grafana without separate permission.
