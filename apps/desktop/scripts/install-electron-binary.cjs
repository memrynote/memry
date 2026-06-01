#!/usr/bin/env node

const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const electronDir = process.argv[2]
const officialMirror = 'https://github.com/electron/electron/releases/download/'

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

  fs.rmSync(distDir, { recursive: true, force: true })
  fs.rmSync(pathFile, { force: true })

  console.log(`[electron] installing ${version} for ${platform}-${arch} from ${officialMirror}`)

  const executablePath = path.join(distDir, platformPath)
  try {
    downloadArtifact(`${officialMirror}v${version}/${zipName}`, zipPath)
    validateChecksum(zipPath, expectedHash)
    extractArtifact(zipPath, distDir)

    const typeDefinitionsPath = path.join(distDir, 'electron.d.ts')
    if (fs.existsSync(typeDefinitionsPath)) {
      const targetTypeDefinitionsPath = path.join(electronDir, 'electron.d.ts')
      fs.rmSync(targetTypeDefinitionsPath, { force: true })
      fs.renameSync(typeDefinitionsPath, targetTypeDefinitionsPath)
    }

    fs.writeFileSync(pathFile, platformPath)

    if (!fs.existsSync(executablePath)) {
      throw new Error(`Electron binary was not found after install: ${executablePath}`)
    }

    console.log(`[electron] installed ${version} for ${platform}-${arch}: ${executablePath}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error.stack || String(error))
  process.exit(1)
}
