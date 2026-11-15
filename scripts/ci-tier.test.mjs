import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

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

const scratch = mkdtempSync(join(tmpdir(), 'ci-tier-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let patchFiles = 0

// `patches` maps a file to its unified-diff hunks, as the pull request files API returns them; a file
// listed in `files` but absent from `patches` gets no patch (the API omits it for a large diff).
// Without `patches` the PATCHES file does not exist, as when the API call failed.
function tier({
  event = 'pull_request',
  ref = '',
  base = 'feat/tauri-v2',
  labels = '',
  files,
  patches,
  listed = true
}) {
  let patchPath = join(scratch, 'missing.jsonl')
  if (patches) {
    patchPath = join(scratch, `patches-${patchFiles++}.jsonl`)
    const lines = files.map((filename) =>
      JSON.stringify({ filename, patch: patches[filename] ?? null, changes: 1 })
    )
    writeFileSync(patchPath, lines.join('\n') + '\n')
  }
  const result = spawnSync('bash', [tierScript], {
    input: files.join('\n'),
    env: {
      PATH: process.env.PATH,
      EVENT: event,
      REF: ref,
      BASE_REF: base,
      LABELS: labels,
      LISTED: String(listed),
      PATCHES: patchPath
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('='))
      .map(([key, value]) => [key, value === 'true' ? true : value === 'false' ? false : value])
  )
}

// The OS legs a fast-tier PR adds, beyond Linux.
function osLegs(out) {
  return {
    rust_windows: out.rust_windows,
    rust_macos: out.rust_macos,
    tauri_windows: out.tauri_windows,
    tauri_macos: out.tauri_macos
  }
}

const noOsLegs = {
  rust_windows: 'none',
  rust_macos: 'none',
  tauri_windows: 'none',
  tauri_macos: 'none'
}
const allOsLegs = {
  rust_windows: 'tests',
  rust_macos: 'tests',
  tauri_windows: 'tests',
  tauri_macos: 'tests'
}

function hunk(...lines) {
  return ['@@ -10,6 +10,7 @@ fn context() {', '     let a = 1;', ...lines, '     a', ' }'].join(
    '\n'
  )
}

describe('ci tier for a PR into feat/tauri-v2', () => {
  it('skips the app builds for a docs-only change', () => {
    assert.deepEqual(tier({ files: ['apps/docs/src/contribute/testing.md'], patches: {} }), {
      full: false,
      tauri: false,
      swift: false,
      electron: false,
      intel: false,
      macos: true,
      ...noOsLegs
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

  it('runs everything when the file list could not be read', () => {
    const out = tier({ listed: false, files: [] })
    assert.equal(out.full, true)
    assert.equal(out.tauri, true)
    assert.equal(out.swift, true)
    assert.equal(out.electron, true)
    assert.deepEqual(osLegs(out), allOsLegs)
  })

  it('sees an app change in a PR with thousands of files', () => {
    const out = tier({ files: largeDiff('apps/desktop-tauri/src/main.tsx') })
    assert.equal(out.tauri, true)
    assert.equal(out.electron, false)
    assert.equal(tier({ files: largeDiff('crates/memry-core/src/lib.rs') }).swift, true)
    assert.equal(tier({ files: largeDiff('packages/shared/src/index.ts') }).electron, true)
  })
})

describe('ci tier for a PR stacked on another PR', () => {
  it('tiers a PR into a stacked branch like a PR into feat/tauri-v2', () => {
    const files = ['crates/memry-desktop/src/vault/mod.rs']
    const patches = { [files[0]]: hunk('+    let b = 2;') }
    const stacked = tier({ base: 'feat/3542-b-images', files, patches })
    assert.deepEqual(stacked, tier({ files, patches }))
    assert.equal(stacked.full, false)
    assert.equal(stacked.intel, false)
  })

  it('keeps a PR into main untiered', () => {
    const out = tier({ base: 'main', files: ['apps/docs/x.md'], patches: {} })
    assert.equal(out.full, true)
    assert.equal(out.intel, true)
    assert.deepEqual(osLegs(out), allOsLegs)
  })
})

describe('ci tier OS legs for a fast-tier PR', () => {
  it('runs a plain Rust change on Linux only', () => {
    const file = 'crates/memry-desktop/src/vault/mod.rs'
    const out = tier({
      files: [file],
      patches: { [file]: hunk('-    let b = 1;', '+    let b = 2;') }
    })
    assert.deepEqual(osLegs(out), noOsLegs)
  })

  it('runs a renderer-only change on Linux only', () => {
    const file = 'apps/desktop-tauri/src/renderer/src/App.tsx'
    const out = tier({ files: [file], patches: { [file]: hunk('+  const windows = 2') } })
    assert.equal(out.tauri, true)
    assert.deepEqual(osLegs(out), noOsLegs)
  })

  it('adds the Windows checks for a cfg(windows) line, and the Tauri Windows debug build in Tauri code', () => {
    const core = 'crates/memry-core/src/paths.rs'
    const shell = 'crates/memry-desktop/src/shell/paths.rs'
    const line = hunk('+#[cfg(windows)]', '+use std::os::windows::fs::MetadataExt;')
    assert.deepEqual(osLegs(tier({ files: [core], patches: { [core]: line } })), {
      ...noOsLegs,
      rust_windows: 'checks'
    })
    assert.deepEqual(osLegs(tier({ files: [shell], patches: { [shell]: line } })), {
      ...noOsLegs,
      rust_windows: 'checks',
      tauri_windows: 'checks'
    })
  })

  it('reads every OS cfg form, removed lines included', () => {
    const file = 'crates/memry-core/src/a.rs'
    const legs = (...lines) => osLegs(tier({ files: [file], patches: { [file]: hunk(...lines) } }))
    assert.equal(legs('-#[cfg(target_os = "windows")]').rust_windows, 'checks')
    assert.equal(legs('+#[cfg_attr(target_env = "msvc", allow(dead_code))]').rust_windows, 'checks')
    assert.equal(legs('+    if cfg!(windows) {').rust_windows, 'checks')
    assert.deepEqual(legs('+#[cfg(target_os = "macos")]'), { ...noOsLegs, rust_macos: 'checks' })
    assert.deepEqual(legs('+#[cfg(unix)]'), {
      ...noOsLegs,
      rust_windows: 'checks',
      rust_macos: 'checks'
    })
    assert.deepEqual(legs('+#[cfg(not(target_os = "linux"))]'), {
      ...noOsLegs,
      rust_windows: 'checks',
      rust_macos: 'checks'
    })
    assert.deepEqual(legs('+#[cfg(target_os = "linux")]'), noOsLegs)
    assert.deepEqual(legs('+#[cfg(not(test))]'), noOsLegs)
    assert.deepEqual(legs(' #[cfg(windows)]', '+    let b = 2;'), noOsLegs)
  })

  it('adds the whole OS leg for OS-specific tests', () => {
    const unit = 'crates/memry-core/src/a.rs'
    const integration = 'crates/memry-desktop/tests/windows_paths.rs'
    const out = tier({
      files: [unit],
      patches: { [unit]: hunk('+    #[cfg(windows)]', '+    #[test]', '+    fn drive_letter() {}') }
    })
    assert.equal(out.rust_windows, 'tests')
    assert.equal(out.rust_macos, 'none')
    const named = tier({
      files: [integration],
      patches: { [integration]: hunk('+    let b = 2;') }
    })
    assert.equal(named.rust_windows, 'tests')
    assert.equal(named.tauri_windows, 'tests')
  })

  it('adds the OS named by a path', () => {
    const win = 'apps/desktop-tauri/src-tauri/src/windows/win32_caption/mod.rs'
    assert.equal(
      tier({ files: [win], patches: { [win]: hunk('+ let b = 2;') } }).tauri_windows,
      'checks'
    )
    const plist = 'apps/desktop-tauri/src-tauri/entitlements.mac.plist'
    assert.deepEqual(osLegs(tier({ files: [plist], patches: { [plist]: hunk('+<key/>') } })), {
      ...noOsLegs,
      rust_macos: 'checks',
      tauri_macos: 'checks'
    })
  })

  it('adds every OS for build scripts, cargo config, the toolchain and CI definitions', () => {
    for (const file of [
      'apps/desktop-tauri/src-tauri/build.rs',
      'crates/.cargo/config.toml',
      'crates/rust-toolchain.toml',
      '.github/actions/ort-static/action.yml',
      '.github/actions/tesseract-sources/action.yml'
    ]) {
      assert.deepEqual(
        osLegs(tier({ files: [file], patches: { [file]: hunk('+x') } })),
        allOsLegs,
        file
      )
    }
    const rustCi = tier({ files: ['.github/workflows/rust-ci.yml'], patches: {} })
    assert.equal(rustCi.rust_windows, 'tests')
    assert.equal(rustCi.tauri_windows, 'none')
    const tauriCi = tier({ files: ['.github/workflows/desktop-tauri-ci.yml'], patches: {} })
    assert.equal(tauriCi.tauri_macos, 'tests')
    assert.equal(tauriCi.rust_macos, 'none')
  })

  it('adds the OS checks for a Cargo manifest or lock change', () => {
    const out = tier({ files: ['crates/Cargo.lock'], patches: { 'crates/Cargo.lock': hunk('+x') } })
    assert.deepEqual(osLegs(out), {
      rust_windows: 'checks',
      rust_macos: 'checks',
      tauri_windows: 'checks',
      tauri_macos: 'checks'
    })
  })

  it('fails the OS legs open for a Rust file without a patch, or when no patch could be read', () => {
    const file = 'crates/memry-desktop/src/vault/mod.rs'
    const noPatch = tier({ files: [file], patches: {} })
    assert.equal(noPatch.full, false)
    assert.deepEqual(osLegs(noPatch), allOsLegs)
    assert.deepEqual(osLegs(tier({ files: [file] })), allOsLegs)
  })

  it('runs every leg with the full-ci label', () => {
    const file = 'apps/docs/x.md'
    assert.deepEqual(osLegs(tier({ labels: 'full-ci', files: [file], patches: {} })), allOsLegs)
  })

  it('sees a cfg line in a PR with thousands of files', () => {
    const file = 'crates/memry-core/src/a.rs'
    const files = largeDiff(file)
    const out = tier({ files, patches: { [file]: hunk('+#[cfg(windows)]') } })
    assert.equal(out.rust_windows, 'checks')
    assert.equal(out.rust_macos, 'none')
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
      macos: true,
      ...allOsLegs
    })
  })
})
