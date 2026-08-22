const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const { builtinModules } = require('module')

const repoRoot = process.cwd()
const mobileRoot = path.resolve(repoRoot, 'apps/mobile')
const packagesRoot = path.resolve(repoRoot, 'packages')
const nodeBuiltins = new Set(builtinModules)
const mobileSkippedDirs = new Set(['node_modules', 'ios', 'android', '.expo', 'assets', 'scripts'])
const desktopRoot = path.resolve(repoRoot, 'apps/desktop')
const mainRoot = path.resolve(desktopRoot, 'src/main')
const rendererRoot = path.resolve(desktopRoot, 'src/renderer/src')
const ipcRoot = path.resolve(mainRoot, 'ipc')
const generatedIpcInvokeMapPath = path.resolve(ipcRoot, 'generated-ipc-invoke-map.ts')
const databaseRoot = path.resolve(mainRoot, 'database')
const queriesRoot = path.resolve(databaseRoot, 'queries')
const notesQueriesRoot = path.resolve(queriesRoot, 'notes')
const mainSyncRoot = path.resolve(mainRoot, 'sync')
const blockedFeatureSyncImports = [
  path.resolve(mainSyncRoot, 'offline-clock'),
  path.resolve(mainSyncRoot, 'task-sync'),
  path.resolve(mainSyncRoot, 'project-sync'),
  path.resolve(mainSyncRoot, 'inbox-sync'),
  path.resolve(mainSyncRoot, 'filter-sync'),
  path.resolve(mainSyncRoot, 'canvas-sync'),
  path.resolve(mainSyncRoot, 'note-sync'),
  path.resolve(mainSyncRoot, 'journal-sync'),
  path.resolve(mainSyncRoot, 'settings-sync'),
  path.resolve(mainSyncRoot, 'tag-definition-sync')
]
const projectionsRoot = path.resolve(mainRoot, 'projections')
const notesFeatureRoot = path.resolve(mainRoot, 'notes')
const journalFeatureRoot = path.resolve(mainRoot, 'journal')
const noteSyncPath = path.resolve(mainRoot, 'vault/note-sync')
const notesStorePath = path.resolve(mainRoot, 'notes/store')
const noteCrudPath = path.resolve(queriesRoot, 'notes/note-crud')
const notePropertyQueriesPath = path.resolve(queriesRoot, 'notes/property-queries')
const noteTagQueriesPath = path.resolve(queriesRoot, 'notes/tag-queries')
const noteLinkQueriesPath = path.resolve(queriesRoot, 'notes/link-queries')
const canonicalWriteFeatureRoots = [ipcRoot, notesFeatureRoot, journalFeatureRoot]
const syncBoundaryExemptIpcFiles = new Set([
  'apps/desktop/src/main/ipc/account-handlers.ts',
  'apps/desktop/src/main/ipc/crypto-handlers.ts',
  // Phase 2 split: these four files compose what sync-handlers.ts used to
  // register. They legitimately drive the sync runtime from the IPC boundary
  // (OAuth loopback, OTP flows, attachment chunking, sync engine control),
  // so they inherit the exemption the old god-module held.
  'apps/desktop/src/main/ipc/sync-core-handlers.ts',
  'apps/desktop/src/main/ipc/auth-oauth-handlers.ts',
  'apps/desktop/src/main/ipc/auth-device-handlers.ts',
  'apps/desktop/src/main/ipc/sync-attachment-handlers.ts',
  // Thin IPC wrapper that registers crdt:* handlers at app bootstrap. Handlers
  // delegate to getCrdtProvider() lazily so they survive sign-out teardown
  // (provider destroy + reset) without unregistering.
  'apps/desktop/src/main/ipc/crdt-handlers.ts',
  // Posts feedback straight to the sync server via postToServer; no sync
  // runtime involvement beyond the shared HTTP client.
  'apps/desktop/src/main/ipc/feedback-handlers.ts'
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

function normalizeRepoPath(filePath) {
  return filePath.replace(/\\/g, '/')
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.join(entry.parentPath, entry.name))
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
  return walk(rootPath).then((files) =>
    files.filter(isSourceFile).filter((filePath) => !isTestFile(filePath))
  )
}

function formatViolation(filePath, specifier, reason) {
  return `${normalizeRepoPath(path.relative(repoRoot, filePath))} -> ${specifier} (${reason})`
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
  if (
    specifier === '@main/database/queries/tasks' ||
    specifier.startsWith('@main/database/queries/tasks/')
  ) {
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

function matchesAnyImportedSymbol(statement, symbols) {
  return symbols.some((symbol) => new RegExp(`\\b${symbol}\\b`).test(statement))
}

function getCanonicalIndexWriteImportReason(statement, resolvedPath) {
  if (!resolvedPath) {
    return null
  }

  if (matchesTarget(resolvedPath, noteSyncPath)) {
    return 'canonical index write import'
  }

  if (
    matchesTarget(resolvedPath, notesStorePath) &&
    matchesAnyImportedSymbol(statement, [
      'updateNoteCache',
      'insertPropertyDefinition',
      'updatePropertyDefinition',
      'deletePropertyDefinition'
    ])
  ) {
    return 'canonical index write import'
  }

  if (
    matchesTarget(resolvedPath, noteCrudPath) &&
    matchesAnyImportedSymbol(statement, ['insertNoteCache', 'updateNoteCache', 'deleteNoteCache'])
  ) {
    return 'canonical index write import'
  }

  if (
    matchesTarget(resolvedPath, notePropertyQueriesPath) &&
    matchesAnyImportedSymbol(statement, [
      'setNoteProperties',
      'deleteNoteProperties',
      'insertPropertyDefinition',
      'updatePropertyDefinition',
      'deletePropertyDefinition',
      'ensurePropertyDefinition'
    ])
  ) {
    return 'canonical index write import'
  }

  if (
    matchesTarget(resolvedPath, noteTagQueriesPath) &&
    matchesAnyImportedSymbol(statement, ['setNoteTags'])
  ) {
    return 'canonical index write import'
  }

  if (
    matchesTarget(resolvedPath, noteLinkQueriesPath) &&
    matchesAnyImportedSymbol(statement, ['setNoteLinks', 'deleteLinksToNote'])
  ) {
    return 'canonical index write import'
  }

  return null
}

function isBlockedFeatureSyncImport(resolvedPath) {
  if (!resolvedPath) {
    return false
  }

  return blockedFeatureSyncImports.some((targetPath) => matchesTarget(resolvedPath, targetPath))
}

function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) {
    return true
  }

  const packageName = specifier.split('/')[0]
  return nodeBuiltins.has(packageName)
}

function isElectronSpecifier(specifier) {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

let workspacePackageDirsCache = null

async function getWorkspacePackageDirs() {
  if (workspacePackageDirsCache) {
    return workspacePackageDirsCache
  }

  const dirs = new Map()
  const entries = await fs.readdir(packagesRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const packageJsonPath = path.join(packagesRoot, entry.name, 'package.json')
    try {
      const manifest = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
      if (manifest.name) {
        dirs.set(manifest.name, {
          dir: path.join(packagesRoot, entry.name),
          exports: manifest.exports ?? null
        })
      }
    } catch {
      // no manifest — not a workspace package
    }
  }

  workspacePackageDirsCache = dirs
  return dirs
}

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js')
  ]

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
      return candidate
    }
  }

  return null
}

