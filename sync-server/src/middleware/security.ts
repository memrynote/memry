import type { MiddlewareHandler } from 'hono'
import type { AppContext } from '../types'

export const securityHeaders: MiddlewareHandler<AppContext> = async (c, next) => {
  await next()

  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
}
