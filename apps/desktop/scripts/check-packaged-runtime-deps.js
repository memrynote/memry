#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const appRequire = createRequire(path.join(appRoot, 'package.json'))
const productName = 'memry'
const requiredModules = [
  '@tiptap/core',
  '@tiptap/pm/model',
  '@tiptap/pm/transform',
  'better-sqlite3',
  'orderedmap',
  'prosemirror-model',
  'readable-stream',
  'safe-buffer',
  'string_decoder/',
  'y-leveldb'
]

function getElectronExecutable() {
  const electronExecutable = appRequire('electron')
  if (typeof electronExecutable !== 'string') {
    throw new Error('Unable to resolve Electron executable from the desktop package')
  }

  return electronExecutable
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

function findDefaultAppBundle() {
  const candidates = [
    path.join(appRoot, 'dist', `mac-${process.arch}`, `${productName}.app`),
    path.join(appRoot, 'dist', 'mac-arm64', `${productName}.app`),
    path.join(appRoot, 'dist', 'mac', `${productName}.app`)
  ]

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function resolveResourcesPath(inputPath) {
  if (!inputPath) {
    const appBundle = findDefaultAppBundle()
    if (!appBundle) {
      throw new Error('No packaged mac app found under apps/desktop/dist')
    }

    return path.join(appBundle, 'Contents', 'Resources')
  }

  const absolutePath = path.resolve(inputPath)
  if (absolutePath.endsWith('.app')) {
    return path.join(absolutePath, 'Contents', 'Resources')
  }

  if (path.basename(absolutePath) === 'Resources') {
    return absolutePath
  }

  return path.join(absolutePath, 'Contents', 'Resources')
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
  const electronExecutable = getElectronExecutable()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-packaged-native-smoke-'))
  const smokeScriptPath = path.join(tempDir, 'smoke.cjs')
  const appMainPath = path.join(resourcesPath, 'app.asar', 'out', 'main', 'index.js')

  fs.writeFileSync(
    smokeScriptPath,
    `
const { createRequire } = require('node:module')

const packagedRequire = createRequire(process.env.MEMRY_PACKAGED_MAIN)
const Database = require(packagedRequire.resolve('better-sqlite3'))
const database = new Database(':memory:')
database.close()
require(packagedRequire.resolve('keytar'))
console.log(\`Electron native runtime ABI \${process.versions.modules}\`)
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

function main() {
  const resourcesPath = resolveResourcesPath(process.argv[2])
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

  const betterSqliteRoot = findPackageRoot(resolvedModules.get('better-sqlite3'), 'better-sqlite3')
  const betterSqliteBinary = path.join(betterSqliteRoot, 'build', 'Release', 'better_sqlite3.node')
  if (!fs.existsSync(betterSqliteBinary)) {
    fail(`Missing packaged better-sqlite3 binary: ${betterSqliteBinary}`)
  }

  const directElectronPath = path.join(externalNodeModulesPath, 'electron')
  if (fs.existsSync(directElectronPath)) {
    fail(`Packaged external node_modules should not include Electron: ${directElectronPath}`)
  }

  runElectronNativeSmoke(resourcesPath)

  if (!process.exitCode) {
    console.log(`Packaged runtime dependencies resolved from ${resourcesPath}`)
  }
}

main()
