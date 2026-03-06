const IPC_PREFIX_PATTERNS = [
  /^Error occurred in handler for ['"][^'"]+['"]:\s*(?:Error:\s*)?/i,
  /^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i,
  /^Error:\s*/i
]

function stripKnownPrefixes(message: string): string {
  let current = message.trim()
  let changed = true

  while (changed && current.length > 0) {
    changed = false
    for (const pattern of IPC_PREFIX_PATTERNS) {
      const next = current.replace(pattern, '').trim()
      if (next !== current) {
        current = next
        changed = true
      }
    }
  }

  return current
}

export function extractErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!raw) return fallback

  const message = stripKnownPrefixes(raw)
  return message || fallback
}
