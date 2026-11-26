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
const { Worker } = require('node:worker_threads')

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

const GENUINE_BYTE = 7
const POISONED_BYTE = 0xba

/** Build a fixture big enough that extraction takes real time. */
function buildFixtureZip(root, { name = zipName, fillByte = GENUINE_BYTE } = {}) {
  const stage = path.join(root, `stage-${fillByte}`)
  const target = path.join(stage, platformPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, fillByte))
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(stage, `resource-${i}.pak`), Buffer.alloc(128 * 1024, i))
  }

  const zipPath = path.join(root, name)
  childProcess.execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: stage })
  return zipPath
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** The fill byte of the executable the installer actually left in `dist/`. */
function installedExecutableByte(electronDir) {
  return fs.readFileSync(path.join(electronDir, 'dist', platformPath))[0]
}

/** A `curl` earlier on PATH that serves the fixture instead of hitting GitHub. */
function buildCurlShim(root, fixtureZip, { fail = false, delayMs = CURL_DELAY_MS } = {}) {
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
sleep ${delayMs / 1000}
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
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify({ [zipName]: sha256(fixtureZip) })
  )
  return dir
}

function runInstaller(electronDir, binDir, tmpDir, extraEnv) {
  return childProcess.spawn(process.execPath, [INSTALLER, electronDir], {
    // A dedicated TMPDIR makes the installer's scratch dirs observable, so a leak
    // on any exit path is caught rather than hidden in the shared system tmp.
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TMPDIR: tmpDir,
      ...extraEnv
    },
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

// A reader on its own thread checks the install in a tight loop, so it lands inside
// windows a few syscalls wide that a timer-driven poll on the main thread misses.
const READER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
${readerSeesValidInstall}
let samples = 0
let broken = 0
let regressed = 0
let seenValid = false
while (Atomics.load(workerData.stop, 0) === 0) {
  samples++
  if (readerSeesValidInstall(workerData.electronDir)) {
    seenValid = true
  } else {
    broken++
    if (seenValid) regressed++
  }
}
parentPort.postMessage({ samples, broken, regressed })
`

/**
 * Run `action` while a concurrent reader checks the install. `broken` counts every
 * invalid read; `regressed` counts invalid reads after the reader had seen a valid one.
 */
async function readWhile(electronDir, action) {
  const stop = new Int32Array(new SharedArrayBuffer(4))
  const reader = new Worker(READER_SOURCE, { eval: true, workerData: { electronDir, stop } })
  const counts = new Promise((resolve, reject) => {
    reader.once('message', resolve)
    reader.once('error', reject)
  })
  await new Promise((resolve) => reader.once('online', resolve))
  const result = await action()
  Atomics.store(stop, 0, 1)
  return { result, ...(await counts) }
}

async function withFixture(run, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-install-electron-test-'))
  try {
    const fixtureZip = buildFixtureZip(root)
    const electronDir = buildElectronDir(root, fixtureZip)
    const defaultBinDir = buildCurlShim(root, fixtureZip, options)
    const tmpDir = path.join(root, 'tmp')
    fs.mkdirSync(tmpDir)
    // Not pre-created: the installer has to create its own cache directory.
    const cacheDir = path.join(root, 'cache')

    return await run({
      root,
      fixtureZip,
      electronDir,
      tmpDir,
      cacheDir,
      cachedZip: path.join(cacheDir, zipName),
      install: (binDir = defaultBinDir, extraEnv) =>
        runInstaller(electronDir, binDir, tmpDir, extraEnv)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// A caller checks the install, finds it missing, and spawns the installer. Another
// installer can finish in between, so the late one starts against a working install
// that other processes are already reading.
test(
  're-running the installer never breaks a working install for concurrent readers',
  { skip: unsupported },
  async () => {
    await withFixture(async ({ electronDir, install }) => {
      const seed = await settled(install())
      assert.equal(seed.code, 0, seed.output)
      assert.ok(readerSeesValidInstall(electronDir))

      const { result, samples, broken } = await readWhile(electronDir, () => settled(install()))

      assert.equal(result.code, 0, result.output)
      assert.ok(samples > 20, `expected a meaningful sample window, got ${samples}`)
      assert.equal(broken, 0, `reader saw a broken install in ${broken}/${samples} samples`)
    })
  }
)

// `require('electron')` re-runs Electron's own unlocked downloader on any invalid read,
// so a repair must never flip a reader that already sees the new install back to broken.
test(
  'repairing a lost dist/ never takes the new install away from a reader',
  { skip: unsupported },
  async () => {
    await withFixture(
      async ({ electronDir, install }) => {
        const seed = await settled(install())
        assert.equal(seed.code, 0, seed.output)

        // The window is a few syscalls wide, so one repair can miss it by luck.
        for (let repair = 0; repair < 10; repair++) {
          fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true })

          const { result, samples, regressed } = await readWhile(electronDir, () =>
            settled(install())
          )

          assert.equal(result.code, 0, result.output)
          assert.ok(readerSeesValidInstall(electronDir), 'the repair left dist/ unusable')
          assert.equal(
            regressed,
            0,
            `repair ${repair}: reader lost the new install in ${regressed}/${samples} samples`
          )
        }
      },
      { delayMs: 0 }
    )
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
      assert.match(combined, /already installed/)
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

test('a failed download leaves the existing dist/ intact', { skip: unsupported }, async () => {
  await withFixture(async ({ root, electronDir, fixtureZip, install }) => {
    const workingBin = buildCurlShim(path.join(root, 'ok'), fixtureZip)
    const seed = await settled(install(workingBin))
    assert.equal(seed.code, 0, seed.output)
    // A working install is never replaced, so lose the marker to force a reinstall.
    fs.rmSync(path.join(electronDir, 'path.txt'))

    const failingBin = buildCurlShim(path.join(root, 'bad'), fixtureZip, { fail: true })
    const failed = await settled(install(failingBin))

    assert.notEqual(failed.code, 0, 'expected the install to fail')
    assert.ok(
      fs.existsSync(path.join(electronDir, 'dist', platformPath)),
      'a failed install destroyed the existing dist/'
    )
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

// MEMRY_ELECTRON_CACHE_DIR keeps the release zip between runs so 16 parallel E2E
// shards stop pulling ~115 MB each from GitHub releases (curl 56 "Connection died"
// killed 4 of 16 shards before a single test ran). The cache is shared and writable
// by any branch on CI, and the artifact is an executable the job then runs, so every
// restored entry has to survive the same checksum gate as a fresh download.

test(
  'a cache miss downloads, installs, and populates the cache',
  { skip: unsupported },
  async () => {
    await withFixture(async ({ electronDir, fixtureZip, cacheDir, cachedZip, install }) => {
      const result = await settled(install(undefined, { MEMRY_ELECTRON_CACHE_DIR: cacheDir }))

      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /downloading electron-v0\.0\.0-test/)
      assert.doesNotMatch(result.output, /reusing the cached/)
      assert.ok(readerSeesValidInstall(electronDir))
      assert.equal(fs.existsSync(cachedZip), true, 'the artifact was not cached')
      assert.equal(sha256(cachedZip), sha256(fixtureZip), 'the cached artifact was corrupted')
      assert.deepEqual(fs.readdirSync(cacheDir), [zipName], 'a partial cache write was left behind')
    })
  }
)

test('a cache hit installs with no network access at all', { skip: unsupported }, async () => {
  await withFixture(async ({ root, electronDir, fixtureZip, cacheDir, install }) => {
    const workingBin = buildCurlShim(path.join(root, 'ok'), fixtureZip)
    const seed = await settled(install(workingBin, { MEMRY_ELECTRON_CACHE_DIR: cacheDir }))
    assert.equal(seed.code, 0, seed.output)
    // A fresh package, as after a version bump, with the cache already warm.
    fs.rmSync(path.join(electronDir, 'dist'), { recursive: true })
    fs.rmSync(path.join(electronDir, 'path.txt'))

    // Any download at all now fails, so a passing install proves the cache was used.
    const failingBin = buildCurlShim(path.join(root, 'bad'), fixtureZip, { fail: true })
    const cached = await settled(install(failingBin, { MEMRY_ELECTRON_CACHE_DIR: cacheDir }))

    assert.equal(cached.code, 0, cached.output)
    assert.match(cached.output, /reusing the cached electron-v0\.0\.0-test/)
    assert.doesNotMatch(cached.output, /downloading electron-v0\.0\.0-test/)
    assert.ok(readerSeesValidInstall(electronDir))
    assert.equal(installedExecutableByte(electronDir), GENUINE_BYTE)
  })
})

test('a poisoned cache entry is rejected and never extracted', { skip: unsupported }, async () => {
  await withFixture(async ({ root, electronDir, fixtureZip, cacheDir, cachedZip, install }) => {
    // A structurally valid zip carrying a different executable — exactly what a
    // cache-poisoning branch would plant. Only the checksum tells them apart.
    const poisoned = buildFixtureZip(path.join(root, 'attacker'), {
      name: 'poisoned.zip',
      fillByte: POISONED_BYTE
    })
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.copyFileSync(poisoned, cachedZip)

    const result = await settled(install(undefined, { MEMRY_ELECTRON_CACHE_DIR: cacheDir }))

    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /discarding unusable cached artifact/)
    assert.match(result.output, /Electron checksum mismatch/)
    // Rejection must fall back to a fresh download, not fail the job.
    assert.match(result.output, /downloading electron-v0\.0\.0-test/)
    assert.ok(readerSeesValidInstall(electronDir))
    assert.equal(
      installedExecutableByte(electronDir),
      GENUINE_BYTE,
      'the poisoned executable was installed'
    )
    assert.equal(sha256(cachedZip), sha256(fixtureZip), 'the poisoned entry was not replaced')
  })
})

test('an unusable cache directory never fails the install', { skip: unsupported }, async () => {
  await withFixture(async ({ root, electronDir, install }) => {
    // A file where the cache directory should be: mkdir and copy both fail.
    const blocked = path.join(root, 'blocked-cache')
    fs.writeFileSync(blocked, 'not a directory')

    const result = await settled(install(undefined, { MEMRY_ELECTRON_CACHE_DIR: blocked }))

    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /could not cache the artifact/)
    assert.ok(readerSeesValidInstall(electronDir))
  })
})
