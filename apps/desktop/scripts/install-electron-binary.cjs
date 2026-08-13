#!/usr/bin/env node

const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const electronDir = process.argv[2]
const officialMirror = 'https://github.com/electron/electron/releases/download/'

// Several processes can reach this script at once on one machine: `ensure-native.sh`
// (predev / prebuild / pretest:e2e / rebuild:electron) and every Playwright worker,
// which falls back to installing when `path.txt` is missing (see
// tests/e2e/utils/electron-lifecycle.ts, `workers: 2` locally). They all target the
// same `dist/`, so the install is serialised with a lock and swapped into place
// atomically — otherwise concurrent `unzip`s collide and readers of the package
// (`require('electron')` throws without `path.txt` + `dist/`) observe a half-written
// tree and fail with "Electron failed to install correctly".
const LOCK_POLL_MS = 250
const LOCK_STALE_MS = 10 * 60 * 1000

// Every CI job that needs a real Electron runtime re-downloads the ~115 MB release
// zip, and `Electron E2E full` fans out to 16 shards that all start at once — GitHub
// releases regularly drops those connections ("curl: (56) Connection died, tried 5
// times before giving up"), failing shards before a single test runs. When
// MEMRY_ELECTRON_CACHE_DIR is set the verified zip is kept there between runs, so the
// usual path does no network I/O at all. Unset (the default) behaves exactly as before.
//
// SECURITY: the artifact is an executable the job then runs, and on CI the cache is
// shared with — and writable by — every branch. A restored zip is therefore never
// trusted: it is copied into this run's scratch dir and hashed against the
// `checksums.json` that ships inside the `electron` npm package, the same gate a fresh
// download passes, before anything is extracted. Anything that does not match is
// deleted and re-downloaded rather than failing the job.
const cacheDir = process.env.MEMRY_ELECTRON_CACHE_DIR

if (!electronDir) {
  console.error('Usage: install-electron-binary.cjs <electron-package-dir>')
  process.exit(2)
}

const { version } = require(path.join(electronDir, 'package.json'))
const checksums = require(path.join(electronDir, 'checksums.json'))

delete process.env.ELECTRON_OVERRIDE_DIST_PATH
delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
process.env.ELECTRON_MIRROR = officialMirror
process.env.npm_config_electron_mirror = officialMirror
process.env.NPM_CONFIG_ELECTRON_MIRROR = officialMirror

function getPlatformPath(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

function getArch(platform) {
  let arch = process.env.npm_config_arch || process.arch

  if (
    platform === 'darwin' &&
    process.platform === 'darwin' &&
    arch === 'x64' &&
    process.env.npm_config_arch === undefined
  ) {
    try {
      const output = childProcess.execSync('sysctl -in sysctl.proc_translated')
      if (output.toString().trim() === '1') {
        arch = 'arm64'
      }
    } catch {
      // Rosetta detection is best effort, matching Electron's installer.
    }
  }

  return arch
}

function downloadArtifact(zipUrl, zipPath) {
  childProcess.execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--show-error',
      '--silent',
      '--retry',
      '3',
      '--retry-delay',
      '2',
      '--output',
      zipPath,
      zipUrl
    ],
    { stdio: 'inherit' }
  )
}

function extractArtifact(zipPath, distDir) {
  childProcess.execFileSync('unzip', ['-q', zipPath, '-d', distDir], { stdio: 'inherit' })
}

function validateChecksum(zipPath, expectedHash) {
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
  if (actualHash !== expectedHash) {
    throw new Error(`Electron checksum mismatch: expected ${expectedHash}, got ${actualHash}`)
  }
}

/** `fs.rmSync(..., { force: true })` still throws on e.g. ENOTDIR; cleanup must not. */
function removeQuietly(target) {
  try {
    fs.rmSync(target, { force: true })
  } catch {
    // Nothing useful to do: the cache is advisory.
  }
}

/**
 * Copy a cached artifact into this run's scratch dir and verify it. Returns false —
 * after discarding the entry — for anything missing, unreadable or tampered with, so
 * the caller falls back to a fresh download instead of failing.
 */
function restoreFromCache(cachedZipPath, zipPath, expectedHash) {
  if (!fs.existsSync(cachedZipPath)) {
    return false
  }

  try {
    // Copy first and hash the copy, so the bytes that get extracted are exactly the
    // bytes that were verified even if the cache entry changes underneath us.
    fs.copyFileSync(cachedZipPath, zipPath)
    validateChecksum(zipPath, expectedHash)
    return true
  } catch (error) {
    console.log(`[electron] discarding unusable cached artifact: ${error.message}`)
    removeQuietly(zipPath)
    removeQuietly(cachedZipPath)
    return false
  }
}

/** Best effort: a cache write must never be the reason an install fails. */
function storeInCache(zipPath, cachedZipPath) {
  const pendingPath = `${cachedZipPath}.${process.pid}.partial`

  try {
    fs.mkdirSync(path.dirname(cachedZipPath), { recursive: true })
    fs.copyFileSync(zipPath, pendingPath)
    // Publish with a rename so a concurrent reader never sees a half-copied zip.
    fs.renameSync(pendingPath, cachedZipPath)
  } catch (error) {
    removeQuietly(pendingPath)
    console.log(`[electron] could not cache the artifact: ${error.message}`)
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === 'EPERM'
  }
}

function isLockAbandoned(lockPath) {
  let holder
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    // Unreadable or torn lock file: treat as abandoned rather than wait forever.
    return true
  }

  if (isProcessAlive(holder.pid)) {
    // Backstop for a live-but-wedged holder, so this can never deadlock.
    return Date.now() - holder.startedAt > LOCK_STALE_MS
  }

  return true
}

