import {
  diagnosticsApi,
  feedbackService,
  localeService,
  onLocaleChanged,
  telemetryService
} from '../services/app-services'
import {
  onSettingsChanged,
  onSettingsOpenRequested,
  settingsService
} from '../services/settings-service'

/**
 * What Step 09 (#3526) puts on `window.api`: settings, language, telemetry, feedback and
 * diagnostics, each over its Rust commands. Callers keep the Electron names. Other domains
 * replace the rest as they port; Step 43 (#3560) deletes this file once every caller imports
 * its service.
 */
const ported: Record<string, unknown> = {
  settings: settingsService,
  locale: localeService,
  telemetry: telemetryService,
  feedback: feedbackService,
  diagnostics: diagnosticsApi,
  onSettingsChanged,
  onSettingsOpenRequested,
  onLocaleChanged
}

export interface PortedApiHost {
  api?: unknown
}

/**
 * Defines `window.api` as the ported domains, falling through to whatever was there (the
 * not-ported shim of the development build). Call it after `installNotPortedShim`.
 */
export function installPortedApi(target: PortedApiHost = window): void {
  const previous = target.api
  const fallback = typeof previous === 'function' || typeof previous === 'object' ? previous : null
  const api = new Proxy(fallback ?? {}, {
    get(base, property, receiver) {
      if (typeof property === 'string' && property in ported) return ported[property]
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a layering proxy resolves arbitrary property keys by definition
      return Reflect.get(base, property, receiver)
    },
    has(base, property) {
      return (typeof property === 'string' && property in ported) || property in base
    }
  })
  Object.defineProperty(target, 'api', { value: api, configurable: true, writable: true })
}