function resolveWorkspaceImport(specifier, workspacePackages) {
  const match = specifier.match(/^(@[^/]+\/[^/]+|[^@][^/]*)(?:\/(.+))?$/)
  if (!match) {
    return null
  }

  const packageInfo = workspacePackages.get(match[1])
  if (!packageInfo) {
    return null
  }

  const subpath = match[2] ? `./${match[2]}` : '.'
  const exportsMap = packageInfo.exports
  if (exportsMap && typeof exportsMap === 'object') {
    const target = exportsMap[subpath]
    if (typeof target === 'string') {
      return resolveSourceFile(path.resolve(packageInfo.dir, target))
    }
  }

  if (subpath === '.') {
    return resolveSourceFile(path.resolve(packageInfo.dir, 'src/index'))
  }

  return resolveSourceFile(path.resolve(packageInfo.dir, 'src', match[2]))
}

async function walkMobileSources(dir) {
  const files = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (mobileSkippedDirs.has(entry.name) || entry.name.startsWith('.')) {
        continue
      }
      files.push(...(await walkMobileSources(path.join(dir, entry.name))))
      continue
    }

    const filePath = path.join(dir, entry.name)
    if (isSourceFile(filePath) && !isTestFile(filePath)) {
      files.push(filePath)
    }
  }
  return files
}

