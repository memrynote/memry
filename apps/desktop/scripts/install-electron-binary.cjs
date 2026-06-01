#!/usr/bin/env node

const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const electronDir = process.argv[2]
const officialMirror = 'https://github.com/electron/electron/releases/download/'

if (!electronDir) {
  console.error('Usage: install-electron-binary.cjs <electron-package-dir>')
  process.exit(2)
}

const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronDir] }))
const extract = require(require.resolve('extract-zip', { paths: [electronDir] }))
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

async function main() {
  const platform = process.env.npm_config_platform || process.platform
  const arch = getArch(platform)
  const platformPath = getPlatformPath(platform)
  const distDir = path.join(electronDir, 'dist')
  const pathFile = path.join(electronDir, 'path.txt')

  await fs.promises.rm(distDir, { recursive: true, force: true })
  await fs.promises.rm(pathFile, { force: true })

  console.log(`[electron] installing ${version} for ${platform}-${arch} from ${officialMirror}`)

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: true,
    cacheRoot: process.env.electron_config_cache,
    checksums,
    platform,
    arch,
    mirrorOptions: {
      mirror: officialMirror
    }
  })

  await extract(zipPath, { dir: distDir })

  const typeDefinitionsPath = path.join(distDir, 'electron.d.ts')
  if (fs.existsSync(typeDefinitionsPath)) {
    const targetTypeDefinitionsPath = path.join(electronDir, 'electron.d.ts')
    await fs.promises.rm(targetTypeDefinitionsPath, { force: true })
    await fs.promises.rename(typeDefinitionsPath, targetTypeDefinitionsPath)
  }

  await fs.promises.writeFile(pathFile, platformPath)

  const executablePath = path.join(distDir, platformPath)
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Electron binary was not found after install: ${executablePath}`)
  }

  console.log(`[electron] installed ${version} for ${platform}-${arch}`)
}

main().catch((error) => {
  console.error(error.stack || String(error))
  process.exit(1)
})
