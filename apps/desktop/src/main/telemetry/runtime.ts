import { randomUUID } from 'node:crypto'

import { app, net } from 'electron'

import type {
  TelemetryAuthState,
  TelemetryBuildChannel,
  TelemetryEvent,
  TelemetryPlatform,
  TelemetrySyncState
} from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import {
  createTelemetryClient,
  TELEMETRY_BATCH_LIMIT,
  TELEMETRY_QUEUE_LIMIT,
  type TelemetryClient,
  type TelemetryClientContext,
  type TelemetryFetch,
  type TelemetryFlushReason,
  type TelemetryFlushResult
} from './client'
import { mergeTelemetryConfig, readTelemetryConfig } from './config'
import { getOrCreateInstallId } from './install-id'

const logger = createLogger('TelemetryRuntime')

const PRODUCTION_DEFAULT_ENDPOINT = 'https://sync.memrynote.com/telemetry/batch'
const DEV_DEFAULT_SYNC_SERVER = 'http://localhost:8787'
const FLUSH_INTERVAL_MS = 30_000

export interface TelemetryRuntimeDeps {
  installId?: string
  sessionId?: string
  fetch?: TelemetryFetch
  endpoint?: string
  buildChannel?: TelemetryBuildChannel
  initialEnabled?: boolean
  platform?: TelemetryPlatform
  arch?: string
  appVersion?: string
  locale?: string
  timezoneOffsetMinutes?: number
  authStateProvider?: () => TelemetryAuthState
  syncStateProvider?: () => TelemetrySyncState
  accessTokenProvider?: () => Promise<string | null>
  /** Disable internal flush interval (used in tests) */
  flushIntervalMs?: number | null
  /** Absolute path of the event queue's crash-durable mirror; omitted → memory only. */
  persistPath?: string
}

export interface TelemetryRuntime {
  context: TelemetryClientContext
  client: TelemetryClient
  track(event: TelemetryEvent): void
  flush(reason: TelemetryFlushReason): Promise<TelemetryFlushResult>
  setEnabled(enabled: boolean): void
  getSettings(): { enabled: boolean }
  dispose(): Promise<void>
}

let runtimeInstance: TelemetryRuntime | null = null

const detectBuildChannel = (override?: TelemetryBuildChannel): TelemetryBuildChannel => {
  if (override) return override
  const fromEnv = process.env.MEMRY_BUILD_CHANNEL
  if (fromEnv === 'staging' || fromEnv === 'production' || fromEnv === 'development') {
    return fromEnv
  }
  // NODE_ENV is undefined at runtime in packaged Electron (the vite define is
  // renderer-only), so isPackaged is the only reliable production signal here.
  return app.isPackaged ? 'production' : 'development'
}

const detectPlatform = (override?: TelemetryPlatform): TelemetryPlatform => {
  if (override) return override
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'linux'
}

const resolveEndpoint = (override?: string, channel?: TelemetryBuildChannel): string => {
  if (override) return override
  const fromEnv = process.env.TELEMETRY_ENDPOINT
  if (fromEnv && fromEnv.length > 0) return fromEnv

  const syncServer = process.env.SYNC_SERVER_URL
  if (syncServer && syncServer.length > 0) {
    return `${syncServer.replace(/\/$/, '')}/telemetry/batch`
  }

  if (channel === 'production') return PRODUCTION_DEFAULT_ENDPOINT
  return `${DEV_DEFAULT_SYNC_SERVER}/telemetry/batch`
}

const computeInitialEnabled = (
  storedEnabled: boolean | undefined,
  override: boolean | undefined,
  channel: TelemetryBuildChannel
): boolean => {
  if (typeof override === 'boolean') return override
  if (typeof storedEnabled === 'boolean') return storedEnabled
  if (process.env.MEMRY_TELEMETRY_ENABLED === 'true') return true
  return channel === 'production'
}

const wrapFetch = (custom?: TelemetryFetch): TelemetryFetch => {
  if (custom) return custom
  return async (input, init) => {
    const response = await net.fetch(input.toString(), init)
    return response
  }
}

