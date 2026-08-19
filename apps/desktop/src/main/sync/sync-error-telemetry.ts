// The telemetry half of a sync failure.
//
// `classifyError` has always computed the status, the server's error code, the
// retryable verdict and a message — and every emitter forwarded only
// `category`, so `sync_error` shipped one opaque `server_error` label covering
// 400, 403, 404, 409 and every 5xx alike, with `"message":""` in the log body.
// Two unrelated root causes shared that bucket for 48 hours and were only
// separable by hand-joining sync-server logs (#1584).
//
// This module is the one place that turns a classified failure into the fields
// `trackMainEvent` ships, so a new emitter cannot forget half of them.
import { redactText } from '@memry/contracts/redact'
import type { TelemetryEvent } from '@memry/contracts/telemetry-api'

import { getMainRedactOptions } from '../telemetry/redact-options'

import { classifyError, type SyncErrorInfo } from './sync-errors'

// TelemetryErrorDetailSchema.message caps at 512 chars, and the sync-server
// rejects an ENTIRE batch when one event fails validation — so the cap is
// applied here, not hoped for.
const MAX_MESSAGE_CHARS = 512

export interface SyncErrorTelemetryFields {
  errorCode: string
  failure?: TelemetryEvent['failure']
  error?: TelemetryEvent['error']
}

/**
 * A sync error message can be anything the sync path threw — a server string, a
 * filesystem error carrying a vault path, an error naming a note. It therefore
 * goes through `redactText` with the main process's salted options (the same
 * ones diagnostics and log shipping use, so placeholders correlate across an
 * incident) before it can leave the device. Never throws: every caller is
 * already on an error path.
 */
const safeMessage = (message: string): string | undefined => {
  if (!message) return undefined
  try {
    const redacted = redactText(message, getMainRedactOptions())
    return redacted ? redacted.slice(0, MAX_MESSAGE_CHARS) : undefined
  } catch {
    return undefined
  }
}

/**
 * Spread into a `trackMainEvent('sync_error', …)` call to ship the category
 * alongside the facts that make it actionable: the HTTP status, the server's
 * structured code, whether the failure was classified retryable, and a
 * redacted message.
 */
export const syncErrorTelemetry = (info: SyncErrorInfo): SyncErrorTelemetryFields => {
  const failure: NonNullable<TelemetryEvent['failure']> = { retryable: info.retryable }
  if (info.statusCode !== undefined) failure.httpStatus = info.statusCode
  if (info.serverCode) failure.serverCode = info.serverCode

  const message = safeMessage(info.message)
  return {
    errorCode: info.category,
    failure,
    ...(message ? { error: { message } } : {})
  }
}

/**
 * Same, for the call sites that hold the raw error rather than a classified
 * one. Falls back to the bare `unknown` code if classification itself throws —
 * telemetry must never break the failure path it is reporting on.
 */
export const syncErrorTelemetryFor = (error: unknown): SyncErrorTelemetryFields => {
  try {
    return syncErrorTelemetry(classifyError(error))
  } catch {
    return { errorCode: 'unknown' }
  }
}
