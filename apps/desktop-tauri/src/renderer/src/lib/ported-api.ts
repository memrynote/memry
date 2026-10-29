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
 * its service. The window functions of Step 10 (#3527) are imported from
 * `services/window-service` and are not on `window.api`.
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
/**
 * A ported domain that only covers some of its Electron names (settings leaves AI, calendar,
 * voice, terminal and global-shortcut functions to later steps): a name it lacks resolves on
 * the layer below, so the call rejects with `NotPortedError` instead of throwing synchronously
 * on `undefined`.
 */
function withFallback(domain: unknown, below: unknown): unknown {
  if (typeof domain !== 'object' || domain === null || below === null || below === undefined) {
    return domain
  }
  return new Proxy(domain, {
    get(target, property, receiver) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a layering proxy resolves arbitrary property keys by definition
      if (property in target) return Reflect.get(target, property, receiver)
      // oxlint-disable-next-line anti-slop/no-reflect-get -- same layering proxy
      return Reflect.get(Object(below), property)
    }
  })
}

export function installPortedApi(target: PortedApiHost = window): void {
  const previous = target.api
  const fallback = typeof previous === 'function' || typeof previous === 'object' ? previous : null
  const api = new Proxy(fallback ?? {}, {
    get(base, property, receiver) {
      if (typeof property === 'string' && property in ported) {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- same layering proxy
        return withFallback(ported[property], Reflect.get(base, property, receiver))
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a layering proxy resolves arbitrary property keys by definition
      return Reflect.get(base, property, receiver)
    },
    has(base, property) {
      return (typeof property === 'string' && property in ported) || property in base
    }
  })
  Object.defineProperty(target, 'api', { value: api, configurable: true, writable: true })
}
