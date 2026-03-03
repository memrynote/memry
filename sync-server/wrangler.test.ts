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
    expect(toml).toContain('new_classes = ["UserSyncState", "LinkingSession"]')
  })

  it('defines environment-specific deployment sections', () => {
    const toml = readFileSync(resolve(__dirname, 'wrangler.toml'), 'utf8')

    expect(toml).toContain('[env.staging]')
    expect(toml).toContain('name = "memry-sync-server-staging"')
    expect(toml).toContain('[env.staging.vars]')
    expect(toml).toContain('ENVIRONMENT = "staging"')

    expect(toml).toContain('[env.production]')
    expect(toml).toContain('name = "memry-sync-server-production"')
    expect(toml).toContain('[env.production.vars]')
    expect(toml).toContain('ENVIRONMENT = "production"')
  })
})
