import { BOOTSTRAP_TOKEN_HEADER } from '@memry/contracts/bootstrap-api'
import type { BootstrapOpenResponse, BootstrapRenewResponse } from '@memry/contracts/bootstrap-api'

import { createLogger } from '../lib/logger'
import {
  clearBootstrapSessionState,
  getBootstrapElevationFactor,
  getBootstrapTokenHeaders,
  setBootstrapSessionState
} from './bootstrap-session-state'
import { postToServer } from './http-client'

const log = createLogger('BootstrapSession')

/**
 * Client bootstrap-mode manager (#1837).
 *
 * A fresh device (no persisted cursor) opens an elevated rate-limit window at
 * the start of its initial full sync: the server answers with a signed
 * session token, the vault manifest summary, the tail cursor and a first page
 * of attachment chunk hashes. While the token is live it rides
 * `X-Memry-Bootstrap-Token` on every authenticated sync request, and the
 * pacing sites (download pacer, CRDT sweep charge) divide their conservative
 * delays by the granted factor.
 *
 * Failure discipline: ANY failure to open/renew/close is silent — the module
 * clears state and sync continues exactly as it did before #1837 existed.
 * The token only ever widens server ceilings; losing it can never lose data.
 */

/** Renew this long before expiry so requests in flight never straddle it. */
const RENEW_LEAD_MS = 5 * 60 * 1000

/** The documented pull-window multiplier until the protocol negotiates one (#1840). */
const DEFAULT_ELEVATION_FACTOR = 5

type GetAccessToken = () => Promise<string | null>

interface OpenResult {
  token: string
  expiresAtMs: number
  elevationFactor: number
  tailCursor: number
}

type FactorListener = (factor: number) => void

let renewalTimer: ReturnType<typeof setTimeout> | null = null
let currentGetAccessToken: GetAccessToken | null = null
const factorListeners = new Set<FactorListener>()

export const onBootstrapElevationChange = (listener: FactorListener): (() => void) => {
  factorListeners.add(listener)
  return () => factorListeners.delete(listener)
}

const notifyFactor = (): void => {
  const factor = getBootstrapElevationFactor()
  for (const listener of factorListeners) {
    try {
      listener(factor)
    } catch {
      // A pacing site that throws in its own callback must not break the rest;
      // nothing here is allowed to break sync.
    }
  }
}

function armRenewal(delayMs: number): void {
  if (renewalTimer) clearTimeout(renewalTimer)
  const wait = Math.max(delayMs - RENEW_LEAD_MS, 30_000)
  renewalTimer = setTimeout(() => {
    renewalTimer = null
    void renew()
  }, wait)
  renewalTimer.unref?.()
}

/**
 * Open a bootstrap session. Returns null when anything says no: the server
 * predates the feature (404), has it unconfigured (501), deems the device
 * already-synced (409), caps concurrent sessions (429), or simply failed.
 */
