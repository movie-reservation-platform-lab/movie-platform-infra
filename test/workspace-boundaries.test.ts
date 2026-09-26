import {
  findForbiddenWorkspaceDependencies,
  type WorkspaceDependencyViolation,
  type WorkspaceNode,
} from '../scripts/workspace-boundaries';

const auditApp: WorkspaceNode = {
  kind: 'app',
  name: '@movie-platform/audit-account',
  relativePath: 'apps/audit-account',
  dependencyNames: ['@movie-platform/audit-ingestion'],
};

const observabilityApp: WorkspaceNode = {
  kind: 'app',
  name: '@movie-platform/observability',
  relativePath: 'apps/observability',
  dependencyNames: ['@movie-platform/prometheus-ingestion'],
};

const auditPackage: WorkspaceNode = {
  kind: 'package',
  name: '@movie-platform/audit-ingestion',
  relativePath: 'packages/audit-ingestion',
  dependencyNames: [],
};

const observabilityPackage: WorkspaceNode = {
  kind: 'package',
  name: '@movie-platform/observability-ingestion',
  relativePath: 'packages/observability-ingestion',
  dependencyNames: [],
};

const packageDependingOnApp: WorkspaceNode = {
  ...auditPackage,
  dependencyNames: [auditApp.name],
};

const obsDependingOnApp: WorkspaceNode = {
  ...observabilityPackage,
  dependencyNames: [auditApp.name, observabilityApp.name],
};

describe('workspace dependency direction', () => {
  test('allows a deployable app to depend on a reusable package', () => {
    const violations = findForbiddenWorkspaceDependencies([
      auditApp,
      auditPackage,
    ]);

    expect(violations).toEqual([]);
  });

  test('rejects a reusable package that depends on a deployable app', () => {
    const violations = findForbiddenWorkspaceDependencies([
      auditApp,
      packageDependingOnApp,
    ]);

    expect(violations).toHaveLength(1);
  });

  test('reports forbidden dependencies in deterministic order', () => {
    const forwardInput: readonly WorkspaceNode[] = [
      auditApp,
      observabilityApp,
      packageDependingOnApp,
      obsDependingOnApp,
    ];

    const reversedObsDependingOnApp: WorkspaceNode = {
      ...observabilityPackage,
      dependencyNames: [observabilityApp.name, auditApp.name],
    };
    const reversedInput: readonly WorkspaceNode[] = [
      reversedObsDependingOnApp,
      packageDependingOnApp,
      observabilityApp,
      auditApp,
    ];

    const toEdges = (violations: readonly WorkspaceDependencyViolation[]) =>
      violations.map(violation => [
        violation.source.name,
        violation.target.name,
      ]);

    const forwardEdges = toEdges(
      findForbiddenWorkspaceDependencies(forwardInput),
    );

    const reversedEdges = toEdges(
      findForbiddenWorkspaceDependencies(reversedInput),
    );

    expect(forwardEdges).toEqual(reversedEdges);
    expect(forwardEdges).toEqual([
      [
        '@movie-platform/audit-ingestion',
        '@movie-platform/audit-account',
      ],
      [
        '@movie-platform/observability-ingestion',
        '@movie-platform/audit-account',
      ],
      [
        '@movie-platform/observability-ingestion',
        '@movie-platform/observability',
      ],
    ]);
  });

  test('rejects package-to-app dependencies and ignores external dependencies', () => {
    const packageWithAppAndExternalDependencies: WorkspaceNode = {
      ...auditPackage,
      dependencyNames: [
        auditApp.name,
        'aws-cdk-lib',
      ],
    };

    const violations = findForbiddenWorkspaceDependencies([
      auditApp,
      packageWithAppAndExternalDependencies,
    ]);

    expect(violations).toHaveLength(1);

    const auditViolation = violations[0];
    expect(auditViolation).toMatchObject({
      source: packageWithAppAndExternalDependencies,
      target: auditApp,
    });
    expect(auditViolation?.message).toContain(
      packageWithAppAndExternalDependencies.name,
    );
    expect(auditViolation?.message).toContain(auditApp.name);
  });
});
