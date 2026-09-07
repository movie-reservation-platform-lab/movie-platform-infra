#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// No AWS credentials or network are available inside these test containers.
const image = 'movie-platform-audit-router:test';
const base = JSON.parse(readFileSync('docs/contracts/platform-audit-v1.json', 'utf8')).event;
const secret = 'DO-NOT-ARCHIVE-THIS-SECRET';
async function docker(args, input = '') {
  if (input) {
    return await new Promise((resolveResult, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.stdin.on('error', reject);
      // EOF is a shutdown signal to Fluent Bit's stdin input. Give its event
      // loop a flush interval before closing, rather than racing startup/EOF.
      child.stdin.write(input);
      const closeInput = setTimeout(() => child.stdin.end(), 2200);
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Local router did not finish within 20 seconds'));
      }, 20_000);
      child.on('close', status => {
        clearTimeout(closeInput);
        clearTimeout(timeout);
        if (status !== 0) reject(new Error(`Local router exited ${status}: ${stderr}`));
        else resolveResult({ stdout, stderr });
      });
    });
  }
  const result = spawnSync('docker', args, {
    encoding: 'utf8', input, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Local router test failed: ${result.error?.message ?? result.stderr}`);
  }
  return result;
}
await docker(['build', '-t', image, 'audit-router']);
const productionConfig = await docker([
  'run', '--rm', '--network', 'none',
  '-e', 'AWS_REGION=eu-central-1', '-e', 'AUDIT_DELIVERY_STREAM=test-stream',
  '-e', 'ROUTER_LOG_GROUP=/test', '-e', 'AWS_ACCESS_KEY_ID=FAKE',
  '-e', 'AWS_SECRET_ACCESS_KEY=FAKE', '-e', 'AWS_EC2_METADATA_DISABLED=true',
  image, '/fluent-bit/bin/fluent-bit', '--dry-run', '-c', '/fluent-bit/platform/platform.conf',
]);
assert((productionConfig.stdout + productionConfig.stderr).includes('configuration test is successful'));
for (const producer of ['movie-reservation-service', 'movie-reservation-agent', 'movie-recommendation-service']) {
  const event = structuredClone(base);
  event.service.name = producer;
  event.metadata.product.name = producer;
  const success = structuredClone(event);
  Object.assign(success, { status_id: 1, severity_id: 1, status_detail: 'AUTHENTICATED' });
  success.user = { name: 'demo-user', type_id: 1 };
  const wrongService = structuredClone(event);
  wrongService.service.name = producer === 'movie-reservation-agent' ? 'movie-reservation-service' : 'movie-reservation-agent';
  wrongService.metadata.product.name = wrongService.service.name;
  const malformed = structuredClone(event);
  malformed.unmapped.platform.password = secret;
  const unsafeIdentity = structuredClone(event);
  unsafeIdentity.user.name = secret;
  const oversizedUtf8Version = structuredClone(event);
  oversizedUtf8Version.service.version = 'é'.repeat(128);
  oversizedUtf8Version.metadata.product.version = oversizedUtf8Version.service.version;
  const operational = { event: 'http.request.finish', request_id: 'demo-request-001', trace_id: event.unmapped.platform.trace_id };
  const rawLogs = [
    JSON.stringify({ audit: event }), JSON.stringify({ audit: success }),
    JSON.stringify(operational), 'plain operational line',
    JSON.stringify({ audit: malformed }), JSON.stringify({ audit: unsafeIdentity }),
    JSON.stringify({ audit: wrongService }), `{"audit":{"password":"${secret}"`,
    JSON.stringify({ _audit_route: 'audit', event: 'marker-spoof' }),
    JSON.stringify({ audit: event, password: secret }),
    JSON.stringify({ audit: oversizedUtf8Version }),
  ];
  const input = rawLogs.map(log => JSON.stringify({
    log, source: 'stdout', container_name: producer, container_id: 'test-container',
  })).join('\n') + '\n';
  const result = await docker([
    'run', '--rm', '--network', 'none', '-i', '-e', `TEST_PRODUCER=${producer}`,
    '--mount', `type=bind,source=${resolve('audit-router/test.conf')},target=/test.conf,readonly`,
    image, '/fluent-bit/bin/fluent-bit', '-c', '/test.conf',
  ], input);
  const records = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const archive = records.filter(record => record.test_destination === 'archive');
  assert.equal(archive.length, 2, `${producer}: archive count; ${result.stdout}\n${result.stderr}`);
  assert.deepEqual(archive.map(({ test_destination, ...record }) => record), [event, success]);
  assert.equal(records.filter(record => record.test_destination === 'operational').length, 3);
  assert.equal(records.filter(record => record.test_destination === 'rejected').length, 6);
  assert(!result.stdout.includes(secret), `${producer}: rejected credentials leaked`);
  assert(result.stderr.includes('type=memory+filesystem'), 'test input is not filesystem-backed');
  console.log(`${producer}: valid OCSF, operational routing, schema rejection and redaction passed`);
}

const config = readFileSync('audit-router/platform.conf', 'utf8');
assert.match(config, /Name forward\s+unix_path \/var\/run\/fluent\.sock\s+storage\.type filesystem/);
assert.match(config, /Name kinesis_firehose\s+Match audit/);
assert.match(config, /Retry_Limit False\s+storage\.total_limit_size 512M/);
assert(!config.includes('log_key audit'), 'Firehose must receive the pure object, not an object-valued log_key');
console.log('Audit router tests passed. Real AWS delivery is intentionally not exercised.');
