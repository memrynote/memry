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
  startSyncRuntime: vi.fn(),
  stopSyncRuntime: vi.fn(),
  startProjectionRuntime: vi.fn(),
  stopProjectionRuntime: vi.fn(),
  reconcileProjections: vi.fn(),
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
          isDestroyed: () => false,
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
