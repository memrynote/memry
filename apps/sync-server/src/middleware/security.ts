import type { MiddlewareHandler } from 'hono'
import type { AppContext } from '../types'

export const securityHeaders: MiddlewareHandler<AppContext> = async (c, next) => {
  await next()

  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  // A route that sets its own Cache-Control (public OCR data) keeps it.
  if (!c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'no-store')
  }
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Permitted-Cross-Domain-Policies', 'none')
}
