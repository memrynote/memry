#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  archListIncludes,
  findPackagedMacApps,
  inferExpectedMacArch
} = require('./check-packaged-runtime-deps-utils.cjs')

const appRoot = path.resolve(__dirname, '..')
const productName = 'Memrynote'
// Resolved from inside app.asar under Electron (Electron reads asar; plain Node
// cannot). These are the modules the main process must be able to require at
// runtime once node_modules is packed into the archive.
const requiredModules = [
  '@tiptap/core',
  '@tiptap/pm/model',
  '@tiptap/pm/transform',
  'better-sqlite3',
  'keytar',
  'orderedmap',
  'prosemirror-model',
  'readable-stream',
  'safe-buffer',
  'string_decoder/',
  'y-leveldb'
]
// Native modules whose .node ABI/arch we verify against the target arch. Their
// real binaries live on disk under app.asar.unpacked (asarUnpack), so plain Node
// can lipo them even though the JS resolves inside the archive.
const nativeArchCheckedBinaries = {
  'better-sqlite3': 'better_sqlite3.node',
  keytar: 'keytar.node',
  'classic-level': 'classic_level.node'
}

function getPackagedElectronExecutable(resourcesPath) {
  const contentsPath = path.dirname(resourcesPath)
  const executable = path.join(contentsPath, 'MacOS', productName)
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

  return [
    {
      resourcesPath: path.join(absolutePath, 'Contents', 'Resources'),
      expectedArch: inferExpectedMacArch(absolutePath)
    }
  ]
}

// Layout-agnostic recursive search: pnpm's deploy tree nests real files under
// .pnpm/<pkg>@<ver>/node_modules/<pkg>/..., so hard-coding a package path is
// fragile. Find every binary by name under the unpacked tree instead.
function findFilesByName(rootDir, fileName) {
  const results = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name === fileName) {
        results.push(fullPath)
      }
    }
  }

  return results
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

// Resolve every required module and load every by-path native (their .node /
// .dylib are dlopen'd by absolute path, which is the classic asar footgun) from
// inside the archive, under Electron. Fails the gate if anything can't load.
function runElectronRuntimeSmoke(resourcesPath) {
  const electronExecutable = getPackagedElectronExecutable(resourcesPath)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-packaged-runtime-smoke-'))
  const smokeScriptPath = path.join(tempDir, 'smoke.cjs')
  const appMainPath = path.join(resourcesPath, 'app.asar', 'out', 'main', 'index.js')

  fs.writeFileSync(
    smokeScriptPath,
    `
const { createRequire } = require('node:module')

const packagedRequire = createRequire(process.env.MEMRY_PACKAGED_MAIN)

for (const moduleName of ${JSON.stringify(requiredModules)}) {
  packagedRequire.resolve(moduleName)
}

const Database = require(packagedRequire.resolve('better-sqlite3'))
const database = new Database(':memory:')

// vec0.dylib is loaded by absolute path via loadExtension — exercise it exactly
// as src/main/database/client.ts does so an asar-stranded dylib fails the gate.
const sqliteVec = require(packagedRequire.resolve('sqlite-vec'))
sqliteVec.load(database)
database.exec('CREATE VIRTUAL TABLE vec_smoke USING vec0(embedding float[4])')
database.close()

// keytar / onnxruntime-node / sharp each dlopen a native binary (and companion
// dylib) by path; requiring them validates those paths resolve under unpacked.
require(packagedRequire.resolve('keytar'))
require(packagedRequire.resolve('classic-level'))
require(packagedRequire.resolve('onnxruntime-node'))
require(packagedRequire.resolve('sharp'))

console.log('Packaged Electron runtime ABI ' + process.versions.modules)
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
      fail(`Packaged runtime modules do not load under Electron:\n${output}`)
      return
    }

    if (result.stdout) {
      process.stdout.write(result.stdout)
    }
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }
}

function checkResources(resourcesPath, expectedArch) {
  const appAsarPath = path.join(resourcesPath, 'app.asar')
  const unpackedNodeModulesPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules')

  if (!fs.existsSync(appAsarPath)) {
    fail(`Missing packaged app.asar: ${appAsarPath}`)
  }

  // node_modules is packed into app.asar; only native packages are unpacked here.
  if (!fs.existsSync(unpackedNodeModulesPath)) {
    fail(`Missing unpacked native node_modules: ${unpackedNodeModulesPath}`)
  }

  if (process.exitCode) {
    return
  }

  // Native ABI/arch check needs the real .node on disk (unpacked).
  for (const [moduleName, binaryName] of Object.entries(nativeArchCheckedBinaries)) {
    const matches = findFilesByName(unpackedNodeModulesPath, binaryName)
    if (matches.length === 0) {
      fail(
        `Missing unpacked native binary for "${moduleName}": ${binaryName} not found under ${unpackedNodeModulesPath}`
      )
      continue
    }

    for (const binaryPath of matches) {
      const archs = runLipoArchs(binaryPath)
      if (archs.length > 0 && !archListIncludes(archs, expectedArch)) {
        fail(
          `Packaged native module "${moduleName}" has wrong architecture for ${expectedArch}: ${binaryPath} (${archs.join(', ')})`
        )
      }
    }
  }

  if (process.exitCode) {
    return
  }

  if (expectedArch === process.arch) {
    runElectronRuntimeSmoke(resourcesPath)
  } else {
    console.log(
      `Skipping Electron runtime smoke for ${resourcesPath}; expected arch ${expectedArch} differs from host ${process.arch}`
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
