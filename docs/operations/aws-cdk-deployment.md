# AWS CDK Deployment Runbook

This runbook deploys `GoldenPathDemoStack` from a developer workstation into an
AWS account, verifies the infrastructure contract, and removes the deployed
resources afterward.

The stack is a learning/demo environment, not a production deployment. It
creates resources that incur charges while they exist, including a Fargate task,
an Application Load Balancer, interface VPC endpoints, CloudWatch logs and
metrics, an AMP workspace, and an Amazon Managed Grafana workspace.

## CDK Lifecycle Mental Model

| Phase | Where it runs | What it does |
| --- | --- | --- |
| `synth` | Workstation | Executes the TypeScript CDK app and writes CloudFormation and asset metadata under `cdk.out/`. It changes no AWS resources. |
| `bootstrap` | Workstation CLI plus AWS CloudFormation | Once per account/Region, creates the CDK toolkit resources used to publish assets and deploy stacks. |
| `diff` | Workstation CLI plus AWS CloudFormation | Compares the synthesized template with the deployed stack. |
| `deploy` | Workstation CLI plus AWS CloudFormation | Publishes the repository-owned ADOT asset, consumes the selected digest-pinned app image, and applies the CloudFormation change set. |
| `destroy` | Workstation CLI plus AWS CloudFormation | Deletes resources owned by `GoldenPathDemoStack`. It does not delete the CDK bootstrap stack or customer-managed prefix list. |

The CDK code is the model, the synthesized template is the deployment contract,
and CloudFormation owns the deployed resource lifecycle.

## Required Inputs

Every real deploy needs:

- AWS account ID and Region.
- Customer-managed IPv4 prefix list ID for ALB and Grafana access.
- Digest-pinned private ECR image reference for the reservation service.
- Application service version or release identifier.
- Operator acknowledgement of expected cost and teardown plan.

Example context:

```bash
export AWS_PROFILE=movie-reservation-platform-cdk
export AWS_REGION=eu-central-1
export AWS_ACCOUNT_ID=123456789012
export ALLOWED_INGRESS_PREFIX_LIST_ID=pl-0123456789abcdef0
export APPLICATION_IMAGE_REFERENCE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest>"
export APPLICATION_SERVICE_VERSION=<release-id>
```

## Prefix List Setup

Create the customer-managed IPv4 prefix list outside the stack:

```bash
aws ec2 create-managed-prefix-list \
  --prefix-list-name movie-reservation-platform-aws-demo-ingress \
  --address-family IPv4 \
  --max-entries 10 \
  --entries Cidr=<your-public-ip>/32,Description=developer-laptop
```

`MaxEntries=10` supports up to ten distinct source CIDRs. Because the ALB
security-group rule references this customer-managed prefix list, AWS counts ten
inbound rules against that security group's IPv4 rule quota even when the list
currently contains fewer entries. This is capacity accounting, not a limit on
users, requests, connections, or throughput. Keep the maximum deliberately
small and check the security-group quota before resizing it.

To add another trusted `/32`, read the current version and modify the list:

```bash
aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=movie-reservation-platform-aws-demo-ingress \
  --query 'PrefixLists[0].{PrefixListId:PrefixListId,Version:Version}'

aws ec2 modify-managed-prefix-list \
  --prefix-list-id "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --current-version <version> \
  --add-entries Cidr=<new-public-ip>/32,Description=<operator-or-location>
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
aws sts get-caller-identity \
  --query '{Account:Account,Arn:Arn}' \
  --output table

aws ec2 describe-managed-prefix-lists \
  --prefix-list-ids "$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  --query 'PrefixLists[0].{Id:PrefixListId,Owner:OwnerId,Family:AddressFamily,State:State,MaxEntries:MaxEntries,Version:Version}' \
  --output table

aws ec2 get-managed-prefix-list-entries \
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
npm run build
npm test
npm run validate:adot-image
npm run validate:xray-smoke
npm run validate:managed-metrics-smoke
npm run validate:grafana-dashboard
npm run synth:ecr-contract
```

`npm run synth:ecr-contract` uses fake account and digest values with
`--no-lookups`. It verifies the CDK contract offline; it does not prove that the
image or prefix list exists in AWS.

## Bootstrap, Diff, And Deploy

Verify the caller before any AWS mutation. This complements, but does not
replace, the prefix-list preflight above:

```bash
aws sts get-caller-identity --profile "$AWS_PROFILE"
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
cost, and teardown plan are clear:

```bash
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
npm run cdk -- destroy GoldenPathDemoStack \
  -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
  -c applicationImageReference="$APPLICATION_IMAGE_REFERENCE" \
  -c applicationServiceVersion="$APPLICATION_SERVICE_VERSION"
```

Confirm that the CloudFormation stack, ALB, ECS service/tasks, AMP workspace,
Grafana workspace, Grafana role, VPC endpoints, and log groups are gone.

The customer-managed prefix list, CDK bootstrap stack, Organizations, and IAM
Identity Center resources are account/Region-level prerequisites and are not
part of `GoldenPathDemoStack`.
