#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { builtinModules, createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.join(appRoot, 'package.json'))
const builtinModuleNames = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.replace(/^node:/, ''),
    `node:${name.replace(/^node:/, '')}`
  ])
)

function normalizePackageName(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : specifier
  }

  return specifier.split('/')[0]
}

function isExternalRuntimeSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) {
    return false
  }

  const packageName = normalizePackageName(specifier)
  return (
    packageName !== 'electron' &&
    !builtinModuleNames.has(specifier) &&
    !builtinModuleNames.has(packageName)
  )
}

function extractRuntimeRoots(bundlePath) {
  const bundle = fs.readFileSync(bundlePath, 'utf8')
  const roots = new Set()

  for (const match of bundle.matchAll(/require\("([^"]+)"\)/g)) {
    const specifier = match[1]
    if (!isExternalRuntimeSpecifier(specifier)) {
      continue
    }

    roots.add(normalizePackageName(specifier))
  }

  return roots
}

function resolvePackageJson(packageName) {
  const directPackageJsonPath = path.join(
    appRoot,
    'node_modules',
    ...packageName.split('/'),
    'package.json'
  )
  if (fs.existsSync(directPackageJsonPath)) {
    return directPackageJsonPath
  }

  const resolvedEntry = desktopRequire.resolve(packageName)
  let currentDir = path.dirname(resolvedEntry)

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      if (packageJson.name === packageName) {
        return packageJsonPath
      }
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }

    currentDir = parentDir
  }

  throw new Error(`Could not resolve package.json for ${packageName}`)
}

function collectDependencyClosure(rootPackages) {
  const seen = new Set()
  const queue = [...rootPackages].sort()
  const parents = new Map()
  const rootSources = new Map()
  const unresolvedRequired = []

  for (const packageName of queue) {
    parents.set(packageName, null)
    rootSources.set(packageName, packageName)
  }

  while (queue.length > 0) {
    const packageName = queue.shift()
    if (seen.has(packageName)) {
      continue
    }

    seen.add(packageName)

    const packageJsonPath = resolvePackageJson(packageName)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const dependencyEntries = [
      ...Object.keys(packageJson.dependencies ?? {}).map((dependencyName) => ({
        dependencyName,
        optional: false
      })),
      ...Object.keys(packageJson.optionalDependencies ?? {}).map((dependencyName) => ({
        dependencyName,
        optional: true
      }))
    ]

    for (const { dependencyName, optional } of dependencyEntries) {
      if (seen.has(dependencyName) || queue.includes(dependencyName)) {
        continue
      }

      try {
        resolvePackageJson(dependencyName)
      } catch (error) {
        if (!optional) {
          unresolvedRequired.push({
            dependencyName,
            parent: packageName,
            message: error instanceof Error ? error.message : String(error)
          })
        }
        continue
      }

      parents.set(dependencyName, packageName)
      rootSources.set(dependencyName, rootSources.get(packageName) ?? packageName)
      queue.push(dependencyName)
    }
  }

  return { packages: seen, parents, rootSources, unresolvedRequired }
}

function findFilesByBasename(dirPath, basename) {
  const matches = []
  if (!fs.existsSync(dirPath)) {
    return matches
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      matches.push(...findFilesByBasename(entryPath, basename))
      continue
    }

    if (entry.isFile() && entry.name === basename) {
      matches.push(entryPath)
    }
  }

  return matches
}

function pickNewestFile(paths) {
  return [...paths].sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]
}

function listAsarPaths(asarPath) {
  const output = execFileSync('npx', ['--no-install', 'asar', 'list', asarPath], {
    cwd: appRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return output.split(/\r?\n/).filter(Boolean)
}

function collectPackagedPackageNames(paths) {
  const packages = new Set()

  for (const entryPath of paths) {
    const match = entryPath.match(/\/node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)/)
    if (match) {
      packages.add(match[1])
    }
  }

  return packages
}

function collectUnpackedPaths(dirPath) {
  const paths = []
  if (!fs.existsSync(dirPath)) {
    return paths
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    paths.push(entryPath)
    if (entry.isDirectory()) {
      paths.push(...collectUnpackedPaths(entryPath))
    }
  }

  return paths
}

function formatChain(packageName, parents) {
  const chain = [packageName]
  let current = packageName

  while (parents.get(current)) {
    current = parents.get(current)
    chain.push(current)
  }

  return chain.join(' <- ')
}

function relativeToAppRoot(filePath) {
  return path.relative(appRoot, filePath) || '.'
}

function main() {
  const bundlePath = path.join(appRoot, 'out', 'main', 'index.js')
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Main bundle not found at ${bundlePath}. Run pnpm build first.`)
  }

  const asarCandidates = findFilesByBasename(path.join(appRoot, 'dist'), 'app.asar')
  if (asarCandidates.length === 0) {
    throw new Error(
      `No packaged app.asar found under ${path.join(appRoot, 'dist')}. Run build:unpack or build:mac first.`
    )
  }

  const asarPath = pickNewestFile(asarCandidates)
  const unpackedPath = `${asarPath}.unpacked`
  const desktopPackageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
  const runtimeRoots = extractRuntimeRoots(bundlePath)
  const misdeclaredRoots = [...runtimeRoots]
    .filter(
      (packageName) =>
        desktopPackageJson.devDependencies?.[packageName] &&
        !desktopPackageJson.dependencies?.[packageName]
    )
    .sort()
  const {
    packages: runtimeClosure,
    parents,
    unresolvedRequired
  } = collectDependencyClosure(runtimeRoots)
  const packagedPaths = [
    ...listAsarPaths(asarPath),
    ...collectUnpackedPaths(unpackedPath).map((entryPath) => entryPath.replace(unpackedPath, ''))
  ]
  const packagedPackages = collectPackagedPackageNames(packagedPaths)
  const missingPackages = [...runtimeClosure]
    .filter((packageName) => !packagedPackages.has(packageName))
    .sort((left, right) => left.localeCompare(right))

  console.log(`Packaged runtime dependency check`)
  console.log(`bundle: ${relativeToAppRoot(bundlePath)}`)
  console.log(`asar:   ${relativeToAppRoot(asarPath)}`)
  console.log(`roots:  ${runtimeRoots.size}`)
  console.log(`closure:${runtimeClosure.size}`)
  console.log(`packed: ${packagedPackages.size}`)

  if (unresolvedRequired.length > 0) {
    console.log(``)
    console.log(`Unresolved required workspace packages (${unresolvedRequired.length}):`)
    for (const { dependencyName, parent, message } of unresolvedRequired) {
      console.log(`- ${dependencyName} <- ${parent}`)
      console.log(`  ${message}`)
    }
  }

  if (misdeclaredRoots.length > 0) {
    console.log(``)
    console.log(`Direct runtime packages misdeclared as devDependencies:`)
    for (const packageName of misdeclaredRoots) {
      console.log(`- ${packageName}`)
    }
  }

  if (missingPackages.length === 0 && unresolvedRequired.length === 0) {
    console.log(``)
    console.log(`No missing runtime packages detected.`)
    return
  }

  console.log(``)
  console.log(`Missing runtime packages (${missingPackages.length}):`)
  for (const packageName of missingPackages) {
    console.log(`- ${formatChain(packageName, parents)}`)
  }

  process.exitCode = 1
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
}
