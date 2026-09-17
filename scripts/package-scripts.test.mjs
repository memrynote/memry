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

describe('native warm-up scripts', () => {
  it('warms the native build from postinstall instead of a stampless rebuild', () => {
    // A bare `electron-rebuild` here never wrote node_modules/.native-build-target,
    // so predev rebuilt everything again on the first `pnpm dev` of a worktree.
    assert.match(desktopPackage.scripts.postinstall, /warm-native\.mjs/)
    assert.match(desktopPackage.scripts.postinstall, /--background/)
    assert.doesNotMatch(desktopPackage.scripts.postinstall, /electron-rebuild/)
    assert.match(desktopPackage.scripts.postinstall, /SKIP_ELECTRON_REBUILD/)
  })

  it('exposes manual warm-up entry points at the root', () => {
    assert.equal(rootPackage.scripts.warm, 'node scripts/warm-native.mjs --target electron')
    assert.equal(
      rootPackage.scripts['warm:bg'],
      'node scripts/warm-native.mjs --background --target electron'
    )
    assert.equal(rootPackage.scripts['warm:log'], 'node scripts/warm-native.mjs --log')
  })

  it('keeps predev on the stamp-aware guard', () => {
    assert.match(desktopPackage.scripts.predev, /ensure-native\.sh electron/)
  })
})
