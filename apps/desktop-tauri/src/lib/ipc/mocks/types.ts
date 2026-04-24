export type MockHandler = (args: unknown) => Promise<unknown>

export type MockRouteMap = Record<string, MockHandler>

/**
 * Shared sequence counter for deterministic mock IDs across the session.
 * Increments on every call regardless of prefix so that each generated ID
 * is unique within a run.
 */
let counter = 0

export function mockId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter.toString().padStart(6, '0')}`
}

/**
 * Returns a Unix-epoch timestamp in milliseconds offset by `daysAgo` days.
 * Positive values are in the past, negative values in the future.
 */
export function mockTimestamp(daysAgo = 0): number {
  return Date.now() - daysAgo * 86_400_000
}
