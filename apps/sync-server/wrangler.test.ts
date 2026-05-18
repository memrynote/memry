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
    expect(toml).toContain('new_sqlite_classes = ["UserSyncState", "LinkingSession"]')
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

  it('binds the PRODUCT_TELEMETRY analytics engine dataset per environment', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    // root (development) dataset
    expect(toml).toMatch(
      /\[\[analytics_engine_datasets\]\][\s\S]*?binding = "PRODUCT_TELEMETRY"[\s\S]*?dataset = "memry_product_telemetry_dev"/
    )

    // staging dataset
    expect(toml).toMatch(
      /\[\[env\.staging\.analytics_engine_datasets\]\][\s\S]*?binding = "PRODUCT_TELEMETRY"[\s\S]*?dataset = "memry_product_telemetry_staging"/
    )

    // production dataset
    expect(toml).toMatch(
      /\[\[env\.production\.analytics_engine_datasets\]\][\s\S]*?binding = "PRODUCT_TELEMETRY"[\s\S]*?dataset = "memry_product_telemetry_production"/
    )
  })
})
