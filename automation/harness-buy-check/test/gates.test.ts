import { assertWatchReady, candidateVerdict, CoverageInput, WatchReadiness } from '../src/watch';

const input = (extra: Partial<CoverageInput> = {}): CoverageInput => ({
  candidateTaskDefinitionArn: 'revision:2',
  candidateDigest: 'sha256:new',
  candidateTasks: ['task-2'],
  startedAt: 0,
  now: 60000,
  samples: Array.from({ length: 61 }, (_, i) => ({
    taskArn: 'task-2',
    taskDefinitionArn: 'revision:2',
    digest: 'sha256:new',
    at: i * 1000,
    ready: true,
    recommendations: true,
  })),
  ...extra,
});

test('healthy candidate needs revision-attributed 60 samples spanning 60 seconds per task', () => {
  expect(candidateVerdict(input())).toBe('PASS');
  expect(candidateVerdict(input({ candidateTasks: ['task-2', 'task-3'] }))).toBe('PENDING');
  expect(candidateVerdict(input({ samples: input().samples.slice(0, 60) }))).toBe('PENDING');

  expect(
    candidateVerdict(input({ samples: input().samples.map((s) => ({ ...s, at: 100 })) })),
  ).toBe('PENDING');

  expect(
    candidateVerdict(
      input({ samples: input().samples.map((s) => ({ ...s, taskDefinitionArn: 'revision:1' })) }),
    ),
  ).toBe('PENDING');
});

test('unhealthy candidate still requires coverage and missing coverage fails at five minutes', () => {
  expect(
    candidateVerdict(
      input({ samples: input().samples.map((s) => ({ ...s, recommendations: false })) }),
    ),
  ).toBe('FAIL');

  expect(candidateVerdict(input({ samples: [], now: 300000 }))).toBe('FAIL');
  expect(candidateVerdict(input({ candidateTasks: [], now: 300000 }))).toBe('FAIL');

  expect(
    candidateVerdict(
      input({
        now: 400000,
        samples: input().samples.map((sample) => ({ ...sample, at: sample.at + 310000 })),
      }),
    ),
  ).toBe('FAIL');
});

test('watch readiness requires fresh heartbeat and every alarm OK', () => {
  const fresh = { ready: true, heartbeatAt: 50000, alarmStates: { probe: 'OK', ecs: 'OK' } };

  expect(() => assertWatchReady(fresh, 60000)).not.toThrow();

  const invalid: WatchReadiness[] = [
    { ...fresh, ready: false },
    { ...fresh, heartbeatAt: 0 },
    { ...fresh, heartbeatAt: 70000 },
    { ...fresh, alarmStates: {} },
    { ...fresh, alarmStates: { probe: 'INSUFFICIENT_DATA' } },
    { ...fresh, alarmStates: { probe: 'ERROR' } },
  ];

  for (const watch of invalid) {
    expect(() => assertWatchReady(watch, 60000)).toThrow();
  }
});

test('a minute-six candidate failure remains failed after healthy initial coverage and later recovery', () => {
  const healthyCoverage = input();
  const lateFailure = { ...healthyCoverage.samples[0], at: 360000, recommendations: false };

  expect(
    candidateVerdict({
      ...healthyCoverage,
      now: 360000,
      samples: [...healthyCoverage.samples, lateFailure],
    }),
  ).toBe('FAIL');

  expect(
    candidateVerdict({
      ...healthyCoverage,
      now: 420000,
      samples: [
        ...healthyCoverage.samples,
        lateFailure,
        { ...lateFailure, at: 420000, recommendations: true },
      ],
    }),
  ).toBe('FAIL');
});
