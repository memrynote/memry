import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const desktopPackage = JSON.parse(
  readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')
)

describe('environment scripts', () => {
  it('keeps dev local and adds an explicit staging command', () => {
    assert.equal(rootPackage.scripts.dev, 'pnpm dev:desktop')
    assert.equal(
      rootPackage.scripts.staging,
      'MEMRY_ENV=staging pnpm --filter @memry/desktop dev:staging'
    )
    assert.equal(rootPackage.scripts.staing, undefined)
  })

  it('exposes explicit sync-server deploy commands', () => {
    assert.equal(
      rootPackage.scripts['deploy:sync:staging'],
      'pnpm --filter @memry/sync-server deploy:staging'
    )
    assert.equal(
      rootPackage.scripts['deploy:sync:production'],
      'pnpm --filter @memry/sync-server deploy:production'
    )
  })

  it('builds the desktop app with the production runtime environment', () => {
    assert.match(desktopPackage.scripts.build, /MEMRY_ENV=production/)
    assert.match(desktopPackage.scripts['dev:staging'], /MEMRY_ENV=staging/)
  })
})
