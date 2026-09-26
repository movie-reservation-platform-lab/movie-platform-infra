import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export type WorkspaceKind = 'app' | 'package';

export interface WorkspaceNode {
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly relativePath: string;
  readonly dependencyNames: readonly string[];
}

export interface WorkspaceDependencyViolation {
  readonly source: WorkspaceNode;
  readonly target: WorkspaceNode;
  readonly message: string;
}

type JsonObject = Readonly<Record<string, unknown>>;

/** Validate that a parsed JSON value is a non-array object. */
function requireJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

/** Read a required, already-trimmed package name from a package manifest. */
function requirePackageName(value: unknown, packageJsonPath: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${packageJsonPath} must contain a nonblank package name.`);
  }
  return value;
}

/** Collect unique dependency names from every npm dependency section in stable order. */
function collectDependencyNames(manifest: JsonObject, packageJsonPath: string): readonly string[] {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const value = manifest[field];
    if (value === undefined) continue;
    for (const name of Object.keys(requireJsonObject(value, `${packageJsonPath}#${field}`))) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Discover immediate child workspaces of one kind, skipping directories without a package.json. */
function discoverWorkspacesByKind(
  repositoryRoot: string,
  directory: 'apps' | 'packages',
): readonly WorkspaceNode[] {
  const workspaceRoot = join(repositoryRoot, directory);
  if (!existsSync(workspaceRoot)) return [];
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const workspacePath = join(workspaceRoot, entry.name);
      const packageJsonPath = join(workspacePath, 'package.json');
      if (!existsSync(packageJsonPath)) return [];
      const manifest = requireJsonObject(JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown, packageJsonPath);
      return [{
        kind: directory === 'apps' ? 'app' : 'package',
        name: requirePackageName(manifest.name, packageJsonPath),
        relativePath: relative(repositoryRoot, workspacePath),
        dependencyNames: collectDependencyNames(manifest, packageJsonPath),
      } satisfies WorkspaceNode];
    });
}

/**
 * Discover the repository-owned app and package workspaces.
 *
 * Only immediate children of apps/ and packages/ participate. Duplicate npm
 * package names are rejected because dependency edges could not be resolved
 * to one unambiguous workspace.
 */
export function discoverWorkspaceGraph(repositoryRoot: string): readonly WorkspaceNode[] {
  const graph = [
    ...discoverWorkspacesByKind(repositoryRoot, 'apps'),
    ...discoverWorkspacesByKind(repositoryRoot, 'packages'),
  ];
  const names = new Set<string>();
  for (const workspace of graph) {
    if (names.has(workspace.name)) {
      throw new Error(`Duplicate workspace name: ${workspace.name}.`);
    }

    names.add(workspace.name);
  }
  return graph;
}

/**
 * Return every forbidden dependency from a reusable package to a deployable app.
 *
 * This function is the engineer-owned hybrid-teaching slice. The filesystem and
 * package.json parsing around it are complete so the exercise stays focused on
 * expressing one architectural rule over a small typed graph.
 */
export function findForbiddenWorkspaceDependencies(
  workspaces: readonly WorkspaceNode[],
): readonly WorkspaceDependencyViolation[] {
  if (workspaces.length === 0) return [];
  const violations: WorkspaceDependencyViolation[] = [];

  for (const workspaceSource of workspaces) {
    if (workspaceSource.kind !== 'package') {
      continue;
    }

    for (const dependencyName of workspaceSource.dependencyNames) {
      const target = workspaces.find(workspace => workspace.name === dependencyName);

      if (target?.kind === 'app') {
        const violation = {
          source: workspaceSource,
          target,
          message: `${workspaceSource.name} must not depend on deployable app: ${target.name}`,
        } satisfies WorkspaceDependencyViolation;
        violations.push(violation);
      }
    }
  }

  return violations.sort(compareViolations);
}

/** Compare violations by source name and then target name for stable reports. */
function compareViolations(
  left: WorkspaceDependencyViolation,
  right: WorkspaceDependencyViolation,
): number {
  const workspaceOrder = left.source.name.localeCompare(right.source.name);

  if (workspaceOrder !== 0) {
    return workspaceOrder;
  }

  return left.target.name.localeCompare(right.target.name);
}
