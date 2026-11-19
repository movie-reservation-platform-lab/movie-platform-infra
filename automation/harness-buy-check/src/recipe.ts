import { isDigestImageReference } from '@movie-platform/experiment-sandbox';
import { array, object, string } from './json';

/** Same render/register contract as S1 release.sh; tested against its committed fixtures. */
export function renderRecipe(
  recipe: unknown,
  containerName: string,
  image: string,
): Record<string, unknown> {
  if (!isDigestImageReference(image)) {
    throw new Error('candidate must be immutable');
  }

  const source = object(recipe, 'recipe');
  const task = object(source.taskDefinition, 'task definition');
  const containers = array(task.containerDefinitions).map((value) => object(value, 'container'));
  const matches = containers.filter((container) => container.name === containerName);

  if (matches.length !== 1) {
    throw new Error('recipe requires exactly one selected container');
  }

  const previous = string(matches[0].image, 'recipe image');

  if (!isDigestImageReference(previous) || previous.split('@')[0] !== image.split('@')[0]) {
    throw new Error('candidate repository differs from recipe');
  }

  const rendered = {
    ...task,
    containerDefinitions: containers.map((container) =>
      container.name === containerName ? { ...container, image } : container,
    ),
  };

  const result: Record<string, unknown> = { ...rendered };

  for (const key of [
    'taskDefinitionArn',
    'revision',
    'status',
    'requiresAttributes',
    'compatibilities',
    'registeredAt',
    'registeredBy',
    'deregisteredAt',
  ]) {
    delete result[key];
  }

  result.tags = [
    ...array(source.tags ?? [])
      .map((value) => object(value, 'tag'))
      .filter((tag) => !string(tag.key).startsWith('aws:')),
    { key: 'ReleasedBy', value: 'release.sh' },
  ];

  return result;
}
