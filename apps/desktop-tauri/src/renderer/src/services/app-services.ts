import type { Locale, LocaleApi } from '@memry/contracts/locale-api'
import { FALLBACK_LOCALE, LocaleSchema } from '@memry/contracts/locale-api'
import { DiagnosticReportSchema } from '@memry/contracts/diagnostics-api'
import type { DiagnosticsClientAPI, FeedbackClientAPI, TelemetryClientAPI } from '@memry/rpc'
import { commands, events } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

function message(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : String(error)
}

/** Every Electron telemetry call resolved with `{ success, error }`; a rejection never reaches the UI. */
async function outcome(run: () => Promise<unknown>): Promise<{ success: boolean; error?: string }> {
  try {
    await run()
    return { success: true }
  } catch (error) {
    return { success: false, error: message(error) }
  }
}

export const localeService: LocaleApi = {
  get: async () => LocaleSchema.parse(await commands.localeGet()),
  set: async (locale) => {
    await commands.localeSet(locale)
  },
  list: async () =>
    (await commands.localeList()).flatMap((l) => {
      const parsed = LocaleSchema.safeParse(l)
      return parsed.success ? [parsed.data] : []
    }),
  getStartupSync: () => {
    const parsed = LocaleSchema.safeParse(window.__MEMRY_STARTUP__?.locale)
    return parsed.success ? parsed.data : FALLBACK_LOCALE
  }
}

export function onLocaleChanged(callback: (locale: Locale) => void): () => void {
  return subscribeToEvent(events.localeChangedEvent, (event) => {
    const parsed = LocaleSchema.safeParse(event.locale)
    if (parsed.success) callback(parsed.data)
  })
}

export const telemetryService: TelemetryClientAPI = {
  track: (event) => outcome(() => commands.telemetryTrack(event)),
  flush: async () => {
    try {
      const result = await commands.telemetryFlush()
      const { error, ...rest } = result
      return error === null ? rest : { ...rest, error }
    } catch (error) {
      return { success: false, attempted: 0, accepted: 0, error: message(error) }
    }
  },
  getSettings: () => commands.telemetryGetSettings(),
  setEnabled: (enabled) => outcome(() => commands.telemetrySetEnabled(enabled)),
  setAutoSendDiagnostics: (enabled) =>
    outcome(() => commands.telemetrySetAutoSendDiagnostics(enabled))
}

export const feedbackService: FeedbackClientAPI = {
  submit: async (input) => {
    const result = await commands.feedbackSubmit(input)
    return result.error === null ? { success: result.success } : { ...result, error: result.error }
  }
}

export const diagnosticsApi: DiagnosticsClientAPI = {
  previewReport: async (trigger): ReturnType<DiagnosticsClientAPI['previewReport']> => {
    const preview = await commands.diagnosticsPreviewReport(trigger)
    if (!preview.success || preview.report === null) {
      return { success: false, error: preview.error ?? 'report unavailable' }
    }
    // The wire type is looser than the contract (plain strings); Rust builds it from the same
    // schema, and a mismatch surfaces here as a failed preview rather than a bad report.
    const parsed = DiagnosticReportSchema.safeParse(preview.report)
    return parsed.success
      ? { success: true, report: parsed.data }
      : { success: false, error: 'report did not match the diagnostics contract' }
  },
  sendReport: async (report): ReturnType<DiagnosticsClientAPI['sendReport']> => {
    const sent = await commands.diagnosticsSendReport(report)
    return sent.success && sent.incidentId !== null
      ? { success: true, incidentId: sent.incidentId }
      : { success: false, error: sent.error ?? 'report not sent' }
  }
}
