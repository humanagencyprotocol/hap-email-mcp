/** The optional `received_after` argument of list_messages: older messages are never returned. */
export function parseReceivedAfter(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}/.test(value as string)) {
    throw new Error(`received_after must be an ISO 8601 date or date-time, got ${JSON.stringify(value)}`);
  }
  return ms;
}
