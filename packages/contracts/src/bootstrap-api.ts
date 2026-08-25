import { z } from 'zod'

/**
 * Bootstrap session API (#1837) — the elevated-throughput window a fresh
 * device opens while it pulls an entire vault for the first time.
 *
 * Wire-compat rules (production beta):
 *  - Every field here is ADDITIVE at the protocol level. Old servers never
 *    answer these routes; old clients never call them and never send the
 *    `X-Memry-Bootstrap-Token` header, which every existing server ignores.
 *  - A bootstrap token only ever WIDENS server rate ceilings via the limiter's
 *    elevation seam. A missing/expired/forged token degrades to today's
 *    steady-state behavior byte-for-byte — it can never fail an unrelated
 *    request.
 */

/** Header carrying the bootstrap session token on elevated requests. */
export const BOOTSTRAP_TOKEN_HEADER = 'X-Memry-Bootstrap-Token'

export const BootstrapSessionSchema = z.object({
  /** Opaque signed token; send verbatim in BOOTSTRAP_TOKEN_HEADER. */
  token: z.string().min(1),
  /** Epoch seconds at which the token stops being honored. */
  expiresAt: z.number().int().positive(),
  /** Server TTL for convenience/renewal scheduling; mirrors exp - iat. */
  ttlSeconds: z.number().int().positive()
})

export type BootstrapSession = z.infer<typeof BootstrapSessionSchema>

/**
 * POST /sync/bootstrap — open a session.
 *
 * `manifest` is the FIRST page of the opt-in paginated manifest service
 * (MAX_MANIFEST_PAGE_LIMIT), never the whole vault. `tailCursor` is the
 * current MAX(server_cursor) so the client knows when its pull has caught up.
 * `packs` is RESERVED for #1839/#1840: always present, always empty until the
 * pack pipeline lands, so #1840 plugs in without a protocol change.
 * `attachments` is likewise RESERVED-for-future: an INFORMATIONAL first keyset
 * page of the vault's ciphertext chunk hashes (absent entirely when the
 * deployment cannot presign) — no continuation endpoint ships yet, so clients
 * must not treat it as a complete inventory; real pagination arrives together
 * with the pack pipeline's consumption of chunk hashes (#1840).
 */
export const BootstrapOpenResponseSchema = z.object({
  session: BootstrapSessionSchema,
  manifest: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        version: z.number(),
        modifiedAt: z.number(),
        size: z.number()
      })
    ),
    nextCursor: z.number().optional(),
    serverTime: z.number()
  }),
  tailCursor: z.number().int().nonnegative(),
  attachments: z
    .object({
      chunkHashes: z.array(z.string()),
      /**
       * RESERVED-for-future (#1840 pack pipeline). Names where a continuation
       * page WOULD start; no continuation endpoint exists yet, so this page is
       * informational only and clients must not rely on its completeness for
       * vaults with more chunks than the server's page limit.
       */
      nextChunkCursor: z.string().optional()
    })
    .optional(),
  packs: z.array(z.unknown())
})

export type BootstrapOpenResponse = z.infer<typeof BootstrapOpenResponseSchema>

/** POST /sync/bootstrap/renew — refresh-on-request before expiry. */
export const BootstrapRenewResponseSchema = z.object({
  session: BootstrapSessionSchema
})

export type BootstrapRenewResponse = z.infer<typeof BootstrapRenewResponseSchema>

/** POST /sync/bootstrap/close — explicit teardown (idempotent). */
export const BootstrapCloseResponseSchema = z.object({
  success: z.literal(true)
})
