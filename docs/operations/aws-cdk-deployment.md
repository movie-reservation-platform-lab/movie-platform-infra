# AWS CDK Deployment Runbook

This runbook deploys `GoldenPathDemoStack` from a developer workstation into an
AWS account, verifies the infrastructure contract, and removes the deployed
resources afterward.

Complete the
[standalone-account access bootstrap](./standalone-account-access-bootstrap.md)
before the first deployment. During an approved rehearsal, use the
[AWS demo release checklist](./aws-demo-release-checklist.md) as the controlling
sequence; this runbook supplies the detailed CDK commands.

The stack is a learning/demo environment, not a production deployment. It
creates resources that incur charges while they exist, including a Fargate task,
an Application Load Balancer, interface VPC endpoints, CloudWatch logs and
metrics, an AMP workspace, and an Amazon Managed Grafana workspace.

## CDK Lifecycle Mental Model

| Phase | Where it runs | What it does |
| --- | --- | --- |
| Account access bootstrap | AWS console plus workstation | Creates the persistent Organization, IAM Identity Center operator, MFA, account assignment, CLI profile, and private target file described by the separate bootstrap runbook. |
| Account preflight | Workstation plus read-only AWS CLI calls | Proves that the pinned SSO profile, Region, account, permission set, and live role all match before a group of mutations. It changes no AWS resources. |
| `synth` | Workstation | Executes the TypeScript CDK app and writes CloudFormation and asset metadata under `cdk.out/`. It changes no AWS resources. |
| `bootstrap` | Workstation CLI plus AWS CloudFormation | Once per account/Region, creates the CDK toolkit resources used to publish assets and deploy stacks. |
| `diff` | Workstation CLI plus AWS CloudFormation | Compares the synthesized template with the deployed stack. |
| `deploy` | Workstation CLI plus AWS CloudFormation | Publishes the repository-owned ADOT asset, consumes the selected digest-pinned app image, and applies the CloudFormation change set. |
| `destroy` | Workstation CLI plus AWS CloudFormation | Deletes resources owned by `GoldenPathDemoStack`. It does not delete the CDK bootstrap stack or customer-managed prefix list. |

The CDK code is the model, the synthesized template is the deployment contract,
and CloudFormation owns the deployed resource lifecycle.

## Required Inputs

Every real deploy needs:

- The dedicated `movie-platform-demo` IAM Identity Center profile and a valid
  SSO session.
- The private `aws-target.json` created by the account bootstrap runbook, which
  pins the exact account, `eu-central-1`, permission set, and generated role.
- AWS account ID and Region for explicit CDK targeting.
- Customer-managed IPv4 prefix list ID for ALB and Grafana access.
- Digest-pinned private ECR image reference for the reservation service.
- Application service version or release identifier.
- Operator acknowledgement of expected cost and teardown plan.

Example context:

```bash
export AWS_PROFILE=movie-platform-demo
export AWS_REGION=eu-central-1
export AWS_ACCOUNT_ID='<12-digit-account-id>'
export ALLOWED_INGRESS_PREFIX_LIST_ID=pl-0123456789abcdef0
export APPLICATION_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest>"
export APPLICATION_SERVICE_VERSION='<release-id>'
```

The account ID, generated role name, and other real identity values belong in
the operator-owned target file or local shell only. Do not commit them.

## Account, Region, And Role Preflight

Start or refresh the dedicated SSO session, then run the repository gate:

```bash
aws sso login --profile movie-platform-demo
npm run preflight:aws
```

The preflight reads the private target file and uses read-only AWS CLI calls to
validate the exact SSO profile, `eu-central-1`, account, permission set, and
generated IAM Identity Center role. It rejects static or alternate credential
providers and prints only a redacted result.

One pass covers only a short, uninterrupted group of related operations. Rerun
it before prefix-list changes, `cdk bootstrap`, `cdk deploy`, and `cdk destroy`,
and after any renewed SSO session or target/profile change. If it fails or is
unavailable, stop rather than substituting a raw identity printout.

## Prefix List Setup

Create the customer-managed IPv4 prefix list outside the stack:

```bash
npm run preflight:aws

aws ec2 create-managed-prefix-list \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-name movie-reservation-platform-aws-demo-ingress \
  --address-family IPv4 \
  --max-entries 10 \
  --entries 'Cidr=<your-public-ip>/32,Description=developer-laptop'
```

`MaxEntries=10` supports up to ten distinct source CIDRs. Because the ALB
security-group rule references this customer-managed prefix list, AWS counts ten
inbound rules against that security group's IPv4 rule quota even when the list
currently contains fewer entries. This is capacity accounting, not a limit on
users, requests, connections, or throughput. Keep the maximum deliberately
small and check the security-group quota before resizing it.

