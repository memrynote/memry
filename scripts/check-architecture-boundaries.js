const fs = require('fs/promises')
const path = require('path')

const repoRoot = process.cwd()
const desktopRoot = path.resolve(repoRoot, 'apps/desktop')
const mainRoot = path.resolve(desktopRoot, 'src/main')
const rendererRoot = path.resolve(desktopRoot, 'src/renderer/src')
const ipcRoot = path.resolve(mainRoot, 'ipc')
const generatedIpcInvokeMapPath = path.resolve(ipcRoot, 'generated-ipc-invoke-map.ts')
const databaseRoot = path.resolve(mainRoot, 'database')
const queriesRoot = path.resolve(databaseRoot, 'queries')
const notesQueriesRoot = path.resolve(queriesRoot, 'notes')
const mainSyncRoot = path.resolve(mainRoot, 'sync')
const ipcQueryAllowlist = new Set([
  'apps/desktop/src/main/ipc/ai-inline-handlers.ts',
  'apps/desktop/src/main/ipc/bookmarks-handlers.ts',
  'apps/desktop/src/main/ipc/graph-handlers.ts',
  'apps/desktop/src/main/ipc/journal-handlers.ts',
  'apps/desktop/src/main/ipc/notes-handlers.ts',
  'apps/desktop/src/main/ipc/properties-handlers.ts',
  'apps/desktop/src/main/ipc/reminder-handlers.ts',
  'apps/desktop/src/main/ipc/saved-filters-handlers.ts',
  'apps/desktop/src/main/ipc/search-handlers.ts',
  'apps/desktop/src/main/ipc/settings-handlers.ts',
  'apps/desktop/src/main/ipc/sync-handlers.ts',
  'apps/desktop/src/main/ipc/tags-handlers.ts',
  'apps/desktop/src/main/ipc/tasks-handlers.ts'
])
const dataOnlySchemaSpecifiers = new Map([
  ['@memry/db-schema/schema/tag-definitions', 'data-db schema import'],
  ['@memry/db-schema/schema/note-positions', 'data-db schema import']
])
const dataOnlyQueryTargets = [
  path.resolve(queriesRoot, 'tasks'),
  path.resolve(queriesRoot, 'projects'),
  path.resolve(queriesRoot, 'note-positions')
]
const databaseModuleTargets = [
  databaseRoot,
  path.resolve(databaseRoot, 'index'),
  path.resolve(databaseRoot, 'client')
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

function stripSourceExtension(filePath) {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
}

function isInside(targetPath, rootPath) {
  const normalizedTarget = stripSourceExtension(targetPath)
  const normalizedRoot = stripSourceExtension(rootPath)
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  )
}

function matchesTarget(targetPath, candidatePath) {
  return stripSourceExtension(targetPath) === stripSourceExtension(candidatePath)
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(fromFile), specifier)
  }

  if (specifier.startsWith('@main/')) {
    return path.resolve(mainRoot, specifier.slice('@main/'.length))
  }

  return null
}

function scanImports(source) {
  return Array.from(
    source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g),
    (match) => ({
      statement: match[0],
      specifier: match[1]
    })
  )
}

function getFilesForRoot(rootPath) {
  return walk(rootPath).then((files) => files.filter(isSourceFile).filter((filePath) => !isTestFile(filePath)))
}

function formatViolation(filePath, specifier, reason) {
  return `${path.relative(repoRoot, filePath)} -> ${specifier} (${reason})`
}

function isBlockedDataSchemaImport(specifier) {
  for (const [blockedSpecifier, reason] of dataOnlySchemaSpecifiers) {
    if (specifier === blockedSpecifier || specifier.startsWith(`${blockedSpecifier}/`)) {
      return reason
    }
  }

  return null
}

function isDataOnlyQueryImport(specifier, resolvedPath) {
  if (specifier === '@main/database/queries/tasks' || specifier.startsWith('@main/database/queries/tasks/')) {
    return 'data-db task query import'
  }

  if (
    specifier === '@main/database/queries/projects' ||
    specifier.startsWith('@main/database/queries/projects/')
  ) {
    return 'data-db project query import'
  }

  if (
    specifier === '@main/database/queries/note-positions' ||
    specifier.startsWith('@main/database/queries/note-positions/')
  ) {
    return 'data-db note-position query import'
  }

  if (!resolvedPath) {
    return null
  }

  if (matchesTarget(resolvedPath, dataOnlyQueryTargets[0])) {
    return 'data-db task query import'
  }

  if (matchesTarget(resolvedPath, dataOnlyQueryTargets[1])) {
    return 'data-db project query import'
  }

  if (matchesTarget(resolvedPath, dataOnlyQueryTargets[2])) {
    return 'data-db note-position query import'
  }

  return null
}

