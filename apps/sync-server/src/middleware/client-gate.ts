import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { CLIENT_HEADER, parseClientIdentity } from '../lib/client-identity'
import { ErrorCodes } from '../lib/errors'
import { evaluateWriteAccess, getClientPolicy } from '../services/client-policies'
import type { AppContext } from '../types'

// GET/HEAD/OPTIONS are reads. Reads are NEVER gated -- neither by the version
// floor nor by the kill switch -- so a device dropped to read-only can still
// open every note it owns (FR-010). Anything else mutates and goes through the
// policy check.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Per-platform write gate (contracts/sync-protocol-additions.md §1-3).
 *
 * Parsing and gating live in ONE middleware on purpose. Splitting them meant a
 * router could be mounted with the gate but without the parser, which fails
 * open silently -- writes stop being gated and status stops reporting policy,
 * with nothing red to show for it.
 *
 * The envelope stays the project's `{ error: { code, message } }` so existing
 * clients keep reading `error.code`; `minVersion` rides inside that object
 * rather than at the top level as the contract sketch had it.
 */
export const clientGateMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  // Parsing is unconditional and never rejects: downstream handlers read the
  // identity for write attribution and for the policy echo on status, both of
  // which must work on read requests too.
  const identity = parseClientIdentity(c.req.header(CLIENT_HEADER))
  if (identity) c.set('client', identity)

  if (READ_METHODS.has(c.req.method)) return next()

  // No header = legacy desktop = full access. This is the branch every
  // currently-shipped build takes, and it must stay free of DB work.
  if (!identity) return next()

  const policy = await getClientPolicy(c.env.DB, identity.platform)
  const access = evaluateWriteAccess(policy, identity.version)
  if (access.allowed) return next()

  if (access.reason === 'kill_switch') {
    return c.json(
      {
        error: {
          code: ErrorCodes.PLATFORM_WRITES_DISABLED,
          message: `Writes from ${identity.platform} are temporarily disabled.`
        }
      },
      403 as ContentfulStatusCode
    )
  }

  return c.json(
    {
      error: {
        code: ErrorCodes.CLIENT_UPGRADE_REQUIRED,
        message: `This version can no longer write. Update to ${access.minVersion} or later.`,
        minVersion: access.minVersion
      }
    },
    426 as ContentfulStatusCode
  )
}
