import type { MiddlewareHandler } from 'hono'

import { resolveSyncTypes, SYNC_TYPES_HEADER } from '../lib/sync-types'
import type { AppContext } from '../types'

/**
 * Resolve which item types this client can safely receive.
 *
 * Mirrors the X-Memry-Vault-Id pattern: read the header once here, and let
 * handlers read the resolved value off the context.
 */
export const syncTypesMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('syncTypes', resolveSyncTypes(c.req.header(SYNC_TYPES_HEADER)))
  await next()
}