function isGetDatabaseImport(statement, specifier, resolvedPath) {
  if (!/\bgetDatabase\b/.test(statement)) {
    return false
  }

  if (specifier === '@main/database') {
    return true
  }

  if (!resolvedPath) {
    return false
  }

  return databaseModuleTargets.some((targetPath) => matchesTarget(resolvedPath, targetPath))
}

async function main() {
  const blockingViolations = new Set()
  const allowlistedIpcViolations = new Set()

  const rendererFiles = await getFilesForRoot(rendererRoot)
  for (const filePath of rendererFiles) {
    const source = await fs.readFile(filePath, 'utf8')

    for (const { specifier } of scanImports(source)) {
      if (specifier.startsWith('@main/')) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'renderer import of @main/* is not allowed')
        )
        continue
      }

      const resolvedPath = resolveImport(filePath, specifier)
      if (!resolvedPath) {
        continue
      }

      if (isInside(resolvedPath, mainSyncRoot)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'renderer import of main sync code is not allowed')
        )
        continue
      }

      if (isInside(resolvedPath, mainRoot)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'renderer import of main code is not allowed')
        )
      }
    }
  }

  const ipcFiles = (await getFilesForRoot(ipcRoot)).filter(
    (filePath) => !matchesTarget(filePath, generatedIpcInvokeMapPath)
  )
  for (const filePath of ipcFiles) {
    const source = await fs.readFile(filePath, 'utf8')

    for (const { specifier } of scanImports(source)) {
      const resolvedPath = resolveImport(filePath, specifier)
      const isDirectQueryImport =
        specifier === '@main/database/queries' ||
        specifier.startsWith('@main/database/queries/') ||
        (resolvedPath ? isInside(resolvedPath, queriesRoot) : false)

      if (!isDirectQueryImport) {
        continue
      }

      const relativeFilePath = path.relative(repoRoot, filePath)
      const violation = formatViolation(filePath, specifier, 'direct IPC query import')

      if (ipcQueryAllowlist.has(relativeFilePath)) {
        allowlistedIpcViolations.add(violation)
      } else {
        blockingViolations.add(violation)
      }
    }
  }

  const noteQueryFiles = await getFilesForRoot(notesQueriesRoot)
  for (const filePath of noteQueryFiles) {
    const source = await fs.readFile(filePath, 'utf8')

    for (const { statement, specifier } of scanImports(source)) {
      const resolvedPath = resolveImport(filePath, specifier)
      const blockedSchemaReason = isBlockedDataSchemaImport(specifier)
      if (blockedSchemaReason) {
        blockingViolations.add(formatViolation(filePath, specifier, blockedSchemaReason))
        continue
      }

      const blockedQueryReason = isDataOnlyQueryImport(specifier, resolvedPath)
      if (blockedQueryReason) {
        blockingViolations.add(formatViolation(filePath, specifier, blockedQueryReason))
        continue
      }

      if (isGetDatabaseImport(statement, specifier, resolvedPath)) {
        blockingViolations.add(formatViolation(filePath, specifier, 'getDatabase import'))
      }
    }
  }

  if (blockingViolations.size === 0) {
    if (allowlistedIpcViolations.size === 0) {
      console.log('architecture boundary check passed')
      return
    }

    console.log('architecture boundary check passed with allowlisted IPC query imports:')
    for (const violation of [...allowlistedIpcViolations].sort()) {
      console.log(`- ${violation}`)
    }
    return
  }

  console.error('architecture boundary check failed:')
  for (const violation of [...blockingViolations].sort()) {
    console.error(`- ${violation}`)
  }

  if (allowlistedIpcViolations.size > 0) {
    console.error('allowlisted IPC query imports:')
    for (const violation of [...allowlistedIpcViolations].sort()) {
      console.error(`- ${violation}`)
    }
  }

  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