export async function openBootstrapSession(
  getAccessToken: GetAccessToken
): Promise<OpenResult | null> {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return null
    currentGetAccessToken = getAccessToken

    const body = (await postToServer<Partial<BootstrapOpenResponse>>(
      '/sync/bootstrap',
      undefined,
      accessToken
    )) as Partial<BootstrapOpenResponse> | Record<string, unknown>

    const session = (body as Partial<BootstrapOpenResponse>).session
    const tailCursor = (body as Partial<BootstrapOpenResponse>).tailCursor
    if (
      !session ||
      typeof session.token !== 'string' ||
      typeof session.expiresAt !== 'number' ||
      typeof tailCursor !== 'number'
    ) {
      return null
    }

    const negotiated = (body as { elevationFactor?: unknown }).elevationFactor
    const elevationFactor =
      typeof negotiated === 'number' && Number.isFinite(negotiated) && negotiated >= 1
        ? negotiated
        : DEFAULT_ELEVATION_FACTOR

    setBootstrapSessionState(session.token, session.expiresAt * 1000, elevationFactor)
    armRenewal(session.expiresAt * 1000 - Date.now())
    notifyFactor()

    // RESERVED-for-future (#1840): attachments.chunkHashes is the FIRST keyset
    // page only and purely informational today — there is no continuation
    // endpoint yet, so this must never be treated as a complete chunk
    // inventory. We log the count for observability and nothing else.
    log.info('Bootstrap session opened', {
      expiresAt: session.expiresAt,
      manifestItems: (body as Partial<BootstrapOpenResponse>).manifest?.items?.length ?? 0,
      chunkHashes: (body as Partial<BootstrapOpenResponse>).attachments?.chunkHashes?.length ?? 0,
      packsReserved: Array.isArray((body as Partial<BootstrapOpenResponse>).packs)
        ? ((body as Partial<BootstrapOpenResponse>).packs as unknown[]).length
        : 0
    })

    return {
      token: session.token,
      expiresAtMs: session.expiresAt * 1000,
      elevationFactor,
      tailCursor
    }
  } catch (error) {
    // Silent fallback: 404/501/409/429/network all mean "no bootstrap here".
    log.debug('Bootstrap session unavailable', {
      error: error instanceof Error ? error.message : String(error)
    })
    closeLocalOnly()
    return null
  }
}

async function renew(): Promise<void> {
  try {
    const current = getBootstrapTokenHeaders()['X-Memry-Bootstrap-Token']
    if (!current) return // already closed/expired locally
    const getAccessToken = currentGetAccessToken
    if (!getAccessToken) return
    const accessToken = await getAccessToken()
    if (!accessToken) {
      closeLocalOnly()
      return
    }

    // The header rides automatically via the state module; the body is empty.
    const res = await postToServer<Partial<BootstrapRenewResponse>>(
      '/sync/bootstrap/renew',
      {},
      accessToken
    )
    if (!res.session || typeof res.session.token !== 'string') {
      throw new Error('malformed renew response')
    }
    setBootstrapSessionState(
      res.session.token,
      res.session.expiresAt * 1000,
      getBootstrapElevationFactor()
    )
    armRenewal(res.session.expiresAt * 1000 - Date.now())
    log.info('Bootstrap session renewed', { expiresAt: res.session.expiresAt })
  } catch (error) {
    log.info('Bootstrap session renewal failed — reverting to steady-state pacing', {
      error: error instanceof Error ? error.message : String(error)
    })
    closeLocalOnly()
  }
}

/**
 * Close on completion/failure/vault switch. Clears local state FIRST (pacing
 * reverts immediately, before any network round trip), then tells the server
 * best-effort so the per-user concurrency slot frees up for other devices.
 */
export async function closeBootstrapSession(
  reason: 'completed' | 'failed' | 'vault_switch' | 'expired'
): Promise<void> {
  // Capture the token BEFORE clearing local state: pacing must revert this
  // instant, but the server's /close still needs the header to identify the
  // session whose ledger row to drop.
  const captured = getBootstrapTokenHeaders()['X-Memry-Bootstrap-Token']
  closeLocalOnly()
  if (!captured || !currentGetAccessToken) return
  try {
    const accessToken = await currentGetAccessToken()
    if (!accessToken) return
    await postToServer('/sync/bootstrap/close', {}, accessToken, undefined, {
      [BOOTSTRAP_TOKEN_HEADER]: captured
    })
    log.info('Bootstrap session closed', { reason })
  } catch (error) {
    // The token dies on its own TTL; a lost close request is harmless.
    log.debug('Bootstrap close request failed (harmless)', {
      reason,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function closeLocalOnly(): void {
  if (renewalTimer) {
    clearTimeout(renewalTimer)
    renewalTimer = null
  }
  clearBootstrapSessionState()
  notifyFactor()
}

/** Test seam + dispose path: drop everything without a server round trip. */
export function abandonBootstrapSession(): void {
  closeLocalOnly()
}