/**
 * Take an exclusive install lock for `electronDir`. Returns `{ contended }` so the
 * caller can skip a redundant download when another process just did the work.
 * Recovers from a lock left behind by a killed process.
 */
function acquireInstallLock(lockPath) {
  let contended = false

  for (;;) {
    try {
      const handle = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
      fs.closeSync(handle)
      return { contended }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }

    if (!contended) {
      contended = true
      console.log('[electron] another install is in progress — waiting for it to finish')
    }

    if (isLockAbandoned(lockPath)) {
      console.log('[electron] clearing an abandoned install lock')
      fs.rmSync(lockPath, { force: true })
      continue
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS)
  }
}

function releaseInstallLock(lockPath) {
  fs.rmSync(lockPath, { force: true })
}

function hasValidInstall(distDir, pathFile, platformPath) {
  try {
    return (
      fs.readFileSync(pathFile, 'utf8').trim() === platformPath &&
      fs.existsSync(path.join(distDir, platformPath))
    )
  } catch {
    return false
  }
}

/**
 * Remove staging/retired trees from a previous run that was killed mid-install.
 * Safe because the caller holds the install lock.
 */
function sweepStaleWorkDirs(electronDir) {
  let entries = []
  try {
    entries = fs.readdirSync(electronDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.startsWith('.dist-staging-') || entry.startsWith('.dist-retired-')) {
      fs.rmSync(path.join(electronDir, entry), { recursive: true, force: true })
    }
  }
}

function main() {
  const platform = process.env.npm_config_platform || process.platform
  const arch = getArch(platform)
  const platformPath = getPlatformPath(platform)
  const distDir = path.join(electronDir, 'dist')
  const pathFile = path.join(electronDir, 'path.txt')
  const zipName = `electron-v${version}-${platform}-${arch}.zip`
  const expectedHash = checksums[zipName]
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-electron-'))
  const zipPath = path.join(tempDir, zipName)
  // Keyed by the exact zip name, so a version/platform/arch change can never reuse a
  // stale artifact even if the cache entry itself was restored too loosely.
  const cachedZipPath = cacheDir ? path.join(cacheDir, zipName) : null

  if (!expectedHash) {
    throw new Error(`No Electron checksum found for ${zipName}`)
  }

  const executablePath = path.join(distDir, platformPath)
  const lockPath = path.join(electronDir, '.install-electron-binary.lock')
  // Staging and retired trees live beside `dist/` so the swap below is a rename on
  // the same filesystem; `os.tmpdir()` can be a different device (EXDEV).
  const stagingDir = path.join(electronDir, `.dist-staging-${process.pid}`)
  const retiredDir = path.join(electronDir, `.dist-retired-${process.pid}`)

  const { contended } = acquireInstallLock(lockPath)

  try {
    // Another process held the lock and may have just completed the install.
    if (contended && hasValidInstall(distDir, pathFile, platformPath)) {
      console.log(`[electron] ${version} already installed by a concurrent run: ${executablePath}`)
      return
    }

    sweepStaleWorkDirs(electronDir)

    console.log(`[electron] installing ${version} for ${platform}-${arch}`)

    try {
      if (cachedZipPath && restoreFromCache(cachedZipPath, zipPath, expectedHash)) {
        console.log(`[electron] reusing the cached ${zipName} from ${cacheDir}`)
      } else {
        console.log(`[electron] downloading ${zipName} from ${officialMirror}`)
        downloadArtifact(`${officialMirror}v${version}/${zipName}`, zipPath)
        validateChecksum(zipPath, expectedHash)

        if (cachedZipPath) {
          storeInCache(zipPath, cachedZipPath)
        }
      }

      extractArtifact(zipPath, stagingDir)

      // Validate the staged tree before the live `dist/` is touched at all, so a
      // failed download can never leave the package worse than it started.
      const stagedExecutablePath = path.join(stagingDir, platformPath)
      if (!fs.existsSync(stagedExecutablePath)) {
        throw new Error(`Electron binary was not found after install: ${stagedExecutablePath}`)
      }

      const typeDefinitionsPath = path.join(stagingDir, 'electron.d.ts')
      if (fs.existsSync(typeDefinitionsPath)) {
        const targetTypeDefinitionsPath = path.join(electronDir, 'electron.d.ts')
        fs.rmSync(targetTypeDefinitionsPath, { force: true })
        fs.renameSync(typeDefinitionsPath, targetTypeDefinitionsPath)
      }

      // Swap: two renames, so the window where `dist/` is absent is microseconds
      // instead of the whole download+extract. `path.txt` is the commit marker and
      // is written last — and never removed — so a reader either sees the previous
      // install or the new one.
      if (fs.existsSync(distDir)) {
        fs.renameSync(distDir, retiredDir)
      }
      fs.renameSync(stagingDir, distDir)
      fs.writeFileSync(pathFile, platformPath)

      console.log(`[electron] installed ${version} for ${platform}-${arch}: ${executablePath}`)
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true })
      fs.rmSync(retiredDir, { recursive: true, force: true })
    }
  } finally {
    // `tempDir` is created before the lock, so it must be cleaned up on the
    // early-return path too.
    fs.rmSync(tempDir, { recursive: true, force: true })
    releaseInstallLock(lockPath)
  }
}

try {
  main()
} catch (error) {
  console.error(error.stack || String(error))
  process.exit(1)
}
