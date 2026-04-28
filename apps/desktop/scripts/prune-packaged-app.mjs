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

function pruneOnnxRuntime(nodeModulesDir, platformName, archName) {
  const napiRoot = join(nodeModulesDir, 'onnxruntime-node', 'bin', 'napi-v3')

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

function pruneBetterSqliteBuildArtifacts(nodeModulesDir) {
  const betterSqliteRoot = join(nodeModulesDir, 'better-sqlite3')

  removePath(join(betterSqliteRoot, 'deps'))
  removePath(join(betterSqliteRoot, 'src'))
  removePath(join(betterSqliteRoot, 'build', 'deps'))
  removePath(join(betterSqliteRoot, 'build', 'Release', 'obj'))
  removePath(join(betterSqliteRoot, 'build', 'Release', 'test_extension.node'))
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

export default async function prunePackagedApp(context) {
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
    pruneBetterSqliteBuildArtifacts(nodeModulesDir)
  }
}
