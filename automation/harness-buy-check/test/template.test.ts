import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Harness wrapper exposes isolated ordered steps without raw AWS release authority or inverted failures', () => {
  const yaml = readFileSync(join(__dirname, '../templates/pipeline.yaml'), 'utf8');

  expect(yaml.match(/--step (gate|watch|release)/g)).toEqual([
    '--step gate',
    '--step watch',
    '--step release',
  ]);

  expect(yaml).not.toMatch(
    /aws ecs|aws iam|RunTask|PassRole|ignoreFailure|markAsSuccess|skip-alarm|continueOnFailure/,
  );

  expect(yaml).toContain('REPLACE_SCRATCH_PROJECT');
  expect(yaml.match(/main\.js delegate "\$TRIAL_CASE"/g)).toHaveLength(3);
  expect(yaml).not.toMatch(/TRIAL_RECORD_PATH|--record|--launcher|--profile/);
});
