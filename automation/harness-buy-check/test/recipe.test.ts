import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRecipe } from '../src/recipe';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../test/fixtures/ecs-canary-spike/release', name), 'utf8'),
  );

test('library renderer preserves S1 characterized register behavior without copying shell', () => {
  const recipe = fixture('describe-task-definition-recipe.json');

  const image =
    '111111111111.dkr.ecr.eu-central-1.amazonaws.com/ecs-canary-spike-fixture@sha256:' +
    'b'.repeat(64);

  expect(renderRecipe(recipe, 'fixture', image)).toEqual(fixture('expected-rendered.json'));
});

test('renderer rejects changed repository, mutable image, and absent container', () => {
  const recipe = fixture('describe-task-definition-recipe.json');

  for (const [name, image] of [
    ['fixture', 'other/image@sha256:' + 'b'.repeat(64)],
    ['fixture', 'image:tag'],
    ['missing', 'image@sha256:' + 'b'.repeat(64)],
  ]) {
    expect(() => renderRecipe(recipe, name, image)).toThrow();
  }
});
