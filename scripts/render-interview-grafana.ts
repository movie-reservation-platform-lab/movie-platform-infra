import { parseArgs } from 'node:util';
import { renderInterviewGrafana } from '../grafana/interview';

/** Stdio adapter only: emits reviewable JSON, never updates Grafana. */
export function main(args: string[]): void {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' },
    'amp-uid': { type: 'string' }, 'folder-uid': { type: 'string' },
    'grafana-url': { type: 'string' }, 'runbook-url': { type: 'string' },
    environment: { type: 'string' }, 'tempo-uid': { type: 'string' },
    'minimum-errors': { type: 'string' }, 'evaluation-seconds': { type: 'string' },
    'pending-seconds': { type: 'string' },
  } });
  if (values.help) {
    process.stdout.write('Render offline Grafana JSON (dashboard + paused HTTP alert rule group).\nRequired: --amp-uid UID --folder-uid UID --grafana-url HTTPS_URL --runbook-url HTTPS_URL\nOptional: --environment aws-demo --tempo-uid demo-tempo --minimum-errors 3 --evaluation-seconds 15 --pending-seconds 30\nNo API calls or credential inputs. Import/activation requires separate operator approval.\n');
    return;
  }
  for (const key of ['amp-uid', 'folder-uid', 'grafana-url', 'runbook-url'] as const) {
    if (!values[key]) throw new Error(`Missing --${key}`);
  }
  const result = renderInterviewGrafana({
    ampUid: values['amp-uid']!, folderUid: values['folder-uid']!,
    grafanaUrl: values['grafana-url']!, runbookUrl: values['runbook-url']!,
    environment: values.environment, tempoUid: values['tempo-uid'],
    minimumErrors: values['minimum-errors'] === undefined ? undefined : Number(values['minimum-errors']),
    evaluationSeconds: values['evaluation-seconds'] === undefined ? undefined : Number(values['evaluation-seconds']),
    pendingSeconds: values['pending-seconds'] === undefined ? undefined : Number(values['pending-seconds']),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // Error messages from validation contain field names, not potentially secret URLs.
    process.stderr.write(`${error instanceof Error ? error.message : 'Rendering failed'}\n`);
    process.exitCode = 1;
  }
}
