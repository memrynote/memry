import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

// The tier decides which CI jobs a diff skips, and a skipped job reports green. These cases pin the
// skips: a change that can break an app must not land in a tier that never builds it.
const tierScript = new URL('../.github/actions/ci-tier/tier.sh', import.meta.url).pathname
const changedScript = new URL('../.github/actions/paths-changed/changed.sh', import.meta.url)
  .pathname

// A large PR lists thousands of files; a match early in the list must still count.
function largeDiff(first) {
  const files = [first]
  for (let i = 0; i < 20000; i++) files.push(`apps/docs/src/generated/page-${i}.md`)
  return files
}

function tier({
  event = 'pull_request',
  ref = '',
  base = 'feat/tauri-v2',
  labels = '',
  files,
  listed = true
}) {
  const result = spawnSync('bash', [tierScript], {
    input: files.join('\n'),
    env: {
      PATH: process.env.PATH,
      EVENT: event,
      REF: ref,
      BASE_REF: base,
      LABELS: labels,
      LISTED: String(listed)
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('='))
      .map(([key, value]) => [key, value === 'true'])
  )
}

describe('ci tier for a PR into feat/tauri-v2', () => {
  it('skips the app builds for a docs-only change', () => {
    assert.deepEqual(tier({ files: ['apps/docs/src/contribute/testing.md'] }), {
      full: false,
      tauri: false,
      swift: false,
      electron: false,
      intel: false,
      macos: true
    })
  })

  it('builds the Tauri app when its code, a bundled package or the lockfile changes', () => {
    for (const file of [
      'apps/desktop-tauri/src/renderer/src/App.tsx',
      'crates/memry-desktop/src/vault/mod.rs',
      'packages/sync-core/src/index.ts',
      'pnpm-lock.yaml',
      '.github/workflows/rust-ci.yml'
    ]) {
      assert.equal(tier({ files: [file] }).tauri, true, file)
    }
  })

  it('leaves the Tauri build to the article-extraction gates for an extractor-only change', () => {
    assert.equal(tier({ files: ['crates/memry-desktop/src/web/extract/score.rs'] }).tauri, false)
  })

  it('checks the Swift bindings when memry-core or the iOS app changes', () => {
    for (const file of ['crates/memry-core/src/api/notes.rs', 'apps/ios/Memry/App.swift']) {
      assert.equal(tier({ files: [file] }).swift, true, file)
    }
    assert.equal(tier({ files: ['crates/memry-desktop/src/lib.rs'] }).swift, false)
  })

  it('runs the Electron jobs for shared packages and root configs, not for Tauri-only code', () => {
    assert.equal(tier({ files: ['packages/shared/src/index.ts'] }).electron, true)
    assert.equal(tier({ files: ['oxlint.config.mts'] }).electron, true)
    assert.equal(tier({ files: ['apps/desktop-tauri/src/main.tsx'] }).electron, false)
  })

  it('runs everything with the full-ci label', () => {
    const out = tier({ labels: 'test,full-ci', files: ['apps/docs/x.md'] })
    assert.equal(out.full, true)
    assert.equal(out.tauri, true)
    assert.equal(out.swift, true)
  })

  it('fails open when the file list could not be read', () => {
    const out = tier({ listed: false, files: [] })
    assert.equal(out.full, false)
    assert.equal(out.tauri, true)
    assert.equal(out.swift, true)
    assert.equal(out.electron, true)
  })

  it('sees an app change in a PR with thousands of files', () => {
    const out = tier({ files: largeDiff('apps/desktop-tauri/src/main.tsx') })
    assert.equal(out.tauri, true)
    assert.equal(out.electron, false)
    assert.equal(tier({ files: largeDiff('crates/memry-core/src/lib.rs') }).swift, true)
    assert.equal(tier({ files: largeDiff('packages/shared/src/index.ts') }).electron, true)
  })
})

describe('paths-changed', () => {
  function changed(files, include, exclude = '^$') {
    const result = spawnSync('bash', [changedScript], {
      input: files.join('\n'),
      env: { PATH: process.env.PATH, INCLUDE: include, EXCLUDE: exclude },
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  it('reports a change only for an included, non-excluded file', () => {
    assert.equal(changed(['apps/sync-server/src/index.ts'], '^apps/sync-server/'), 'true')
    assert.equal(changed(['apps/docs/x.md'], '^apps/sync-server/'), 'false')
    assert.equal(changed(['apps/docs/x.md'], '.', '^apps/(docs|landing)/'), 'false')
  })

  it('sees an included file in a PR with thousands of files', () => {
    assert.equal(changed(largeDiff('crates/memry-core/src/lib.rs'), '^crates/'), 'true')
  })
})

describe('ci tier outside PRs into feat/tauri-v2', () => {
  it('runs the full matrix in the merge queue, without macOS', () => {
    const out = tier({ event: 'merge_group', base: '', files: ['apps/docs/x.md'] })
    assert.equal(out.full, true)
    assert.equal(out.macos, false)
    assert.equal(out.intel, false)
    assert.equal(out.electron, false)
  })

  it('keeps Intel Macs on a push to main', () => {
    const out = tier({ event: 'push', ref: 'refs/heads/main', base: '', listed: false, files: [] })
    assert.deepEqual(out, {
      full: true,
      tauri: true,
      swift: true,
      electron: true,
      intel: true,
      macos: true
    })
  })
})
