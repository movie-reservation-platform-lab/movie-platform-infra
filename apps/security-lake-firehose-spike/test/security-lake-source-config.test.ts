import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import {
  parseSecurityLakeSourceConfigJson,
  SecurityLakeSourceConfigError,
} from '../lib/security-lake-source-config';

const auditConfig: AuditAccountConfig = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
};

test('parses an assigned source in the configured audit and workload accounts', () => {
  expect(parseSecurityLakeSourceConfigJson(JSON.stringify({
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourceAccountId: '333333333333',
    sourceLocation: 's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/',
  }), auditConfig)).toEqual({
    bucketName: 'aws-security-data-lake-eu-central-1-example',
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    providerRoleName: 'AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourceAccountId: '333333333333',
    sourceLocation: 's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/',
    sourcePrefix: 'ext/MOVIE_AUTH/',
  });
});

test.each([
  ['a role in another account', {
    providerRoleArn:
      'arn:aws:iam::999999999999:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourceAccountId: '333333333333',
    sourceLocation: 's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/',
  }],
  ['a source outside the Security Lake ext prefix', {
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourceAccountId: '333333333333',
    sourceLocation: 's3://aws-security-data-lake-eu-central-1-example/arbitrary/',
  }],
  ['an account outside the workload allowlist', {
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourceAccountId: '444444444444',
    sourceLocation: 's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/',
  }],
])('rejects %s', (_description, value) => {
  expect(() => parseSecurityLakeSourceConfigJson(JSON.stringify(value), auditConfig))
    .toThrow(SecurityLakeSourceConfigError);
});
