# Set up the Grafana service dashboard and alert

This is an operator procedure, not an automatic deployment. The renderer makes
no network calls. Importing, creating a silence and activating a rule are live
changes that require the operator's approval. Keep the existing AWS overview.

## Prerequisites and render

- Record the Managed Grafana version and confirm Grafana-managed alerting and
  the existing AMP Prometheus data source work. AMP data-source-managed rules
  and Grafana-managed rules are different; this procedure uses the latter.
- Create a **dedicated** `Service observability` folder and record its UID. Use a new
  `service-observability` evaluation group, not a group containing unrelated rules.
- Verify the metric/labels below in Explore for the selected environment. The
  collector disables added suffixes, so do not add another `_total` or `_milliseconds`.
- Select a public runbook URL pinned to the merged infra commit. Do not publish
  workspace URLs, credentials, tokens or rendered local state in the repository.

```bash
npm run --silent render:service-grafana -- \
  --amp-uid "$AMP_DATASOURCE_UID" \
  --folder-uid "$SERVICE_FOLDER_UID" \
  --grafana-url "$GRAFANA_URL" \
  --runbook-url "$PUBLIC_PINNED_RUNBOOK_URL" \
  --environment aws-demo \
  --tempo-uid "$TEMPO_DATASOURCE_UID" > /tmp/service-grafana.json

jq '.dashboard' /tmp/service-grafana.json > /tmp/service-dashboard.json
jq '.ruleGroup' /tmp/service-grafana.json > /tmp/service-alert-group.json
```

Omit `--tempo-uid` until Tempo is reachable in AMG. Its absence must not block the
real AMP alert. The Tempo search link uses native Explore/TraceQL, not an X-Ray ID.
Use the actual data-source UID shown by Grafana, not its display name. `demo-tempo`
is only the suggested UID when explicitly set during API/provisioned creation;
UI creation can assign a different UID.
If the installed plugin ignores the link query, select `demo-tempo` in Explore
and paste `{ resource.service.name = "movie-recommendation-service" }` manually.

Import `/tmp/service-dashboard.json` through Dashboards → New → Import into the
dedicated folder. UID is `service-observability`; review rather than overwrite a collision.

## Alert import contract (paused)

The generated `ruleGroup` is the **HTTP provisioning API** payload for
`PUT /api/v1/provisioning/folder/<folderUID>/rule-groups/service-observability`.
It is NOT a provisioning-file/export payload, nor dashboard-import JSON. AMG
does not give access to Grafana's filesystem. Use the installed version's API
with authorized operator tooling, or create an equivalent Grafana-managed rule
in the UI using the generated values. This PR deliberately contains no token
handling or API writer. A group PUT replaces that group's rules: never reuse an
unrelated group. `isPaused: true` is intentional, and must be confirmed afterward.

For UI creation, copy query A's `expr` from the bundle as an **instant** AMP
query. Add Math B `$A >= 3`, use B as condition, 30 seconds pending and the dedicated
15-second group. Copy labels/annotations, including dashboard/panel association.
Keep the rule paused while configuring safety. If the UI cannot save paused,
complete and verify the notification silence below **before** saving the rule.
The renderer allows `--minimum-errors`, `--evaluation-seconds`, `--pending-seconds`
to tune the same definition; if AMG rejects 15 seconds, use its supported cadence
and record it rather than claiming a 15-second evaluation.

## No external delivery today: silence before activation

Pausing stops evaluation and is NOT the demo mode. A **silence** suppresses
notifications while evaluation and the visible state continue. A dummy contact
point, lack of a new contact point, or a successful contact-point test does not
prove suppression: existing default policies can route alerts elsewhere.

1. Inspect the workspace's notification policies and configured Alertmanagers.
   Use the built-in **Grafana** Alertmanager for this Grafana-managed rule.
   Do not replace the global routing tree or mute unrelated alerts.
2. Alerting → Silences → Create silence: start now; set a finite end after the
   validation run (for example four hours); use exact matcher
   `grafana_folder = Service observability`. Match the actual dedicated folder label
   shown by this workspace, including any nested path; do not assume its UID is
   the label value. Do not add `alertname` or `exercise` constraints: those can
   miss the generated `DatasourceNoData`/`DatasourceError` instances.
