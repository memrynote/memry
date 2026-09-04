// Some failures are normal states, not faults: Ollama is not running, the user
// walked away from an OAuth consent screen. They still surface to the UI as an
// error envelope, but reporting them as error telemetry drowns the real signal.
//
// The throw site marks such an error; trackMainError skips marked errors. The
// decision lives here — a pure, unit-tested predicate — rather than inline at
// the reporting site (same precedent as childProcessGoneErrorCode returning
// null for a clean idle-worker exit).

const EXPECTED_CONDITION = Symbol.for('memry.telemetry.expectedCondition')

/**
 * Mark an error as an expected condition so it never becomes error telemetry.
 * Returns the same value, so it can wrap a throw. The marker is non-enumerable:
 * it does not change the error's message, JSON shape, or identity.
 */
export const markExpectedCondition = <T>(error: T): T => {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    Object.defineProperty(error, EXPECTED_CONDITION, {
      value: true,
      enumerable: false,
      configurable: true
    })
  }
  return error
}

export const isExpectedConditionError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[EXPECTED_CONDITION] === true
  )

/**
 * Per-file conditions the machine imposes on a watch, not defects in the app.
 *
 * On Windows an antivirus scanner, OneDrive, or any process holding a vault
 * file makes chokidar's watch of that one path fail. EPERM and EACCES are a
 * sharing violation, EBUSY a lock, ENOENT a file deleted between the directory
 * scan and the watch call. In every case the watcher keeps running and keeps
 * watching everything else, so there is nothing for the user to do and nothing
 * for us to fix.
 *
 * Deliberately excludes EMFILE and ENOSPC. Those mean the watch descriptor
 * limit is exhausted and the watcher has genuinely stopped seeing changes,
 * which is a real defect and must stay reportable.
 */
const WATCH_ENVIRONMENT_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT'])

export const isWatchEnvironmentError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && WATCH_ENVIRONMENT_ERROR_CODES.has(code)
}

const MAX_CAUSE_DEPTH = 4

/**
 * True only when a request failed because nothing is listening on the port.
 * Deliberately narrow: ECONNREFUSED means "the service is not running", while
 * ENOTFOUND / ECONNRESET / an HTTP error status mean something is actually
 * misconfigured or broken and must still be reported. undici nests the real
 * cause (sometimes inside an AggregateError for dual-stack localhost), so the
 * cause chain is walked to a bounded depth.
 */
export const isConnectionRefusedError = (error: unknown, depth = 0): boolean => {
  if (!error || typeof error !== 'object' || depth > MAX_CAUSE_DEPTH) return false

  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown }
  if (candidate.code === 'ECONNREFUSED') return true
  if (
    Array.isArray(candidate.errors) &&
    candidate.errors.some((nested) => isConnectionRefusedError(nested, depth + 1))
  ) {
    return true
  }
  return isConnectionRefusedError(candidate.cause, depth + 1)
}
