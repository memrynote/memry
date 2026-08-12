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

    console.log(`[electron] installing ${version} for ${platform}-${arch} from ${officialMirror}`)

    try {
      downloadArtifact(`${officialMirror}v${version}/${zipName}`, zipPath)
      validateChecksum(zipPath, expectedHash)
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
      fs.rmSync(tempDir, { recursive: true, force: true })
      fs.rmSync(stagingDir, { recursive: true, force: true })
      fs.rmSync(retiredDir, { recursive: true, force: true })
    }
  } finally {
    releaseInstallLock(lockPath)
  }
}

try {
  main()
} catch (error) {
  console.error(error.stack || String(error))
  process.exit(1)
}
