# Dedicated Audit Account Bootstrap Runbook

This runbook prepares a dedicated AWS Organizations member account to become the
Security Lake delegated administrator and deployment target for the audit demo.
The repository currently supplies offline configuration, read-only preflight and
status checks, and a guarded CDK bootstrap command. It does not automate account
creation or delegated-administrator registration.

> Account creation, permission assignment, delegated-administrator registration,
> CDK bootstrap, and budget creation mutate AWS. Do them only during an explicitly
> authorized live operation. Ordinary PR and CI validation stops at offline synth.

Never commit a real account ID, root email, generated Identity Center role name,
AWS profile, credential, token, or private topology file.

## Account Responsibilities

| Account | Responsibility | Must not own |
| --- | --- | --- |
| Organization management | Create/member-account governance, Security Lake delegated-administrator registration, consolidated-billing budgets | Security Lake data lake or routine investigations |
| Dedicated audit member | Security Lake delegated administrator, future central ingestion, retained evidence and investigator access | Workload compute or organization management |
| Workload member | Reservation workload and narrowly scoped audit publication | Audit storage administration or query access |

AWS allows one Security Lake delegated administrator per organization. The
management account cannot hold that role. The selected audit account becomes the
same delegated administrator across Regions, even though this demo initially uses
only `eu-central-1`.

## Phase 0: Offline Repository Gate

From a clean checkout:

```bash
npm ci
npm run build
npm run validate:workspace-boundaries
npm run test:cdk:audit-account
npm run synth:audit-account
```

The synth command uses synthetic account IDs, performs no lookup, and emits an
empty `AuditAccountStack`. Pipeline resources arrive only after the separately
authorized Security Lake and Firehose feasibility checkpoint.

## Phase 1: Create the Member Account

In the organization management account:

1. Confirm the organization uses all features and reconcile any existing log
   archive or Security Lake administrator before creating another account.
2. In AWS Organizations, choose **Add an AWS account → Create an AWS account**.
3. Use a dedicated account name and a unique root email controlled through the
   project's private recovery process.
4. Keep the default `OrganizationAccountAccessRole` unless the organization has
   already standardized another bootstrap role.
5. Move the account into the intended security/log-archive OU if one exists and
   review inherited service-control policies before continuing.
6. Record the account ID only in the private operator configuration described
   below.

AWS Organizations creates administrative and service-linked roles in a newly
created member account. Treat those as initial bootstrap access; routine operator
access should use IAM Identity Center.

Official reference: [Creating a member account in an organization](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html).

## Phase 2: Protect Recovery and Assign Operator Access

1. Verify the member account's root email and recovery contact privately.
2. Protect root with MFA and do not create root access keys.
3. Assign the named IAM Identity Center operator to the audit member account.
4. Use a short-lived administrator permission set only for the initial bootstrap.
5. Record the intended later roles: deployment operator, read-only status
   operator, investigator, and break-glass administrator.
6. Keep break-glass access separate from routine investigation access and test
   recovery before evidence retention becomes important.

This PR records those roles but does not create their final least-privilege IAM
policies. The future account-composition PR owns those policies.

## Phase 3: Create Private Local Configuration

Create a second SSO profile and generic target file for the audit account by
following the existing account-preflight package documentation. The target must
pin the exact audit account, `eu-central-1`, permission set, and generated role.

Create the topology file outside Git:

```bash
audit_config_root="${XDG_CONFIG_HOME:-${HOME}/.config}/movie-platform"
audit_config_file="${audit_config_root}/audit-account.json"

umask 077
mkdir -p "${audit_config_root}"
touch "${audit_config_file}"
chmod 600 "${audit_config_file}"
```

Edit it locally using the following shape:

```json
{
  "managementAccountId": "<12-digit-management-account-id>",
  "auditAccountId": "<12-digit-audit-account-id>",
  "workloadAccountIds": [
    "<12-digit-workload-account-id>"
  ],
  "region": "eu-central-1"
}
```

Export only the path:

```bash
export MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE="${audit_config_file}"
export MOVIE_PLATFORM_AWS_TARGET_FILE="${audit_config_root}/audit-aws-target.json"
```

Account IDs are identifiers, so they remain JSON strings. The app rejects an
unknown key, unsupported Region, duplicate account role, or malformed ID before
CDK or another AWS command runs.

## Phase 4: Read-Only Audit-Account Gate

Start the SSO session using the private profile, then run:

```bash
npm run preflight:audit-account
npm run status:audit-account
```

The preflight performs two checks:

1. the reusable package proves the private target file, AWS CLI v2 SSO profile,
   permission set, and live STS caller agree; and
2. the audit app proves that target equals its configured audit account and
   Region.

`status:audit-account` then reads only the `CDKToolkit` CloudFormation status. A
missing stack reports unavailable and does not bootstrap automatically.

## Phase 5: Designate the Security Lake Administrator

This is a management-account action and a separate authorized checkpoint. Run
the generic account preflight against a private management-account target before
making it.

Use Security Lake's `RegisterDataLakeDelegatedAdministrator` operation from the
management account, selecting the dedicated audit member account. Do not use the
generic Organizations delegated-administrator API for this service; AWS states
that the Security Lake operation establishes the required integration correctly.

After registration, verify privately that:

- the selected audit account is the only Security Lake delegated administrator;
- the organization and account remain active;
- the management account is not the delegated administrator; and
- the selected account matches the reviewed private topology file.

Do not remove delegated administration casually. AWS documents removal as a
destructive operation that disables Security Lake and deletes the data lake for
organization accounts.

Official reference: [Managing multiple accounts with AWS Organizations in Security Lake](https://docs.aws.amazon.com/security-lake/latest/userguide/multi-account-management.html).

## Phase 6: Establish the Cost Boundary

Before creating pipeline resources:

1. In the management/payer account, create a consolidated budget for the audit
   experiment and route alerts through a private, monitored address.
2. Record the monthly threshold and the operator responsible for shutdown in the
   private environment/release record.
3. Review expected Security Lake, EventBridge, Firehose, S3, Glue, Athena, KMS,
   CloudWatch, and interface-endpoint costs.
4. Confirm the two teardown modes: stop expensive demo processing while retaining
   the approved baseline, or fully remove the account application and data after
   an explicit retention decision.

The public repository records no billing email, real threshold, or account ID.

## Phase 7: Guarded CDK Bootstrap

Only after live authorization and successful audit-account preflight:

```bash
npm run bootstrap:audit-account
```

Without `--execute`, this command validates the exact target and prints a plan;
it does not mutate AWS. Review the account and Region privately, then run the
authorized operation:

```bash
npm run bootstrap:audit-account -- --execute
```

CDK bootstrap creates or updates `CDKToolkit` in the audit account. It does not
deploy `AuditAccountStack`, enable Security Lake, or create ingestion resources.
Review the bootstrap execution role's authority before using it for later deploys.

Official reference: [Bootstrapping AWS environments for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html).

## Teardown Prerequisites

Before any later full removal, inventory and order these dependencies:

1. active custom sources, native sources, subscribers, and organization settings;
2. retained S3 evidence and the KMS keys needed to read it;
3. EventBridge archives, queues, Firehose outputs, Glue tables, and Athena work;
4. Security Lake delegated-administrator removal from the management account;
5. account-app and CDK bootstrap stacks; and
6. budget, Identity Center assignment, break-glass path, and final account closure.

Do not delete a KMS key while retained evidence still depends on it. Do not close
the member account as ordinary demo cleanup.
