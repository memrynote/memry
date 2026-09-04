#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const {
  archListIncludes,
  findPackagedMacApps,
  inferExpectedMacArch
} = require('./check-packaged-runtime-deps-utils.cjs')

const appRoot = path.resolve(__dirname, '..')
const productName = 'Memrynote'
// Must match package.json `dependencies` — the native/unbundleable modules
// that ship loose next to app.asar. Everything else is bundled into out/.
const requiredModules = [
  '@huggingface/transformers',
  '@mixmark-io/domino',
  'better-sqlite3',
  // electron-log is pure JS but unbundleable: its entry picks the
  // main/renderer/node implementation via runtime `require()` branches, and
  // bundling hoists all three — including main's `require('electron')`, which
  // crashes worker_threads (sync/image/voice workers). Ship it loose.
  'electron-log',
  'jsdom',
  'keytar',
  'libsodium-wrappers-sumo',
  'sharp',
  'sqlite-vec',
  'y-leveldb',
  'yjs'
]
const nativeArchCheckedModules = ['better-sqlite3', 'keytar']

function getPackagedElectronExecutable(resourcesPath) {
  const contentsPath = path.dirname(resourcesPath)
  const executable =
    process.platform === 'win32'
      ? path.join(contentsPath, `${productName}.exe`)
      : path.join(contentsPath, 'MacOS', productName)
  if (!fs.existsSync(executable)) {
    throw new Error(`Missing packaged Electron executable: ${executable}`)
  }

  return executable
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

function resolveResourcesCheck(inputPath) {
  if (!inputPath) {
    const appBundles = findPackagedMacApps(appRoot, productName)
    if (appBundles.length === 0) {
      throw new Error('No packaged mac app found under apps/desktop/dist')
    }

    return appBundles.map((appBundle) => ({
      resourcesPath: path.join(appBundle, 'Contents', 'Resources'),
      expectedArch: inferExpectedMacArch(appBundle)
    }))
  }

  const absolutePath = path.resolve(inputPath)
  if (absolutePath.endsWith('.app')) {
    return [
      {
        resourcesPath: path.join(absolutePath, 'Contents', 'Resources'),
        expectedArch: inferExpectedMacArch(absolutePath)
      }
    ]
  }

  if (path.basename(absolutePath) === 'Resources') {
    return [
      {
        resourcesPath: absolutePath,
        expectedArch: process.arch
      }
    ]
  }

  // Windows/Linux unpacked layout (e.g. dist/win-unpacked): resources/ sits
  // next to the executable instead of inside a mac bundle.
  if (fs.existsSync(path.join(absolutePath, 'resources'))) {
    return [
      {
        resourcesPath: path.join(absolutePath, 'resources'),
        expectedArch: process.arch
      }
    ]
  }

  return [
    {
      resourcesPath: path.join(absolutePath, 'Contents', 'Resources'),
      expectedArch: inferExpectedMacArch(absolutePath)
    }
  ]
}

function findPackageRoot(resolvedPath, packageName) {
  let current = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : path.dirname(resolvedPath)
  const root = path.parse(current).root

  while (current !== root) {
    const packageJsonPath = path.join(current, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      if (packageJson.name === packageName) {
        return current
      }
    }

    current = path.dirname(current)
  }

  throw new Error(`Unable to locate ${packageName} package root from ${resolvedPath}`)
}

function assertPackagedPath(moduleName, resolvedPath, resourcesPath) {
  const realResolvedPath = fs.realpathSync(resolvedPath)
  const realResourcesPath = fs.realpathSync(resourcesPath)

  if (!realResolvedPath.startsWith(`${realResourcesPath}${path.sep}`)) {
    fail(`Packaged runtime module "${moduleName}" resolved outside the app: ${realResolvedPath}`)
  }
}

function runElectronNativeSmoke(resourcesPath) {
  const electronExecutable = getPackagedElectronExecutable(resourcesPath)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-packaged-native-smoke-'))
  const smokeScriptPath = path.join(tempDir, 'smoke.cjs')
  const appMainPath = path.join(resourcesPath, 'app.asar', 'out', 'main', 'index.js')

  fs.writeFileSync(
    smokeScriptPath,
    `
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const packagedRequire = createRequire(process.env.MEMRY_PACKAGED_MAIN)
const Database = require(packagedRequire.resolve('better-sqlite3'))
const database = new Database(':memory:')
database.close()
require(packagedRequire.resolve('keytar'))

// classic-level backs the CRDT store. A binary built for the wrong ABI does
// not fail at require() — it fails at open() with napi_create_reference errors
// thrown out-of-band, hangs its callbacks (shipped broken in 2026.705.1: first
// keystroke crashed the editor), or access-violates on the first write (#1988,
// win32). Probe through y-leveldb, not classic-level directly: the CRDT store
// loads its own copy through level, which is a different resolution than a bare
// require('classic-level') and was the copy left unrebuilt in #1988.
const Y = require(packagedRequire.resolve('yjs'))
const { LeveldbPersistence } = require(packagedRequire.resolve('y-leveldb'))
const levelDbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-store-smoke-'))
const PROBE_DOC = '__memry_packaged_smoke__'

const timer = setTimeout(() => {
  console.error('CRDT store smoke timed out — native binding hangs under packaged Electron')
  process.exit(1)
}, 30000)

;(async () => {
  const persistence = new LeveldbPersistence(levelDbPath)
  const doc = new Y.Doc()
  doc.getMap('probe').set('ok', true)
  await persistence.storeUpdate(PROBE_DOC, Y.encodeStateAsUpdate(doc))
  doc.destroy()

  const loaded = await persistence.getYDoc(PROBE_DOC)
  const value = loaded.getMap('probe').get('ok')
  loaded.destroy()
  if (value !== true) {
    throw new Error(\`CRDT store probe read mismatch: \${value}\`)
  }

  await persistence.clearDocument(PROBE_DOC)
  await persistence.destroy()
  clearTimeout(timer)
  fs.rmSync(levelDbPath, { force: true, recursive: true })
  console.log(\`Electron native runtime ABI \${process.versions.modules}\`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`.trimStart()
  )

  try {
    const result = spawnSync(electronExecutable, [smokeScriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MEMRY_PACKAGED_MAIN: appMainPath
      }
    })

    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      fail(`Packaged native modules do not load under Electron:\n${output}`)
      return
    }
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }
}

