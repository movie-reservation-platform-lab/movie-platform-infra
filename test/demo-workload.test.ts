import { APPLICATION_COMPONENT_INPUTS } from '../lib/config/platform-config';
import { prepareWorkloadSynth } from '../scripts/demo-workload';

const target = { accountId: '111111111111', region: 'eu-central-1' };
const digest = `sha256:${'a'.repeat(64)}`;
function composition(version: string) {
  const components = APPLICATION_COMPONENT_INPUTS.map(input => ({
    componentId: input.componentId,
    destinationImageReference: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${input.repositoryName}@${digest}`,
    deploymentVersion: version, expectedDigest: digest,
  }));
  const cdkContext = Object.fromEntries(APPLICATION_COMPONENT_INPUTS.flatMap((input, index) => [
    [input.imageReferenceKey, components[index].destinationImageReference],
    [input.serviceVersionKey, version],
  ]));
  return { components, cdkContext };
}
const release = () => ({
  releaseVersion: 'temporary-audit-demo-release-v1', target,
  authority: { selected: false, deployed: false, durableAdmissionRecorded: false },
  previous: composition('previous-version'), proposed: composition('proposed-version'),
});
const options = { selection: 'proposed', output: '.local/test-assembly', prefixListId: 'pl-0123456789abcdef0' } as const;

test('prepares only offline synth with the exact selected six-image composition', () => {
  const invocation = prepareWorkloadSynth(release(), options, {});
  expect(invocation.args.slice(0, 3)).toEqual(['synth', 'MovieReservationWorkloadStack', '--no-lookups']);
  expect(invocation.args).not.toContain('deploy');
  expect(invocation.args).toContain('applicationServiceVersion=proposed-version');
  expect(invocation.args.filter(value => value.startsWith('demoAuthEnabled'))).toHaveLength(0);
  expect(invocation.env).toMatchObject({ CDK_DEFAULT_ACCOUNT: target.accountId, CDK_DEFAULT_REGION: target.region });
  expect(prepareWorkloadSynth(release(), { ...options, selection: 'previous' }, {}).args).toContain('applicationServiceVersion=previous-version');
});

test('rejects conflicting target, misleading authority and unknown context keys', () => {
  expect(() => prepareWorkloadSynth(release(), options, { AWS_REGION: 'us-east-1' })).toThrow('conflicts');
  const document = release();
  document.authority.deployed = true;
  expect(() => prepareWorkloadSynth(document, options, {})).toThrow('authority.deployed');
  document.authority.deployed = false;
  document.proposed.cdkContext.password = 'must-not-be-accepted';
  expect(() => prepareWorkloadSynth(document, options, {})).toThrow('twelve');
});

test('rejects duplicate components and image/version mismatch before launching CDK', () => {
  const document = release();
  document.proposed.components[0].deploymentVersion = 'mismatch';
  expect(() => prepareWorkloadSynth(document, options, {})).toThrow('identity disagrees');
  document.proposed = composition('proposed-version');
  document.proposed.components[1] = document.proposed.components[0];
  expect(() => prepareWorkloadSynth(document, options, {})).toThrow('exactly one');
});

test('validates secret reference, output safety and digest-pinned refs with existing config', () => {
  const secret = 'arn:aws:secretsmanager:eu-central-1:111111111111:secret:demo/auth-Ab12Cd';
  expect(prepareWorkloadSynth(release(), { ...options, demoAuthSecretArn: secret }, {}).args).toContain(`demoAuthSecretArn=${secret}`);
  expect(() => prepareWorkloadSynth(release(), { ...options, output: '.' }, {})).toThrow('dedicated');
  const document = release();
  document.proposed.cdkContext.applicationImageReference = 'example/image:latest';
  expect(() => prepareWorkloadSynth(document, options, {})).toThrow('pinned');
});

test('refuses an existing output directory instead of overwriting a saved assembly', () => {
  expect(() => prepareWorkloadSynth(release(), { ...options, output: __dirname }, {})).toThrow('already exists');
});
