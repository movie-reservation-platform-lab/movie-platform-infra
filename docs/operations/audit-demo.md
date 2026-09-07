# Deploy, demonstrate and remove the audit demo

This runbook is for an operator, not unattended agent execution. The code was
validated locally; no AWS deployment was performed for this PR. Start with a
fresh environment. The previous single-stack demo has already been torn down.
The [architecture](../architecture/audit-and-observability.md) explains the event
path, ownership and delivery limits.

## 1. Prepare access, images and local tools

You need Node/npm, Docker, AWS CLI v2, jq, the existing account-access preflight,
six published images already copied to same-account/same-Region ECR by digest,
and permission to create the resources shown in the CDK diffs. Use the existing
[artifact foundation](aws-artifact-foundation.md) and environments repository's
exact-digest handoff; do not substitute mutable `latest` tags.

```bash
npm ci
npm run ci
npm run validate:audit-router
export AWS_PROFILE=movie-platform-demo
export AWS_REGION=eu-central-1
export AWS_ACCOUNT_ID='<expected-12-digit-account>'
aws sso login --profile "$AWS_PROFILE"
npm run preflight:aws
test "$(aws sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID"
export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"
export CDK_DEFAULT_REGION="$AWS_REGION"
mkdir -p .local/audit-demo
git check-ignore .local/audit-demo/operator.json
```

Confirm that `CDKToolkit` and the six ECR repositories exist. If not, follow the
linked artifact/access bootstrap runbooks before continuing. Do not delete a
shared bootstrap stack as part of this demo.

Set `ALLOWED_PREFIX_LIST_ID` to the existing customer-managed IPv4 prefix list
containing only your public `/32`. If it was removed during the previous teardown,
create a new demo-only prefix list and record the returned ID:

```bash
aws ec2 create-managed-prefix-list --prefix-list-name movie-platform-audit-demo \
  --address-family IPv4 --max-entries 1 \
  --entries 'Cidr=<your-public-ip>/32,Description=demo-operator'
export ALLOWED_PREFIX_LIST_ID='<returned-pl-id>'
aws ec2 describe-managed-prefix-lists --prefix-list-ids "$ALLOWED_PREFIX_LIST_ID"
aws ec2 get-managed-prefix-list-entries --prefix-list-id "$ALLOWED_PREFIX_LIST_ID"
```

Grafana uses IAM Identity Center. Complete the existing
[Grafana access bootstrap](standalone-account-access-bootstrap.md) if you want
Grafana. If Identity Center is unavailable, add `-c enableGrafana=false` to the
observability synth below: AMP, CloudWatch and X-Ray still work. This setting
does not disable application observability.

## 2. Create synthetic demo credentials

The current ALB is restricted but HTTP, not HTTPS. Use a throwaway credential
pair only; never a real password or an identity-provider account. Do not enable
this endpoint on an unrestricted/public production deployment. TLS is required
before using real credentials.

Create `.local/audit-demo/auth.json` in your editor with exactly two string
properties, `username` and `password`. Choose a strong disposable password. The
file is ignored by Git; do not paste it into the journal, terminal output or PR.

```bash
install -m 600 /dev/null .local/audit-demo/auth.json
"$EDITOR" .local/audit-demo/auth.json
aws secretsmanager create-secret --name movie-platform/aws-demo/audit-demo-auth \
  --description 'Disposable audit demo credential check only' \
  --secret-string file://.local/audit-demo/auth.json \
  --query ARN --output text
export DEMO_AUTH_SECRET_ARN='<returned-complete-secret-arn>'
```

The secret must use the default Secrets Manager encryption key. A custom KMS key
needs additional execution-role decrypt policy and is not configured here. ECS
injects the JSON fields through its execution role at task startup; the
application task role cannot fetch the secret. Updating its value requires new
tasks to pick it up. Existing application auth behavior is unchanged.

## 3. Deploy the independent foundations

Synthesize into separate directories so a later command cannot accidentally
replace the reviewed assembly. Foundations require no application images.
Review the account, Region, policies, buckets, retention and resources in each
diff before deploying. `--change-set=false` prevents CDK diff from creating its
optional change set; it still reads AWS state.

