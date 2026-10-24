import type { AppUpdateState } from '@memry/contracts/ipc-updater'

/**
 * What the update surfaces are allowed to say, derived once from the raw updater
 * state. Every surface (sidebar row, popover, settings row) reads this instead of
 * branching on `UpdaterStatus`, so "is there something to show, and what" is
 * answered in one place rather than re-derived — differently — per component.
 */
export type UpdatePresentation =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string | null }
  | { kind: 'failed'; version: string | null }

function clampPercent(percent: number | null): number | null {
  if (percent == null || Number.isNaN(percent)) return null
  return Math.max(0, Math.min(100, percent))
}

/**
 * Rules, in precedence order:
 *   - updates unsupported (dev builds, unpackaged) → nothing to say
 *   - installing wins over everything; the app is on its way out
 *   - a failed install wins over the next update; recovery comes first
 *   - available / downloading stay silent while auto-download is on, because the
 *     app is doing the work itself and there is nothing for the user to decide
 *   - a phase that cannot name its version is not shown at all
 */
export function toUpdatePresentation(state: AppUpdateState): UpdatePresentation {
  if (!state.updateSupported) return { kind: 'hidden' }

  if (state.status === 'installing') {
    return { kind: 'installing', version: state.availableVersion }
  }

  if (state.installFailed) {
    return { kind: 'failed', version: state.installFailed.version }
  }

  const version = state.availableVersion

  switch (state.status) {
    case 'available':
      if (state.autoDownloadEnabled || !version) return { kind: 'hidden' }
      return { kind: 'available', version }
    case 'downloading':
      if (state.autoDownloadEnabled || !version) return { kind: 'hidden' }
      return { kind: 'downloading', version, percent: clampPercent(state.downloadProgressPercent) }
    case 'downloaded':
      if (!version) return { kind: 'hidden' }
      return { kind: 'ready', version }
    default:
      return { kind: 'hidden' }
  }
}
