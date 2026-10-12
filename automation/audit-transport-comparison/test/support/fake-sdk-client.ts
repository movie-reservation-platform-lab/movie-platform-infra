/**
 * Fake AWS SDK client: answers each command class from its own queue of
 * responses (an Error in the queue is thrown) and records every command sent.
 */
export function fakeSdkClient(responses: ReadonlyArray<readonly [unknown, readonly unknown[]]>) {
  const queues = new Map(responses.map(([command, queue]) => [command, [...queue]]));
  const sent: Array<{ input: unknown }> = [];
  return {
    sent,
    send: async (command: { constructor: unknown; input: unknown }) => {
      sent.push(command);
      const next = queues.get(command.constructor)?.shift();
      if (next === undefined) {
        throw new Error(`unexpected ${(command.constructor as { name: string }).name}`);
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}
