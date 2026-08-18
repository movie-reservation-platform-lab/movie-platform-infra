# AWS Account Preflight Automation

This directory is an isolated automation building block. It is not imported by
the CDK application under `bin/` or `lib/`, and its tests are not part of the
ordinary infrastructure test suite under `test/`.

The building block owns one read-only safety contract for human-operated AWS
mutations:

- parse an operator-owned JSON target manifest as inert data;
- accept only the pinned AWS CLI v2 Identity Center profile;
- reject static and alternate credential providers;
- compare the pinned account, Region, permission set, and generated role with
  read-only STS identity;
- emit only the approved redacted result.

Run its independent checks with:

```bash
npm run validate:aws-account-preflight
```

Run the live read-only gate, only after the account bootstrap instructions say
it is available:

```bash
npm run preflight:aws
```

The target defaults to
`${XDG_CONFIG_HOME:-$HOME/.config}/movie-platform/aws-target.json`. It must be a
regular file owned by the current operator with no group or other permissions:

```json
{
  "profile": "movie-platform-demo",
  "region": "eu-central-1",
  "accountId": "111111111111",
  "expectedRoleName": "AWSReservedSSO_AdministratorAccess_0123456789abcdef"
}
```

The values above are synthetic examples. Keep real values outside Git and set
the file mode to `0600`.

The implementation is split by runtime boundary:

- `cli.ts` owns standard Node argument parsing and sanitized process output;
- `target-schema.ts` converts untrusted JSON into a validated TypeScript shape;
- `target-file.ts` owns path, file type, ownership, and permission checks;
- `aws-cli.ts` owns the bounded AWS CLI/profile/STS adapter;
- `preflight.ts` owns the short high-level safety workflow;
- `index.ts` exports only the CLI seam used by black-box callers and tests;
- `main.ts` is the executable entrypoint.

The JSON target and CLI/output contracts are intentionally language-neutral.
If deployment automation later moves to a dedicated building-block repository,
move this source, its tests, its local TypeScript/Jest configuration, and its CI
gate together. Do not move only the executable and leave its regression suite
behind.
