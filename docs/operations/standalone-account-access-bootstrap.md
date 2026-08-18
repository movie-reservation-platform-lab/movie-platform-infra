# Standalone-Account Identity Center And Grafana Access Bootstrap

This runbook prepares the existing pay-as-you-go AWS account for short-lived
human access through AWS IAM Identity Center and for access to the disposable
Amazon Managed Grafana workspace created by this repository.

The first lab deliberately uses one account as both the AWS Organizations
management account and the workload account. That is a learning constraint,
not the long-term topology. A later migration keeps this account for management
and redeploys the workload into a member account.

> This document does not authorize account changes. Complete all four
> repository PRs for issue #14, then obtain separate approval for the real-AWS
> rehearsal. If the current checkout does not provide `npm run preflight:aws`,
> stop before any workstation mutation; that read-only gate arrives in PR 3.

Never put a real account ID, operator email, access-portal/issuer URL, generated
role name, password, MFA QR code or seed, token, or credential in Git, an issue,
or shared test evidence.

## What Is Persistent And What Is Disposable

The identity and authorization layers are deliberately separate:

| Layer | Purpose | Lifecycle |
| --- | --- | --- |
| AWS account root | Account ownership and break-glass recovery | Persistent; never routine access |
| AWS Organization | Enables the organization identity boundary | Persistent, no additional Organizations charge |
| IAM Identity Center directory | Stores the named operator and MFA enrollment | Persistent, no additional Identity Center charge |
| Permission set and account assignment | Grants short-lived AWS account access | Temporary Admin first; least-privilege assignment later |
| AWS CLI SSO profile | Requests short-lived credentials | Local profile persists; sessions expire |
| Grafana workspace assignment | Admits the operator to one workspace | Disposable with the workspace |
| Grafana workspace role | Allows Admin, Editor, or Viewer actions inside Grafana | Temporary Admin, then Editor |
| Grafana data-access IAM role | Lets the Grafana service query AMP and CloudWatch | Created and destroyed by `GoldenPathDemoStack` |

An AWS account assignment does not grant Grafana workspace access. A Grafana
human role does not grant the service permission to read metrics. Treating
these as separate checkpoints makes a failed login distinguishable from a
failed data-source query.

## Cost Boundary

- AWS Organizations and IAM Identity Center have no additional service charge.
- The local AWS CLI profile, TOTP enrollment, IAM permission sets, IAM roles,
  and STS sessions do not add a direct service charge.
- CDK bootstrap and repository-external artifact/foundation resources survive
  routine stack teardown and can retain normal storage or request charges.
- Managed Grafana currently requires at least one USD 9 Editor license per
  workspace per month. Treat any free trial as a temporary discount.
- The deployed stack also creates billable Fargate, ALB, VPC endpoint,
  CloudWatch, AMP, X-Ray, and related resources. Destroy it promptly after each
  rehearsal.

Current references:

