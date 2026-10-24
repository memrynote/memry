/** The `code` of a Node system error (`ENOENT`, `EEXIST`, ...), or undefined for any other thrown value. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