function runLipoArchs(binaryPath) {
  if (process.platform !== 'darwin') {
    return []
  }

  const result = spawnSync('lipo', ['-archs', binaryPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`Unable to inspect native binary architecture for ${binaryPath}:\n${output}`)
    return []
  }

  return result.stdout.trim().split(/\s+/).filter(Boolean)
}

function assertNativeModuleArch(moduleName, resolvedPath, expectedArch) {
  const packageRoot = findPackageRoot(resolvedPath, moduleName)
  const releaseDir = path.join(packageRoot, 'build', 'Release')
  if (!fs.existsSync(releaseDir)) {
    return
  }

  for (const entry of fs.readdirSync(releaseDir)) {
    if (!entry.endsWith('.node')) {
      continue
    }

    const binaryPath = path.join(releaseDir, entry)
    const archs = runLipoArchs(binaryPath)
    if (archs.length > 0 && !archListIncludes(archs, expectedArch)) {
      fail(
        `Packaged native module "${moduleName}" has wrong architecture for ${expectedArch}: ${binaryPath} (${archs.join(', ')})`
      )
    }
  }
}

/**
 * The CRDT store's classic-level must be compiled for Electron, not the upstream
 * Node prebuild.
 *
 * @electron/rebuild silently leaves it as a prebuild under pnpm: its walker never
 * descends into y-leveldb's sibling `level` -> `classic-level` copy, and
 * `Prebuildify.findPrebuiltModule` short-circuits the compile whenever a
 * `node.napi.node` is present. v2026.903.2 shipped to Windows that way and every
 * install access-violated on the first store write (#1988). A `build/Release`
 * binary is the only observable proof the rebuild actually ran, so assert it here
 * rather than trusting the rebuild step's exit code.
 *
 * Resolved through y-leveldb, because that is the chain the main process uses; a
 * bare require('classic-level') can land on a different copy.
 */
