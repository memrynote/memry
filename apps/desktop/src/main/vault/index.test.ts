import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  dialogResult: { canceled: false, filePaths: ['/vault/picked'] },
  vaults: [] as Array<{
    path: string
    name: string
    noteCount: number
    taskCount: number
    lastOpened: string
    isDefault: boolean
  }>,
  currentVaultPath: null as string | null,
  config: {
    excludePatterns: ['.git'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    attachmentsFolder: 'attachments'
  },
  isVaultInitialized: vi.fn(),
  isValidDirectory: vi.fn(),
  hasWritePermission: vi.fn(),
  initVault: vi.fn(),
  readVaultConfig: vi.fn(),
  writeVaultConfig: vi.fn(),
  countMarkdownFiles: vi.fn(),
  checkIndexHealth: vi.fn(),
  rebuildIndex: vi.fn(),
  indexVault: vi.fn(),
  startWatcher: vi.fn(),
  stopWatcher: vi.fn(),
  runMigrations: vi.fn(),
  runIndexMigrations: vi.fn(),
  initDatabase: vi.fn(),
  initIndexDatabase: vi.fn(),
  initializeFts: vi.fn(),
  initializeFtsTasks: vi.fn(),
  initializeFtsInbox: vi.fn(),
  closeAllDatabases: vi.fn(),
  ensureDefaultTaskProject: vi.fn(),
  promoteSpatialCanvas: vi.fn(),
  reloadPropertyDefinitions: vi.fn(),
  destroyPropertyDefinitions: vi.fn(),
  migrateSettingsToConfig: vi.fn(),
  snapshotProjectFrontmatterBackfill: vi.fn(),
  applyProjectFrontmatterBackfill: vi.fn(),
  migrateTemplateFilesToDb: vi.fn(() => 0),
  startSyncRuntime: vi.fn(),
  stopSyncRuntime: vi.fn(),
  startProjectionRuntime: vi.fn(),
  stopProjectionRuntime: vi.fn(),
  reconcileProjections: vi.fn(),
  trackMainError: vi.fn(),
  initEmbeddingModel: vi.fn(),
  isModelLoaded: vi.fn(),
  isModelLoading: vi.fn(),
  startAgentMcpLifecycle: vi.fn(),
  stopAgentMcpLifecycle: vi.fn(),
  configureLazyAgentServices: vi.fn(),
  registerLazyAgentHandlers: vi.fn(),
  unregisterLazyAgentHandlers: vi.fn(),
  startAgent: vi.fn(),
  agentShutdown: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => mocks.dialogResult)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => mocks.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

vi.mock('../store', () => ({
  getCurrentVaultPath: () => mocks.currentVaultPath,
  setCurrentVaultPath: (path: string | null) => {
    mocks.currentVaultPath = path
  },
  getVaults: () => mocks.vaults,
  upsertVault: (vault: (typeof mocks.vaults)[number]) => {
    const index = mocks.vaults.findIndex((item) => item.path === vault.path)
    if (index >= 0) mocks.vaults[index] = vault
    else mocks.vaults.push(vault)
  },
  removeVault: (path: string) => {
    mocks.vaults = mocks.vaults.filter((vault) => vault.path !== path)
  },
  findVault: (path: string) => mocks.vaults.find((vault) => vault.path === path),
  touchVault: vi.fn()
}))

vi.mock('./init', () => ({
  initVault: (...args: unknown[]) => mocks.initVault(...args),
  isVaultInitialized: (...args: unknown[]) => mocks.isVaultInitialized(...args),
  isValidDirectory: (...args: unknown[]) => mocks.isValidDirectory(...args),
  hasWritePermission: (...args: unknown[]) => mocks.hasWritePermission(...args),
  getVaultName: (vaultPath: string) => vaultPath.split('/').at(-1) || 'Vault',
  readVaultConfig: (...args: unknown[]) => mocks.readVaultConfig(...args),
  writeVaultConfig: (...args: unknown[]) => mocks.writeVaultConfig(...args),
  countMarkdownFiles: (...args: unknown[]) => mocks.countMarkdownFiles(...args),
  getDataDbPath: (vaultPath: string) => `${vaultPath}/data.db`,
  getIndexDbPath: (vaultPath: string) => `${vaultPath}/index.db`
}))