```bash
npm run cdk:audit -- synth AuditStack --no-lookups \
  --output .local/audit-demo/audit-assembly
npm run cdk -- --app .local/audit-demo/audit-assembly diff AuditStack --change-set=false
npm run preflight:aws
npm run cdk -- --app .local/audit-demo/audit-assembly deploy AuditStack

npm run cdk:observability -- synth ObservabilityStack --no-lookups \
  --output .local/audit-demo/observability-assembly \
  -c allowedIngressPrefixListId="$ALLOWED_PREFIX_LIST_ID"
npm run cdk -- --app .local/audit-demo/observability-assembly diff ObservabilityStack --change-set=false
npm run preflight:aws
npm run cdk -- --app .local/audit-demo/observability-assembly deploy ObservabilityStack
```

Audit and ALB data expire after 30 days by default. Change with
`-c auditRetentionDays=<1..3650>` when synthesizing audit. Query results expire
after 7 days. Buckets retain on stack deletion unless explicitly changed in the
cleanup section. CloudTrail captures this Region's write-management events;
check existing trails first because duplicate copies can add charges.

## 4. Deploy the six exact application versions

Use the images from the coordinated PRs. The three service images must contain
the OCSF emitters and demo auth endpoints; the web image must contain the audit
screen and proxies. Unchanged MCP images can keep their previously reviewed
digests. The environments repository's
[temporary release helper](https://github.com/movie-reservation-platform-lab/movie-platform-environments/blob/main/docs/operations/audit-demo-release.md) creates a
`temporary-audit-demo-release-v1` document with previous/proposed compositions.
After copying and verifying its images, pass that ignored local file directly
to the synth-only wrapper:

```bash
npm run demo:workload -- --release /absolute/path/to/release.json \
  --selection proposed --output .local/audit-demo/workload-assembly \
  --prefix-list-id "$ALLOWED_PREFIX_LIST_ID" \
  --demo-auth-secret-arn "$DEMO_AUTH_SECRET_ARN"
```

The wrapper validates the exact six image/version bindings and target account,
then runs offline synth. It does not copy images, fetch credentials or deploy.
`--selection previous` synthesizes the rollback composition. Use a different
output directory for each version; the wrapper refuses existing output paths
so a saved deployment assembly is not overwritten.

If you are using the older handoff, set these twelve variables instead and use
the explicit synth command below; both routes produce the same workload template:

```bash
export RESERVATION_SERVICE_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RESERVATION_SERVICE_VERSION='<version-in-this-image>'
export RESERVATION_WEB_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RESERVATION_WEB_VERSION='<version-in-this-image>'
export RESERVATION_AGENT_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RESERVATION_AGENT_VERSION='<version-in-this-image>'
export RESERVATION_MCP_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RESERVATION_MCP_VERSION='<version-in-this-image>'
export RECOMMENDATION_MCP_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RECOMMENDATION_MCP_VERSION='<version-in-this-image>'
export RECOMMENDATION_SERVICE_IMAGE='<ECR-URI@sha256:64-hex-digest>'
export RECOMMENDATION_SERVICE_VERSION='<version-in-this-image>'

npm run cdk -- synth MovieReservationWorkloadStack --no-lookups \
  --output .local/audit-demo/workload-assembly \
  -c allowedIngressPrefixListId="$ALLOWED_PREFIX_LIST_ID" \
  -c applicationImageReference="$RESERVATION_SERVICE_IMAGE" \
  -c applicationServiceVersion="$RESERVATION_SERVICE_VERSION" \
  -c reservationWebImageReference="$RESERVATION_WEB_IMAGE" \
  -c reservationWebServiceVersion="$RESERVATION_WEB_VERSION" \
  -c reservationAgentImageReference="$RESERVATION_AGENT_IMAGE" \
  -c reservationAgentServiceVersion="$RESERVATION_AGENT_VERSION" \
  -c reservationMcpImageReference="$RESERVATION_MCP_IMAGE" \
  -c reservationMcpServiceVersion="$RESERVATION_MCP_VERSION" \
  -c recommendationMcpImageReference="$RECOMMENDATION_MCP_IMAGE" \
  -c recommendationMcpServiceVersion="$RECOMMENDATION_MCP_VERSION" \
  -c recommendationServiceImageReference="$RECOMMENDATION_SERVICE_IMAGE" \
  -c recommendationServiceVersion="$RECOMMENDATION_SERVICE_VERSION" \
  -c demoAuthEnabled=true -c demoAuthSecretArn="$DEMO_AUTH_SECRET_ARN"
npm run cdk -- --app .local/audit-demo/workload-assembly diff MovieReservationWorkloadStack --change-set=false
npm run preflight:aws
npm run cdk -- --app .local/audit-demo/workload-assembly deploy MovieReservationWorkloadStack
aws ecs wait services-stable --cluster movie-reservation-platform-aws-demo \
  --services movie-platform-demo
```

The deployment builds/publishes only the repository-owned ADOT and router
assets. It does not build sibling application source. Verify running container
digests with `aws ecs list-tasks` followed by `aws ecs describe-tasks`; compare
all six `containers[].imageDigest` values with the reviewed handoff.

For another version, preserve the previous six-digest handoff and workload
assembly, change only the intended image/version variables, and repeat the
workload synth/diff/deploy. Do not redeploy the foundations for application-only
changes. Rollback is deploying the previous reviewed workload assembly; ECS
also has deployment circuit-breaker rollback enabled.

## 5. Run the investigation

Get the URL and open the audit screen in the web application:

```bash
aws cloudformation describe-stacks --stack-name MovieReservationWorkloadStack \
  --query 'Stacks[0].Outputs' --output table
export DEMO_BASE_URL='<DemoBaseUrl-output>'
```

Submit wrong credentials to each service in the UI. For CLI use, create an
ignored `wrong-auth.json` containing a deliberately wrong synthetic pair, then:

```bash
curl --silent --show-error -i "$DEMO_BASE_URL/audit-demo/reservation/login" \
  -H 'Content-Type: application/json' -H 'X-Correlation-ID: audit-rehearsal-001' \
  --data-binary @.local/audit-demo/wrong-auth.json
```

Repeat with `/audit-demo/agent/login` and `/audit-demo/recommendation/login`.
Expect 401 with an `audit_event_id`, request ID and, when instrumentation is
active, trace ID. Correct credentials return 200 without creating a session.
Disabled endpoints return 404. Never put credentials in URL query strings.

Allow a few minutes for Firehose and ALB delivery. In Athena select workgroup
`movie-platform-audit`, database `movie_platform_audit`, and run the first two
queries in [audit-queries.sql](audit-queries.sql), substituting the event ID and
UTC delivery dates. The workgroup enforces a 1 GiB scan limit per query, not a
daily spend limit. The stack exports an `AuditAnalystPolicyArn` that can be
attached by an administrator to an approved investigator role; no principal is
automatically granted archive access.

In CloudWatch Logs Insights select the corresponding component group and use:

```text
fields @timestamp, @message
| filter @message like /REPLACE-WITH-AUDIT-EVENT-ID/
| sort @timestamp asc
```

Open the trace in X-Ray, or use its native trace-ID representation:

```bash
export OTEL_TRACE_ID='<32-lowercase-hex-trace-id-from-event>'
[[ "$OTEL_TRACE_ID" =~ ^[0-9a-f]{32}$ ]]
export XRAY_TRACE_ID="1-${OTEL_TRACE_ID:0:8}-${OTEL_TRACE_ID:8:24}"
aws xray batch-get-traces --trace-ids "$XRAY_TRACE_ID"
```

This conversion is for the OTel trace ID, not the ALB header's independent
`Root`. The second Athena query joins that ALB root to native access evidence.
The CloudTrail query answers who deployed or changed resources; it does not
pretend that login events have individual Firehose publication receipts.

If evidence is missing, check in order: endpoint version/configuration, response
ID, component logs, router rejection/retry logs, Firehose freshness alarm and
delivery logs, S3 prefix and Athena UTC date. A 401 alone does not prove archival.
Do not turn up body/header logging to troubleshoot authentication.

## 6. Stop spending: drain and destroy in order

Record stack outputs and resources before deleting anything. These files
contain resource identifiers, not secret values:

```bash
aws cloudformation describe-stacks --stack-name AuditStack \
  --query 'Stacks[0].Outputs' > .local/audit-demo/audit-outputs.json
aws cloudformation list-stack-resources --stack-name AuditStack \
  > .local/audit-demo/audit-resources.json
npm run preflight:aws
aws ecs update-service --cluster movie-reservation-platform-aws-demo \
  --service movie-platform-demo --desired-count 0
aws ecs wait services-stable --cluster movie-reservation-platform-aws-demo \
  --services movie-platform-demo
```

Wait for Firehose freshness to return to zero and verify the last rehearsal
event is in S3/Athena. If delivery is failing, do not delete the delivery stream
until you have accepted the potential data loss. Then delete workload, which
removes the ALB, task/service/cluster, VPC and all interface endpoints:

```bash
npm run cdk -- --app .local/audit-demo/workload-assembly destroy MovieReservationWorkloadStack
npm run cdk -- --app .local/audit-demo/observability-assembly destroy ObservabilityStack
```

Observability destruction removes AMP, Grafana and its CDK-owned roles/policies,
log groups, metric filter and alarm. Metrics/traces already ingested have AWS's
own retention; deleting a stack does not refund prior ingestion or Grafana user
charges. Manually created Grafana roles/workspaces from older demos are not
owned by this stack—inspect and remove those exact resources separately.

Choose **one** audit teardown mode:

**Keep evidence:** destroy audit using the original retained-data assembly.
Firehose, CloudTrail, Glue, Athena and delivery alarms/logs are removed; the three
versioned buckets and their data remain and continue incurring storage charges.

```bash
npm run cdk -- --app .local/audit-demo/audit-assembly destroy AuditStack
```

**Delete this demo's evidence permanently:** before destroying audit, explicitly
resynthesize/redeploy it with disposable-data deletion enabled. Review the diff:
it changes bucket removal policies and adds the CDK empty-bucket cleanup provider.
Use the same `auditRetentionDays` value as the original deployment if customized.

```bash
npm run cdk:audit -- synth AuditStack --no-lookups \
  --output .local/audit-demo/audit-delete-assembly -c allowAuditDataDeletion=true
npm run cdk -- --app .local/audit-demo/audit-delete-assembly diff AuditStack --change-set=false
npm run preflight:aws
npm run cdk -- --app .local/audit-demo/audit-delete-assembly deploy AuditStack
aws cloudformation list-stack-resources --stack-name AuditStack \
  > .local/audit-demo/audit-delete-resources.json
npm run cdk -- --app .local/audit-demo/audit-delete-assembly destroy AuditStack
```

This deletes all objects, noncurrent versions and delete markers in the three
stack-owned buckets. It is irreversible. Do not use it on evidence you need to
retain. The CloudTrail trail is stopped/deleted by CloudFormation before its
bucket disappears. If you already destroyed audit in retained mode, those
buckets are no longer managed by a new stack: use the recorded exact bucket IDs,
inspect `list-object-versions`, and explicitly delete their versions/markers
before `delete-bucket`. Do not use `aws s3 rm --recursive` as a substitute—it does
not remove noncurrent versions.

## 7. Check resources outside the three stacks

- **Demo secret:** delete the exact ARN with
  `aws secretsmanager delete-secret --secret-id "$DEMO_AUTH_SECRET_ARN" --recovery-window-in-days 7`.
  For irreversible immediate deletion use `--force-delete-without-recovery`
  instead, only after confirming it is the disposable secret. Remove the ignored
  credential files from your machine using your normal secure local workflow.
- **Demo-only prefix list:** if this runbook created it and nothing else uses it,
  run `aws ec2 delete-managed-prefix-list --prefix-list-id "$ALLOWED_PREFIX_LIST_ID"`.
  Keep a shared ingress prefix list.
- **Cleanup-provider log group:** the opt-in S3 emptying Lambda can leave its
  automatically created `/aws/lambda/<physical-function-name>` group behind.
  Find the exact function name in `audit-delete-resources.json`, confirm that
  exact log group with `aws logs describe-log-groups`, then delete it with
  `aws logs delete-log-group --log-group-name '<exact-name>'` if no longer needed.
- **ECR artifacts:** the six application repositories remain in
  `ArtifactFoundationStack`. Use its [guarded final-cleanup procedure](aws-artifact-foundation.md#guarded-final-cleanup)
  only when finishing the whole project, not every demo.
- **CDK assets:** router/ADOT images and staged files remain in the shared
  bootstrap ECR/S3 stores. Inspect the saved `*.assets.json` manifests and the
  bootstrap repository with `aws ecr describe-images`. Delete only the exact
  unreferenced image digests with `aws ecr batch-delete-image`; use exact object
  keys/version IDs for staged S3 files. Never bulk-empty a shared bootstrap
  bucket/repository or destroy `CDKToolkit` without checking other projects.
- **Identity Center and GitHub trust:** these are account/project prerequisites,
  not demo resources. Keep them unless explicitly doing final account cleanup.

Finally check CloudFormation for the three stack names, ECS for running demo
tasks, EC2 for leftover interface endpoints/ALBs, AMP/Grafana for workspaces,
Firehose/CloudTrail for streams/trails, and S3 for the recorded bucket names.
Budgets/Cost Explorer can lag; an empty workload alone is not proof of zero cost.
Main running costs are Fargate, ALB, interface endpoints, telemetry ingestion,
AMP/Grafana, Firehose/S3 and queries. This design has no NAT Gateway or OpenSearch
cluster, and no new AWS account.
