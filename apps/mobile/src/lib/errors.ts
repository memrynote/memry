/**
 * User-facing error text helper — the mobile twin of desktop's
 * `extractErrorMessage` from `@/lib/ipc-error` (same contract: never show a
 * raw stack, always fall back to the caller's plain-language message).
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  if (typeof err === 'string' && err.trim().length > 0) return err
  return fallback
}
