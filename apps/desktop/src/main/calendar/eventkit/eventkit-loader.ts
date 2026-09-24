import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { createLogger } from '../../lib/logger'
import type { EventKitBridge } from './eventkit-types'

const log = createLogger('Calendar:EventKitLoader')

const HELPER_NAME = 'memry-eventkit'

export type EventKitBridgeLoad =
  | { status: 'available'; bridge: EventKitBridge }
  /** Windows or Linux: the bridge does not exist there and is never loaded. */
  | { status: 'unsupported_platform' }
  /** macOS, but the helper is missing or would not load. The rest of the app carries on. */
  | { status: 'unavailable'; reason: string }

/**
 * Where the helper lives. Packaged: next to the app executable in
 * `Contents/MacOS`, placed there by `mac.extraFiles`. Development: the output
 * of `pnpm --filter @memry/desktop build:eventkit`.
 */
function resolveHelperPath(): string {
  const override = process.env.MEMRY_EVENTKIT_HELPER
  if (override) return override
  if (app.isPackaged) return path.join(path.dirname(app.getPath('exe')), HELPER_NAME)
  return path.join(app.getAppPath(), 'native', 'eventkit', 'bin', HELPER_NAME)
}

let loading: Promise<EventKitBridgeLoad> | null = null

async function load(): Promise<EventKitBridgeLoad> {
  const helperPath = resolveHelperPath()
  if (!existsSync(helperPath)) {
    log.warn('EventKit helper not found', { helperPath })
    return { status: 'unavailable', reason: 'helper_missing' }
  }
  // Lazy on purpose, the documented exception to "no inline imports" (#1405):
  // the bridge must never load on Windows or Linux, so it is only reached
  // after the darwin check in loadEventKitBridge(). No module imports it at
  // the top level.
  const { createEventKitBridge } = await import('./eventkit-bridge')
  return { status: 'available', bridge: createEventKitBridge({ command: helperPath }) }
}

/**
 * The macOS Calendar bridge, loaded on first use. Off macOS this answers
 * `unsupported_platform` without loading anything. A failed load reports
 * `unavailable` and is retried on the next call rather than cached.
 */
export function loadEventKitBridge(
  platform: NodeJS.Platform = process.platform
): Promise<EventKitBridgeLoad> {
  if (platform !== 'darwin') return Promise.resolve({ status: 'unsupported_platform' })
  if (!loading) {
    const attempt: Promise<EventKitBridgeLoad> = load().catch((error: unknown) => {
      log.warn('EventKit bridge failed to load', error)
      return { status: 'unavailable', reason: 'load_failed' }
    })
    loading = attempt.then((result) => {
      if (result.status !== 'available') loading = null
      return result
    })
  }
  return loading
}

/** Drop the loaded bridge and stop its helper. The next load starts over. */
export async function disposeEventKitBridge(): Promise<void> {
  const current = loading
  loading = null
  if (!current) return
  const result = await current
  if (result.status === 'available') result.bridge.dispose()
}
