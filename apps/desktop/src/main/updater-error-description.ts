/**
 * Where in the update lifecycle a failure happened. Shipped verbatim as the `phase`
 * field (see VERBATIM_FIELD_KEYS in contracts/redact) so a Loki line says whether the
 * startup check, the background check, the download, or the install is what broke.
 */
export type UpdaterErrorPhase =
  | 'startup-check'
  | 'scheduled-check'
  | 'auto-check-enable'
  | 'auto-download-enable'
  | 'check'
  | 'download'
  | 'downloaded'
  | 'install'
  | 'idle'

const ERROR_TEXT_CAP = 300
const ERROR_STACK_FRAMES = 4

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

/** electron-updater / node errno codes are strings; HTTP-ish libs sometimes use numbers. */
const codeOf = (error: unknown): string | undefined => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caught value is unknown; only .code is read and undefined is handled
  const { code } = error as { code?: unknown }
  if (typeof code === 'string' && code) return code
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return undefined
}

const describeCause = (cause: unknown): string | undefined => {
  if (cause instanceof Error) {
    const code = codeOf(cause)
    return truncate(`${cause.name}: ${cause.message}${code ? ` (${code})` : ''}`, ERROR_TEXT_CAP)
  }
  return typeof cause === 'string' && cause ? truncate(cause, ERROR_TEXT_CAP) : undefined
}

/**
 * Stack frames only — the `Name: message` header is already carried by errorName /
 * errorMessage, and the shipped field value is capped at 500 chars upstream.
 */
const describeStack = (stack: unknown): string | undefined => {
  if (typeof stack !== 'string') return undefined
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, ERROR_STACK_FRAMES)
  return frames.length > 0 ? truncate(frames.join(' | '), 400) : undefined
}

/**
 * Flatten an updater failure into log fields. Without this, `logger.error('updater
 * error', error)` shipped `{"errorName":"Error"}` and nothing else: the log-ship
 * transport keeps the first string argument as the message and never reads the
 * Error's own message/code (see telemetry/log-ship.ts parseRecord). Field names are
 * chosen against the redaction allowlist — `phase`/`errorCode` pass verbatim, `url`
 * is path-redacted (query string stripped), the rest are text-redacted and capped.
 */
export function describeUpdaterError(
  error: unknown,
  phase: UpdaterErrorPhase
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      phase,
      errorName: 'NonError',
      errorMessage: truncate(String(error), ERROR_TEXT_CAP)
    }
  }

  const source = error as Error & { statusCode?: unknown; url?: unknown; cause?: unknown }
  const status = typeof source.statusCode === 'number' ? source.statusCode : undefined
  const url = typeof source.url === 'string' && source.url ? source.url : undefined
  const code = codeOf(source)
  const cause = describeCause(source.cause)
  const stack = describeStack(source.stack)

  return {
    phase,
    errorName: error.name,
    errorMessage: truncate(error.message, ERROR_TEXT_CAP),
    ...(code ? { errorCode: code } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(url ? { url } : {}),
    ...(cause ? { errorCause: cause } : {}),
    ...(stack ? { errorStack: stack } : {})
  }
}
