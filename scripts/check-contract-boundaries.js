const fs = require('fs/promises')
const path = require('path')

const repoRoot = process.cwd()
const contractsDir = path.resolve(repoRoot, 'packages/contracts/src')
const desktopRoot = path.resolve(repoRoot, 'apps/desktop')
const legacySharedRoot = path.resolve(desktopRoot, 'src/shared')
const legacySharedSchemaDir = path.resolve(legacySharedRoot, 'db/schema')
const blockedPackageImports = [
  { prefix: '@memry/db-schema', reason: 'db schema import' },
  { prefix: '@memry/desktop', reason: 'app package import' },
  { prefix: '@memry/sync-server', reason: 'app package import' }
]
const appRoots = [
  path.resolve(desktopRoot, 'src/main'),
  path.resolve(desktopRoot, 'src/preload'),
  path.resolve(desktopRoot, 'src/renderer'),
  legacySharedRoot,
  path.resolve(repoRoot, 'apps/sync-server')
]

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return walk(entryPath)
      }
      return [entryPath]
    })
  )

  return files.flat()
}

function isSourceFile(filePath) {
  if (filePath.endsWith('.d.ts')) {
    return false
  }

  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)
}

function isTestFile(filePath) {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(fromFile), specifier)
  }

  if (specifier.startsWith('@shared/')) {
    // Keep resolving the removed alias so future regressions still fail
    // the boundary check instead of being ignored as unresolved imports.
    return path.resolve(legacySharedRoot, specifier.slice('@shared/'.length))
  }

  return null
}

function isInside(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`)
}

function getBlockedPackageReason(specifier) {
  for (const { prefix, reason } of blockedPackageImports) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
      return reason
    }
  }

  return null
}

async function main() {
  const files = (await walk(contractsDir)).filter(isSourceFile).filter((filePath) => !isTestFile(filePath))
  const violations = []

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8')
    const matches = source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)

    for (const match of matches) {
      const specifier = match[1]
      const blockedPackageReason = getBlockedPackageReason(specifier)

      if (blockedPackageReason) {
        violations.push(`${path.relative(repoRoot, filePath)} -> ${specifier} (${blockedPackageReason})`)
        continue
      }

      const resolvedPath = resolveImport(filePath, specifier)

      if (!resolvedPath) {
        continue
      }

      if (isInside(resolvedPath, legacySharedSchemaDir)) {
        violations.push(`${path.relative(repoRoot, filePath)} -> ${specifier} (db schema import)`)
        continue
      }

      if (appRoots.some((rootPath) => isInside(resolvedPath, rootPath))) {
        violations.push(`${path.relative(repoRoot, filePath)} -> ${specifier} (app code import)`)
      }
    }
  }

  if (violations.length === 0) {
    console.log('contracts boundary check passed')
    return
  }

  console.error('contracts boundary check failed:')
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
