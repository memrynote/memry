import { Hono } from 'hono'

import { BOOTSTRAP_TOKEN_HEADER } from '@memry/contracts/bootstrap-api'
import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { clientGateMiddleware } from '../middleware/client-gate'
import { paidSyncMiddleware } from '../middleware/paid-sync'
import { syncTypesMiddleware } from '../middleware/sync-types'
import { createRateLimiter, deviceIdentifier } from '../middleware/rate-limit'
import {
  closeBootstrapSession,
  openBootstrapSession,
  renewBootstrapSession
} from '../services/bootstrap-session'
import { getManifest, MAX_MANIFEST_PAGE_LIMIT } from '../services/sync'
import { resolveR2PresignConfig } from '../services/r2-presign'
import type { AppContext } from '../types'

/**
 * Bootstrap session endpoints (#1837).
 *
 * Mounted alongside /sync/blob as a second router on `/sync` because these
 * routes must carry their own middleware stack (Hono's `use('*')` inside one
 * router does not leak into another) and because they sit behind the same
 * paid-sync gate as everything else in the vault pull path.
 *
 * Compat: old servers never mount these routes (404); new clients treat any
 * open failure as "no bootstrap" and fall back silently to steady-state
 * pacing. Nothing about an existing route changes.
 */

export const bootstrap = new Hono<AppContext>()

bootstrap.use('*', authMiddleware)
bootstrap.use('*', clientGateMiddleware)
bootstrap.use('*', paidSyncMiddleware)
bootstrap.use('*', syncTypesMiddleware)

// Open/renew/close are once-per-run operations, not hot-path traffic — the
// elevation itself lives on the regular sync buckets. Device-keyed like the
// CRDT buckets, since eligibility is per device.
const bootstrapSessionLimit = createRateLimiter({
  keyPrefix: 'bootstrap_session',
  maxRequests: 30,
  windowSeconds: 60,
  identifier: deviceIdentifier
})

/** First keyset page of chunk hashes handed to the client for batch presigning. */
const CHUNK_HASH_PAGE_LIMIT = 512

const requireSecret = (secret: string | undefined): string => {
  if (!secret) {
    // Typed, permanent signal — mirrors STORAGE_PRESIGN_UNAVAILABLE. Clients
    // treat this (and any failure) as "bootstrap not available here".
    throw new AppError(
      ErrorCodes.BOOTSTRAP_UNAVAILABLE,
      'Bootstrap sessions are not configured on this deployment',
      501
    )
  }
  return secret
}

const readSessionToken = (token: string | undefined): string => {
  if (!token) {
    throw new AppError(
      ErrorCodes.BOOTSTRAP_SESSION_INVALID,
      `Missing ${BOOTSTRAP_TOKEN_HEADER} header`,
      401
    )
  }
  return token
}

bootstrap.post('/', bootstrapSessionLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const secret = requireSecret(c.env.BOOTSTRAP_SESSION_HMAC_KEY)

  const { session, token } = await openBootstrapSession(c.env.DB, secret, {
    userId,
    deviceId,
    vaultId
  })

  // FIRST PAGE of the opt-in paginated manifest service — never all rows.
  const manifest = await getManifest(c.env.DB, userId, vaultId, c.get('syncTypes')!, {
    cursor: 0,
    limit: MAX_MANIFEST_PAGE_LIMIT
  })

  const tailRow = await c.env.DB.prepare(
    'SELECT MAX(server_cursor) AS max_cursor FROM sync_items WHERE user_id = ? AND vault_id = ?'
  )
    .bind(userId, vaultId)
    .first<{ max_cursor: number | null }>()

  // Attachment chunks overview: hash page only — URLs come from the existing
  // presign-batch endpoint (≤1024 per call), which keeps THIS response bounded
  // no matter how attachment-heavy the vault is. Absent entirely on
  // deployments without R2 presign credentials (#1836 graceful degradation).
  let attachments: { chunkHashes: string[]; nextChunkCursor?: string } | undefined
  if (resolveR2PresignConfig(c.env)) {
    const page = await c.env.DB.prepare(
      `SELECT hash FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash > ?
       ORDER BY hash LIMIT ?`
    )
      .bind(userId, vaultId, '', CHUNK_HASH_PAGE_LIMIT + 1)
      .all<{ hash: string }>()
    const rows = page.results ?? []
    const hasMore = rows.length > CHUNK_HASH_PAGE_LIMIT
    const pageRows = hasMore ? rows.slice(0, CHUNK_HASH_PAGE_LIMIT) : rows
    attachments = {
      chunkHashes: pageRows.map((row) => row.hash),
      ...(hasMore && pageRows.length > 0
        ? { nextChunkCursor: pageRows[pageRows.length - 1]!.hash }
        : {})
    }
  }

  // RESERVED for #1839/#1840 (vault packs). Always present and empty until the
  // pack pipeline lands, so #1840 plugs in without a protocol change.
  return c.json({
    session: {
      token,
      expiresAt: session.expiresAt,
      ttlSeconds: session.expiresAt - Math.floor(Date.now() / 1000)
    },
    manifest,
    tailCursor: tailRow?.max_cursor ?? 0,
    ...(attachments ? { attachments } : {}),
    packs: []
  })
})

bootstrap.post('/renew', bootstrapSessionLimit, async (c) => {
  const secret = requireSecret(c.env.BOOTSTRAP_SESSION_HMAC_KEY)
  const { session, token } = await renewBootstrapSession(
    c.env.DB,
    secret,
    readSessionToken(c.req.header(BOOTSTRAP_TOKEN_HEADER))
  )
  return c.json({
    session: {
      token,
      expiresAt: session.expiresAt,
      ttlSeconds: session.expiresAt - Math.floor(Date.now() / 1000)
    }
  })
})

bootstrap.post('/close', bootstrapSessionLimit, async (c) => {
  const secret = requireSecret(c.env.BOOTSTRAP_SESSION_HMAC_KEY)
  await closeBootstrapSession(
    c.env.DB,
    secret,
    readSessionToken(c.req.header(BOOTSTRAP_TOKEN_HEADER))
  )
  return c.json({ success: true })
})