export const initializeTelemetryRuntime = (deps?: TelemetryRuntimeDeps): TelemetryRuntime => {
  if (runtimeInstance) return runtimeInstance

  const channel = detectBuildChannel(deps?.buildChannel)
  const installId = deps?.installId ?? getOrCreateInstallId()
  const sessionId = deps?.sessionId ?? randomUUID()
  const platform = detectPlatform(deps?.platform)
  const stored = readTelemetryConfig()
  const initialEnabled = computeInitialEnabled(stored.enabled, deps?.initialEnabled, channel)
  const endpoint = resolveEndpoint(deps?.endpoint, channel)

  const context: TelemetryClientContext = {
    installId,
    sessionId,
    appVersion: deps?.appVersion ?? '0.0.0',
    buildChannel: channel,
    platform,
    arch: deps?.arch ?? process.arch,
    locale: deps?.locale ?? 'en',
    timezoneOffsetMinutes: deps?.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset()
  }

  const client = createTelemetryClient({
    fetch: wrapFetch(deps?.fetch),
    endpoint,
    context,
    initialEnabled,
    getAuthState: deps?.authStateProvider ?? (() => 'anonymous'),
    getSyncState: deps?.syncStateProvider ?? (() => 'unknown'),
    getAccessToken: deps?.accessTokenProvider,
    persistPath: deps?.persistPath
  })

  if (initialEnabled) {
    client.track({
      id: randomUUID(),
      name: 'app_started',
      occurredAt: new Date().toISOString(),
      surface: 'app',
      action: 'started',
      result: 'success'
    })
  }

  const currentVersion = context.appVersion
  if (initialEnabled && stored.lastRunVersion && stored.lastRunVersion !== currentVersion) {
    client.track({
      id: randomUUID(),
      name: 'app_update_installed',
      occurredAt: new Date().toISOString(),
      surface: 'updater',
      action: 'installed',
      result: 'success',
      dimensions: { from_version: stored.lastRunVersion }
    })
  }
  if (stored.lastRunVersion !== currentVersion) {
    mergeTelemetryConfig({ lastRunVersion: currentVersion })
  }

  let flushTimer: ReturnType<typeof setInterval> | null = null
  const intervalMs = deps?.flushIntervalMs ?? FLUSH_INTERVAL_MS
  if (intervalMs && Number.isFinite(intervalMs) && intervalMs > 0) {
    flushTimer = setInterval(() => {
      void client.flush('interval').catch((error) => {
        logger.warn('Scheduled telemetry flush failed', { error })
      })
    }, intervalMs)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  runtimeInstance = {
    context,
    client,
    track: (event) => client.track(event),
    flush: (reason) => client.flush(reason),
    setEnabled: (enabled) => {
      client.setEnabled(enabled)
      mergeTelemetryConfig({ enabled })
    },
    getSettings: () => client.getSettings(),
    dispose: async () => {
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      // One flush sends at most TELEMETRY_BATCH_LIMIT events, but a session can
      // queue up to TELEMETRY_QUEUE_LIMIT — a single shutdown flush silently
      // dropped everything past the first batch. Drain in bounded rounds,
      // stopping at the first failure so an offline quit never stalls.
      const maxRounds = Math.ceil(TELEMETRY_QUEUE_LIMIT / TELEMETRY_BATCH_LIMIT)
      for (let round = 0; round < maxRounds && client.getQueueDepth() > 0; round++) {
        const result = await client
          .flush('shutdown')
          .catch((): TelemetryFlushResult => ({ success: false, attempted: 0, accepted: 0 }))
        if (!result.success) break
      }
      runtimeInstance = null
    }
  }

  return runtimeInstance
}

export const getTelemetryRuntime = (): TelemetryRuntime | null => runtimeInstance

export const disposeTelemetryRuntime = async (): Promise<void> => {
  if (runtimeInstance) {
    await runtimeInstance.dispose()
  }
}
