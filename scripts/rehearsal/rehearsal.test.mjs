import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { feedValues, patchConstant, publishOverrides } from './build-electron-rehearsal.mjs'
import { pollUntil } from './drive-electron-update.mjs'
import {
  assertPublishConfirmed,
  FEED_REPO,
  flag,
  parseRehearsalVersion,
  rehearsalTag
} from './rehearse.mjs'

const velopack = {
  constant: 'VELOPACK_FEED_URL',
  pattern: /^(\s*(?:export\s+)?const VELOPACK_FEED_URL\s*=\s*)(['"`]).*?\2/m
}

describe('build-electron-rehearsal', () => {
  it('replaces the feed constant and nothing else', () => {
    const source =
      "import x from 'y'\nexport const VELOPACK_FEED_URL = 'https://github.com/memrynote/memry'\nconst other = 1\n"
    assert.equal(
      patchConstant(source, velopack, 'https://github.com/memrynote/memry-update-rehearsal'),
      "import x from 'y'\nexport const VELOPACK_FEED_URL = 'https://github.com/memrynote/memry-update-rehearsal'\nconst other = 1\n"
    )
  })

  it('fails loudly when the constant is missing or unchanged', () => {
    assert.throws(() => patchConstant('const a = 1\n', velopack, 'x'), /not replaced/)
    assert.throws(
      () => patchConstant("export const VELOPACK_FEED_URL = 'x'\n", velopack, 'x'),
      /not replaced/
    )
  })

  it('derives both feed values and the electron-builder publish override from the repo', () => {
    assert.deepEqual(feedValues(FEED_REPO), {
      VELOPACK_FEED_URL: 'https://github.com/memrynote/memry-update-rehearsal',
      GITHUB_RELEASE_DOWNLOAD_BASE:
        'https://github.com/memrynote/memry-update-rehearsal/releases/download'
    })
    assert.deepEqual(publishOverrides(FEED_REPO), [
      '--publish',
      'never',
      '-c.publish.provider=github',
      '-c.publish.owner=memrynote',
      '-c.publish.repo=memry-update-rehearsal'
    ])
    assert.throws(() => feedValues('nope'), /owner>\/<name/)
  })
})

describe('rehearse', () => {
  it('accepts only rehearsal versions and builds the tag', () => {
    assert.equal(rehearsalTag('2099.101.1'), 'rehearsal-2099.101.1')
    assert.throws(() => parseRehearsalVersion('2026.1015.1'), /Rehearsal versions/)
  })

  it('refuses to publish without the repo confirmation', () => {
    assert.throws(() => assertPublishConfirmed([]), /--confirm-repo/)
    assert.throws(
      () => assertPublishConfirmed(['--confirm-repo', 'memrynote/memry']),
      /--confirm-repo/
    )
    assert.doesNotThrow(() => assertPublishConfirmed(['--confirm-repo', FEED_REPO]))
  })

  it('reads flag values', () => {
    assert.equal(flag(['--run', '7'], '--run'), '7')
    assert.equal(flag([], '--run'), undefined)
  })
})

describe('drive-electron-update', () => {
  it('returns the first matching state and reports the last state on timeout', async () => {
    const states = [{ status: 'downloading' }, { status: 'downloaded' }]
    assert.deepEqual(
      await pollUntil(
        async () => states.shift(),
        (s) => s.status === 'downloaded',
        { timeoutMs: 1000, intervalMs: 1 }
      ),
      { status: 'downloaded' }
    )
    await assert.rejects(
      pollUntil(
        async () => ({ status: 'downloading' }),
        (s) => s.status === 'downloaded',
        { timeoutMs: 20, intervalMs: 5 }
      ),
      /Last state: \{"status":"downloading"\}/
    )
  })
})
