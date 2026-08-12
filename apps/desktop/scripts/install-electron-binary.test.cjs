// Guards the concurrency behaviour of install-electron-binary.cjs.
//
// Several processes reach that script at once on one machine (`ensure-native.sh`
// from predev/prebuild/pretest:e2e, plus every Playwright worker via
// tests/e2e/utils/electron-lifecycle.ts). They all target the same `dist/`, and
// `require('electron')` throws "Electron failed to install correctly" whenever
// `path.txt` or `dist/` is missing — so a half-written install fails unrelated
// vitest suites at import time.
//
// These tests drive the real script end to end, offline: a `curl` shim earlier on
// PATH serves a fixture zip, and the real `unzip` extracts it.

const assert = require('node:assert/strict')
const test = require('node:test')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const INSTALLER = path.join(__dirname, 'install-electron-binary.cjs')
const VERSION = '0.0.0-test'
const CURL_DELAY_MS = 300

function hasCommand(command) {
  return childProcess.spawnSync('sh', ['-c', `command -v ${command}`]).status === 0
}

// The shim is a shell script and the swap relies on POSIX rename semantics.
const unsupported =
  process.platform === 'win32' || !hasCommand('zip') || !hasCommand('unzip')
    ? 'requires a POSIX shell with zip and unzip'
    : false

function platformPathFor(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

const platformPath = platformPathFor(process.platform)
const zipName = `electron-v${VERSION}-${process.platform}-${process.arch}.zip`

/** Build a fixture big enough that extraction takes real time. */
function buildFixtureZip(root) {
  const stage = path.join(root, 'stage')
  const target = path.join(stage, platformPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 7))
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(stage, `resource-${i}.pak`), Buffer.alloc(128 * 1024, i))
  }

  const zipPath = path.join(root, zipName)
  childProcess.execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: stage })
  return zipPath
}

/** A `curl` earlier on PATH that serves the fixture instead of hitting GitHub. */
function buildCurlShim(root, fixtureZip, { fail = false } = {}) {
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const shim = path.join(binDir, 'curl')
  fs.writeFileSync(
    shim,
    `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
sleep ${CURL_DELAY_MS / 1000}
${fail ? 'echo "curl: (22) simulated download failure" >&2; exit 22' : 'cp ' + JSON.stringify(fixtureZip) + ' "$out"'}
`
  )
  fs.chmodSync(shim, 0o755)
  return binDir
}

function buildElectronDir(root, fixtureZip) {
  const dir = path.join(root, 'electron-pkg')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'electron', version: VERSION })
  )
  const hash = crypto.createHash('sha256').update(fs.readFileSync(fixtureZip)).digest('hex')
  fs.writeFileSync(path.join(dir, 'checksums.json'), JSON.stringify({ [zipName]: hash }))
  return dir
}

function runInstaller(electronDir, binDir, tmpDir) {
  return childProcess.spawn(process.execPath, [INSTALLER, electronDir], {
    // A dedicated TMPDIR makes the installer's scratch dirs observable, so a leak
    // on any exit path is caught rather than hidden in the shared system tmp.
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function settled(child) {
  return new Promise((resolve) => {
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => resolve({ code, output }))
  })
}

/** The check `ensure-native.sh` and `node_modules/electron/index.js` both perform. */
function readerSeesValidInstall(electronDir) {
  try {
    const relativePath = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
    return relativePath ? fs.existsSync(path.join(electronDir, 'dist', relativePath)) : false
  } catch {
    return false
  }
}

async function withFixture(run, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-install-electron-test-'))
  try {
    const fixtureZip = buildFixtureZip(root)
    const electronDir = buildElectronDir(root, fixtureZip)
    const defaultBinDir = buildCurlShim(root, fixtureZip, options)
    const tmpDir = path.join(root, 'tmp')
    fs.mkdirSync(tmpDir)

    return await run({
      root,
      fixtureZip,
      electronDir,
      tmpDir,
      install: (binDir = defaultBinDir) => runInstaller(electronDir, binDir, tmpDir)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test(
  'a reinstall never exposes a half-written install to concurrent readers',
  { skip: unsupported },
  async () => {
    await withFixture(async ({ electronDir, install }) => {
      const seed = await settled(install())
      assert.equal(seed.code, 0, seed.output)
      assert.ok(readerSeesValidInstall(electronDir))

      let samples = 0
      let broken = 0
      const poll = setInterval(() => {
        samples++
        if (!readerSeesValidInstall(electronDir)) broken++
      }, 5)

      const reinstall = await settled(install())
      clearInterval(poll)

      assert.equal(reinstall.code, 0, reinstall.output)
      assert.ok(samples > 20, `expected a meaningful sample window, got ${samples}`)
      assert.equal(broken, 0, `reader saw a broken install in ${broken}/${samples} samples`)
    })
  }
)

test(
  'concurrent installs are serialised instead of corrupting dist/',
  { skip: unsupported },
  async () => {
    await withFixture(async ({ electronDir, tmpDir, install }) => {
      const [first, second] = await Promise.all([settled(install()), settled(install())])

      assert.equal(first.code, 0, first.output)
      assert.equal(second.code, 0, second.output)
      assert.ok(readerSeesValidInstall(electronDir), 'dist/ was left unusable')

      // Exactly one process should have done the work; the other waits and no-ops.
      const combined = `${first.output}${second.output}`
      assert.match(combined, /already installed by a concurrent run/)
      assert.equal(combined.match(/installing 0\.0\.0-test/g).length, 1)

      // The waiter returns before the download block, so its scratch dir has to be
      // cleaned up on that early-return path too.
      assert.deepEqual(fs.readdirSync(tmpDir), [], 'an install leaked a scratch directory')
    })
  }
)

test(
  'a lock left by a killed process is reclaimed, not waited on forever',
  { skip: unsupported },
  async () => {
    await withFixture(async ({ electronDir, install }) => {
      // A pid that cannot be running: recorded far in the past and never alive.
      const lockPath = path.join(electronDir, '.install-electron-binary.lock')
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, startedAt: 0 }))

      const result = await settled(install())

      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /clearing an abandoned install lock/)
      assert.ok(readerSeesValidInstall(electronDir))
      assert.equal(fs.existsSync(lockPath), false, 'lock file was not released')
    })
  }
)

test('a failed download leaves the previous install intact', { skip: unsupported }, async () => {
  await withFixture(async ({ root, electronDir, fixtureZip, tmpDir, install }) => {
    const workingBin = buildCurlShim(path.join(root, 'ok'), fixtureZip)
    const seed = await settled(install(workingBin))
    assert.equal(seed.code, 0, seed.output)

    const failingBin = buildCurlShim(path.join(root, 'bad'), fixtureZip, { fail: true })
    const failed = await settled(install(failingBin))

    assert.notEqual(failed.code, 0, 'expected the install to fail')
    assert.ok(readerSeesValidInstall(electronDir), 'a failed install destroyed the good one')
    assert.equal(
      fs.existsSync(path.join(electronDir, '.install-electron-binary.lock')),
      false,
      'lock file survived a failed install'
    )
    assert.deepEqual(
      fs.readdirSync(electronDir).filter((entry) => entry.startsWith('.dist-')),
      [],
      'staging directories were left behind'
    )
  })
})
