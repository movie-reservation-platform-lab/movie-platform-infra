/** Expected, sanitized failure at the artifact-foundation inspector boundary. */
export class InspectionFailure extends Error {}

/** Stop inspection without forwarding SDK responses or private target details. */
export function failInspection(message: string): never {
  throw new InspectionFailure(message);
}