3. Verify the silence is active, its timezone/end time is correct, and it covers
   the rule's actual labels. Inspect the version's generated NoData/Error labels
   too. If their folder matcher differs, create a separately scoped silence for
   those instances. If coverage or external Alertmanager forwarding cannot be
   established, **leave the rule paused**. No suppression guarantee is made until
   this check passes; do not use a workspace-wide wildcard as a shortcut.
4. Only then unpause. When the rule fires, confirm the alert instance is shown
   as silenced and no notification delivery occurred. Keep the silence active
   through recovery, including any resolved-notification processing.
5. **Pause the rule before silence expiry, teardown or ending the exercise.**
   Confirm paused, then retire the silence. Record its expiry in the handover;
   a later validation run needs a fresh verified silence.

AMG version-10 [silence documentation](https://docs.aws.amazon.com/grafana/latest/userguide/v10-alerting-silences.html)
explains evaluation versus suppression. Check the corresponding installed-version
guide. [HTTP provisioning documentation](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/http-api-provisioning/)
distinguishes HTTP requests from file-export schemas.

## Metric semantics and live acceptance

Offline checks: `npm run build`, `npm run test:tooling`,
`npm run validate:grafana-dashboard` and `npm run validate:service-promql`.
The last command uses a digest-pinned Prometheus 3.5.0 tooling container (Docker
required, image pulled if absent) with networking disabled. It evaluates the
actual rendered query for fresh healthy traffic, failures/recovery, counter reset,
stale/missing series and insufficient samples. These are not live AMP/Grafana tests.

Inspect this unaggregated series first:

```promql
movie_recommendation_service_http_requests_total{deployment_environment="aws-demo",service_name="movie-recommendation-service",http_route="/recommendations"}
```

The rule sums `increase(...{http_status_code=~"5.."}[2m])`. Zero is supplied only
from existing route counters, not unconditional `vector(0)`. It also requires a
route sample newer than 90 seconds. Missing/stale data therefore becomes **NoData**;
data-source failure becomes **Error**, not a fake Normal/recovery. The sample-age
panel helps distinguish this from healthy, fresh zero errors.

`increase` is an extrapolated estimate, not an exact event count. Counters need at
least two exports; a brand-new error series' first event may not contribute to the
first increase. Warm up normal requests for at least two export intervals, then
sustain the agreed failure scenario long enough for repeated exports. Three fast
clicks alone are not a reliable test. Rehearse bounded user-path traffic and
measure latency; do not promise alerting faster than the metrics export cadence.

Acceptance (record timestamps, rule URL and observed query values):

1. Normal requests and at least two fresh counter samples → Normal and near-zero
   error estimate. Confirm the sample-age panel is fresh.
2. Sustained failing user-path requests → query >=3, then Pending → Firing after
   the configured pending period. Keep traffic bounded and stop at the agreed
   exercise duration. Do not alter the diagnostic fault counter to force an alert.
3. Follow alert dashboard/runbook links; trace search finds a real matching
   request when Tempo is enabled. Native CloudWatch log correlation remains
   manual; Loki is not delivered by this slice.
4. Restore normal user requests. Allow the two-minute error window to clear plus
   export/evaluation delay. Verify Normal, fresh samples, and successful UI flow.
5. A missing-series or unavailable-data-source dry run must show NoData/Error,
   **not** healthy recovery. Do this only with explicit live-test approval and
   restore the configuration afterward; never break a shared production source.
6. Repeat once before presentation. Offline tests are not this live acceptance.

## Cleanup and rollback

Pause the rule and verify it is paused before stopping the workload or allowing
the silence to expire. If removing the artifacts, delete only rule
`sre-recommendation-errors`, its now-empty dedicated group and dashboard
`service-observability`. Preserve existing AMP/Grafana data sources, dashboards, routes
and the audit/observability stacks. No AWS deployment is performed by this code.

## Existing generated artifacts

The service renderer uses the `service-observability` dashboard/group namespace
and the `Service observability` folder title. Existing imported objects are not
renamed, deleted or updated by this offline tool. Snapshot current Grafana state
and explicitly review UID/group/label differences before importing a new bundle;
update notification matchers deliberately and avoid duplicate active rules.
