import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { VaultActivityChannels } from '@memry/contracts/vault-activity-api'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    },
    shell: { showItemInFolder: vi.fn() }
  }
})

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  shell: mocks.shell,
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

import { closeActivityLog, openActivityLog, recordActivity } from '../vault/activity-log'
import {
  registerVaultActivityHandlers,
  unregisterVaultActivityHandlers
} from './vault-activity-handlers'

function invoke(channel: string, input?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, input))
}

describe('vault activity IPC handlers', () => {
  let vaultPath: string

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-activity-ipc-'))
    registerVaultActivityHandlers()
  })

  afterEach(async () => {
    unregisterVaultActivityHandlers()
    await closeActivityLog()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('reports the log as unavailable while no vault is open', async () => {
    await expect(invoke(VaultActivityChannels.invoke.LIST, {})).resolves.toEqual({
      entries: [],
      retentionDays: 30,
      available: false
    })
    await expect(invoke(VaultActivityChannels.invoke.REVEAL)).resolves.toEqual({ revealed: false })
    expect(mocks.shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('lists, filters, re-times and clears the open vault log', async () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })
    recordActivity({ kind: 'failed', source: 'drop', path: 'b.md', reason: 'copy-failed' })

    const all = (await invoke(VaultActivityChannels.invoke.LIST, { limit: 10 })) as {
      entries: { path?: string }[]
      available: boolean
    }
    expect(all.available).toBe(true)
    expect(all.entries.map((entry) => entry.path)).toEqual(['b.md', 'a.md'])

    const problems = (await invoke(VaultActivityChannels.invoke.LIST, {
      filter: 'problems'
    })) as { entries: { path?: string }[] }
    expect(problems.entries.map((entry) => entry.path)).toEqual(['b.md'])

    await expect(invoke(VaultActivityChannels.invoke.SET_RETENTION, { days: 7 })).resolves.toEqual({
      retentionDays: 7
    })
    const retimed = (await invoke(VaultActivityChannels.invoke.LIST, {})) as {
      retentionDays: number
    }
    expect(retimed.retentionDays).toBe(7)

    await expect(invoke(VaultActivityChannels.invoke.CLEAR)).resolves.toEqual({ cleared: true })
    const cleared = (await invoke(VaultActivityChannels.invoke.LIST, {})) as {
      entries: unknown[]
    }
    expect(cleared.entries).toEqual([])
  })

  it('rejects a retention the settings do not offer', async () => {
    openActivityLog(vaultPath)
    await expect(invoke(VaultActivityChannels.invoke.SET_RETENTION, { days: 12 })).rejects.toThrow()
  })

  it('creates the log file before revealing it', async () => {
    openActivityLog(vaultPath)
    const logPath = path.join(vaultPath, '.memry', 'activity.jsonl')

    await expect(invoke(VaultActivityChannels.invoke.REVEAL)).resolves.toEqual({ revealed: true })

    expect(fs.existsSync(logPath)).toBe(true)
    expect(mocks.shell.showItemInFolder).toHaveBeenCalledWith(logPath)
  })

  it('removes every handler it registered', () => {
    unregisterVaultActivityHandlers()
    expect(mocks.handlers.size).toBe(0)
  })
})
