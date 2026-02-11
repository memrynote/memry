const IPC_PREFIX = /^Error occurred in handler for '[^']+': (?:Error: )?/

export function extractErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!raw) return fallback
  return raw.replace(IPC_PREFIX, '') || fallback
}
