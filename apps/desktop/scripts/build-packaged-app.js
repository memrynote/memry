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
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-desktop-package-'))
const distDir = path.join(appRoot, 'dist')
const defaultConfigPath = 'config/electron-builder.staged.yml'
const nativeModules = ['better-sqlite3', 'classic-level', 'keytar']

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

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options })
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

function main() {
  const { args, configPath } = parseElectronBuilderArgs(process.argv.slice(2))

  if (args.length === 0) {
    throw new Error(
      'Usage: node scripts/build-packaged-app.js [--config path] <electron-builder-args...>'
    )
  }

  run('pnpm', ['--filter', '@memry/desktop', 'deploy', '--legacy', '--prod', stageDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SKIP_ELECTRON_REBUILD: '1'
    }
  })

  syncIntoStage('build')
  syncIntoStage('config')
  syncIntoStage('out')
  syncIntoStage('scripts')
  syncIntoStage('.env.staging', { optional: true })
  removePath(path.join(stageDir, 'node_modules', '@memry', 'desktop'))
  removePath(path.join(stageDir, 'electron-builder.env'))
  run(
    'pnpm',
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
      '--version',
      electronVersion
    ],
    {
      cwd: repoRoot
    }
  )
  relativizeInternalSymlinks(path.join(stageDir, 'node_modules'))

  run(process.execPath, [electronBuilderCli, '--config', configPath, ...args], {
    cwd: stageDir,
    env: {
      ...process.env,
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
  }
}
