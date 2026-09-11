import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import prunePackagedApp from './prune-packaged-app.mjs'

const VELOPACK_BINARIES = [
  'velopack_nodeffi_win_x64_msvc.node',
  'velopack_nodeffi_win_x86_msvc.node',
  'velopack_nodeffi_win_arm64_msvc.node',
  'velopack_nodeffi_osx.node',
  'velopack_nodeffi_linux_x64_gnu.node',
  'velopack_nodeffi_linux_arm64_gnu.node'
]

function writeVelopackNative(nodeModulesDir) {
  const nativeDir = path.join(nodeModulesDir, 'velopack', 'lib', 'native')
  fs.mkdirSync(nativeDir, { recursive: true })
  for (const binary of VELOPACK_BINARIES) {
    fs.writeFileSync(path.join(nativeDir, binary), '')
  }

  return nativeDir
}

function createContext(appOutDir, electronPlatformName, arch) {
  return {
    electronPlatformName,
    arch,
    appOutDir,
    packager: { appInfo: { productFilename: 'Memrynote' } }
  }
}

test('win32 x64 keeps only the win x64 velopack binary in every node_modules dir', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-prune-velopack-'))
  try {
    const resourcesDir = path.join(appOutDir, 'resources')
    const nativeDirs = [
      writeVelopackNative(path.join(resourcesDir, 'node_modules')),
      writeVelopackNative(path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'))
    ]

    await prunePackagedApp(createContext(appOutDir, 'win32', 'x64'))

    for (const nativeDir of nativeDirs) {
      assert.deepEqual(fs.readdirSync(nativeDir), ['velopack_nodeffi_win_x64_msvc.node'])
    }
  } finally {
    fs.rmSync(appOutDir, { force: true, recursive: true })
  }
})

test('darwin universal keeps only the macOS velopack binary', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-prune-velopack-'))
  try {
    const nativeDir = writeVelopackNative(
      path.join(appOutDir, 'Memrynote.app', 'Contents', 'Resources', 'node_modules')
    )

    await prunePackagedApp(createContext(appOutDir, 'darwin', 'universal'))

    assert.deepEqual(fs.readdirSync(nativeDir), ['velopack_nodeffi_osx.node'])
  } finally {
    fs.rmSync(appOutDir, { force: true, recursive: true })
  }
})

test('a mapped binary that velopack no longer ships leaves the rest in place', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-prune-velopack-'))
  try {
    const nativeDir = writeVelopackNative(path.join(appOutDir, 'resources', 'node_modules'))
    fs.rmSync(path.join(nativeDir, 'velopack_nodeffi_win_arm64_msvc.node'))

    await prunePackagedApp(createContext(appOutDir, 'win32', 'arm64'))

    assert.equal(fs.readdirSync(nativeDir).length, VELOPACK_BINARIES.length - 1)
  } finally {
    fs.rmSync(appOutDir, { force: true, recursive: true })
  }
})

test('an unmapped platform-arch leaves every velopack binary in place', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-prune-velopack-'))
  try {
    const nativeDir = writeVelopackNative(path.join(appOutDir, 'resources', 'node_modules'))

    await prunePackagedApp(createContext(appOutDir, 'linux', 'armv7l'))

    assert.deepEqual(fs.readdirSync(nativeDir).sort(), [...VELOPACK_BINARIES].sort())
  } finally {
    fs.rmSync(appOutDir, { force: true, recursive: true })
  }
})