// Mobile reachability rule (spec 001-mobile-app T003 / Constitution I): nothing
// reachable from apps/mobile — including transitively through workspace
// packages — may import a node builtin or electron. Walks the real import
// graph: mobile sources first, then every workspace package file they reach.
async function checkMobileReachability(blockingViolations) {
  if (!fsSync.existsSync(mobileRoot)) {
    return
  }

  const workspacePackages = await getWorkspacePackageDirs()
  const queue = await walkMobileSources(mobileRoot)
  const visited = new Set()

  while (queue.length > 0) {
    const filePath = queue.pop()
    const normalized = stripSourceExtension(filePath)
    if (visited.has(normalized)) {
      continue
    }
    visited.add(normalized)

    let source
    try {
      source = await fs.readFile(filePath, 'utf8')
    } catch {
      continue
    }

    for (const { specifier } of scanImports(source)) {
      if (isNodeBuiltinSpecifier(specifier)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'node builtin reachable from apps/mobile')
        )
        continue
      }

      if (isElectronSpecifier(specifier)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'electron reachable from apps/mobile')
        )
        continue
      }

      if (specifier.startsWith('.')) {
        const resolved = resolveSourceFile(path.resolve(path.dirname(filePath), specifier))
        if (resolved && isSourceFile(resolved) && !isTestFile(resolved)) {
          queue.push(resolved)
        }
        continue
      }

      const workspaceResolved = resolveWorkspaceImport(specifier, workspacePackages)
      if (workspaceResolved && isSourceFile(workspaceResolved) && !isTestFile(workspaceResolved)) {
        queue.push(workspaceResolved)
      }
    }
  }
}

async function main() {
  const blockingViolations = new Set()

  await checkMobileReachability(blockingViolations)

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
    const relativeFilePath = normalizeRepoPath(path.relative(repoRoot, filePath))
    const syncBoundaryExempt = syncBoundaryExemptIpcFiles.has(relativeFilePath)

    for (const { statement, specifier } of scanImports(source)) {
      const resolvedPath = resolveImport(filePath, specifier)
      const isDirectQueryImport =
        specifier === '@main/database/queries' ||
        specifier.startsWith('@main/database/queries/') ||
        (resolvedPath ? isInside(resolvedPath, queriesRoot) : false)

      if (isDirectQueryImport) {
        blockingViolations.add(formatViolation(filePath, specifier, 'direct IPC query import'))
        continue
      }

      if (!syncBoundaryExempt && resolvedPath && isInside(resolvedPath, mainSyncRoot)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'feature IPC import of sync module')
        )
        continue
      }

      if (
        !syncBoundaryExempt &&
        /\bpublishProjectionEvent\b/.test(statement) &&
        resolvedPath &&
        isInside(resolvedPath, projectionsRoot)
      ) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'feature IPC import of projection publisher')
        )
        continue
      }

      if (resolvedPath && matchesTarget(resolvedPath, noteSyncPath)) {
        blockingViolations.add(formatViolation(filePath, specifier, 'canonical write path import'))
      }
    }
  }

  const canonicalWriteFeatureFiles = [
    ...new Set(
      (
        await Promise.all(canonicalWriteFeatureRoots.map((rootPath) => getFilesForRoot(rootPath)))
      ).flat()
    )
  ].filter((filePath) => !matchesTarget(filePath, generatedIpcInvokeMapPath))

  const featureFiles = (await getFilesForRoot(mainRoot)).filter(
    (filePath) =>
      !matchesTarget(filePath, generatedIpcInvokeMapPath) && !isInside(filePath, mainSyncRoot)
  )

  for (const filePath of featureFiles) {
    const source = await fs.readFile(filePath, 'utf8')
    const relativeFilePath = normalizeRepoPath(path.relative(repoRoot, filePath))
    const syncBoundaryExempt = syncBoundaryExemptIpcFiles.has(relativeFilePath)

    for (const { specifier } of scanImports(source)) {
      const resolvedPath = resolveImport(filePath, specifier)
      if (!resolvedPath) {
        continue
      }

      if (syncBoundaryExempt && isInside(filePath, ipcRoot)) {
        continue
      }

      if (isBlockedFeatureSyncImport(resolvedPath)) {
        blockingViolations.add(
          formatViolation(filePath, specifier, 'feature import of sync adapter internals')
        )
      }
    }
  }

  for (const filePath of canonicalWriteFeatureFiles) {
    const source = await fs.readFile(filePath, 'utf8')

    for (const { statement, specifier } of scanImports(source)) {
      const resolvedPath = resolveImport(filePath, specifier)
      const canonicalWriteReason = getCanonicalIndexWriteImportReason(statement, resolvedPath)
      if (canonicalWriteReason) {
        blockingViolations.add(formatViolation(filePath, specifier, canonicalWriteReason))
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
    console.log('architecture boundary check passed')
    return
  }

  console.error('architecture boundary check failed:')
  for (const violation of [...blockingViolations].sort()) {
    console.error(`- ${violation}`)
  }

  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
