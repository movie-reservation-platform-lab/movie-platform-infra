#!/usr/bin/env node
import { discoverWorkspaceGraph, findForbiddenWorkspaceDependencies } from './workspace-boundaries';

export function main(repositoryRoot: string = process.cwd()): void {
  const violations = findForbiddenWorkspaceDependencies(discoverWorkspaceGraph(repositoryRoot));
  if (violations.length === 0) {
    process.stdout.write('Workspace dependency direction is valid.\n');
    return;
  }
  for (const violation of violations) process.stderr.write(`${violation.message}\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Workspace boundary validation failed.'}\n`);
    process.exitCode = 1;
  }
}
