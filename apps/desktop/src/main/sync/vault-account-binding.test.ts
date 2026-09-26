import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import type { VaultBindingState } from '@memry/contracts/ipc-sync-ops'

const mocks = vi.hoisted(() => ({
  storedDeviceId: 'device-b' as string | undefined,
  currentVaultPath: null as string | null,
  vaults: [] as Array<Record<string, unknown>>
}))

vi.mock('../store', () => ({
  getStoredDeviceId: () => mocks.storedDeviceId,
  getCurrentVaultPath: () => mocks.currentVaultPath,
  getAccountVaultsCache: () => ({
    fetchedAt: 0,
    vaults: [{ vaultUuid: 'account-vault', name: 'Main', itemCount: 9, createdAt: 0 }]
  }),
  findVault: (p: string) => mocks.vaults.find((v) => v.path === p),
  upsertVault: (v: Record<string, unknown>) => {
    mocks.vaults = mocks.vaults.map((e) => (e.path === v.path ? v : e))
  }
}))
vi.mock('./http-client', () => ({ getFromServer: vi.fn() }))
vi.mock('./token-manager', () => ({ getValidAccessToken: vi.fn(), retrieveToken: vi.fn() }))
vi.mock('./vault-directory', () => ({ refreshVaultDirectory: vi.fn(async () => {}) }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { getFromServer } from './http-client'
import { getValidAccessToken, retrieveToken } from './token-manager'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  applyOpenVaultBinding,
  bindVaultForSync,
  getVaultBindingState,
  resetVaultBindingState,
  decideVaultBinding,
  isChoiceAllowed,
  readVaultAccountBinding,
  vaultHasForeignHistory,
  vaultHasLocalContent,
  writeVaultAccountBinding,
  type BindingInputs
} from './vault-account-binding'

function createDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
      modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, clock TEXT);
    CREATE TABLE inbox_items (id TEXT PRIMARY KEY, clock TEXT);
    CREATE TABLE note_metadata (id TEXT PRIMARY KEY, clock TEXT);
    CREATE TABLE sync_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
      os_version TEXT, app_version TEXT NOT NULL, linked_at INTEGER NOT NULL,
      last_sync_at INTEGER, is_current_device INTEGER NOT NULL DEFAULT 0,
      signing_public_key TEXT NOT NULL);
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO vault_metadata VALUES ('singleton', 'local-vault', 0, 0);
  `)
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

const base: BindingInputs = {
  binding: null,
  userId: 'user-b',
  localVaultUuid: 'local-vault',
  hasLocalContent: true,
  hasForeignHistory: false,
  accountVaults: []
}

describe('decideVaultBinding', () => {
  it('starts a vault already bound to this account', () => {
    expect(decideVaultBinding({ ...base, binding: { userId: 'user-b', mode: 'sync' } })).toEqual({
      action: 'start',
      bind: false
    })
  })

  it('never syncs a vault bound to another account', () => {
    const decision = decideVaultBinding({
      ...base,
      binding: { userId: 'user-a', mode: 'sync' },
      // Even when nothing else would stand in the way.
      hasLocalContent: false
    })
    expect(decision).toEqual({ action: 'hold', state: { status: 'foreign' } })
  })

  it('keeps a vault this account chose to keep local', () => {
    expect(decideVaultBinding({ ...base, binding: { userId: 'user-b', mode: 'local' } })).toEqual({
      action: 'hold',
      state: { status: 'local-only' }
    })
  })

  it('binds an empty vault without asking, even offline', () => {
    expect(decideVaultBinding({ ...base, hasLocalContent: false, accountVaults: null })).toEqual({
      action: 'start',
      bind: true
    })
  })

  it('holds when ownership cannot be checked', () => {
    expect(decideVaultBinding({ ...base, accountVaults: null })).toEqual({
      action: 'hold',
      state: { status: 'unknown' }
    })
  })

  it('binds a vault from an older version that the account already knows', () => {
    const decision = decideVaultBinding({
      ...base,
      hasForeignHistory: true,
      accountVaults: [{ vaultUuid: 'local-vault' }]
    })
    expect(decision).toEqual({ action: 'start', bind: true })
  })

  it('treats history from another session on an unknown vault as foreign', () => {
    const decision = decideVaultBinding({
      ...base,
      hasForeignHistory: true,
      accountVaults: [{ vaultUuid: 'account-vault' }]
    })
    expect(decision).toEqual({ action: 'hold', state: { status: 'foreign' } })
  })

  it('asks before syncing local content into an account, offering the largest vault to merge', () => {
    const decision = decideVaultBinding({
      ...base,
      accountVaults: [
        { vaultUuid: 'small', itemCount: 1 },
        { vaultUuid: 'account-vault', itemCount: 9 }
      ]
    })
    expect(decision).toEqual({
      action: 'hold',
      state: {
        status: 'needs-decision',
        accountVaultCount: 2,
        mergeTarget: { vaultUuid: 'account-vault', name: 'Main' }
      }
    })
  })

  it('asks even when the account is empty, with nothing to merge into', () => {
    expect(decideVaultBinding(base)).toEqual({
      action: 'hold',
      state: { status: 'needs-decision', accountVaultCount: 0, mergeTarget: null }
    })
  })

  it('re-binds a vault another account only kept local', () => {
    const decision = decideVaultBinding({
      ...base,
      binding: { userId: 'user-a', mode: 'local' },
      hasLocalContent: false
    })
    expect(decision).toEqual({ action: 'start', bind: true })
  })
})

describe('isChoiceAllowed', () => {
  const needs = (
    mergeTarget: { vaultUuid: string; name: string | null } | null
  ): VaultBindingState => ({
    status: 'needs-decision',
    accountVaultCount: 1,
    mergeTarget
  })

  it('accepts nothing for a foreign vault', () => {
    for (const choice of ['sync', 'merge', 'local'] as const) {
      expect(isChoiceAllowed({ status: 'foreign' }, choice)).toBe(false)
    }
  })

  it('only merges when there is a target', () => {
    expect(isChoiceAllowed(needs(null), 'merge')).toBe(false)
    expect(isChoiceAllowed(needs({ vaultUuid: 'v', name: null }), 'merge')).toBe(true)
  })

  it('lets a local-only vault start syncing', () => {
    expect(isChoiceAllowed({ status: 'local-only' }, 'sync')).toBe(true)
    expect(isChoiceAllowed({ status: 'local-only' }, 'merge')).toBe(false)
  })
})

describe('storage and inputs', () => {
  let db: ReturnType<typeof createDb>['db']
  let sqlite: ReturnType<typeof createDb>['sqlite']
  let vaultDir: string

  beforeEach(() => {
    ;({ db, sqlite } = createDb())
    vaultDir = mkdtempSync(path.join(tmpdir(), 'memry-binding-'))
    mocks.currentVaultPath = vaultDir
    mocks.storedDeviceId = 'device-b'
    mocks.vaults = [{ path: vaultDir, name: 'V', vaultUuid: 'local-vault' }]
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('round-trips the binding and mirrors it onto the store entry', () => {
    expect(readVaultAccountBinding(db)).toBeNull()
    writeVaultAccountBinding(db, { userId: 'user-b', mode: 'local' })
    expect(readVaultAccountBinding(db)).toEqual({ userId: 'user-b', mode: 'local' })
    expect(mocks.vaults[0].accountBinding).toEqual({ userId: 'user-b', mode: 'local' })
  })

  it('ignores a malformed binding row', () => {
    sqlite
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('sync.account-binding.v1', '{"mode":"x"}')`
      )
      .run()
    expect(readVaultAccountBinding(db)).toBeNull()
  })

  it('treats a vault with only folders and app state as empty', () => {
    mkdirSync(path.join(vaultDir, 'Journal'))
    mkdirSync(path.join(vaultDir, '.memry'))
    writeFileSync(path.join(vaultDir, '.memry', 'data.db'), '')
    expect(vaultHasLocalContent(db, vaultDir)).toBe(false)
  })

  it('finds a note in a nested folder, or a task in the database', () => {
    mkdirSync(path.join(vaultDir, 'a', 'b'), { recursive: true })
    writeFileSync(path.join(vaultDir, 'a', 'b', 'note.md'), '# hi')
    expect(vaultHasLocalContent(db, vaultDir)).toBe(true)

    rmSync(path.join(vaultDir, 'a'), { recursive: true })
    sqlite.prepare(`INSERT INTO tasks (id) VALUES ('t1')`).run()
    expect(vaultHasLocalContent(db, vaultDir)).toBe(true)
  })

  it('sees ticks from another device as foreign history, but not our own or offline ones', () => {
    sqlite
      .prepare(`INSERT INTO tasks (id, clock) VALUES ('t1', '{"device-b":2,"_offline":1}')`)
      .run()
    expect(vaultHasForeignHistory(db)).toBe(false)

    sqlite.prepare(`INSERT INTO note_metadata (id, clock) VALUES ('n1', '{"device-a":1}')`).run()
    expect(vaultHasForeignHistory(db)).toBe(true)
  })

  it('drops a previous session device row and cursor when binding', () => {
    sqlite
      .prepare(
        `INSERT INTO sync_devices (id, name, platform, app_version, linked_at, is_current_device, signing_public_key)
         VALUES ('device-a', 'mac', 'macos', '1', 0, 1, 'pk')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('lastCursor', '42', 0)`)
      .run()

    bindVaultForSync(db, 'user-b')

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_devices').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_state').get()).toEqual({ n: 0 })
    expect(readVaultAccountBinding(db)).toEqual({ userId: 'user-b', mode: 'sync' })
  })

  it('keeps this session’s own device row and cursor when binding', () => {
    sqlite
      .prepare(
        `INSERT INTO sync_devices (id, name, platform, app_version, linked_at, is_current_device, signing_public_key)
         VALUES ('device-b', 'mac', 'macos', '1', 0, 1, 'pk')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('lastCursor', '42', 0)`)
      .run()

    bindVaultForSync(db, 'user-b')

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_devices').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_state').get()).toEqual({ n: 1 })
  })
})

