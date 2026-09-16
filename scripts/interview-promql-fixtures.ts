import { renderInterviewGrafana } from '../grafana/interview';

// promtool accepts JSON as YAML. Reuse the real rendered expression rather than
// maintaining a second copy of the alert's policy in test fixtures.
const query = renderInterviewGrafana({
  ampUid: 'test-amp', folderUid: 'test-folder', grafanaUrl: 'https://grafana.example.test',
  runbookUrl: 'https://example.test/runbook',
}).ruleGroup.rules[0].data[0].model.expr!;
const counter = 'movie_recommendation_service_http_requests_total';
const labels = 'deployment_environment="aws-demo",service_name="movie-recommendation-service",http_route="/recommendations"';
const series = (status: string, values: string) => ({ series: `${counter}{${labels},http_status_code="${status}"}`, values });
const check = (eval_time: string, expected?: number) => ({
  expr: query, eval_time, exp_samples: expected === undefined ? [] : [{ labels: '{}', value: expected }],
});

process.stdout.write(JSON.stringify({
  rule_files: [], evaluation_interval: '15s', tests: [
    { name: 'fresh healthy traffic with no error series', interval: '30s',
      input_series: [series('200', '0+1x10')], promql_expr_test: [check('2m', 0)] },
    { name: 'sustained failures then fresh healthy recovery', interval: '30s',
      input_series: [series('200', '0+1x10'), series('503', '0 1 2 3 4 4 4 4 4 4 4')],
      promql_expr_test: [check('2m', 4), check('5m', 0)] },
    { name: 'counter resets remain measurable without negative errors', interval: '30s',
      input_series: [series('503', '0 2 4 0 2 4 6')],
      promql_expr_test: [check('2m', 16 / 3), check('3m', 6)] },
    { name: 'stale route samples do not become healthy zero', interval: '30s',
      input_series: [series('200', '0+1x4')], promql_expr_test: [check('4m')] },
    { name: 'missing route series stays absent', interval: '30s',
      input_series: [], promql_expr_test: [check('2m')] },
    { name: 'first single sample is not sufficient', interval: '30s',
      input_series: [series('503', '3')], promql_expr_test: [check('0s')] },
  ],
}, null, 2));
