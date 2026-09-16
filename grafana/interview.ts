/** Offline artifact construction. This module does not contact Grafana or AWS. */
export interface InterviewGrafanaConfig {
  ampUid: string;
  folderUid: string;
  grafanaUrl: string;
  runbookUrl: string;
  environment?: string;
  tempoUid?: string;
  minimumErrors?: number;
  evaluationSeconds?: number;
  pendingSeconds?: number;
}

const dashboardUid = 'sre-interview';
const ruleUid = 'sre-recommendation-errors';
const service = 'movie-recommendation-service';
const counter = 'movie_recommendation_service_http_requests_total';

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) {
    throw new Error(`${name} must be a 1–40 character identifier (letters, digits, _ or -)`);
  }
  return value;
}

function publicHttpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be HTTPS without credentials, query parameters or fragment`);
  }
  return value.replace(/\/$/, '');
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function renderInterviewGrafana(config: InterviewGrafanaConfig) {
  const ampUid = identifier(config.ampUid, 'ampUid');
  const folderUid = identifier(config.folderUid, 'folderUid');
  const environment = identifier(config.environment ?? 'aws-demo', 'environment');
  const grafanaUrl = publicHttpsUrl(config.grafanaUrl, 'grafanaUrl');
  const runbookUrl = publicHttpsUrl(config.runbookUrl, 'runbookUrl');
  const minimumErrors = integer(config.minimumErrors ?? 3, 'minimumErrors', 1, 1000);
  const evaluationSeconds = integer(config.evaluationSeconds ?? 15, 'evaluationSeconds', 10, 300);
  const pendingSeconds = integer(config.pendingSeconds ?? 30, 'pendingSeconds', 0, 600);
  const datasource = { type: 'prometheus', uid: ampUid };
  const labels = `deployment_environment="${environment}",service_name="${service}",http_route="/recommendations"`;
  const all = `${counter}{${labels}}`;
  const errors = `${counter}{${labels},http_status_code=~"5.."}`;
  // An absent error series can be healthy; an absent/stale service must not be.
  // increase() also requires at least two samples of a counter series.
  const errorCount = `(sum(increase(${errors}[2m])) or (0 * sum(increase(${all}[2m])))) and (max(timestamp(${all})) > time() - 90)`;
  const dashboardUrl = `${grafanaUrl}/d/${dashboardUid}`;
  const links = [
    { title: 'Investigation runbook', url: runbookUrl, type: 'link', targetBlank: true },
    { title: 'Alert rule', url: `${grafanaUrl}/alerting/grafana/${ruleUid}/view`, type: 'link', targetBlank: true },
  ];
  if (config.tempoUid) {
    const tempoUid = identifier(config.tempoUid, 'tempoUid');
    const left = {
      datasource: tempoUid,
      queries: [{ refId: 'A', datasource: { type: 'tempo', uid: tempoUid }, queryType: 'traceql', query: `{ resource.service.name = "${service}" }` }],
      range: { from: 'now-15m', to: 'now' },
    };
    links.push({ title: 'Recommendation traces (Tempo)', url: `${grafanaUrl}/explore?left=${encodeURIComponent(JSON.stringify(left))}`, type: 'link', targetBlank: true });
  }
  const panel = (id: number, title: string, expr: string, unit: string, description: string) => ({
    id, title, description, type: 'timeseries', datasource,
    gridPos: { x: ((id - 1) % 2) * 12, y: Math.floor((id - 1) / 2) * 8, w: 12, h: 8 },
    fieldConfig: { defaults: { unit, min: 0 }, overrides: [] },
    options: { legend: { displayMode: 'list', placement: 'bottom' } },
    targets: [{ refId: 'A', datasource, expr, range: true, instant: false, legendFormat: '{{http_status_code}}' }],
  });
  const dashboard = {
    uid: dashboardUid, title: 'SRE interview — recommendation service', schemaVersion: 39,
    version: 1, editable: true, tags: ['sre-interview'], timezone: 'browser',
    refresh: '15s', time: { from: 'now-15m', to: 'now' }, links,
    panels: [
      panel(1, 'Recommendation 5xx — estimated requests / 2m', errorCount, 'short', `Alert threshold >= ${minimumErrors}; pending ${pendingSeconds}s. No data is not a healthy zero.`),
      panel(2, 'Recommendation traffic by HTTP status', `sum by (http_status_code) (rate(${all}[2m]))`, 'reqps', 'User-route traffic only; excludes health/readiness. HTTP errors are symptoms, not proof of root cause.'),
      panel(3, 'Recommendation p95 latency', `histogram_quantile(0.95, sum by (le) (rate(movie_recommendation_service_http_request_duration_ms_bucket{${labels}}[2m])))`, 'ms', 'Histogram estimate in milliseconds; sparse/no traffic can produce NaN. Compare error rate and traces.'),
      panel(4, 'Latest route metric sample age', `time() - max(timestamp(${all}))`, 's', 'Older than 90 seconds invalidates the symptom query; missing data needs a collector/data-source investigation.'),
    ],
  };
  const rule = {
    uid: ruleUid, title: 'Recommendation requests are failing', folderUID: folderUid,
    ruleGroup: 'sre-interview', orgID: 1, condition: 'B',
    for: `${pendingSeconds}s`, isPaused: true,
    noDataState: 'NoData', execErrState: 'Error',
    labels: { exercise: 'sre-interview', environment, service, severity: 'warning' },
    annotations: {
      summary: 'Recommendation requests are returning server errors',
      description: `At least ${minimumErrors} estimated 5xx requests in 2 minutes, sustained for ${pendingSeconds}s. Agent-assisted booking may be affected. Investigate the time window; metrics do not identify one trace.`,
      runbook_url: runbookUrl, dashboard_url: dashboardUrl,
      __dashboardUid__: dashboardUid, __panelId__: '1',
    },
    data: [
      { refId: 'A', queryType: '', relativeTimeRange: { from: 120, to: 0 }, datasourceUid: ampUid,
        model: { refId: 'A', datasource, expr: errorCount, instant: true, range: false, intervalMs: 15000, maxDataPoints: 43200 } },
      { refId: 'B', queryType: '', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__',
        model: { refId: 'B', datasource: { type: '__expr__', uid: '__expr__' }, type: 'math', expression: `$A >= ${minimumErrors}` } },
    ],
  };
  return {
    dashboard,
    // This is the HTTP rule-group PUT shape, not provisioning-file/export JSON.
    ruleGroup: { name: 'sre-interview', folderUid, interval: evaluationSeconds, rules: [rule] },
    setup: {
      folderTitle: 'SRE interview',
      ruleGroupApiPath: `/api/v1/provisioning/folder/${folderUid}/rule-groups/sre-interview`,
      pausedOnImport: true,
      notificationSafety: 'Create and verify a silence on the dedicated grafana_folder before unpausing; cover generated DatasourceNoData/DatasourceError instances. Pause before silence expiry.',
      windowSeconds: 120, freshnessSeconds: 90,
    },
  };
}