describe('applyOpenVaultBinding', () => {
  let db: ReturnType<typeof createDb>['db']
  let vaultDir: string

  const tokenFor = (sub: string): string =>
    ['{"alg":"none"}', JSON.stringify({ sub })]
      .map((part) => Buffer.from(part).toString('base64url'))
      .join('.') + '.sig'

  beforeEach(() => {
    ;({ db } = createDb())
    vaultDir = mkdtempSync(path.join(tmpdir(), 'memry-binding-gate-'))
    writeFileSync(path.join(vaultDir, 'note.md'), '# mine')
    mocks.currentVaultPath = vaultDir
    mocks.storedDeviceId = 'device-b'
    mocks.vaults = [{ path: vaultDir, name: 'V', vaultUuid: 'local-vault' }]
    vi.mocked(retrieveToken).mockResolvedValue(tokenFor('user-b'))
    vi.mocked(getValidAccessToken).mockResolvedValue('access')
    vi.mocked(broadcastToAllWindows).mockClear()
    resetVaultBindingState()
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('binds a vault from an older version the account already has, and starts', async () => {
    vi.mocked(getFromServer).mockResolvedValue({ vaults: [{ vaultUuid: 'local-vault' }] })

    await expect(applyOpenVaultBinding(db)).resolves.toBe('start')

    expect(readVaultAccountBinding(db)).toEqual({ userId: 'user-b', mode: 'sync' })
    expect(getVaultBindingState()).toEqual({ status: 'bound' })
  })

  it('holds another account’s vault and tells the renderer, without asking the server', async () => {
    writeVaultAccountBinding(db, { userId: 'user-a', mode: 'sync' })
    vi.mocked(getFromServer).mockClear()

    await expect(applyOpenVaultBinding(db)).resolves.toBe('held')

    expect(getFromServer).not.toHaveBeenCalled()
    expect(readVaultAccountBinding(db)).toEqual({ userId: 'user-a', mode: 'sync' })
    expect(broadcastToAllWindows).toHaveBeenCalledWith('sync:vault-binding-changed', {
      status: 'foreign'
    })
  })

  it('reports unknown when the account cannot be reached', async () => {
    vi.mocked(getFromServer).mockRejectedValue(new Error('offline'))

    await expect(applyOpenVaultBinding(db)).resolves.toBe('unknown')
    expect(readVaultAccountBinding(db)).toBeNull()
  })
})
