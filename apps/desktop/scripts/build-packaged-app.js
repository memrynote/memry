#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')
const appRequire = createRequire(path.join(appRoot, 'package.json'))
const electronBuilderCli = appRequire.resolve('electron-builder/cli.js')
const electronVersion = appRequire('electron/package.json').version
const { parse } = require('dotenv')
const {
  assertProductionSyncServerUrl,
  resolveTargetArch
} = require('./build-packaged-app-utils.cjs')
const stageRoot =
  process.platform === 'win32' ? path.join(repoRoot, '.memry-desktop-package.tmp') : os.tmpdir()
fs.mkdirSync(stageRoot, { recursive: true })
const stageDir = fs.mkdtempSync(path.join(stageRoot, 'memry-desktop-package-'))
const distDir = path.join(appRoot, 'dist')
const defaultConfigPath = 'config/electron-builder.staged.yml'
const runtimeEnvName = 'production'
const runtimeEnvFile = `.env.${runtimeEnvName}`
const nativeModules = ['better-sqlite3', 'classic-level', 'keytar']
const generateIconsScript = path.join(appRoot, 'scripts', 'generate-icons.mjs')
const osxSignWalkPatchScript = path.join(appRoot, 'scripts', 'patch-osx-sign-walk.js')
const electronBuilderUlimitScript = path.join(appRoot, 'scripts', 'run-with-builder-ulimit.sh')
const pnpmCli = resolveBundledPnpmCli()

function resolveBundledPnpmCli() {
  const nodeBinDir = path.dirname(process.execPath)
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(nodeBinDir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
          path.resolve(nodeBinDir, '..', 'node_modules', 'corepack', 'dist', 'pnpm.js')
        ]
      : [
          path.resolve(nodeBinDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
          path.join(nodeBinDir, 'pnpm')
        ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error('Unable to resolve the Corepack pnpm CLI next to the active Node runtime')
}

function removePath(targetPath) {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false })
  if (!stat) {
    return
  }

  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetPath)
    return
  }

  fs.rmSync(targetPath, { force: true, recursive: true })
}

function getPnpmDeployTarget() {
  if (process.platform === 'win32') {
    return path.relative(repoRoot, stageDir)
  }

  return stageDir
}

function runPnpm(args, options = {}) {
  execFileSync(process.execPath, [pnpmCli, ...args], { stdio: 'inherit', shell: false, ...options })
}

function parseElectronBuilderArgs(argv) {
  const args = []
  let configPath = defaultConfigPath

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error(`${arg} requires a config path`)
      }

      configPath = value
      index += 1
      continue
    }

    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length)
      continue
    }

    args.push(arg)
  }

  return { args, configPath }
}

function syncIntoStage(relativePath, { optional = false } = {}) {
  const sourcePath = path.join(appRoot, relativePath)
  const destinationPath = path.join(stageDir, relativePath)

  if (!fs.existsSync(sourcePath)) {
    if (optional) {
      return
    }

    throw new Error(`Missing required packaging path: ${sourcePath}`)
  }

  removePath(destinationPath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.cpSync(sourcePath, destinationPath, {
    dereference: false,
    force: true,
    recursive: true,
    verbatimSymlinks: true
  })
}

function readRuntimeEnv() {
  const runtimeEnvPath = path.join(appRoot, runtimeEnvFile)
  if (!fs.existsSync(runtimeEnvPath)) {
    throw new Error(`Missing apps/desktop/${runtimeEnvFile}`)
  }

  const runtimeEnv = parse(fs.readFileSync(runtimeEnvPath, 'utf8'))
  assertProductionSyncServerUrl(runtimeEnv.SYNC_SERVER_URL)
  return runtimeEnv
}

function relativizeInternalSymlinks(rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name)

    if (entry.isSymbolicLink()) {
      const targetPath = fs.readlinkSync(entryPath)
      if (!path.isAbsolute(targetPath) || !targetPath.startsWith(stageDir)) {
        continue
      }

      const relativeTargetPath = path.relative(path.dirname(entryPath), targetPath)
      fs.unlinkSync(entryPath)
      fs.symlinkSync(relativeTargetPath || '.', entryPath)
      continue
    }

    if (entry.isDirectory()) {
      relativizeInternalSymlinks(entryPath)
    }
  }
}

function ensureBuildResources() {
  execFileSync(process.execPath, [generateIconsScript], {
    stdio: 'inherit',
    shell: false,
    cwd: appRoot
  })
}

function runElectronBuilder(args, options = {}) {
  if (process.platform !== 'darwin') {
    execFileSync(process.execPath, [electronBuilderCli, ...args], {
      stdio: 'inherit',
      shell: false,
      ...options
    })
    return
  }

  const nodeOptions = [options.env?.NODE_OPTIONS, `--require=${osxSignWalkPatchScript}`]
    .filter(Boolean)
    .join(' ')

  execFileSync(
    '/bin/bash',
    [electronBuilderUlimitScript, process.execPath, electronBuilderCli, ...args],
    {
      ...options,
      stdio: 'inherit',
      shell: false,
      env: {
        ...options.env,
        NODE_OPTIONS: nodeOptions
      }
    }
  )
}

function main() {
  const { args, configPath } = parseElectronBuilderArgs(process.argv.slice(2))

  if (args.length === 0) {
    throw new Error(
      'Usage: node scripts/build-packaged-app.js [--config path] <electron-builder-args...>'
    )
  }

  const runtimeEnv = readRuntimeEnv()
  const targetArch = resolveTargetArch(args)

  runPnpm(['--filter', '@memry/desktop', 'deploy', '--legacy', '--prod', getPnpmDeployTarget()], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SKIP_ELECTRON_REBUILD: '1'
    }
  })

  ensureBuildResources()
  syncIntoStage('build')
  syncIntoStage('config')
  syncIntoStage('out')
  syncIntoStage('scripts')
  syncIntoStage(runtimeEnvFile)
  removePath(path.join(stageDir, 'node_modules', '@memry', 'desktop'))
  removePath(path.join(stageDir, 'electron-builder.env'))
  runPnpm(
    [
      '--dir',
      appRoot,
      'exec',
      'electron-rebuild',
      '--force',
      '--only',
      nativeModules.join(','),
      '--module-dir',
      stageDir,
      '--arch',
      targetArch,
      '--version',
      electronVersion
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SKIP_ELECTRON_REBUILD: '1'
      }
    }
  )
  relativizeInternalSymlinks(path.join(stageDir, 'node_modules'))

  runElectronBuilder(['--config', configPath, ...args], {
    cwd: stageDir,
    env: {
      ...process.env,
      MEMRY_ENV: runtimeEnvName,
      SYNC_SERVER_URL: runtimeEnv.SYNC_SERVER_URL,
      MEMRY_PACKAGED_STAGE_DIR: stageDir
    }
  })

  removePath(distDir)
  fs.cpSync(path.join(stageDir, 'dist'), distDir, {
    dereference: false,
    force: true,
    recursive: true,
    verbatimSymlinks: true
  })
}

try {
  main()
} finally {
  if (process.env.MEMRY_KEEP_STAGED_PACKAGE_DIR === '1') {
    console.error(`Kept staged package dir: ${stageDir}`)
  } else {
    removePath(stageDir)
    if (process.platform === 'win32') {
      try {
        fs.rmdirSync(stageRoot)
      } catch {
        // Ignore leftover staged sibling directories.
      }
    }
  }
}
