import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

// The tier decides which CI jobs a diff skips, and a skipped job reports green. These cases pin the
// skips: a change that can break an app must not land in a tier that never builds it.
const repo = new URL('..', import.meta.url).pathname
const tierDir = join(repo, '.github/actions/ci-tier')
const tierScript = join(tierDir, 'tier.sh')
const changedScript = join(repo, '.github/actions/paths-changed/changed.sh')

// A large PR lists thousands of files (the API stops at 3000); a match early in the list must still
// count. 2999 files outgrow the pipe buffer that once turned a match into a miss.
function largeDiff(first, total = 2999) {
  const files = [first]
  for (let i = 1; i < total; i++) files.push(`apps/docs/src/generated/page-${i}.md`)
  return files
}

const scratch = mkdtempSync(join(tmpdir(), 'ci-tier-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let patchFiles = 0

function writeTree(root, tree) {
  for (const [file, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

// The Rust sources the plan job checks out: the modules only some OSes compile.
const source = writeTree(join(scratch, 'source'), {
  'apps/desktop-tauri/src-tauri/src/power/mod.rs': [
    '#[cfg(windows)]',
    'mod win;',
    '#[cfg(target_os = "macos")]',
    'mod mac;',
    '#[cfg(target_os = "linux")]',
    'mod linux;',
    'mod common;'
  ].join('\n'),
  'apps/desktop-tauri/src-tauri/src/updater.rs': [
    '/// The WebView2 runtime check.',
    '#[cfg(windows)]',
    '#[allow(dead_code)]',
    'pub(crate) mod webview2;'
  ].join('\n'),
  'crates/memry-core/src/lib.rs': [
    '#[cfg(any(',
    '    target_os = "macos",',
    '    windows',
    '))]',
    'mod desktop_only;'
  ].join('\n'),
  'crates/memry-desktop/tests/integration.rs': [
    '#[cfg(windows)]',
    '#[path = "trash/mod.rs"]',
    'mod trash;'
  ].join('\n'),
  'apps/desktop-tauri/src-tauri/src/shell/permissions.rs': [
    'pub fn install() {}',
    '#[cfg(windows)]',
    'mod windows_impl {',
    '    pub fn install() {}',
    '}'
  ].join('\n'),
  'crates/memry-desktop/tests/live.rs': [
    '#[cfg(target_os = "macos")]',
    'mod macos {',
    '    #[test]',
    '    fn reads() {}',
    '}'
  ].join('\n'),
  'crates/memry-desktop/src/plain.rs': ['#[cfg(test)]', 'mod tests {', '}'].join('\n'),
  'crates/memry-core/src/forms.rs': [
    '#[cfg(windows)] mod one_line;',
    '#[cfg(target_os = "macos")]',
    'mod after_one_line;',
    '#[cfg(windows)]',
    '#[cfg(feature = "x")]',
    'mod with_feature;',
    '#[cfg(target_os = "macos")] // note',
    'mod commented;',
    'mod plain;'
  ].join('\n')
})

function osModules(root) {
  const result = spawnSync('bash', [join(tierDir, 'os-modules.sh'), root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))
}

// `patches` maps a file to its unified-diff hunks (a string), or to `{ patch, previous_filename,
// changes }`, as the pull request files API returns them; a file absent from `patches` gets no patch
// (the API omits it for a large diff). Without `patches` the PATCHES file does not exist, as when the
// API call failed.
function tier({
  event = 'pull_request',
  ref = '',
  base = 'feat/tauri-v2',
  labels = '',
  files,
  patches,
  listed = true,
  sourceRoot = source
}) {
  let patchPath = join(scratch, 'missing.jsonl')
  if (patches) {
    patchPath = join(scratch, `patches-${patchFiles++}.jsonl`)
    const lines = files.map((filename) => {
      const entry = patches[filename]
      const fields = typeof entry === 'object' && entry !== null ? entry : { patch: entry ?? null }
      return JSON.stringify({ filename, previous_filename: null, changes: 1, ...fields })
    })
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
      PATCHES: patchPath,
      SOURCE_ROOT: sourceRoot
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  // stdout is $GITHUB_OUTPUT: anything but `key=value` lines fails the step.
  for (const line of result.stdout.trim().split('\n')) assert.match(line, /^[a-z0-9_]+=[a-z]+$/)
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

function legs(rust_windows, rust_macos, tauri_windows, tauri_macos) {
  return { rust_windows, rust_macos, tauri_windows, tauri_macos }
}
const noOsLegs = legs('none', 'none', 'none', 'none')
const allOsLegs = legs('tests', 'tests', 'tests', 'tests')

function hunk(...lines) {
  return ['@@ -10,6 +10,7 @@ fn context() {', '     let a = 1;', ...lines, '     a', ' }'].join(
    '\n'
  )
}

// The OS legs of one file with one hunk.
function legsOf(file, ...lines) {
  return osLegs(tier({ files: [file], patches: { [file]: hunk(...lines) } }))
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
      ...noOsLegs,
      rust_linux_arm64: false
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

// rust-ci.yml's ml-worker-linux-arm64 job (#4775).
describe('ci tier Linux arm64 worker leg', () => {
  const arm64Files = [
    'crates/memry-ml-worker/src/main.rs',
    'crates/memry-ml-worker/build.rs',
    'crates/memry-ml/src/runtime.rs',
    'crates/memry-media/src/lib.rs',
    'crates/Cargo.toml',
    'crates/Cargo.lock',
    'crates/rust-toolchain.toml',
    'crates/.cargo/config.toml',
    'scripts/fetch-pdfium.mjs',
    'scripts/fetch-tesseract-sources.mjs',
    'packages/contracts/test-vectors/embeddings-text.json',
    'packages/contracts/test-vectors/pixel-tensors.json',
    'packages/contracts/test-vectors/audio-features.json',
    'apps/desktop-tauri/src-tauri/resources/tessdata/eng.traineddata.gz',
    '.github/actions/ci-tier/tier.sh',
    '.github/actions/ort-static/action.yml',
    '.github/actions/tesseract-sources/action.yml',
    '.github/workflows/rust-ci.yml'
  ]

  it('runs on a PR that touches the worker, the crates it links or their native inputs', () => {
    for (const file of arm64Files) {
      assert.equal(tier({ files: [file], patches: {} }).rust_linux_arm64, true, file)
    }
  })

  it('skips a PR that cannot change the worker', () => {
    for (const file of [
      'crates/memry-core/src/lib.rs',
      'crates/memry-desktop/src/services/file_text/worker.rs',
      'crates/memry-mlx/src/lib.rs',
      'apps/desktop-tauri/src-tauri/src/ml_worker.rs',
      'apps/desktop-tauri/src-tauri/resources/icons/icon.png',
      'packages/contracts/test-vectors/crdt-update.json',
      '.github/workflows/desktop-tauri-ci.yml',
      'apps/docs/x.md'
    ]) {
      assert.equal(tier({ files: [file], patches: {} }).rust_linux_arm64, false, file)
    }
  })

  it('runs on every full run, the merge queue included', () => {
    const docs = ['apps/docs/x.md']
    assert.equal(tier({ labels: 'full-ci', files: docs }).rust_linux_arm64, true)
    assert.equal(tier({ listed: false, files: [] }).rust_linux_arm64, true)
    assert.equal(
      tier({ event: 'push', ref: 'refs/heads/feat/tauri-v2', base: '', files: docs })
        .rust_linux_arm64,
      true
    )
    assert.equal(tier({ event: 'merge_group', base: '', files: docs }).rust_linux_arm64, true)
  })

  it('starts Rust CI for every file that adds the leg', () => {
    const include = new RegExp(
      readFileSync(join(repo, '.github/workflows/rust-ci.yml'), 'utf8').match(
        /include: '([^']+)'/
      )[1]
    )
    for (const file of arm64Files) assert.match(file, include, file)
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
  const core = 'crates/memry-core/src/paths.rs'
  const shell = 'crates/memry-desktop/src/shell/paths.rs'

  it('runs a plain Rust change on Linux only', () => {
    assert.deepEqual(legsOf(shell, '-    let b = 1;', '+    let b = 2;'), noOsLegs)
  })

  it('runs a renderer-only change on Linux only', () => {
    const file = 'apps/desktop-tauri/src/renderer/src/App.tsx'
    const out = tier({ files: [file], patches: { [file]: hunk('+  const windows = 2') } })
    assert.equal(out.tauri, true)
    assert.deepEqual(osLegs(out), noOsLegs)
  })

  it('adds the Windows and macOS checks for an OS cfg line, and the Tauri debug builds in Tauri code', () => {
    const line = ['+#[cfg(windows)]', '+use std::path::Prefix;']
    assert.deepEqual(legsOf(core, ...line), legs('checks', 'checks', 'none', 'none'))
    assert.deepEqual(legsOf(shell, ...line), legs('checks', 'checks', 'checks', 'checks'))
  })

  it('counts every OS cfg form on both OSes, a Linux-only one and a removed one included', () => {
    const both = legs('checks', 'checks', 'none', 'none')
    for (const line of [
      '-#[cfg(target_os = "windows")]',
      '+#[cfg(target_os = "linux")]',
      '+#[cfg(target_os = "macos")]',
      '+#[cfg(unix)]',
      '+#[cfg(not(target_os = "linux"))]',
      '+#[cfg_attr(target_env = "msvc", allow(dead_code))]',
      '+#[cfg(target_family = "unix")]',
      '+    if cfg!(windows) {'
    ]) {
      assert.deepEqual(legsOf(core, line), both, line)
    }
    assert.deepEqual(legsOf(core, '+#[cfg(not(test))]'), noOsLegs)
    assert.deepEqual(legsOf(core, '+#[cfg(feature = "markdown")]'), noOsLegs)
  })

  it('counts an OS cfg in the hunk context and a multi-line cfg', () => {
    const both = legs('checks', 'checks', 'none', 'none')
    assert.deepEqual(
      legsOf(core, ' #[cfg(windows)]', ' fn drive() {', '-    old();', '+    new();'),
      both
    )
    assert.deepEqual(
      legsOf(
        core,
        '+#[cfg(any(',
        '+    target_os = "windows",',
        '+    target_os = "macos"',
        '+))]'
      ),
      both
    )
    assert.deepEqual(
      legsOf(core, ' #[cfg(any(', '     windows,', '-    unix', '+    target_family = "wasm"'),
      both
    )
  })

  it('counts an OS API on a changed line, not in the context', () => {
    const both = legs('checks', 'checks', 'none', 'none')
    assert.deepEqual(legsOf(core, '+use std::os::windows::fs::MetadataExt;'), both)
    assert.deepEqual(legsOf(core, '+    windows_sys::Win32::Foundation::CloseHandle(h);'), both)
    assert.deepEqual(legsOf(core, '+    let app = objc2_app_kit::NSApp();'), both)
    assert.deepEqual(
      legsOf(core, ' use std::os::unix::fs::PermissionsExt;', '+    let b = 2;'),
      noOsLegs
    )
  })

  it('adds the whole OS leg for OS-specific tests', () => {
    const tests = legs('tests', 'tests', 'none', 'none')
    assert.deepEqual(
      legsOf(core, '+    #[cfg(windows)]', '+    #[test]', '+    fn drive_letter() {}'),
      tests
    )
    assert.deepEqual(
      legsOf(core, '+    #[cfg(unix)]', '+    #[tokio::test]', '+    async fn mode() {}'),
      tests
    )
    assert.deepEqual(legsOf('crates/memry-core/src/paths_test.rs', '+#[cfg(windows)]'), tests)
    assert.deepEqual(
      legsOf('crates/memry-desktop/tests/windows_paths.rs', '+    let b = 2;'),
      legs('tests', 'none', 'tests', 'none')
    )
  })

  it('adds the OS a path names', () => {
    const win = legs('checks', 'none', 'checks', 'none')
    const mac = legs('none', 'checks', 'none', 'checks')
    for (const file of [
      'apps/desktop-tauri/src-tauri/src/windows/chrome.rs',
      'apps/desktop-tauri/src-tauri/src/tray/win.rs',
      'apps/desktop-tauri/src-tauri/src/x/win32_menu.rs',
      'crates/memry-desktop/src/x/msvc.rs'
    ]) {
      assert.deepEqual(legsOf(file, '+ let b = 2;'), win, file)
    }
    for (const file of [
      'apps/desktop-tauri/src-tauri/src/tray/mac.rs',
      'apps/desktop-tauri/src-tauri/src/x/macos/menu.rs',
      'apps/desktop-tauri/src-tauri/src/x/darwin.rs',
      'apps/desktop-tauri/src-tauri/src/x/apple_events.rs',
      'apps/desktop-tauri/src-tauri/Info.plist'
    ]) {
      assert.deepEqual(legsOf(file, '+ x'), mac, file)
    }
  })

  it('adds the OS of a module only that OS compiles', () => {
    const body = ['-    old();', '+    new();']
    const src = 'apps/desktop-tauri/src-tauri/src'
    const win = legs('checks', 'none', 'checks', 'none')
    assert.deepEqual(legsOf(`${src}/power/win.rs`, ...body), win)
    assert.deepEqual(legsOf(`${src}/updater/webview2.rs`, ...body), win)
    assert.deepEqual(legsOf(`${src}/updater/webview2/registry.rs`, ...body), win)
    assert.deepEqual(
      legsOf(`${src}/power/mac.rs`, ...body),
      legs('none', 'checks', 'none', 'checks')
    )
    assert.deepEqual(legsOf(`${src}/power/linux.rs`, ...body), noOsLegs)
    assert.deepEqual(legsOf(`${src}/power/common.rs`, ...body), noOsLegs)
    assert.deepEqual(
      legsOf('crates/memry-core/src/desktop_only.rs', ...body),
      legs('checks', 'checks', 'none', 'none')
    )
    assert.deepEqual(
      legsOf('crates/memry-desktop/tests/trash/mod.rs', ...body),
      legs('tests', 'none', 'tests', 'none')
    )
  })

  it('adds the OS of an inline module for any change to the file that holds it', () => {
    const body = ['-    old();', '+    new();']
    assert.deepEqual(
      legsOf('apps/desktop-tauri/src-tauri/src/shell/permissions.rs', ...body),
      legs('checks', 'none', 'checks', 'none')
    )
    assert.deepEqual(
      legsOf('crates/memry-desktop/tests/live.rs', ...body),
      legs('none', 'tests', 'none', 'tests')
    )
    assert.deepEqual(legsOf('crates/memry-desktop/src/plain.rs', ...body), noOsLegs)
  })

  it('reads a one-line cfg, a cfg followed by another attribute and a trailing comment', () => {
    const forms = osModules(source)
      .filter(([, , at]) => at.startsWith('crates/memry-core/src/forms.rs:'))
      .map(([prefix, os]) => `${prefix} ${os}`)
    const dir = 'crates/memry-core/src/forms'
    assert.deepEqual(forms, [
      `${dir}/one_line win`,
      `${dir}/after_one_line mac`,
      `${dir}/with_feature win`,
      `${dir}/commented mac`
    ])
  })

  it('judges a rename by its old name too, and a pure rename of plain code adds nothing', () => {
    const src = 'apps/desktop-tauri/src-tauri/src'
    const moved = `${src}/power/common.rs`
    const fromWin = tier({
      files: [moved],
      patches: { [moved]: { previous_filename: `${src}/power/win.rs`, changes: 0 } }
    })
    assert.deepEqual(osLegs(fromWin), legs('checks', 'none', 'checks', 'none'))
    const plain = tier({
      files: [shell],
      patches: { [shell]: { previous_filename: core, changes: 0 } }
    })
    assert.deepEqual(osLegs(plain), noOsLegs)
  })

  it('adds every OS for build scripts, cargo config, the toolchain and the CI definitions a workflow uses', () => {
    for (const file of [
      'apps/desktop-tauri/src-tauri/build.rs',
      'crates/.cargo/config.toml',
      'crates/rust-toolchain.toml',
      '.github/actions/ci-tier/tier.sh',
      '.github/actions/setup-pnpm/action.yml'
    ]) {
      assert.deepEqual(legsOf(file, '+x'), allOsLegs, file)
    }
    assert.deepEqual(
      legsOf('crates/memry-ml-worker/build.rs', '+x'),
      legs('tests', 'tests', 'none', 'none')
    )
    assert.deepEqual(
      legsOf('.github/actions/ort-static/action.yml', '+x'),
      legs('tests', 'tests', 'none', 'none')
    )
    assert.deepEqual(
      legsOf('.github/workflows/rust-ci.yml', '+x'),
      legs('tests', 'tests', 'none', 'none')
    )
    assert.deepEqual(
      legsOf('.github/workflows/desktop-tauri-ci.yml', '+x'),
      legs('none', 'none', 'tests', 'tests')
    )
    // Linux-only actions and the Electron workflow add no OS.
    assert.deepEqual(legsOf('.github/actions/apt-install/action.yml', '+x'), noOsLegs)
    assert.deepEqual(legsOf('.github/workflows/desktop-ci.yml', '+x'), noOsLegs)
  })

  it('adds the OS checks for a Cargo manifest or lock change', () => {
    assert.deepEqual(
      legsOf('crates/Cargo.lock', '+x'),
      legs('checks', 'checks', 'checks', 'checks')
    )
    assert.deepEqual(
      legsOf('crates/memry-core/Cargo.toml', '+x'),
      legs('checks', 'checks', 'none', 'none')
    )
  })

  it('fails the OS legs open without a patch for a changed Rust file, the patch list or the sources', () => {
    const noPatch = tier({ files: [shell], patches: {} })
    assert.equal(noPatch.full, false)
    assert.deepEqual(osLegs(noPatch), allOsLegs)
    assert.deepEqual(osLegs(tier({ files: [shell] })), allOsLegs)
    const patches = { [shell]: hunk('+    let b = 2;') }
    assert.deepEqual(osLegs(tier({ files: [shell], patches, sourceRoot: '' })), allOsLegs)
    assert.deepEqual(
      osLegs(tier({ files: [shell], patches, sourceRoot: join(scratch, 'empty') })),
      allOsLegs
    )
  })

  it('runs every leg with the full-ci label', () => {
    const file = 'apps/docs/x.md'
    assert.deepEqual(osLegs(tier({ labels: 'full-ci', files: [file], patches: {} })), allOsLegs)
  })

  it('sees a cfg line in a PR with thousands of files', () => {
    const files = largeDiff(core)
    const out = tier({ files, patches: { [core]: hunk('+#[cfg(windows)]') } })
    assert.equal(out.full, false)
    assert.equal(out.rust_windows, 'checks')
  })

  it('runs everything for a list of 3000 files, where the API stops', () => {
    const out = tier({ files: largeDiff('apps/docs/x.md', 3000), patches: {} })
    assert.equal(out.full, true)
    assert.deepEqual(osLegs(out), allOsLegs)
  })
})

describe('ci tier on the repo itself', () => {
  const gated = osModules(repo)

  it('finds the Windows-only and macOS-only modules', () => {
    const found = Object.fromEntries(gated)
    const src = 'apps/desktop-tauri/src-tauri/src'
    for (const name of [
      'power/win',
      'autostart/win',
      'spell/win',
      'updater/webview2',
      'updater/nsis_host'
    ]) {
      assert.equal(found[`${src}/${name}`], 'win', name)
    }
    for (const name of ['power/mac', 'autostart/mac', 'notifications/mac', 'shutdown/mac_quit']) {
      assert.equal(found[`${src}/${name}`], 'mac', name)
    }
    const inline = new Set(
      gated.filter(([prefix]) => prefix.endsWith('.rs')).map(([, os, at]) => `${at} ${os}`)
    )
    for (const decl of [
      `${src}/shell/permissions.rs:68 win`,
      'crates/memry-desktop/tests/move_dir.rs:764 win',
      'crates/memry-desktop/tests/electron_secrets_live.rs:75 mac',
      'crates/memry-desktop/tests/electron_secrets_live.rs:346 win'
    ]) {
      assert.ok(inline.has(decl), decl)
    }
  })

  // An independent read of the same sources: every `mod x;` or `mod x {` whose attributes, back to
  // the previous item, carry an OS cfg (one only Linux satisfies excepted, as the scanner does).
  it('lists every OS-gated module declaration a plain grep finds', () => {
    const expected = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory() && entry.name !== 'target') walk(path)
        else if (entry.name.endsWith('.rs')) {
          const lines = readFileSync(join(repo, path), 'utf8')
            .split('\n')
            .map((l) => l.replace(/\/\/.*$/, ''))
          lines.forEach((line, i) => {
            const decl = /^\s*((?:#\[[^\]]*\]\s*)*)(pub(\([^)]*\))?\s+)?mod\s+\w+\s*(;|\{|$)/.exec(
              line
            )
            if (!decl) return
            let attrs = decl[1] ?? ''
            for (let j = i - 1; j >= 0 && !/[;{}]\s*$/.test(lines[j]); j--) attrs = lines[j] + attrs
            const cfgs = attrs.match(/#\[cfg\s*\([^\]]*\]/g)?.join(' ') ?? ''
            const os =
              /\b(windows|unix|macos|ios|apple|darwin|msvc)\b/.test(cfgs) ||
              (/target_(os|family|env)/.test(cfgs) && /not\s*\(/.test(cfgs))
            if (os) expected.push(`${path}:${i + 1}`)
          })
        }
      }
    }
    walk('crates')
    walk('apps/desktop-tauri/src-tauri')
    assert.deepEqual(new Set(gated.map(([, , at]) => at)), new Set(expected))
  })

  it('adds its OS for an edit inside every cfg-gated module of the repo', () => {
    for (const [prefix, os] of gated) {
      const file = prefix.endsWith('.rs')
        ? prefix
        : [`${prefix}.rs`, `${prefix}/mod.rs`].find((f) => existsSync(join(repo, f)))
      if (!file) continue
      const patches = { [file]: hunk('-    old();', '+    new();') }
      const out = tier({ files: [file], patches, sourceRoot: repo })
      if (os !== 'mac') assert.notEqual(out.rust_windows, 'none', file)
      if (os !== 'win') assert.notEqual(out.rust_macos, 'none', file)
    }
  })
})

// The matrices the workflows build from the tier outputs (rust-legs.jq, tauri-builds.jq).
function rustLegs(out) {
  const result = spawnSync(
    'jq',
    [
      '-cn',
      '--arg',
      'full',
      String(out.full),
      '--arg',
      'macos',
      String(out.macos),
      '--arg',
      'intel',
      String(out.intel),
      '--arg',
      'win',
      out.rust_windows,
      '--arg',
      'mac',
      out.rust_macos,
      '-f',
      join(tierDir, 'rust-legs.jq')
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout).map(
    (l) => `${l.os} ${l.part}${l.partition ? ` ${l.partition}` : ''}`
  )
}

function tauriBuilds(out, queue = false) {
  const result = spawnSync(
    'jq',
    [
      '-cn',
      '--arg',
      'full',
      String(out.full),
      '--arg',
      'macos',
      String(out.macos),
      '--arg',
      'intel',
      String(out.intel),
      '--arg',
      'queue',
      String(queue),
      '--arg',
      'win',
      out.tauri_windows,
      '--arg',
      'mac',
      out.tauri_macos,
      '-f',
      join(tierDir, 'tauri-builds.jq')
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout).include.map(
    (b) => `${b.platform} ${b.variant}${b.shard ? ` ${b.shard}` : ''}`
  )
}

const linuxRust = ['ubuntu-22.04 checks', 'ubuntu-22.04 tests 1/2', 'ubuntu-22.04 tests 2/2']
const windowsRust = ['windows-2022 checks', 'windows-2022 tests 1/2', 'windows-2022 tests 2/2']
const armRust = ['windows-11-arm checks', 'windows-11-arm tests 1/2', 'windows-11-arm tests 2/2']
const linuxTauri = ['linux-x64 debug', 'linux-x64 e2e 1', 'linux-x64 e2e 2']

describe('ci matrices', () => {
  const shell = 'crates/memry-desktop/src/shell/paths.rs'
  const pr = (...lines) => tier({ files: [shell], patches: { [shell]: hunk(...lines) } })

  it('builds Linux only for a fast-tier PR without OS changes', () => {
    const out = pr('+    let b = 2;')
    assert.deepEqual(rustLegs(out), linuxRust)
    assert.deepEqual(tauriBuilds(out), linuxTauri)
  })

  it('adds the Windows and Apple Silicon checks and debug builds for an OS cfg', () => {
    const out = pr('+#[cfg(windows)]')
    assert.deepEqual(rustLegs(out), [...linuxRust, 'windows-2022 checks', 'macos-15 checks'])
    assert.deepEqual(tauriBuilds(out), ['macos-arm64 debug', 'windows-x64 debug', ...linuxTauri])
  })

  it('adds the whole Windows and Apple Silicon legs for OS-specific tests', () => {
    const out = pr('+#[cfg(windows)]', '+#[test]')
    assert.deepEqual(rustLegs(out), [...linuxRust, ...windowsRust, 'macos-15 all'])
    assert.deepEqual(tauriBuilds(out), [
      'macos-arm64 debug',
      'macos-arm64 e2e',
      'windows-x64 debug',
      'windows-x64 e2e 1',
      'windows-x64 e2e 2',
      ...linuxTauri
    ])
  })

  const fullTauri = [
    'macos-arm64 debug',
    'macos-arm64 e2e',
    'windows-x64 debug',
    'windows-x64 e2e 1',
    'windows-x64 e2e 2',
    'windows-arm64 debug',
    'windows-arm64 e2e',
    ...linuxTauri,
    'linux-arm64 debug',
    'linux-arm64 e2e'
  ]

  it('builds everything but Intel for a full-ci PR and a push to feat/tauri-v2', () => {
    for (const out of [
      tier({ labels: 'full-ci', files: [shell], patches: {} }),
      tier({ event: 'push', ref: 'refs/heads/feat/tauri-v2', base: '', files: [shell] })
    ]) {
      assert.deepEqual(rustLegs(out), [...linuxRust, 'macos-15 all', ...windowsRust, ...armRust])
      assert.deepEqual(tauriBuilds(out), fullTauri)
    }
  })

  it('builds no Mac and no windows-arm64 e2e in the merge queue', () => {
    const out = tier({ event: 'merge_group', base: '', files: [shell] })
    assert.deepEqual(rustLegs(out), [...linuxRust, ...windowsRust, ...armRust])
    assert.deepEqual(tauriBuilds(out, true), [
      'windows-x64 debug',
      'windows-x64 e2e 1',
      'windows-x64 e2e 2',
      'windows-arm64 debug',
      ...linuxTauri,
      'linux-arm64 debug',
      'linux-arm64 e2e'
    ])
  })

  it('adds Intel on a push to main', () => {
    const out = tier({ event: 'push', ref: 'refs/heads/main', base: '', listed: false, files: [] })
    assert.deepEqual(rustLegs(out), [
      ...linuxRust,
      'macos-15 all',
      'macos-15-intel all',
      ...windowsRust,
      ...armRust
    ])
    assert.deepEqual(tauriBuilds(out), [
      ...fullTauri.slice(0, 2),
      'macos-x64 debug',
      ...fullTauri.slice(2)
    ])
  })
})

// A file that adds an OS leg must also start the workflow: its `paths` gate (the plan job's include
// regex and the push filter) and, for Tauri, the `tauri` output.
describe('ci tier and the workflow path gates agree', () => {
  const workflows = {
    rust: '.github/workflows/rust-ci.yml',
    tauri: '.github/workflows/desktop-tauri-ci.yml'
  }
  const text = Object.fromEntries(
    Object.entries(workflows).map(([k, f]) => [k, readFileSync(join(repo, f), 'utf8')])
  )
  const include = Object.fromEntries(
    Object.entries(text).map(([k, t]) => [k, new RegExp(t.match(/include: '([^']+)'/)[1])])
  )

  it('starts each workflow for a change to every composite action it uses', () => {
    for (const [k, t] of Object.entries(text)) {
      for (const [, action] of t.matchAll(/uses: \.\/\.github\/actions\/([a-z0-9-]+)/g)) {
        assert.match(
          `.github/actions/${action}/action.yml`,
          include[k],
          `${workflows[k]}: ${action}`
        )
        assert.ok(
          t.includes(`- '.github/actions/${action}/**'`),
          `${workflows[k]} push paths: ${action}`
        )
      }
    }
  })

  it('starts the workflow for every file that adds one of its OS legs', () => {
    for (const file of [
      'apps/desktop-tauri/src-tauri/build.rs',
      'apps/desktop-tauri/src-tauri/src/power/win.rs',
      'crates/.cargo/config.toml',
      'crates/rust-toolchain.toml',
      'crates/Cargo.lock',
      'crates/memry-core/src/paths.rs',
      '.github/actions/ci-tier/tier.sh',
      '.github/actions/setup-pnpm/action.yml',
      '.github/actions/ort-static/action.yml',
      '.github/workflows/rust-ci.yml',
      '.github/workflows/desktop-tauri-ci.yml'
    ]) {
      const out = tier({ files: [file], patches: { [file]: hunk('+#[cfg(windows)]') } })
      if (out.rust_windows !== 'none' || out.rust_macos !== 'none')
        assert.match(file, include.rust, file)
      if (out.tauri_windows !== 'none' || out.tauri_macos !== 'none') {
        assert.match(file, include.tauri, file)
        assert.equal(out.tauri, true, file)
      }
    }
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
      ...allOsLegs,
      rust_linux_arm64: true
    })
  })
})
