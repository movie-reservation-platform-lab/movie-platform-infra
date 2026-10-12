/**
 * Only the `send` method of an AWS SDK client. Adapters depend on this narrow
 * shape so tests can pass a fake that records commands, without credentials or
 * network access.
 */
export type SendClient<T extends { send: unknown }> = Pick<T, 'send'>;
