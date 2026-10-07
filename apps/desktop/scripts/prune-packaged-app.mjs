import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ARCH_NAMES = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal']
])

function resolveArchName(arch) {
  if (typeof arch === 'string') {
    return arch
  }

  return ARCH_NAMES.get(arch) ?? process.arch
}

function removePath(path) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
}

function getResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    )
  }

  return join(context.appOutDir, 'resources')
}

// onnxruntime-node ships its prebuilds under bin/napi-v<N>/<platform>/<arch>;
// N moved from 3 to 6 in 1.22, so every napi dir present is pruned.
function pruneOnnxRuntime(nodeModulesDir, platformName, archName) {
  const binRoot = join(nodeModulesDir, 'onnxruntime-node', 'bin')
  if (!existsSync(binRoot)) return
  for (const entry of readdirSync(binRoot)) {
    if (entry.startsWith('napi-v')) {
      pruneOnnxNapiDir(join(binRoot, entry), platformName, archName)
    }
  }
}

function pruneOnnxNapiDir(napiRoot, platformName, archName) {
  for (const platform of ['darwin', 'linux', 'win32']) {
    if (platform !== platformName) {
      removePath(join(napiRoot, platform))
    }
  }

  if (archName === 'universal') {
    return
  }

  const platformRoot = join(napiRoot, platformName)
  for (const arch of ['arm64', 'x64', 'ia32']) {
    if (arch !== archName) {
      removePath(join(platformRoot, arch))
    }
  }
}

// velopack ships a prebuilt for every platform it supports (~19 MB total) while its
// loader only ever requires the host's, so a packaged build keeps exactly one.
const VELOPACK_NATIVE_BINARIES = new Map([
  ['win32-x64', 'velopack_nodeffi_win_x64_msvc.node'],
  ['win32-ia32', 'velopack_nodeffi_win_x86_msvc.node'],
  ['win32-arm64', 'velopack_nodeffi_win_arm64_msvc.node'],
  ['darwin-x64', 'velopack_nodeffi_osx.node'],
  ['darwin-arm64', 'velopack_nodeffi_osx.node'],
  ['darwin-universal', 'velopack_nodeffi_osx.node'],
  ['linux-x64', 'velopack_nodeffi_linux_x64_gnu.node'],
  ['linux-arm64', 'velopack_nodeffi_linux_arm64_gnu.node']
])

function pruneVelopackNative(nodeModulesDir, platformName, archName) {
  const nativeDir = join(nodeModulesDir, 'velopack', 'lib', 'native')
  if (!existsSync(nativeDir)) {
    return
  }

  const keptBinary = VELOPACK_NATIVE_BINARIES.get(`${platformName}-${archName}`)
  const entries = readdirSync(nativeDir)
  if (!keptBinary || !entries.includes(keptBinary)) {
    return
  }

  for (const entry of entries) {
    if (entry.endsWith('.node') && entry !== keptBinary) {
      removePath(join(nativeDir, entry))
    }
  }
}

function pruneBetterSqliteBuildArtifacts(nodeModulesDir) {
  const betterSqliteRoot = join(nodeModulesDir, 'better-sqlite3')

  removePath(join(betterSqliteRoot, 'deps'))
  removePath(join(betterSqliteRoot, 'src'))
  removePath(join(betterSqliteRoot, 'build', 'deps'))
  removePath(join(betterSqliteRoot, 'build', 'Release', 'obj'))
  removePath(join(betterSqliteRoot, 'build', 'Release', 'test_extension.node'))
}

// tesseract.js-core ships every build for browsers and Node, about 45 MB. Under
// Node, tesseract.js 7.0.0 loads the full (legacy + LSTM) builds even for an
// LSTM-only worker: its worker script hands getCore a boolean where getCore
// expects an OEM number. So the kept set is tesseract-core.js, -simd.js and
// -relaxedsimd.js with the .wasm next to each. check-packaged-runtime-deps.js
// runs OCR through the packaged tree and fails if this set goes stale.
const TESSERACT_CORE_KEPT = /^tesseract-core(-simd|-relaxedsimd)?\.(js|wasm)$/

