import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { feedValues, patchConstant, publishOverrides } from './build-electron-rehearsal.mjs'
import { pollUntil } from './drive-electron-update.mjs'
import {
  assertPublishConfirmed,
  assertWorkflowMatches,
  dispatchFields,
  FEED_REPO,
  flag,
  isPreviousFullOf,
  parseRehearsalVersion,
  rehearsalTag,
  windowsPlan,
  workflowRef
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

  it('writes latest.yml for a signed pack, and for an unsigned one only when asked', () => {
    assert.deepEqual(windowsPlan([]), { packs: true, signed: true, latestYml: true })
    assert.deepEqual(windowsPlan(['--unsigned-windows']), {
      packs: true,
      signed: false,
      latestYml: false
    })
    assert.deepEqual(windowsPlan(['--unsigned-windows', '--with-latest']), {
      packs: true,
      signed: false,
      latestYml: true
    })
    assert.deepEqual(windowsPlan(['--no-windows', '--with-latest']), {
      packs: false,
      signed: false,
      latestYml: false
    })
  })

  it('reads flag values', () => {
    assert.equal(flag(['--run', '7'], '--run'), '7')
    assert.equal(flag([], '--run'), undefined)
  })

  it('builds the branch it is given, and the workflow default otherwise', () => {
    assert.deepEqual(dispatchFields('2099.101.4', ['--source-ref', 'feat/x']), [
      '-f',
      'version=2099.101.4',
      '-f',
      `feed_repo=${FEED_REPO}`,
      '-f',
      'previous_tag=',
      '-f',
      'source_ref=feat/x'
    ])
    assert.ok(!dispatchFields('2099.101.4', []).some((field) => field.startsWith('source_ref')))
  })

  it("runs the rehearsal repo workflow only when it is this checkout's copy", () => {
    assert.equal(workflowRef([]), 'main')
    assert.equal(workflowRef(['--workflow-ref', 'feat-x']), 'feat-x')
    const local =
      'jobs:\n  windows:\n    steps:\n      - run: node scripts/release/pe-imports.mjs pack/Memrynote.exe\n'
    assert.doesNotThrow(() => assertWorkflowMatches(local, local, 'main'))
    // The copy `2099.101.17` and `.18` ran: the step is missing.
    const stale = 'jobs:\n  windows:\n    steps:\n'
    assert.throws(
      () => assertWorkflowMatches(stale, local, 'main'),
      /memry-update-rehearsal@main has a different update-bridge-rehearsal\.yml than this checkout/
    )
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

describe('previous fulls', () => {
  const fulls = [
    'MemryNote-2099.101.1-full.nupkg',
    'MemryNote-2099.101.1-win-arm64-full.nupkg',
    'MemryNote-2099.101.1-osx-arm64-full.nupkg',
    'MemryNote-2099.101.1-linux-full.nupkg'
  ]

  it('keeps only the pack target own full, so no foreign full leaks into its feed', () => {
    assert.deepEqual(
      fulls.filter((name) => isPreviousFullOf('win-x64', name)),
      ['MemryNote-2099.101.1-full.nupkg']
    )
    assert.deepEqual(
      fulls.filter((name) => isPreviousFullOf('win-arm64', name)),
      ['MemryNote-2099.101.1-win-arm64-full.nupkg']
    )
  })
})
