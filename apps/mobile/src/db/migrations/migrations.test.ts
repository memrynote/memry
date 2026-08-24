import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_MIGRATIONS } from './index'

// The .sql files are the reviewable canonical text; the shipped strings live
// in index.ts because Metro cannot import .sql. This test is the drift gate.
describe('mobile migration ledger', () => {
  it('ships byte-identical SQL to the canonical .sql files', () => {
    for (const migration of MOBILE_MIGRATIONS) {
      const canonical = readFileSync(join(__dirname, `${migration.name}.sql`), 'utf-8')
      expect(migration.sql).toBe(canonical)
    }
  })

  it('is strictly ordered and additive', () => {
    const versions = MOBILE_MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions[0]).toBe(1)
  })
})
