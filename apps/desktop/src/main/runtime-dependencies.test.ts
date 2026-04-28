import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

describe('runtime dependencies', () => {
  it('keeps packaged main-process dependencies in production dependencies', () => {
    const dependencies = packageJson.dependencies ?? {}

    expect(dependencies).toHaveProperty('better-sqlite3')
    expect(dependencies).toHaveProperty('safe-buffer')
  })
})