function pruneTesseractCore(nodeModulesDir) {
  const roots = [join(nodeModulesDir, 'tesseract.js-core')]
  const storeDir = join(nodeModulesDir, '.pnpm')
  if (existsSync(storeDir)) {
    for (const entry of readdirSync(storeDir)) {
      if (entry.startsWith('tesseract.js-core@')) {
        roots.push(join(storeDir, entry, 'node_modules', 'tesseract.js-core'))
      }
    }
  }

  for (const root of roots) {
    if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('tesseract-core') && !TESSERACT_CORE_KEPT.test(entry)) {
        removePath(join(root, entry))
      }
    }
  }
}

function relativizeInternalSymlinks(rootPath) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name)

    if (entry.isSymbolicLink()) {
      const targetPath = readlinkSync(entryPath)
      if (!isAbsolute(targetPath) || !targetPath.startsWith(rootPath)) {
        continue
      }

      unlinkSync(entryPath)
      symlinkSync(relative(dirname(entryPath), targetPath) || '.', entryPath)
      continue
    }

    if (entry.isDirectory()) {
      relativizeInternalSymlinks(entryPath)
    }
  }
}

const EVENTKIT_HELPER_NAME = 'memry-eventkit'

function findFileNamed(rootPath, fileName) {
  if (!existsSync(rootPath)) return null
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      // node_modules can only hold what pnpm installed, never the helper.
      if (entry.name === 'node_modules') continue
      const found = findFileNamed(entryPath, fileName)
      if (found) return found
    } else if (entry.name === fileName) {
      return entryPath
    }
  }
  return null
}

/**
 * The macOS Calendar bridge (#1405) ships in the mac app bundle and nowhere
 * else. A mac artifact without it would ship a provider that is always
 * unavailable; a Windows or Linux artifact with it would break the promise
 * that those builds carry no macOS-only code. Both fail the build.
 */
export function assertEventKitHelperPlacement(context) {
  if (context.electronPlatformName === 'darwin') {
    const helperPath = join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'MacOS',
      EVENTKIT_HELPER_NAME
    )
    if (!existsSync(helperPath)) {
      throw new Error(`macOS build is missing the EventKit helper at ${helperPath}`)
    }
    return
  }

  const stray = findFileNamed(context.appOutDir, EVENTKIT_HELPER_NAME)
  if (stray) {
    throw new Error(
      `${context.electronPlatformName} build must not contain the macOS EventKit helper: ${stray}`
    )
  }
}

const MAC_CALENDAR_USAGE_KEYS = [
  'NSCalendarsFullAccessUsageDescription',
  'NSCalendarsUsageDescription'
]

/**
 * Without a top-level calendar usage string, tccd refuses the EventKit request
 * without showing a dialog and EventKit never answers, so "This Mac" hangs on
 * Connecting. A `mac.extendInfo` written as a YAML list shipped exactly that.
 * Info.plist is written before afterPack runs. Mac builds only run on macOS
 * (Swift helper, signing), which is also where `plutil` exists.
 */
export function assertMacCalendarUsageStrings(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return
  const plistPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  )
  const missing = MAC_CALENDAR_USAGE_KEYS.filter((key) => {
    try {
      const value = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return value.trim().length === 0
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(
      `macOS Info.plist has no top-level ${missing.join(', ')} at ${plistPath}; check mac.extendInfo is a map`
    )
  }
}

export default async function prunePackagedApp(context) {
  assertEventKitHelperPlacement(context)
  assertMacCalendarUsageStrings(context)

  const resourcesDir = resolve(getResourcesDir(context))
  const archName = resolveArchName(context.arch)
  const nodeModulesDirs = [
    join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
    join(resourcesDir, 'node_modules')
  ]

  for (const nodeModulesDir of nodeModulesDirs) {
    if (!existsSync(nodeModulesDir)) {
      continue
    }

    const stat = lstatSync(nodeModulesDir)
    if (stat.isDirectory()) {
      relativizeInternalSymlinks(nodeModulesDir)
    }

    pruneOnnxRuntime(nodeModulesDir, context.electronPlatformName, archName)
    pruneVelopackNative(nodeModulesDir, context.electronPlatformName, archName)
    pruneBetterSqliteBuildArtifacts(nodeModulesDir)
    pruneTesseractCore(nodeModulesDir)
  }
}
