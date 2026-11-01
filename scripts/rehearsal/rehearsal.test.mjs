import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { feedValues, patchConstant, publishOverrides } from './build-electron-rehearsal.mjs'
import { pollUntil } from './drive-electron-update.mjs'
import {
  assertPublishConfirmed,
  FEED_REPO,
  flag,
  isPreviousFullOf,
  parseRehearsalVersion,
  rehearsalTag,
  windowsPlan
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
})

// `gh` for `rehearse.mjs build`: `api` replies come from the state file, `run list` lists one run
// created now, and every call is appended to the log.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
const url = args.find((arg) => arg.startsWith('repos/'))
if (args[0] === 'api' && url) {
  if (!(url in state.api)) {
    console.error('fake gh: no reply for ' + url)
    process.exit(1)
  }
  process.stdout.write(state.api[url])
} else if (args[0] === 'run' && args[1] === 'list') {
  const run = { databaseId: 77, createdAt: new Date().toISOString(), headSha: state.runHeadSha }
  process.stdout.write(JSON.stringify([run]))
} else if (!['workflow run', 'run watch'].includes(args.slice(0, 2).join(' '))) {
  console.error('fake gh: unexpected call ' + args.join(' '))
  process.exit(1)
}
`

const REHEARSE = fileURLToPath(new URL('./rehearse.mjs', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(REHEARSE), '../..')
const WORKFLOW_FILE = '.github/workflows/update-bridge-rehearsal.yml'
const REHEARSAL_SHA = 'a'.repeat(40)
const SOURCE_SHA = 'b'.repeat(40)
// A kill for a hung child, not a performance bound: generous for a cold start on a loaded runner.
const SPAWN_TIMEOUT_MS = 60_000

/**
 * Runs `rehearse.mjs build <version> --source-ref feat/x` against the fake `gh`: the rehearsal
 * repo's `main` is at REHEARSAL_SHA with `rehearsalCopy` of the workflow, memry's `feat/x` is at
 * SOURCE_SHA with `sourceCopy`, and the dispatched run started from `runHeadSha`.
 */
function build(version, { rehearsalCopy, sourceCopy, runHeadSha = REHEARSAL_SHA }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rehearse-build-'))
  writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
  const contents = (repo, sha) => `repos/${repo}/contents/${WORKFLOW_FILE}?ref=${sha}`
  const state = path.join(dir, 'state.json')
  writeFileSync(
    state,
    JSON.stringify({
      runHeadSha,
      api: {
        [`repos/${FEED_REPO}/commits/main`]: REHEARSAL_SHA,
        'repos/memrynote/memry/commits/feat%2Fx': SOURCE_SHA,
        [contents(FEED_REPO, REHEARSAL_SHA)]: rehearsalCopy,
        // GitHub answers the branch name with the same file.
        [contents(FEED_REPO, 'main')]: rehearsalCopy,
        [contents('memrynote/memry', SOURCE_SHA)]: sourceCopy
      }
    })
  )
  const log = path.join(dir, 'gh.log')
  writeFileSync(log, '')
  const result = spawnSync(
    process.execPath,
    [REHEARSE, 'build', version, '--source-ref', 'feat/x'],
    {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_STATE: state,
        FAKE_GH_LOG: log
      }
    }
  )
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  rmSync(dir, { force: true, recursive: true })
  return { ...result, dispatch: calls.find(([a, b]) => a === 'workflow' && b === 'run') }
}

describe(
  'rehearse build',
  {
    skip:
      process.platform === 'win32' &&
      'the fake gh is a script, and Windows starts no script as `gh` without a .cmd shim'
  },
  () => {
    const checkout = readFileSync(path.join(REPO_ROOT, WORKFLOW_FILE), 'utf8')
    // A copy that is neither this checkout's nor the source commit's.
    const elsewhere =
      'jobs:\n  windows:\n    steps:\n      - run: node scripts/release/pe-imports.mjs pack/Memrynote.exe\n'
    const [refused, wrongRun, recorded] = ['2099.999.1', '2099.999.2', '2099.999.3']
    // `build` records the run id under `.rehearsal-state/<version>`.
    after(() => {
      for (const version of [refused, wrongRun, recorded]) {
        rmSync(path.join(REPO_ROOT, '.rehearsal-state', version), { force: true, recursive: true })
      }
    })

    it("refuses a rehearsal copy that differs from memry's at the source commit, even when it is this checkout's", () => {
      const result = build(refused, {
        rehearsalCopy: checkout,
        sourceCopy: `${checkout}# a step the source commit added\n`
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(
        result.stderr,
        /memry-update-rehearsal@main \(aaaaaaaaaa\) has a different update-bridge-rehearsal\.yml than memrynote\/memry@feat\/x \(bbbbbbbbbb\)/
      )
      assert.equal(result.dispatch, undefined)
    })

    it('dispatches the source commit, and refuses a run that started from another rehearsal commit', () => {
      const result = build(wrongRun, {
        rehearsalCopy: elsewhere,
        sourceCopy: elsewhere,
        runHeadSha: 'c'.repeat(40)
      })
      assert.deepEqual(result.dispatch, [
        'workflow',
        'run',
        'update-bridge-rehearsal.yml',
        '-R',
        FEED_REPO,
        '--ref',
        'main',
        '-f',
        `version=${wrongRun}`,
        '-f',
        `feed_repo=${FEED_REPO}`,
        '-f',
        'previous_tag=',
        '-f',
        `source_ref=${SOURCE_SHA}`
      ])
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /run 77 started from cccccccccc, not the checked aaaaaaaaaa/)
    })

    it('records the run that started from the checked commit', () => {
      const result = build(recorded, { rehearsalCopy: elsewhere, sourceCopy: elsewhere })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /build run: 77/)
      const runId = path.join(REPO_ROOT, '.rehearsal-state', recorded, 'run-id')
      assert.equal(readFileSync(runId, 'utf8'), '77')
    })
  }
)

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