- [AWS Organizations pricing](https://docs.aws.amazon.com/organizations/latest/userguide/pricing.html)
- [IAM Identity Center resources and pricing](https://aws.amazon.com/iam/identity-center/resources/)
- [Amazon Managed Grafana pricing](https://aws.amazon.com/grafana/pricing/)

## Phase 0: Approval And Existing-State Gate

Before signing in as root:

1. Confirm that issue #14 repository PRs 1–4 are merged and offline CI passed.
2. Obtain explicit approval for the supervised real-account rehearsal.
3. Confirm that the intended account is the existing standalone lab account.
4. Check whether the account already belongs to an Organization or has an IAM
   Identity Center instance. Stop and reconcile existing state rather than
   creating a competing identity boundary.
5. Do not create root access keys, IAM-user access keys, or a temporary IAM
   user for this procedure.

The first console actions cannot use the repository preflight because the SSO
operator does not exist yet. Explicit account ownership, Region, and
existing-state checks are the bootstrap equivalent.

## Phase 1: Protect Root And Recovery

Use root only if no existing federated administrator can perform the initial
bootstrap.

1. Verify control of the root sign-in email.
2. Verify that the AWS account primary contact phone is current and that at
   least one root recovery channel remains accessible if the TOTP phone is
   lost.
3. Use a unique root password and verify root MFA.
4. Record whether root MFA is currently registered on the same phone that will
   run Google Authenticator for the Identity Center operator.
5. If both MFA registrations use that phone, acknowledge that losing it removes
   both routine and break-glass MFA. This is an accepted initial lab weakness,
   not a resilient recovery design.
6. Keep the root email and contact-phone recovery paths current. Add another
   MFA device on a different physical device later as a non-blocking hardening
   task.

Do not save an MFA QR code or seed in this repository or an ordinary
screenshot. LastPass, FIDO2, passkeys, and a YubiKey are not requirements for
the initial setup. After the SSO operator is proven, sign out root and reserve
it for account-owner or recovery tasks.

References:

- [AWS account root-user best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html)
- [AWS MFA recommendations](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa.html)

## Phase 2: Create Or Verify The AWS Organization

1. In the intended account, open **AWS Organizations**.
2. If no organization exists, choose **Create an organization**. Retain the
   default/recommended **All features** mode; do not choose consolidated
   billing only.
3. Complete management-account email verification if AWS requests it.
4. Verify that:
   - the feature set is **All features**;
   - the current account is the management account;
   - no unexpected member account exists; and
   - service control policies are enabled.
5. Do not create another account, organizational-unit hierarchy, delegated
   administrator, or Control Tower landing zone in this issue.

This is the explicitly accepted single-account exception. AWS recommends
separating management and workload accounts for a mature topology; the
approved plan documents the later member-account migration.

Reference: [Creating an AWS Organization](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_org_create.html).

## Phase 3: Enable The Organization Instance In Frankfurt

The primary Region is durable. An Organization can have IAM Identity Center
enabled in only one primary Region; moving it requires deleting and recreating
the instance.

1. Select **Europe (Frankfurt) — `eu-central-1`** in the console.
2. Open **IAM Identity Center**.
3. Choose **Enable** using the organization-instance path. Do not follow the
   account-instance link.
4. Wait for enablement to finish.
5. On **Settings**, verify:
   - instance type is **Organization**;
   - primary Region is `eu-central-1`;
   - identity source is **Identity Center directory**; and
   - an AWS access-portal URL exists.
6. Keep the portal/start URL only in the local AWS CLI configuration or a
   protected private note.

An organization instance supports AWS account permission sets and Managed
Grafana. Account instances do not satisfy this contract.

References:

- [Enable IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html)
- [AWS managed applications and instance compatibility](https://docs.aws.amazon.com/singlesignon/latest/userguide/awsapps-that-work-with-identity-center.html)

## Phase 4: Create The Operator And Enroll Google Authenticator

The built-in Identity Center directory is the authoritative identity source for
this lab. There is no Entra ID, Okta, Google Workspace, or other workforce
directory to integrate.

### Create or identify the operator

1. In IAM Identity Center, open **Users**.
2. Reuse the intended named operator if it already exists and is controlled by
   the correct person. Otherwise choose **Add user**.
3. Use a non-shared username and enter the real email only in AWS.
4. Keep email-based password setup enabled, accept the invitation, and set a
   unique password.
5. For one operator, use a direct assignment. Introduce a group only when more
   operators exist.

### Require and test TOTP on every sign-in

In **Settings → Authentication → Multi-factor authentication → Configure**:

1. Set **Prompt users for MFA** to **Every time they sign in**.
2. Enable **Authenticator apps**. Google Authenticator is a tested RFC 6238 TOTP
   application for IAM Identity Center.
3. For a user without a registered device, choose **Require them to register an
   MFA device at sign in**. Do not allow sign-in without MFA and do not use
   email verification as the second factor.
4. Sign in to the access portal as the operator and register Google
   Authenticator on the phone.
5. Sign out completely, sign back in, and verify that AWS requests a new TOTP
   code.
6. Record the accepted same-phone recovery drawback without copying the MFA QR
   code, secret, or real identity into evidence.

IAM Identity Center supports up to two virtual authenticator apps for one user.
Registering another app on a different physical device remains a later
hardening task.

References:

- [MFA for Identity Center directory users](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-mfa.html)
- [Available MFA types and tested authenticator apps](https://docs.aws.amazon.com/singlesignon/latest/userguide/mfa-types.html)
- [Register an MFA device](https://docs.aws.amazon.com/singlesignon/latest/userguide/user-device-registration.html)

## Phase 5: Assign Temporary Bootstrap Administration

`AdministratorAccess` is intentionally broad. A one-hour session limits the
credential lifetime, but it does not make the policy least-privileged.

1. In IAM Identity Center, open **AWS accounts** under **Multi-account
   permissions**.
2. Select the management account and choose **Assign users or groups**.
3. Select only the named operator.
4. Create or select the predefined permission set backed by the AWS managed
   `AdministratorAccess` policy.
5. Keep the permission-set name `AdministratorAccess` and its one-hour session
   duration.
6. Submit the assignment and wait until provisioning succeeds.
7. In the access portal, verify that the intended account exposes the
   `AdministratorAccess` role.
8. Sign out root. Use the Identity Center operator from this point onward.

This assignment is approved only for account bootstrap and one workload
deployment/teardown rehearsal. A second workload deployment is blocked until a
tested least-privilege replacement is active and this assignment is removed.

References:

- [Configure access with the default directory](https://docs.aws.amazon.com/singlesignon/latest/userguide/quick-start-default-idc.html)
- [Permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsets.html)

## Phase 6: Configure The CLI And Private Target File

Use AWS CLI v2 with its SSO token-provider configuration. The command retains
the historical `sso` name:

```bash
aws --version
aws configure sso --profile movie-platform-demo
```

Use these wizard values:

| Prompt | Value |
| --- | --- |
| SSO session name | `movie-platform-demo` |
| Start URL or issuer URL | Private value from IAM Identity Center |
| SSO Region | `eu-central-1` |
| Registration scopes | `sso:account:access` |
| AWS account | Intended standalone/management account |
| Permission set | `AdministratorAccess` for the temporary phase |
| Default client Region | `eu-central-1` |
| Output format | `json` |
| Profile name | `movie-platform-demo` |

Start a session and inspect the real caller in a private terminal:

```bash
aws sso login --profile movie-platform-demo

aws sts get-caller-identity \
  --profile movie-platform-demo \
  --region eu-central-1 \
  --query '{Account:Account,Arn:Arn}' \
  --output table
```

The ARN must be an Identity Center assumed-role session with this shape:

```text
arn:aws:sts::<account-id>:assumed-role/AWSReservedSSO_AdministratorAccess_<16-hex-suffix>/<session-name>
```

Do not paste this output into Git or shared evidence. Copy the account ID and
the complete generated role-name segment into the independent target file.
Create the file without overwriting an existing one:

```bash
target_config_root="${XDG_CONFIG_HOME:-${HOME}/.config}"
target_config_dir="${target_config_root}/movie-platform"
target_config_file="${target_config_dir}/aws-target.json"

umask 077
mkdir -p "${target_config_dir}"
touch "${target_config_file}"
chmod 600 "${target_config_file}"
vi "${target_config_file}"
```

Enter exactly one JSON object. Keep the account ID quoted because it is an
identifier, not a number used for arithmetic:

```json
{
  "profile": "movie-platform-demo",
  "region": "eu-central-1",
  "accountId": "<12-digit-account-id>",
  "expectedRoleName": "AWSReservedSSO_AdministratorAccess_<16-hex-suffix>"
}
```

Do not `source` this file: PR 3 parses it as inert data and rejects unknown,
missing, wrongly typed, or invalid fields and unsafe permissions. It defaults
to this XDG path and supports `MOVIE_PLATFORM_AWS_TARGET_FILE` as an explicit
future override for another account target. Do not create a repository copy.

Reference: [Configure IAM Identity Center authentication for the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html).

## Phase 7: Required Read-Only Gate

The target file is an independent pin; the AWS profile being checked is not
allowed to approve itself. Before each distinct workstation mutation group:

```bash
aws sso login --profile movie-platform-demo
npm run preflight:aws
```

If `npm run preflight:aws` is unavailable in the checkout, stop. Do not replace
it with a visual `get-caller-identity` check and do not continue to CDK or
manual workload mutations.

The command must validate the profile, exact account, `eu-central-1`, permission
set, and full generated role name against live STS. Success output contains
only the profile, Region, permission-set name, and final four account digits.
It never prints the complete account, role suffix, ARN, username/email, or
session name. It accepts only an AWS CLI v2 SSO token-provider profile and
rejects access keys, root/IAM-user callers, role chaining,
`credential_process`, web identity, and container credential sources.

One passing check covers only a short, uninterrupted group of related commands.
Rerun it before bootstrap, deploy, and destroy; after a new/renewed SSO session;
or after any target, profile, permission-set, or assignment change.

Read-only postconditions after the gate may include:

```bash
aws organizations describe-organization \
  --profile movie-platform-demo \
  --query 'Organization.{FeatureSet:FeatureSet,ManagementAccountId:MasterAccountId}' \
  --output table

aws organizations list-roots \
  --profile movie-platform-demo \
  --query 'Roots[*].{RootId:Id,ScpStatus:PolicyTypes[?Type==`SERVICE_CONTROL_POLICY`] | [0].Status}' \
  --output table

aws sso-admin list-instances \
  --profile movie-platform-demo \
  --region eu-central-1 \
  --query 'Instances[*].{InstanceArn:InstanceArn,IdentityStoreId:IdentityStoreId,OwnerAccountId:OwnerAccountId}' \
  --output table
```

Verify `FeatureSet=ALL`, the expected management/owner account,
`SERVICE_CONTROL_POLICY=ENABLED` on the root, and one organization instance
queried in `eu-central-1`. These commands are evidence, not a substitute for
the preflight.

## Phase 8: Temporary Grafana Admin, Then Editor

Perform this phase only after all repository PRs have merged, the real rehearsal
has separate approval, `GoldenPathDemoStack` is deployed, and the workspace is
`ACTIVE`.

1. Pass the preflight immediately before using the AWS console.
2. Open the access portal's account role, then verify the console account and
   `eu-central-1` in the navigation bar.
3. Open **Amazon Managed Grafana → All workspaces**, select the deployed
   workspace, open **Authentication**, and choose **Configure users and user
   groups**.
4. Assign only the named Identity Center operator to the workspace.
5. Promote that operator to **Admin** and verify the displayed role.
6. Open the workspace URL in a fresh browser session and complete the
   MFA-backed Identity Center login.
7. While Admin, create and test the Amazon Managed Service for Prometheus and
   CloudWatch data sources in `eu-central-1`. Use the stack-created customer-
   managed data-access role; do not enter human AWS credentials into Grafana.
8. Confirm both data sources return a successful test/query result.
9. Return to the Amazon Managed Grafana workspace's **Authentication** page and
   change the operator's workspace role from Admin to **Editor**. Role changes
   belong in the Amazon Managed Grafana console/API, not inside the Grafana UI.
10. Start a fresh workspace session and verify the final state: the operator
    can open dashboards and Explore but cannot add, edit, or delete data
    sources.
11. Only after Editor is verified, import the repository dashboard and perform
    normal demo work.

Admin is temporary because it can manage data sources and users. Editor can
manage dashboards and use Explore but cannot change data sources. If data-source
administration is needed later, deliberately re-promote for that task and
downgrade again; do not leave standing Admin access silently.

References:

- [Manage users and groups in Amazon Managed Grafana](https://docs.aws.amazon.com/grafana/latest/userguide/AMG-manage-users-and-groups-AMG.html)
- [Amazon Managed Grafana user roles](https://docs.aws.amazon.com/grafana/latest/userguide/Grafana-user-roles.html)

## Phase 9: First-Rehearsal Exit Gate

After the first approved deployment and teardown:

1. Verify that `GoldenPathDemoStack` and its Grafana workspace are gone.
2. Verify that the Organization, Identity Center instance, operator, MFA-backed
   access, local profile, CDK bootstrap, and declared external foundations
   remain.
3. Design and review a least-privilege deployment permission set as separate
   follow-up work.
4. Activate and test that replacement, update the CLI profile and private
   target role, rerun the preflight, and then remove the temporary
   `AdministratorAccess` assignment.
5. Do not perform a second workload deployment until step 4 succeeds.

If the rehearsal fails, stop at the failed checkpoint. Destroy safely removable
billable workload resources, preserve the identity foundation unless it is the
source of the failure, and use a focused corrective PR before another approved
attempt. Passing application tests does not waive this gate.

## Lifecycle And Teardown Boundaries

| Layer | Routine post-demo action | Removed by `cdk destroy`? |
| --- | --- | --- |
| Organization, Identity Center instance, directory operator, MFA | Preserve | No |
| Temporary `AdministratorAccess` assignment | Replace and remove after first rehearsal | No; manual identity operation |
| Eventual least-privilege account assignment | Preserve between demos | No |
| AWS CLI profile and private target file | Preserve; let sessions expire normally | Local only |
| CDK bootstrap and external artifact/foundation resources | Preserve until separately retired | No |
| `GoldenPathDemoStack`, including Managed Grafana and its operator assignment | Destroy promptly | Yes |

Routine teardown must not disable IAM Identity Center, delete the Organization,
delete the operator, or remove root recovery. Full account-prerequisite teardown
is a separate destructive account-retirement project requiring a new plan,
dependency inventory, current AWS procedure review, and explicit approval.

## Troubleshooting

### The access portal shows no account or role

The operator exists but the account assignment is missing or still
provisioning. Verify the assignment and wait for successful provisioning.

### Google Authenticator codes are rejected

Verify that the phone clock is synchronized, then retry with a newly generated
code. If recovery is required, use the verified account recovery path; do not
disable MFA as the routine workaround.

### The preflight command is missing

The checkout does not yet include Gate 1 PR 3. Stop before workload mutation.
Do not use environment variables or a raw STS printout as an improvised gate.

### The preflight rejects the target file

Use exactly the four documented keys. Ensure the file is a regular file owned
by the operator with mode `0600`; do not source it or add shell syntax.

### The generated role suffix changed

Deleting all assignments can remove the generated IAM role. After deliberate
assignment recreation, privately verify the new role, update the target file,
and rerun the preflight. Never accept the new suffix automatically.

### The Grafana operator is unavailable for assignment

Verify that the workspace uses `AWS_SSO`, the operator is active in the same
organization instance, and the workspace is `ACTIVE` in `eu-central-1`.

### Grafana login works but data queries fail

Human admission is working. Check the Grafana data-source configuration, the
stack-created data-access role, AMP/CloudWatch selection, and Region separately.

### The Grafana URL is unreachable before authentication

The workspace is also protected by the customer-managed ingress prefix list.
Follow the [deployment runbook's prefix-list preflight](./aws-cdk-deployment.md#prefix-list-preflight)
and verify that the current public `/32` is present.
