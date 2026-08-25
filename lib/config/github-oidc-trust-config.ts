import { readFileSync } from 'node:fs';

export interface GitHubOidcIdentityConfig {
  readonly subject: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly workflow: string;
  readonly ref: 'refs/heads/main';
  readonly environment: string;
}

export interface GitHubOidcTrustConfig {
  readonly schemaVersion: '1';
  readonly bootstrapQualifier: string;
  readonly admission: GitHubOidcIdentityConfig;
  readonly deployment: GitHubOidcIdentityConfig;
}

const CONFIG_KEYS = [
  'schemaVersion',
  'bootstrapQualifier',
  'admission',
  'deployment',
] as const;
const IDENTITY_KEYS = [
  'subject',
  'repository',
  'repositoryId',
  'repositoryOwnerId',
  'workflow',
  'ref',
  'environment',
] as const;
const BOOTSTRAP_QUALIFIER_PATTERN = /^[a-z0-9]{9}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]*$/;
const PLACEHOLDER_PATTERN = /(?:change[_-]?me|replace[_-]?me|your[_-]|placeholder)/i;
const FORBIDDEN_EXACT_CLAIM_CHARACTERS = /[\u0000-\u001f\u007f*?<>]|\$\{/;

export function loadGitHubOidcTrustConfig(configPath: unknown): GitHubOidcTrustConfig {
  const path = parseRequiredString(configPath, 'githubOidcTrustConfigFile');
  let contents: string;

  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error('Unable to read the GitHub OIDC trust configuration file.');
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('GitHub OIDC trust configuration must contain valid JSON.');
  }

  return parseGitHubOidcTrustConfig(value);
}

export function parseGitHubOidcTrustConfig(value: unknown): GitHubOidcTrustConfig {
  const config = parseObject(value, 'configuration');
  assertExactKeys(config, CONFIG_KEYS, 'configuration');

  if (config.schemaVersion !== '1') {
    throw new Error('GitHub OIDC trust configuration "schemaVersion" must be "1".');
  }

  const bootstrapQualifier = parseExactClaim(
    config.bootstrapQualifier,
    'bootstrapQualifier',
  );
  if (!BOOTSTRAP_QUALIFIER_PATTERN.test(bootstrapQualifier)) {
    throw new Error(
      'GitHub OIDC trust configuration "bootstrapQualifier" must contain exactly nine lowercase letters or digits.',
    );
  }

  const admission = parseIdentity(config.admission, 'admission');
  const deployment = parseIdentity(config.deployment, 'deployment');

  if (
    admission.repository !== deployment.repository ||
    admission.repositoryId !== deployment.repositoryId ||
    admission.repositoryOwnerId !== deployment.repositoryOwnerId
  ) {
    throw new Error(
      'Admission and deployment must use the same GitHub repository and owner identities.',
    );
  }
  if (admission.workflow === deployment.workflow) {
    throw new Error('Admission and deployment must use different GitHub workflows.');
  }
  if (admission.environment === deployment.environment) {
    throw new Error('Admission and deployment must use different GitHub Environments.');
  }

  return {
    schemaVersion: '1',
    bootstrapQualifier,
    admission,
    deployment,
  };
}

function parseIdentity(value: unknown, key: string): GitHubOidcIdentityConfig {
  const identity = parseObject(value, key);
  assertExactKeys(identity, IDENTITY_KEYS, key);

  const subject = parseExactClaim(identity.subject, `${key}.subject`);
  const repository = parseExactClaim(identity.repository, `${key}.repository`);
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `GitHub OIDC trust configuration "${key}.repository" must use the owner/repository format.`,
    );
  }

  const repositoryId = parseGitHubId(identity.repositoryId, `${key}.repositoryId`);
  const repositoryOwnerId = parseGitHubId(
    identity.repositoryOwnerId,
    `${key}.repositoryOwnerId`,
  );
  const workflow = parseExactClaim(identity.workflow, `${key}.workflow`);
  const ref = parseExactClaim(identity.ref, `${key}.ref`);
  if (ref !== 'refs/heads/main') {
    throw new Error(`GitHub OIDC trust configuration "${key}.ref" must be "refs/heads/main".`);
  }
  const environment = parseExactClaim(identity.environment, `${key}.environment`);

  return {
    subject,
    repository,
    repositoryId,
    repositoryOwnerId,
    workflow,
    ref,
    environment,
  };
}

function parseGitHubId(value: unknown, key: string): string {
  const id = parseExactClaim(value, key);
  if (!GITHUB_ID_PATTERN.test(id)) {
    throw new Error(`GitHub OIDC trust configuration "${key}" must be a positive numeric ID.`);
  }
  return id;
}

function parseExactClaim(value: unknown, key: string): string {
  const claim = parseRequiredString(value, key);
  if (FORBIDDEN_EXACT_CLAIM_CHARACTERS.test(claim) || PLACEHOLDER_PATTERN.test(claim)) {
    throw new Error(
      `GitHub OIDC trust configuration "${key}" must be an exact non-placeholder value without wildcards or templates.`,
    );
  }
  return claim;
}

function parseRequiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`GitHub OIDC trust configuration "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function parseObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub OIDC trust configuration "${key}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  key: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((item, index) => item !== expected[index])) {
    const missing = expected.filter((item) => !actualKeys.includes(item));
    const unexpected = actualKeys.filter((item) => !expected.includes(item));
    const details = [
      missing.length > 0 ? `missing keys: ${missing.join(', ')}` : undefined,
      unexpected.length > 0 ? `unexpected keys: ${unexpected.join(', ')}` : undefined,
    ].filter((item): item is string => item !== undefined);
    throw new Error(
      `GitHub OIDC trust configuration "${key}" has invalid keys (${details.join('; ')}).`,
    );
  }
}
