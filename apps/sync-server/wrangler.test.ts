import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('wrangler config', () => {
  it('defines required entrypoint, bindings, and durable objects', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    expect(toml).toContain('main = "src/index.ts"')
    expect(toml).toContain('compatibility_date = "2025-01-01"')

    expect(toml).toContain('binding = "DB"')
    expect(toml).toContain('binding = "STORAGE"')

    expect(toml).toContain('{ name = "USER_SYNC_STATE", class_name = "UserSyncState" }')
    expect(toml).toContain('{ name = "LINKING_SESSION", class_name = "LinkingSession" }')
    expect(toml).toContain('{ name = "RATE_LIMITER", class_name = "RateLimiter" }')
    expect(toml).toContain('new_sqlite_classes = ["UserSyncState", "LinkingSession"]')
    expect(toml).toContain('new_sqlite_classes = ["RateLimiter"]')
  })

  it('binds the RateLimiter durable object in every environment', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    // Deploys go through GitHub Actions with --env staging / --env production;
    // env durable_objects blocks are NOT inherited from the top level, so a
    // missing entry here means the limiter 500s every request in that env.
    const bindingLine = '{ name = "RATE_LIMITER", class_name = "RateLimiter" }'
    const occurrences = toml.split(bindingLine).length - 1
    expect(occurrences).toBe(3)
  })

  it('schedules both the cleanup sweep and the daily release download pull', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    // The daily entry must not coincide with a 6-hourly one, or the two triggers
    // collapse into a single invocation and the download sync stops running.
    expect(toml).toContain('crons = ["0 */6 * * *", "0 4 * * *"]')
  })

  it('defines environment-specific deployment sections', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    expect(toml).toContain('[env.staging]')
    expect(toml).toContain('name = "memry-sync-server-staging"')
    expect(toml).toContain('[env.staging.vars]')
    expect(toml).toContain('ENVIRONMENT = "staging"')
    expect(toml).toContain('PADDLE_ENVIRONMENT = "sandbox"')

    expect(toml).toContain('[env.production]')
    expect(toml).toContain('name = "memry-sync-server-production"')
    expect(toml).toContain('[env.production.vars]')
    expect(toml).toContain('ENVIRONMENT = "production"')
    expect(toml).toContain('PADDLE_ENVIRONMENT = "production"')
  })

  it('routes staging and production workers to separate sync hostnames', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    expect(toml).toMatch(
      /\[\[env\.staging\.routes\]\][\s\S]*?pattern = "sync-staging\.memrynote\.com\/\*"[\s\S]*?zone_name = "memrynote\.com"/
    )
    expect(toml).toMatch(
      /\[\[env\.production\.routes\]\][\s\S]*?pattern = "sync\.memrynote\.com\/\*"[\s\S]*?zone_name = "memrynote\.com"/
    )
  })

  // Pack compaction queue (#1839). Like durable_objects, env-level bindings are
  // NOT inherited from the top level: a missing producer binding makes every
  // enqueue silently no-op (packs never build), and a missing consumer means
  // messages pile up unconsumed. All three blocks must therefore wire both.
  it('binds the pack compaction queue producer in the top level and every environment', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    const producerBlock = (queueName: string): string =>
      `[[queues.producers]]\nbinding = "PACK_QUEUE"\nqueue = "${queueName}"`
    expect(toml).toContain(producerBlock('memry-pack-compaction-dev'))
    expect(toml).toContain('[[env.staging.queues.producers]]\nbinding = "PACK_QUEUE"')
    expect(toml).toContain('[[env.production.queues.producers]]\nbinding = "PACK_QUEUE"')
    expect(toml).toContain('queue = "memry-pack-compaction-staging"')
    expect(toml).toContain('queue = "memry-pack-compaction-production"')
  })

  it('declares a bounded pack compaction consumer for dev, staging, and production', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    // One pack build ≈ 269 subrequests; batch size must stay 1 so an
    // invocation's budget stays predictable (see services/pack-compaction.ts).
    const consumers = toml.match(/\[\[queues\.consumers\]\]/g) ?? []
    const stagingConsumers = toml.match(/\[\[env\.staging\.queues\.consumers\]\]/g) ?? []
    const productionConsumers = toml.match(/\[\[env\.production\.queues\.consumers\]\]/g) ?? []
    expect(consumers.length + stagingConsumers.length + productionConsumers.length).toBe(3)

    expect(toml.match(/max_batch_size = 1/g)?.length).toBe(3)
    expect(toml.match(/max_concurrency = 1/g)?.length).toBe(3)
    expect(toml.match(/max_retries = 3/g)?.length).toBe(3)
  })
})
