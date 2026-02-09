import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  ENVIRONMENT: string
  ALLOWED_ORIGIN?: string
}

const ORIGIN_BY_ENV: Record<string, string[]> = {
  development: ['http://localhost:5173', 'http://localhost:3000'],
  staging: [],
  production: [],
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development'
  const origins = [...(ORIGIN_BY_ENV[env] ?? [])]
  if (c.env.ALLOWED_ORIGIN) {
    origins.push(c.env.ALLOWED_ORIGIN)
  }
  const middleware = cors({ origin: origins })
  return middleware(c, next)
})

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: Date.now()
  })
})

export default app
