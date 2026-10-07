import { getI18n } from 'react-i18next'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'

const I18N_KEY_PREFIX = 'errors:'

/**
 * Lock refusals carry fixed English text because agents relay it verbatim
 * (#2606); the app shows it in the user's language.
 */
const FIXED_MESSAGE_KEYS = new Map<string, string>([
  [VAULT_LOCKED_NOTE_MESSAGE, 'errors:vaultLock.noteReadOnly']
])

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

/**
 * An IPC failure envelope carried across a `throw`.
 *
 * Main-process handlers localize their `error` string before returning it, so
 * that string is display text and cannot be used as a branch condition — a
 * pattern match over it only ever matches in English (issue #1202). This keeps
 * the handler's machine-readable `code` attached to the error so callers that
 * need to react differently can, while callers that only render the message are
 * unaffected: it is a plain `Error` with one extra field.
 */
export class IpcFailureError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'IpcFailureError'
    this.code = code
  }
}

/** The machine-readable code an IPC failure carried, if it carried one. */
export function getIpcErrorCode(error: unknown): string | undefined {
  return error instanceof IpcFailureError ? error.code : undefined
}

/**
 * Turn an IPC command's failure envelope back into a thrown error.
 *
 * `withErrorHandler` resolves a failed command as `{ success: false, error }`
 * rather than rejecting, so a caller that feeds the response straight into its
 * success path crashes on a missing property and shows that crash instead of
 * the handler's real message. Run every envelope-returning response through
 * this first; the thrown message is display text (often an `errors:` key) for
 * {@link extractErrorMessage}.
 */
export function unwrapIpcResult<T>(
  result: T | { success: false; error?: string },
  fallback: string
): T {
  if (result && typeof result === 'object' && (result as { success?: boolean }).success === false) {
    throw new Error((result as { error?: string }).error || fallback)
  }
  return result as T
}

/**
 * The fixed English lock refusal an error carries, or null. Agent replies use
 * this so the model reads the same text in every locale (#2606).
 */
export function getVaultLockRefusal(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = stripKnownPrefixes(raw)
  return FIXED_MESSAGE_KEYS.has(message) ? message : null
}

export function extractErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!raw) return fallback

  const stripped = stripKnownPrefixes(raw)
  if (!stripped) return fallback
  const message = FIXED_MESSAGE_KEYS.get(stripped) ?? stripped

  if (message.startsWith(I18N_KEY_PREFIX)) {
    const translated = getI18n()?.t(message)
    if (typeof translated === 'string' && translated !== message) return translated
  }

  return message
}
