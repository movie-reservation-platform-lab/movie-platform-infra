import { renderInterviewGrafana, InterviewGrafanaConfig } from '../grafana/interview';
import { main } from '../scripts/render-interview-grafana';

const config: InterviewGrafanaConfig = {
  ampUid: 'demo-amp', folderUid: 'sre-interview',
  grafanaUrl: 'https://grafana.example.test',
  runbookUrl: 'https://github.com/example/infra/blob/main/docs/operations/sre-investigation.md',
};

describe('interview Grafana artifacts', () => {
  test('stable dashboard/rule association, concrete data source and bounded evaluation', () => {
    const { dashboard, ruleGroup } = renderInterviewGrafana(config);
    const rule = ruleGroup.rules[0];
    expect(dashboard.uid).toBe('sre-interview');
    expect(rule.annotations.__dashboardUid__).toBe(dashboard.uid);
    expect(rule.annotations.__panelId__).toBe('1');
    expect(ruleGroup.interval).toBe(15);
    expect(rule.for).toBe('30s');
    expect(rule.data[0].datasourceUid).toBe('demo-amp');
    expect(rule.data[1].model).toMatchObject({ expression: '$A >= 3', type: 'math' });
    expect(rule.labels).toMatchObject({ exercise: 'sre-interview', environment: 'aws-demo' });
  });

  test('never activates a rule or suppresses telemetry failures as healthy', () => {
    const { ruleGroup, setup } = renderInterviewGrafana(config);
    expect(ruleGroup.rules[0]).toMatchObject({ isPaused: true, noDataState: 'NoData', execErrState: 'Error' });
    expect(setup.notificationSafety).toContain('Pause before silence expiry');
    expect(JSON.stringify(ruleGroup)).not.toContain('notification_settings');
  });

  test('symptom expression uses normalized labels, excludes diagnostic fault labels and guards missing telemetry', () => {
    const { dashboard, ruleGroup } = renderInterviewGrafana(config);
    const query = ruleGroup.rules[0].data[0].model.expr!;
    expect(query).toBe(dashboard.panels[0].targets[0].expr);
    expect(query).toContain('movie_recommendation_service_http_requests_total');
    expect(query).toContain('http_route="/recommendations"');
    expect(query).toContain('http_status_code=~"5.."');
    expect(query).toContain('deployment_environment="aws-demo"');
    expect(query).toContain('or (0 * sum(increase(');
    expect(query).toContain('> time() - 90');
    expect(query).not.toMatch(/vector\(0\)|fault|health|ready|\$\{/);
    expect(dashboard.panels[2].targets[0].expr).toContain('http_request_duration_ms_bucket');
    expect(dashboard.panels[2].fieldConfig.defaults.unit).toBe('ms');
  });

  test('Tempo is optional; explicit UID produces a scoped trace search, never fabricated trace IDs', () => {
    expect(renderInterviewGrafana(config).dashboard.links).toHaveLength(2);
    const link = renderInterviewGrafana({ ...config, tempoUid: 'demo-tempo' }).dashboard.links[2];
    const left = JSON.parse(new URL(link.url).searchParams.get('left')!);
    expect(left.datasource).toBe('demo-tempo');
    expect(left.queries[0].query).toBe('{ resource.service.name = "movie-recommendation-service" }');
    expect(left.range).toEqual({ from: 'now-15m', to: 'now' });
  });

  test('supports reviewed threshold/cadence adjustments and concrete environment selection', () => {
    const { ruleGroup } = renderInterviewGrafana({ ...config, environment: 'interview', minimumErrors: 5, evaluationSeconds: 30, pendingSeconds: 60 });
    expect(ruleGroup.interval).toBe(30);
    expect(ruleGroup.rules[0].for).toBe('60s');
    expect(ruleGroup.rules[0].data[1].model.expression).toBe('$A >= 5');
    expect(ruleGroup.rules[0].data[0].model.expr).toContain('deployment_environment="interview"');
  });

  test.each([
    { ampUid: '../unsafe' }, { folderUid: '' }, { environment: 'x"} or vector(1)' },
    { tempoUid: 'bad uid' }, { grafanaUrl: 'http://grafana.test' },
    { grafanaUrl: 'https://token@grafana.test' }, { runbookUrl: 'https://example.test/?token=private' },
    { minimumErrors: 0 }, { minimumErrors: NaN }, { minimumErrors: 1.5 },
    { evaluationSeconds: 0 }, { pendingSeconds: -1 },
  ])('rejects invalid runtime inputs: %j', override => {
    expect(() => renderInterviewGrafana({ ...config, ...override })).toThrow();
  });

  test('CLI emits only parseable JSON and rejects unknown/missing arguments', () => {
    const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      main(['--amp-uid', 'demo-amp', '--folder-uid', 'sre-interview', '--grafana-url', config.grafanaUrl, '--runbook-url', config.runbookUrl]);
      const json = JSON.parse(String(output.mock.calls[0][0]));
      expect(json.ruleGroup.rules[0].isPaused).toBe(true);
      expect(() => main([])).toThrow('Missing --amp-uid');
      expect(() => main(['--publish'])).toThrow();
    } finally { output.mockRestore(); }
  });
});
