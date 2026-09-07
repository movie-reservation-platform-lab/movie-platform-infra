#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { APPLICATION_COMPONENT_INPUTS, resolvePlatformConfig, type PlatformConfigContext } from '../lib/config/platform-config';

const CONTEXT_KEYS = APPLICATION_COMPONENT_INPUTS.flatMap(input => [input.imageReferenceKey, input.serviceVersionKey]);
const RELEASE_VERSION = 'temporary-audit-demo-release-v1';

interface SynthOptions {
  readonly selection: 'previous' | 'proposed';
  readonly output: string;
  readonly prefixListId: string;
  readonly demoAuthSecretArn?: string;
}

interface SynthInvocation {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a nonblank string without control characters.`);
  }
  return value;
}

/** Validate the environment handoff and prepare a SYNTH command, never a deploy. */
export function prepareWorkloadSynth(
  document: unknown,
  options: SynthOptions,
  inherited: NodeJS.ProcessEnv = process.env,
): SynthInvocation {
  const release = object(document, 'release');
  if (release.releaseVersion !== RELEASE_VERSION) throw new Error(`releaseVersion must be ${RELEASE_VERSION}.`);
  const authority = object(release.authority, 'authority');
  for (const key of ['selected', 'deployed', 'durableAdmissionRecorded']) {
    if (authority[key] !== false) throw new Error(`authority.${key} must be false for the temporary local handoff.`);
  }
  const target = object(release.target, 'target');
  const account = string(target.accountId, 'target.accountId');
  const region = string(target.region, 'target.region');
  for (const [key, expected] of [
    ['CDK_DEFAULT_ACCOUNT', account], ['AWS_ACCOUNT_ID', account],
    ['CDK_DEFAULT_REGION', region], ['AWS_REGION', region], ['AWS_DEFAULT_REGION', region],
  ]) {
    if (inherited[key] && inherited[key] !== expected) throw new Error(`${key} conflicts with release target.`);
  }
  const composition = object(release[options.selection], options.selection);
  const context = object(composition.cdkContext, `${options.selection}.cdkContext`);
  if (Object.keys(context).sort().join(',') !== [...CONTEXT_KEYS].sort().join(',')) {
    throw new Error('cdkContext must contain exactly the twelve image/version keys.');
  }
  for (const key of CONTEXT_KEYS) string(context[key], `cdkContext.${key}`);
  const platformContext: PlatformConfigContext = {
    ...context,
    allowedIngressPrefixListId: options.prefixListId,
    demoAuthEnabled: options.demoAuthSecretArn !== undefined,
    demoAuthSecretArn: options.demoAuthSecretArn,
  };
  const config = resolvePlatformConfig(platformContext, { account, region });
  if (!Array.isArray(composition.components) || composition.components.length !== 6) {
    throw new Error('Selected composition must contain exactly six components.');
  }
  const components = composition.components.map((value: unknown) => object(value, 'component'));
  for (const input of APPLICATION_COMPONENT_INPUTS) {
    const matches = components.filter(component => component.componentId === input.componentId);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${input.componentId} component.`);
    const component = matches[0];
    if (component.destinationImageReference !== context[input.imageReferenceKey] ||
        component.deploymentVersion !== context[input.serviceVersionKey] ||
        component.expectedDigest !== config.applicationImages[input.componentId].imageDigest) {
      throw new Error(`${input.componentId} identity disagrees with cdkContext.`);
    }
  }
  const output = resolve(options.output);
  if (output === process.cwd() || output === parse(output).root) {
    throw new Error('Use a dedicated output directory, not the repository or filesystem root.');
  }
  if (existsSync(output)) {
    throw new Error('Output path already exists. Choose a new directory to preserve saved deployment assemblies.');
  }
  const args = ['synth', 'MovieReservationWorkloadStack', '--no-lookups', '--quiet', '--output', output];
  for (const key of CONTEXT_KEYS) args.push('-c', `${key}=${context[key]}`);
  args.push('-c', `allowedIngressPrefixListId=${options.prefixListId}`);
  if (options.demoAuthSecretArn) {
    args.push('-c', 'demoAuthEnabled=true', '-c', `demoAuthSecretArn=${options.demoAuthSecretArn}`);
  }
  return {
    args,
    env: { ...inherited, CDK_DEFAULT_ACCOUNT: account, CDK_DEFAULT_REGION: region, AWS_REGION: region, AWS_EC2_METADATA_DISABLED: 'true' },
  };
}

function main(): number {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' }, selection: { type: 'string', default: 'proposed' },
      output: { type: 'string' }, 'prefix-list-id': { type: 'string' },
      'demo-auth-secret-arn': { type: 'string' }, help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: npm run demo:workload -- --release FILE --selection proposed|previous --output DIRECTORY --prefix-list-id pl-ID [--demo-auth-secret-arn ARN]');
    console.log('Validates the local release and synthesizes into a new directory. Never deploys or contacts registries.');
    return 0;
  }
  const releasePath = string(values.release, '--release');
  if (statSync(releasePath).size > 1024 * 1024) throw new Error('Release document exceeds 1 MiB.');
  if (values.selection !== 'previous' && values.selection !== 'proposed') throw new Error('--selection must be previous or proposed.');
  const invocation = prepareWorkloadSynth(JSON.parse(readFileSync(releasePath, 'utf8')), {
    selection: values.selection,
    output: string(values.output, '--output'),
    prefixListId: string(values['prefix-list-id'], '--prefix-list-id'),
    demoAuthSecretArn: values['demo-auth-secret-arn'],
  });
  const result = spawnSync(process.execPath, [require.resolve('aws-cdk/bin/cdk'), ...invocation.args], {
    env: invocation.env, stdio: 'inherit', shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Workload synth preparation failed.');
    process.exitCode = 2;
  }
}