function assertCrdtClassicLevelBuiltFromSource(yLeveldbEntry) {
  let classicLevelRoot
  try {
    const yLeveldbRoot = findPackageRoot(yLeveldbEntry, 'y-leveldb')
    const levelEntry = createRequire(path.join(yLeveldbRoot, 'package.json')).resolve('level')
    const levelRoot = findPackageRoot(levelEntry, 'level')
    const classicLevelEntry = createRequire(path.join(levelRoot, 'package.json')).resolve(
      'classic-level'
    )
    classicLevelRoot = findPackageRoot(classicLevelEntry, 'classic-level')
  } catch (error) {
    fail(`Cannot resolve the CRDT store's classic-level from y-leveldb: ${error.message}`)
    return
  }

  const releaseDir = path.join(classicLevelRoot, 'build', 'Release')
  const builtBinaries = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter((entry) => entry.endsWith('.node'))
    : []

  if (builtBinaries.length === 0) {
    fail(
      `Packaged classic-level was never rebuilt for Electron: no build/Release binary in ${classicLevelRoot}. ` +
        'Run apps/desktop/scripts/ensure-native.sh electron before packaging.'
    )
  }
}

function checkResources(resourcesPath, expectedArch) {
  const appAsarPath = path.join(resourcesPath, 'app.asar')
  const externalNodeModulesPath = path.join(resourcesPath, 'node_modules')

  if (!fs.existsSync(appAsarPath)) {
    fail(`Missing packaged app.asar: ${appAsarPath}`)
  }

  if (!fs.existsSync(externalNodeModulesPath)) {
    fail(`Missing external production node_modules: ${externalNodeModulesPath}`)
  }

  if (process.exitCode) {
    return
  }

  const packagedRequire = createRequire(path.join(appAsarPath, 'out', 'main', 'index.js'))
  const resolvedModules = new Map()

  for (const moduleName of requiredModules) {
    try {
      const resolvedPath = packagedRequire.resolve(moduleName)
      resolvedModules.set(moduleName, resolvedPath)
      assertPackagedPath(moduleName, resolvedPath, resourcesPath)
    } catch (error) {
      fail(`Cannot resolve packaged runtime module "${moduleName}": ${error.message}`)
    }
  }

  if (process.exitCode) {
    return
  }

  for (const moduleName of nativeArchCheckedModules) {
    assertNativeModuleArch(moduleName, resolvedModules.get(moduleName), expectedArch)
  }

  if (process.exitCode) {
    return
  }

  const betterSqliteRoot = findPackageRoot(resolvedModules.get('better-sqlite3'), 'better-sqlite3')
  const betterSqliteBinary = path.join(betterSqliteRoot, 'build', 'Release', 'better_sqlite3.node')
  if (!fs.existsSync(betterSqliteBinary)) {
    fail(`Missing packaged better-sqlite3 binary: ${betterSqliteBinary}`)
  }

  assertCrdtClassicLevelBuiltFromSource(resolvedModules.get('y-leveldb'))

  const directElectronPath = path.join(externalNodeModulesPath, 'electron')
  if (fs.existsSync(directElectronPath)) {
    fail(`Packaged external node_modules should not include Electron: ${directElectronPath}`)
  }

  if (expectedArch === process.arch) {
    runElectronNativeSmoke(resourcesPath)
  } else {
    console.log(
      `Skipping Electron native smoke for ${resourcesPath}; expected arch ${expectedArch} differs from host ${process.arch}`
    )
  }

  if (!process.exitCode) {
    console.log(`Packaged runtime dependencies resolved from ${resourcesPath} (${expectedArch})`)
  }
}

function main() {
  for (const check of resolveResourcesCheck(process.argv[2])) {
    checkResources(check.resourcesPath, check.expectedArch)
  }
}

main()
