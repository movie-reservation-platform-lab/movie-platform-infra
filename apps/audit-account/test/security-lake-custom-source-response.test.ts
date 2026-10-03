import { parseSecurityLakeCustomSourceResponse } from '../lib/security-lake-custom-source-response';

const VALID_RESPONSE = {
  source: {
    provider: {
      location:
        's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/1.0/',
      roleArn:
        'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIEAUTH-eu-central-1',
    },
    sourceName: 'MOVIE_AUTH',
    sourceVersion: '1.0',
  },
} as const;

describe('Security Lake custom-source response', () => {
  it('derives the narrow ingestion destination from the AWS response', () => {
    expect(parseSecurityLakeCustomSourceResponse(
      JSON.stringify(VALID_RESPONSE),
      '222222222222',
    )).toEqual({
      destination: {
        bucketName: 'aws-security-data-lake-eu-central-1-example',
        providerRoleArn:
          'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIEAUTH-eu-central-1',
        providerRoleName:
          'AmazonSecurityLake-Provider-MOVIEAUTH-eu-central-1',
        sourcePrefix: 'ext/MOVIE_AUTH/1.0/',
      },
      sourceName: 'MOVIE_AUTH',
      sourceVersion: '1.0',
    });
  });

  it.each([
    ['another audit account', {
      ...VALID_RESPONSE,
      source: {
        ...VALID_RESPONSE.source,
        provider: {
          ...VALID_RESPONSE.source.provider,
          roleArn: 'arn:aws:iam::999999999999:role/provider',
        },
      },
    }],
    ['another source prefix', {
      ...VALID_RESPONSE,
      source: {
        ...VALID_RESPONSE.source,
        provider: {
          ...VALID_RESPONSE.source.provider,
          location: 's3://example/ext/OTHER/1.0/',
        },
      },
    }],
    ['another source version', {
      ...VALID_RESPONSE,
      source: { ...VALID_RESPONSE.source, sourceVersion: '2.0' },
    }],
  ])('rejects %s', (_scenario, response) => {
    expect(() => parseSecurityLakeCustomSourceResponse(
      JSON.stringify(response),
      '222222222222',
    )).toThrow();
  });
});
