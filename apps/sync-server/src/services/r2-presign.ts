import type { Bindings } from '../types'
import { createLogger } from '../lib/logger'
import { encodeObjectKey, presignS3Url } from './sigv4'

const logger = createLogger('R2Presign')

/**
 * Presigned R2 URLs, deployment policy layer (#1836).
 *
 * R2 speaks the S3 protocol on `https://<account>.r2.cloudflarestorage.com`,
 * so a presigned URL is a plain SigV4 presign with region `auto`, service
 * `s3` and payload hash `UNSIGNED-PAYLOAD`. The pure SigV4 chain lives in
 * sigv4.ts (Web Crypto, no dependency to audit) and is pinned byte-for-byte
 * against AWS's published known-answer vector; THIS module owns every policy
 * decision and is the only surface callers may import:
 * - `presignR2Url` derives the path-style R2 address and clamps TTLs to
 *   minutes-scale (MAX_PRESIGN_TTL_SECONDS).
 * - `resolveR2PresignConfig` makes unconfigured deployments degrade
 *   gracefully instead of failing.
 * - `assertPresignKeyInVault` runs before signing as defense in depth.
 *
 * Security posture: a leaked URL exposes only E2E-encrypted ciphertext, but
 * TTLs are still clamped and keys are derived SERVER-SIDE from D1 rows scoped
 * by user + vault — clients only ever send chunk hashes, never key material,
 * so cross-vault scope escapes are structurally impossible.
 */

export const DEFAULT_PRESIGN_TTL_SECONDS = 300
export const MAX_PRESIGN_TTL_SECONDS = 300

export interface R2PresignConfig {
  accessKeyId: string
  secretAccessKey: string
  /** S3 endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  bucket: string
}

/**
 * Resolve the presign credential set from Worker bindings. Any missing piece
 * means this deployment has not opted into direct R2 transfers: callers must
 * degrade gracefully to the proxied blob paths (the production-beta contract),
 * never fail.
 */
export const resolveR2PresignConfig = (
  env: Pick<
    Bindings,
    'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_S3_ENDPOINT' | 'R2_S3_BUCKET'
  >
): R2PresignConfig | null => {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_S3_BUCKET } = env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT || !R2_S3_BUCKET) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(R2_S3_ENDPOINT)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.host) return null
  return {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    // Normalize: a trailing slash would double up in the canonical path.
    endpoint: `${parsed.protocol}//${parsed.host}`,
    bucket: R2_S3_BUCKET
  }
}

/**
 * Defense in depth over the structural scope guarantee: every key handed to
 * the presigner must sit under the authenticated user's vault prefix. Chunk
 * keys already derive from scoped D1 rows, but presigned URLs bypass every
 * other auth check, so the prefix assertion runs immediately before signing.
 */
export const assertPresignKeyInVault = (key: string, userId: string, vaultId: string): void => {
  if (!key.startsWith(`${userId}/vaults/${vaultId}/`)) {
    throw new Error(`presign key outside vault scope: ${key}`)
  }
}

// One-shot per Worker isolate: Workers have no constructor-time "boot", so the
// first request through the server's binding validation plays that role. The
// flag keeps this at one line per isolate instead of one per request.
let presignBootLogged = false

/**
 * Boot-time visibility for the resolved presign credential set (#1836 review).
 *
 * R2_S3_BUCKET must name THE SAME bucket as the STORAGE binding: URLs are
 * signed against the secret while every proxied read/write goes through the
 * binding, so silent drift between the two produces signatures for a bucket
 * the binding never touches — surfacing downstream as confusing wrong-bucket
 * completes instead of anything that points back at configuration.
 *
 * The Workers R2Bucket API exposes no bucket name at runtime, so equality
 * usually cannot be asserted here; when the name happens to be readable a
 * mismatch warns loudly, and otherwise the resolved values are still logged
 * with that coupling requirement stated, so drift is diffable in deployed
 * logs rather than invisible.
 */
export const logPresignConfigAtBoot = (
  env: Pick<
    Bindings,
    'STORAGE' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_S3_ENDPOINT' | 'R2_S3_BUCKET'
  >
): void => {
  if (presignBootLogged) return
  presignBootLogged = true

  const config = resolveR2PresignConfig(env)
  if (!config) {
    // Unconfigured deployments degrade to the proxied paths by contract;
    // nothing to compare and nothing to warn about.
    return
  }

  // Defensive read: not part of the typed R2Bucket surface, but if a runtime
  // ever exposes it we get a real match/mismatch verdict for free.
  const boundBucket = (env.STORAGE as unknown as { name?: unknown } | undefined)?.name
  if (typeof boundBucket === 'string') {
    if (boundBucket === config.bucket) {
      logger.info('presign config matches the STORAGE binding bucket', {
        bucket: config.bucket,
        endpoint: config.endpoint
      })
    } else {
      logger.warn(
        'R2_S3_BUCKET differs from the STORAGE binding bucket — presigned URLs will target a bucket the binding never reads or writes',
        {
          configuredBucket: config.bucket,
          storageBindingBucket: boundBucket,
          endpoint: config.endpoint
        }
      )
    }
    return
  }

  logger.info('presign config resolved; R2_S3_BUCKET must equal the STORAGE binding bucket', {
    bucket: config.bucket,
    endpoint: config.endpoint
  })
}

// ---------------------------------------------------------------------------
// R2 policy layer — path-style addressing + minutes-scale TTL ceiling
// ---------------------------------------------------------------------------

/**
 * Presign one R2 object URL with the deployment TTL policy applied. `now` and
 * `region` are injectable so tests can reproduce fixed-date vectors.
 */
export const presignR2Url = async (
  config: R2PresignConfig,
  options: {
    method: 'GET' | 'PUT'
    key: string
    expiresInSeconds?: number
    now?: Date
    /** R2 signs with region `auto`; override only for known-answer tests. */
    region?: string
  }
): Promise<string> => {
  const expiresInSeconds = Math.min(
    Math.max(Math.floor(options.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS), 1),
    MAX_PRESIGN_TTL_SECONDS
  )

  return presignS3Url({
    host: new URL(config.endpoint).host,
    method: options.method,
    objectPath: `/${encodeObjectKey(config.bucket)}/${encodeObjectKey(options.key)}`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: options.region ?? 'auto',
    expiresInSeconds,
    ...(options.now ? { now: options.now } : {})
  })
}