vi.mock('../database', () => ({
  initDatabase: (...args: unknown[]) => mocks.initDatabase(...args),
  initIndexDatabase: (...args: unknown[]) => mocks.initIndexDatabase(...args),
  closeAllDatabases: (...args: unknown[]) => mocks.closeAllDatabases(...args),
  runMigrations: (...args: unknown[]) => mocks.runMigrations(...args),
  runIndexMigrations: (...args: unknown[]) => mocks.runIndexMigrations(...args),
  initializeFts: (...args: unknown[]) => mocks.initializeFts(...args),
  initializeFtsTasks: (...args: unknown[]) => mocks.initializeFtsTasks(...args),
  initializeFtsInbox: (...args: unknown[]) => mocks.initializeFtsInbox(...args),
  getDatabase: () => ({ kind: 'data-db' }),
  getIndexDatabase: () => ({ kind: 'index-db' }),
  checkIndexHealth: (...args: unknown[]) => mocks.checkIndexHealth(...args)
}))

vi.mock('../settings/promote-spatial-canvas', () => ({
  promoteSpatialCanvas: (...args: unknown[]) => mocks.promoteSpatialCanvas(...args)
}))

vi.mock('../database/defaults', () => ({
  ensureDefaultTaskProject: (...args: unknown[]) => mocks.ensureDefaultTaskProject(...args)
}))

vi.mock('./watcher', () => ({
  startWatcher: (...args: unknown[]) => mocks.startWatcher(...args),
  stopWatcher: (...args: unknown[]) => mocks.stopWatcher(...args)
}))

vi.mock('./indexer', () => ({
  indexVault: (...args: unknown[]) => mocks.indexVault(...args),
  rebuildIndex: (...args: unknown[]) => mocks.rebuildIndex(...args)
}))