To add another trusted `/32`, read the current version and modify the list:

```bash
npm run preflight:aws

aws ec2 describe-managed-prefix-lists \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --filters Name=prefix-list-name,Values=movie-reservation-platform-aws-demo-ingress \
  --query 'PrefixLists[0].{PrefixListId:PrefixListId,Version:Version}'

aws ec2 modify-managed-prefix-list \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-id "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --current-version '<version>' \
  --add-entries 'Cidr=<new-public-ip>/32,Description=<operator-or-location>'
```

Do not add `0.0.0.0/0`. Prefix list entries change who can reach the ALB and
Grafana without redeploying the stack.

## Prefix List Preflight

CDK validates the prefix-list ID syntax offline. It cannot prove that the
external list is owned by the target account, exists in the target Region, uses
IPv4, has the expected capacity, or contains only reviewed entries.

With the intended AWS profile and Region exported, inspect the exact configured
ID before `cdk diff` or `cdk deploy`:

```bash
npm run preflight:aws

aws ec2 describe-managed-prefix-lists \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-ids "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --query 'PrefixLists[0].{Id:PrefixListId,Owner:OwnerId,Family:AddressFamily,State:State,MaxEntries:MaxEntries,Version:Version}' \
  --output table

aws ec2 get-managed-prefix-list-entries \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --prefix-list-id "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --query 'Entries[*].{CIDR:Cidr,Description:Description}' \
  --output table
```

Verify all of the following before deployment:

- the caller account and prefix-list owner equal `$AWS_ACCOUNT_ID`;
- the command is running in the intended `AWS_REGION`;
- the address family is `IPv4` and the state is complete, not in progress or
  failed;
- `MaxEntries` is `10`, unless a larger value and its security-group quota cost
  were intentionally reviewed;
- every entry is an expected public `/32`, with no `0.0.0.0/0` or stale access;
- the operator's current public address is present to avoid lockout.

AWS deployment can reject an unusable reference, but it does not prove this
operator policy. The preflight is therefore part of the deployment contract,
not an optional troubleshooting step.

## Local Verification Before AWS

Install dependencies and run the offline checks:

```bash
npm ci
npm run validate:aws-account-preflight
npm run build
npm run test:cdk
npm run test:tooling
npm run validate:adot-image
npm run validate:xray-smoke
npm run validate:managed-metrics-smoke
npm run validate:grafana-dashboard
npm run synth:ecr-contract
```

`npm run ci` runs this ordered, credential-free repository suite as one local
convenience command. In GitHub Actions, automation, CDK assertions, repository
tooling, and synth are separate checks so failures keep their ownership
boundary. The synth contract itself is offline and uses `--no-lookups`; package
installation and the pinned ADOT base-image download can still require internet
access.

`npm run synth:ecr-contract` uses fake account and digest values with
`--no-lookups`. It verifies the CDK contract offline; it does not prove that the
image or prefix list exists in AWS.

## Bootstrap, Diff, And Deploy

Pass the account preflight immediately before bootstrapping:

```bash
npm run preflight:aws
```

Bootstrap the account/Region once:

```bash
npm run cdk -- bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION" \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"
```

Synthesize and review:

```bash
npm run cdk -- synth \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"

npm run cdk -- diff \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"
```

Deploy only after account, Region, prefix list, application digest, expected
cost, teardown plan, and synthesized diff are clear. Because deploy is a new
mutation group after review, rerun the preflight first:

```bash
npm run preflight:aws

npm run cdk -- deploy GoldenPathDemoStack \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"
```

## Post-Deploy Smoke Checks

Run smoke checks with the same AWS profile and Region:

```bash
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:xray -- --report /tmp/xray-smoke.json

AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  npm run smoke:managed-metrics -- --report /tmp/managed-metrics-smoke.json
```

Managed metrics smoke requires `awscurl` for SigV4-signed AMP queries.

## Teardown

Destroy the stack with the same context boundary:

```bash
npm run preflight:aws

npm run cdk -- destroy GoldenPathDemoStack \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"
```

Confirm that the CloudFormation stack, ALB, ECS service/tasks, AMP workspace,
Grafana workspace, Grafana role, VPC endpoints, and log groups are gone.

The customer-managed prefix list, CDK bootstrap stack, Organizations, and IAM
Identity Center resources are account/Region-level prerequisites and are not
part of `GoldenPathDemoStack`. Preserve them after routine demo teardown. Then
complete the access bootstrap runbook's
[first-rehearsal exit gate](./standalone-account-access-bootstrap.md#phase-9-first-rehearsal-exit-gate),
including replacement of the temporary `AdministratorAccess` assignment before
a second workload deployment.
