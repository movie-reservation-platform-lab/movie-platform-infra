import { readFileSync } from 'node:fs';

interface MetricEvidence {
  readonly name: string;
  readonly type: 'cumulative-histogram' | 'cumulative-monotonic-sum' | 'up-down-sum';
  readonly unit: string;
  readonly attributes: readonly string[];
  readonly cloudWatchDimensions: readonly string[];
}

interface PullRequestEvidence {
  readonly url: string;
  readonly mergeCommit: string;
  readonly source: string;
}

interface ProducerEvidence {
  readonly serviceName: string;
  readonly receiver: string;
  readonly port: number;
  readonly evidence: PullRequestEvidence;
  readonly metrics: readonly MetricEvidence[];
}

interface SignalContractFixture {
  readonly contractVersion: string;
  readonly producers: readonly ProducerEvidence[];
  readonly stages: Record<string, string>;
}

interface CloudWatchDeclaration {
  readonly dimensions: readonly string[];
  readonly selectors: readonly string[];
}

const config = readFileSync('adot-collector/adot-config.yaml', 'utf8');
const overlay = readFileSync('adot-collector/tempo-overlay.yaml', 'utf8');
const fixture = JSON.parse(
  readFileSync('test/fixtures/five-backend-signal-contract.json', 'utf8'),
) as SignalContractFixture;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function cloudWatchDeclarations(): readonly CloudWatchDeclaration[] {
  const block = config
    .split('    metric_declarations:\n', 2)[1]
    ?.split('  prometheusremotewrite/application:\n', 1)[0];
  if (block === undefined) throw new Error('missing CloudWatch metric declarations');

  return block
    .split('      - dimensions:\n')
    .slice(1)
    .map((declaration) => {
      const lines = declaration.split('\n');
      const dimensions = lines[0]?.match(/^          - \[(.*)]$/)?.[1]?.split(', ') ?? [];
      const selectors = lines
        .filter(line => line.startsWith('          - ^'))
        .map(line => line.slice('          - ^'.length, -1));
      return { dimensions, selectors };
    });
}

test('routes every evidenced producer through one unique private OTLP receiver', () => {
  expect(fixture.contractVersion).toBe('five-backend-signals-v1');
  expect(fixture.producers).toHaveLength(5);
  expect(new Set(fixture.producers.map(({ port }) => port)).size).toBe(5);

  const receiverNames = fixture.producers.map(({ receiver }) => `otlp/${receiver}`);
  const traceReceiverList = `[${receiverNames.join(', ')}]`;
  expect(config).toContain(`      receivers: ${traceReceiverList}\n`);
  expect(overlay).toContain(`      receivers: ${traceReceiverList}\n`);

  for (const producer of fixture.producers) {
    expect(producer.evidence.url).toMatch(/^https:\/\/github\.com\/movie-reservation-platform-lab\/.+\/pull\/\d+$/);
    expect(producer.evidence.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(producer.evidence.source).toMatch(/^docs\//);

    const receiverBlock = [
      `  otlp/${producer.receiver}:`,
      '    protocols:',
      '      http:',
      `        endpoint: 127.0.0.1:${producer.port}`,
    ].join('\n');
    expect(config).toContain(receiverBlock);
    expect(occurrences(config, `endpoint: 127.0.0.1:${producer.port}`)).toBe(1);

    const cloudWatchPipeline = [
      `    metrics/${producer.receiver}/cloudwatch:`,
      `      receivers: [otlp/${producer.receiver}]`,
      `      processors: [memory_limiter, attributes/${producer.receiver}_cloudwatch, batch/application_cloudwatch]`,
      '      exporters: [awsemf/application]',
    ].join('\n');
    expect(config).toContain(cloudWatchPipeline);

    const ampPipeline = [
      `    metrics/${producer.receiver}/amp:`,
      `      receivers: [otlp/${producer.receiver}]`,
      `      processors: [memory_limiter, attributes/${producer.receiver}_amp, resource/application_amp, batch/application_amp]`,
      '      exporters: [prometheusremotewrite/application]',
    ].join('\n');
    expect(config).toContain(ampPipeline);
    expect(config).toContain(`value: ${producer.serviceName}`);
  }
});

test('maps every emitted metric to its exact bounded CloudWatch dimensions', () => {
  const emittedMetrics = fixture.producers.flatMap(({ metrics }) => metrics);
  expect(emittedMetrics).toHaveLength(21);
  expect(new Set(emittedMetrics.map(({ name }) => name)).size).toBe(emittedMetrics.length);

  const declarations = cloudWatchDeclarations();
  const actualDimensionsByMetric = new Map<string, readonly string[]>();
  for (const declaration of declarations) {
    for (const selector of declaration.selectors) {
      expect(actualDimensionsByMetric.has(selector)).toBe(false);
      actualDimensionsByMetric.set(selector, declaration.dimensions);
    }
  }

  expect(actualDimensionsByMetric.size).toBe(emittedMetrics.length);
  for (const metric of emittedMetrics) {
    expect(metric.type).toMatch(/^(cumulative-histogram|cumulative-monotonic-sum|up-down-sum)$/);
    expect(new Set(metric.attributes).size).toBe(metric.attributes.length);
    for (const dimension of metric.cloudWatchDimensions) {
      if (!['ServiceName', 'Environment'].includes(dimension)) {
        expect(metric.attributes).toContain(dimension);
      }
    }
    expect(actualDimensionsByMetric.get(escapeRegex(metric.name))).toEqual(metric.cloudWatchDimensions);
  }
});

test('keeps AMP labels bounded and records offline acceptance without claiming live queryability', () => {
  expect(config).toContain('    add_metric_suffixes: false');
  expect(config).toContain('      - key: service.instance.id\n        action: delete');
  expect(config).toContain('    target_info:\n      enabled: false');
  expect(config).toContain('    disable_scope_info: true');
  expect(fixture.stages).toEqual({
    expected: 'verified',
    emitted: 'verified',
    accepted: 'verified-offline',
    queryable: 'pending-live-acceptance',
  });
});
