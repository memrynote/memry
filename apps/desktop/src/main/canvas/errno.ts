/** The errno code of a thrown fs error, or undefined when the thrown value carries none. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  return typeof err.code === 'string' ? err.code : undefined
}
