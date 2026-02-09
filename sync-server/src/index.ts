import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { errorHandler } from './lib/errors'
import { securityHeaders } from './middleware/security'
import type { AppContext } from './types'

const ORIGIN_BY_ENV: Record<string, string[]> = {
  development: ['http://localhost:5173', 'http://localhost:3000'],
  staging: [],
  production: []
}

const app = new Hono<AppContext>()

app.use('*', securityHeaders)

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development'
  const origins = [...(ORIGIN_BY_ENV[env] ?? [])]
  if (c.env.ALLOWED_ORIGIN) {
    origins.push(c.env.ALLOWED_ORIGIN)
  }
  const middleware = cors({ origin: origins })
  return middleware(c, next)
})

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development'
  const requiredSecrets = ['JWT_PUBLIC_KEY', 'JWT_PRIVATE_KEY', 'RESEND_API_KEY'] as const

  for (const key of requiredSecrets) {
    const value = c.env[key]
    const missing = typeof value !== 'string' || value.length === 0

    if (missing && env !== 'development') {
      throw new Error(`Missing required secret: ${key}`)
    }

    if (missing && env === 'development') {
      console.warn(`[dev] Missing secret binding: ${key}`)
    }
  }

  await next()
})

app.onError(errorHandler)

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: Date.now()
  })
)

export default app