vi.mock('../lib/embeddings', () => ({
  initEmbeddingModel: (...args: unknown[]) => mocks.initEmbeddingModel(...args),
  isModelLoaded: (...args: unknown[]) => mocks.isModelLoaded(...args),
  isModelLoading: (...args: unknown[]) => mocks.isModelLoading(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('../sync/runtime', () => ({
  startSyncRuntime: (...args: unknown[]) => mocks.startSyncRuntime(...args),
  stopSyncRuntime: (...args: unknown[]) => mocks.stopSyncRuntime(...args)
}))

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: (...args: unknown[]) => mocks.trackMainError(...args),
  trackMainLog: vi.fn()
}))

vi.mock('../projections', () => ({
  reconcileProjections: (...args: unknown[]) => mocks.reconcileProjections(...args),
  startProjectionRuntime: (...args: unknown[]) => mocks.startProjectionRuntime(...args),
  stopProjectionRuntime: (...args: unknown[]) => mocks.stopProjectionRuntime(...args)
}))

vi.mock('../projections/projectors/note-derived-state-projector', () => ({
  createNoteDerivedStateProjector: () => ({ kind: 'note-derived' })
}))

vi.mock('../projections/projectors/search-projector', () => ({
  createSearchProjector: () => ({ kind: 'search' })
}))

vi.mock('../projections/projectors/embedding-projector', () => ({
  createEmbeddingProjector: () => ({ kind: 'embedding' })
}))

vi.mock('../projections/projectors/inbox-stats-projector', () => ({
  createInboxStatsProjector: () => ({ kind: 'inbox-stats' })
}))

vi.mock('./property-definitions', () => ({
  PropertyDefinitionsService: {
    init: vi.fn(() => ({
      reload: (...args: unknown[]) => mocks.reloadPropertyDefinitions(...args)
    })),
    destroy: (...args: unknown[]) => mocks.destroyPropertyDefinitions(...args)
  }
}))

vi.mock('./settings-cache', () => ({
  migrateSettingsToConfig: (...args: unknown[]) => mocks.migrateSettingsToConfig(...args)
}))

vi.mock('./backfill-project-frontmatter', () => ({
  snapshotProjectFrontmatterBackfill: (...args: unknown[]) =>
    mocks.snapshotProjectFrontmatterBackfill(...args),
  applyProjectFrontmatterBackfill: (...args: unknown[]) =>
    mocks.applyProjectFrontmatterBackfill(...args)
}))

vi.mock('./templates-migration', () => ({
  migrateTemplateFilesToDb: (...args: unknown[]) => mocks.migrateTemplateFilesToDb(...args)
}))

vi.mock('../agent/mcp/lifecycle', () => ({
  startAgentMcpLifecycle: (...args: unknown[]) => mocks.startAgentMcpLifecycle(...args),
  stopAgentMcpLifecycle: (...args: unknown[]) => mocks.stopAgentMcpLifecycle(...args)
}))

vi.mock('../agent/lazy-services', () => ({
  configureLazyAgentServices: (...args: unknown[]) => mocks.configureLazyAgentServices(...args)
}))

vi.mock('../ipc/agent-lazy-handlers', () => ({
  registerLazyAgentHandlers: (...args: unknown[]) => mocks.registerLazyAgentHandlers(...args),
  unregisterLazyAgentHandlers: (...args: unknown[]) => mocks.unregisterLazyAgentHandlers(...args)
}))

vi.mock('../agent/bootstrap', () => ({
  startAgent: (...args: unknown[]) => mocks.startAgent(...args)
}))

import {
  autoOpenLastVault,
  closeVault,
  emitIndexProgress,
  emitVaultError,
  getAllVaults,
  getConfig,
  getStatus,
  reindex,
  removeVault,
  selectVault,
  updateConfig
} from './index'

describe('vault lifecycle', () => {
  beforeEach(async () => {
    await closeVault()
    vi.clearAllMocks()
    mocks.sent = []
    mocks.vaults = []
    mocks.currentVaultPath = null
    mocks.dialogResult = { canceled: false, filePaths: ['/vault/picked'] }
    mocks.config = {
      excludePatterns: ['.git'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    }
    mocks.isVaultInitialized.mockReturnValue(true)
    mocks.isValidDirectory.mockReturnValue(true)
    mocks.hasWritePermission.mockReturnValue(true)
    mocks.readVaultConfig.mockImplementation(() => mocks.config)
    mocks.writeVaultConfig.mockImplementation((_path, updates) => {
      mocks.config = { ...mocks.config, ...(updates as Partial<typeof mocks.config>) }
    })
    mocks.countMarkdownFiles.mockReturnValue(7)
    mocks.checkIndexHealth.mockReturnValue('healthy')
    mocks.rebuildIndex.mockResolvedValue({ filesIndexed: 3, duration: 42 })
    mocks.indexVault.mockResolvedValue(undefined)
    mocks.startWatcher.mockResolvedValue(undefined)
    mocks.stopWatcher.mockResolvedValue(undefined)
    mocks.reloadPropertyDefinitions.mockResolvedValue(undefined)
    mocks.startSyncRuntime.mockResolvedValue(undefined)
    mocks.stopSyncRuntime.mockResolvedValue(undefined)
    mocks.stopProjectionRuntime.mockResolvedValue(undefined)
    mocks.reconcileProjections.mockResolvedValue(undefined)
    mocks.applyProjectFrontmatterBackfill.mockResolvedValue(undefined)
    mocks.initEmbeddingModel.mockResolvedValue(undefined)
    mocks.isModelLoaded.mockReturnValue(false)
    mocks.isModelLoading.mockReturnValue(false)
    mocks.startAgentMcpLifecycle.mockResolvedValue(undefined)
    mocks.stopAgentMcpLifecycle.mockResolvedValue(undefined)
    mocks.configureLazyAgentServices.mockImplementation(() => undefined)
    mocks.registerLazyAgentHandlers.mockImplementation(() => undefined)
    mocks.unregisterLazyAgentHandlers.mockImplementation(() => undefined)
    mocks.agentShutdown.mockResolvedValue(undefined)
    mocks.startAgent.mockResolvedValue({ shutdown: mocks.agentShutdown })
    delete process.env.TEST_VAULT_PATH
  })

  afterEach(async () => {
    await closeVault()
    delete process.env.TEST_VAULT_PATH
  })

  it('opens a healthy vault, stores it, emits status, and starts runtimes', async () => {
    mocks.isVaultInitialized.mockReturnValue(false)

    const result = await selectVault({ path: '/vault/work' })

    expect(result).toEqual({
      success: true,
      vault: expect.objectContaining({
        path: '/vault/work',
        name: 'work',
        noteCount: 7,
        taskCount: 0,
        isDefault: true
      })
    })
    expect(mocks.initVault).toHaveBeenCalledWith('/vault/work')
    expect(mocks.runMigrations).toHaveBeenCalledWith('/vault/work/data.db')
    expect(mocks.runIndexMigrations).toHaveBeenCalledWith('/vault/work/index.db')
    // Existing installs only get canvas turned on if this runs on open.
    expect(mocks.promoteSpatialCanvas).toHaveBeenCalledWith({ kind: 'data-db' })
    expect(mocks.reloadPropertyDefinitions).toHaveBeenCalled()
    expect(mocks.indexVault).toHaveBeenCalledWith('/vault/work')
    expect(mocks.startWatcher).toHaveBeenCalledWith('/vault/work')
    expect(mocks.startSyncRuntime).toHaveBeenCalled()
    expect(mocks.initEmbeddingModel).not.toHaveBeenCalled()
    expect(mocks.configureLazyAgentServices).toHaveBeenCalledWith(expect.any(Function))
    expect(mocks.registerLazyAgentHandlers).toHaveBeenCalled()
    expect(mocks.startAgentMcpLifecycle).not.toHaveBeenCalled()
    expect(mocks.startAgent).not.toHaveBeenCalled()
    expect(mocks.currentVaultPath).toBe('/vault/work')
    expect(getStatus()).toEqual(expect.objectContaining({ isOpen: true, path: '/vault/work' }))
    expect(mocks.sent.some((event) => event.channel === 'vault:status-changed')).toBe(true)
  })

  // The project-link backfill has to read data.db before the projectors can
  // reconcile a row away, and can only write once the index cache the property
  // writer resolves entities through is populated — after indexing.
  it('snapshots project links before the projectors start and applies them after indexing', async () => {
    await selectVault({ path: '/vault/work' })

    expect(mocks.snapshotProjectFrontmatterBackfill).toHaveBeenCalledWith({ kind: 'data-db' })
    expect(mocks.snapshotProjectFrontmatterBackfill.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startProjectionRuntime.mock.invocationCallOrder[0]
    )
    expect(mocks.applyProjectFrontmatterBackfill.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.indexVault.mock.invocationCallOrder[0]
    )
  })

  it('applies the backfill after an index rebuild and opens the vault even if it throws', async () => {
    mocks.checkIndexHealth.mockReturnValue('missing')
    mocks.applyProjectFrontmatterBackfill.mockRejectedValue(new Error('backfill exploded'))

    const result = await selectVault({ path: '/vault/rebuild' })

    expect(result.success).toBe(true)
    expect(getStatus()).toEqual(expect.objectContaining({ isOpen: true, path: '/vault/rebuild' }))
    expect(mocks.applyProjectFrontmatterBackfill.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.rebuildIndex.mock.invocationCallOrder[0]
    )
  })

  it('starts vault-scoped agent services only when lazy startup is requested', async () => {
    await selectVault({ path: '/vault/work' })

    const starter = mocks.configureLazyAgentServices.mock.calls.at(-1)?.[0] as () => Promise<void>
    await starter()

    expect(mocks.startAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.startAgent).toHaveBeenCalledTimes(1)
  })

  it('returns errors for picker cancelation and invalid directories', async () => {
    mocks.dialogResult = { canceled: true, filePaths: [] }
    await expect(selectVault({})).resolves.toEqual({
      success: false,
      vault: null,
      error: 'No folder selected'
    })

    mocks.isValidDirectory.mockReturnValue(false)
    await expect(selectVault({ path: '/bad/path' })).resolves.toEqual({
      success: false,
      vault: null,
      error: 'Selected path is not a valid directory'
    })
    expect(getStatus().error).toBe('Selected path is not a valid directory')
  })

  it('rebuilds unhealthy indexes and emits recovery events', async () => {
    mocks.checkIndexHealth.mockReturnValue('missing')

    await selectVault({ path: '/vault/rebuild' })

    expect(mocks.rebuildIndex).toHaveBeenCalledWith('/vault/rebuild')
    expect(mocks.runIndexMigrations).not.toHaveBeenCalled()
    expect(mocks.sent).toContainEqual({
      channel: 'vault:index-recovered',
      payload: { reason: 'missing', filesIndexed: 3, duration: 42 }
    })
  })

  it('restarts the watcher when exclude patterns change and supports manual reindex', async () => {
    await selectVault({ path: '/vault/config' })
    vi.clearAllMocks()

    await expect(updateConfig({ excludePatterns: ['node_modules'] })).resolves.toEqual({
      excludePatterns: ['node_modules'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    })

    expect(mocks.writeVaultConfig).toHaveBeenCalledWith('/vault/config', {
      excludePatterns: ['node_modules']
    })
    expect(mocks.stopWatcher).toHaveBeenCalled()
    expect(mocks.startWatcher).toHaveBeenCalledWith('/vault/config', ['node_modules'])

    await reindex()
    expect(mocks.indexVault).toHaveBeenCalledWith('/vault/config')
    expect(getStatus().indexProgress).toBe(100)
  })

  it('drains deferred embeddings after a manual reindex and a structural config rebuild', async () => {
    await selectVault({ path: '/vault/config' })
    // The open-time reconcile already ran; only the passes below should count.
    mocks.reconcileProjections.mockClear()

    // Both passes run with isIndexing set, so the embedding projector defers
    // every note they touch. Without a drain here those ids sit unembedded until
    // the next vault open.
    await reindex()
    expect(mocks.reconcileProjections).toHaveBeenCalledWith(['embedding'])

    mocks.reconcileProjections.mockClear()
    await updateConfig({ journalFolder: 'diary' })

    expect(mocks.rebuildIndex).toHaveBeenCalledWith('/vault/config')
    expect(mocks.reconcileProjections).toHaveBeenCalledWith(['embedding'])
  })

  it('reports a failed embedding drain without failing the reindex', async () => {
    await selectVault({ path: '/vault/config' })
    mocks.reconcileProjections.mockRejectedValueOnce(new Error('drain failed'))

    // The drain is fire-and-forget, so its failure must surface in telemetry
    // rather than rejecting the reindex the user asked for.
    await expect(reindex()).resolves.toBeUndefined()
    await Promise.resolve()

    expect(mocks.trackMainError).toHaveBeenCalledWith(
      'vault',
      'projection_reconcile',
      expect.any(Error)
    )
  })

  it('returns default config when closed and closes/removes the active vault', async () => {
    await selectVault({ path: '/vault/remove' })

    expect(getAllVaults().vaults).toHaveLength(1)
    await removeVault('/vault/remove')

    expect(getStatus()).toEqual(
      expect.objectContaining({ isOpen: false, path: null, indexProgress: 0 })
    )
    expect(mocks.currentVaultPath).toBeNull()
    expect(getAllVaults().vaults).toEqual([])
    expect(getConfig()).toEqual({
      excludePatterns: [],
      defaultNoteFolder: '',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    })
    expect(mocks.closeAllDatabases).toHaveBeenCalled()
    expect(mocks.destroyPropertyDefinitions).toHaveBeenCalled()
    expect(mocks.unregisterLazyAgentHandlers).toHaveBeenCalled()
    expect(mocks.agentShutdown).not.toHaveBeenCalled()
    expect(mocks.stopAgentMcpLifecycle).not.toHaveBeenCalled()
  })

  it('restarts vault-scoped agent services when switching vaults', async () => {
    await selectVault({ path: '/vault/one' })
    const firstStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>
    await firstStarter()

    expect(mocks.startAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.startAgent).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mocks.startAgentMcpLifecycle.mockResolvedValue(undefined)
    mocks.stopAgentMcpLifecycle.mockResolvedValue(undefined)
    mocks.agentShutdown.mockResolvedValue(undefined)
    mocks.startAgent.mockResolvedValue({ shutdown: mocks.agentShutdown })

    await selectVault({ path: '/vault/two' })

    expect(mocks.agentShutdown).toHaveBeenCalledTimes(1)
    expect(mocks.stopAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.closeAllDatabases).toHaveBeenCalledTimes(1)
    expect(mocks.configureLazyAgentServices).toHaveBeenCalledWith(expect.any(Function))
    const secondStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>
    await secondStarter()
    expect(mocks.startAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.startAgent).toHaveBeenCalledTimes(1)
    expect(mocks.agentShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeAllDatabases.mock.invocationCallOrder[0]
    )
    expect(mocks.currentVaultPath).toBe('/vault/two')
  })

  // A vault switch that lands while startAgent() is still in flight used to
  // early-return from the agent teardown (agentHandle was still null), so the
  // orphaned start resolved *after* the next vault registered its lazy
  // handlers: registerAgentHandlers() replaced them with handlers closed over
  // the previous vault's db/conversations/vaultId, and that runtime was never
  // shut down (vault key left unzeroed, subprocesses left alive).
  it('tears down an agent runtime that finishes starting during a vault switch', async () => {
    await selectVault({ path: '/vault/one' })
    const firstStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>

    // Park the startup inside startAgent() so the switch is guaranteed to run
    // in the gap — no timers, no timing assumptions.
    let markStartAgentEntered!: () => void
    const startAgentEntered = new Promise<void>((resolve) => {
      markStartAgentEntered = resolve
    })
    let releaseStartAgent!: (handle: { shutdown: () => Promise<void> }) => void
    const staleHandle = new Promise<{ shutdown: () => Promise<void> }>((resolve) => {
      releaseStartAgent = resolve
    })
    mocks.startAgent.mockImplementation(() => {
      markStartAgentEntered()
      return staleHandle
    })

    const startupInFlight = firstStarter()
    await startAgentEntered

    vi.useFakeTimers()
    try {
      const switchInFlight = selectVault({ path: '/vault/two' })
      releaseStartAgent({ shutdown: mocks.agentShutdown })
      await startupInFlight
      await switchInFlight

      // The settle path must clear its timeout rather than leave a pending
      // timer behind — closeVault() also runs on the quit path.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }

    // The orphaned runtime is shut down: handlers unregistered, subprocesses
    // killed, vault key zeroed.
    expect(mocks.agentShutdown).toHaveBeenCalledTimes(1)
    expect(mocks.stopAgentMcpLifecycle).toHaveBeenCalledTimes(1)

    // ...and it is torn down before the previous vault's databases close and
    // before the new vault publishes its own agent IPC handlers, so the new
    // vault's channels are never replaced by old-vault-bound ones.
    const shutdownOrder = mocks.agentShutdown.mock.invocationCallOrder[0]
    expect(shutdownOrder).toBeLessThan(mocks.closeAllDatabases.mock.invocationCallOrder[0])
    expect(shutdownOrder).toBeLessThan(
      mocks.registerLazyAgentHandlers.mock.invocationCallOrder.at(-1) as number
    )

    // The new vault gets its own runtime rather than inheriting the stale
    // handle — never two live runtimes, never zero.
    mocks.startAgent.mockReset()
    mocks.startAgent.mockResolvedValue({ shutdown: mocks.agentShutdown })
    const secondStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>
    await secondStarter()
    expect(mocks.startAgent).toHaveBeenCalledTimes(1)
    expect(mocks.currentVaultPath).toBe('/vault/two')
  })

  // closeVault() also runs on the quit path, where main/index.ts force-exits
  // after 5s. Waiting on a start that never settles would trade the leak above
  // for a frozen vault switch and a hung quit, so the wait is bounded.
  it('does not block a vault switch on an agent startup that never settles', async () => {
    await selectVault({ path: '/vault/one' })
    const firstStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>

    let markStartAgentEntered!: () => void
    const startAgentEntered = new Promise<void>((resolve) => {
      markStartAgentEntered = resolve
    })
    // Wedged start: resolvable only by the test, so the module is not left
    // holding a forever-pending promise after this case.
    let releaseStuckStart!: (handle: { shutdown: () => Promise<void> }) => void
    const stuckStart = new Promise<{ shutdown: () => Promise<void> }>((resolve) => {
      releaseStuckStart = resolve
    })
    mocks.startAgent.mockImplementation(() => {
      markStartAgentEntered()
      return stuckStart
    })

    const startupInFlight = firstStarter()
    await startAgentEntered

    vi.useFakeTimers()
    try {
      let switchSettled = false
      const switchInFlight = selectVault({ path: '/vault/two' }).then((result) => {
        switchSettled = true
        return result
      })

      // Burn exactly the teardown budget. advanceTimersByTimeAsync drains
      // microtasks between ticks, so an unbounded wait leaves this false.
      await vi.advanceTimersByTimeAsync(1000)

      expect(switchSettled).toBe(true)
      await switchInFlight
    } finally {
      vi.useRealTimers()
      releaseStuckStart({ shutdown: mocks.agentShutdown })
      await startupInFlight
    }

    // The switch completed and the new vault owns its own agent IPC handlers.
    expect(getStatus()).toEqual(expect.objectContaining({ isOpen: true, path: '/vault/two' }))
    expect(mocks.currentVaultPath).toBe('/vault/two')
    expect(mocks.closeAllDatabases).toHaveBeenCalledTimes(1)
    expect(mocks.registerLazyAgentHandlers.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mocks.unregisterLazyAgentHandlers.mock.invocationCallOrder[0] as number
    )
  })

  // The bound has to be generous enough that a slow-but-healthy start is still
  // waited for; a wait that gives up immediately would be no fix at all.
  it('waits for a slow agent startup that settles inside the teardown budget', async () => {
    await selectVault({ path: '/vault/one' })
    const firstStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>

    vi.useFakeTimers()
    try {
      mocks.startAgent.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ shutdown: mocks.agentShutdown }), 500)
          })
      )

      const startupInFlight = firstStarter()
      await vi.advanceTimersByTimeAsync(0)

      const switchInFlight = selectVault({ path: '/vault/two' })
      await vi.advanceTimersByTimeAsync(500)
      await startupInFlight
      await switchInFlight
    } finally {
      vi.useRealTimers()
    }

    expect(mocks.agentShutdown).toHaveBeenCalledTimes(1)
    expect(mocks.stopAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.agentShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeAllDatabases.mock.invocationCallOrder[0]
    )
  })

  // startAgentMcpLifecycle() binds the localhost server's tool closures to this
  // vault's data/index databases *before* startAgent() runs, so a start that
  // fails after that point leaves a listening, bearer-authenticated server
  // holding the outgoing vault's handles. Teardown keyed on agentHandle skipped
  // it, and startAgentMcpLifecycle()'s `if (handle) return` then handed that
  // same server to the next vault.
  it('stops the MCP server when the agent runtime failed to start', async () => {
    await selectVault({ path: '/vault/one' })
    const firstStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>
    mocks.startAgent.mockRejectedValue(new Error('agent runtime exploded'))

    await firstStarter()

    expect(mocks.startAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.stopAgentMcpLifecycle).not.toHaveBeenCalled()

    await selectVault({ path: '/vault/two' })

    // The listener is closed — and closed before the databases its tool
    // closures captured, so it never serves the outgoing vault to a client
    // holding the still-valid bearer token.
    expect(mocks.stopAgentMcpLifecycle).toHaveBeenCalledTimes(1)
    expect(mocks.stopAgentMcpLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeAllDatabases.mock.invocationCallOrder[0]
    )
    // Nothing to shut down on the agent side: that runtime never came up.
    expect(mocks.agentShutdown).not.toHaveBeenCalled()

    // ...and the next vault starts its own server instead of inheriting the
    // stale one — never two live servers, never zero.
    mocks.startAgent.mockResolvedValue({ shutdown: mocks.agentShutdown })
    const secondStarter = mocks.configureLazyAgentServices.mock.calls.at(
      -1
    )?.[0] as () => Promise<void>
    await secondStarter()

    expect(mocks.startAgentMcpLifecycle).toHaveBeenCalledTimes(2)
    expect(mocks.startAgent).toHaveBeenCalledTimes(2)
    expect(mocks.currentVaultPath).toBe('/vault/two')
  })

  it('auto-opens the test vault and emits explicit progress/error events', async () => {
    process.env.NODE_ENV = 'test'
    process.env.TEST_VAULT_PATH = '/vault/e2e'
    mocks.isVaultInitialized.mockReturnValue(false)

    await autoOpenLastVault()
    emitIndexProgress(55)
    emitVaultError('boom')

    expect(mocks.initVault).toHaveBeenCalledWith('/vault/e2e')
    expect(getStatus()).toEqual(expect.objectContaining({ isOpen: true, error: 'boom' }))
    expect(mocks.sent).toContainEqual({ channel: 'vault:index-progress', payload: 55 })
    expect(mocks.sent).toContainEqual({ channel: 'vault:error', payload: 'boom' })
  })
})
