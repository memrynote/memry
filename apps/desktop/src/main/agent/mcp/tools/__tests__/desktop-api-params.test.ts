import { describe, expect, it, vi } from 'vitest'
import {
  AgentMcpDesktopOperations,
  AgentMcpDesktopWriteOperations
} from '@memry/contracts/agent-mcp-channels'

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: {}
}))

import { bookmarksApi } from '../../../../../preload/api/bookmarks'
import { propertiesApi, savedFiltersApi, templatesApi } from '../../../../../preload/api/content'
import { folderViewApi } from '../../../../../preload/api/folder-view'
import { homePagesApi } from '../../../../../preload/api/home-pages'
import { journalApi } from '../../../../../preload/api/journal'
import { remindersApi } from '../../../../../preload/api/reminders'
import { graphApi, searchApi } from '../../../../../preload/api/search'
import { tagsApi } from '../../../../../preload/api/tags'
import { vaultApi } from '../../../../../preload/api/vault'
import { assertDesktopApiArgs, desktopOperationParams } from '../desktop-api-params'
import { desktopWriteReadback } from '../desktop-api-readback'

const handWrittenApis: Record<string, Record<string, unknown>> = {
  bookmarks: bookmarksApi,
  folderView: folderViewApi,
  graph: graphApi,
  homePages: homePagesApi,
  journal: journalApi,
  properties: propertiesApi,
  reminders: remindersApi,
  savedFilters: savedFiltersApi,
  search: searchApi,
  tags: tagsApi,
  templates: templatesApi,
  vault: vaultApi
}

describe('desktop API parameter lists', () => {
  it('match the preload function behind every hand-written operation', () => {
    const mismatches: string[] = []
    for (const operation of AgentMcpDesktopOperations) {
      const [domain, method] = operation.split('.')
      const fn = handWrittenApis[domain]?.[method]
      if (fn === undefined) continue
      const params = desktopOperationParams(operation)
      if (typeof fn !== 'function' || fn.length !== params.length) {
        mismatches.push(`${operation}: table ${params.length}, preload ${String(fn)}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('cover every allowlisted operation', () => {
    const missing = AgentMcpDesktopOperations.filter((operation) => {
      try {
        desktopOperationParams(operation)
        return false
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  it('accept a call up to the last parameter, including the two-string calendar range', () => {
    expect(() =>
      assertDesktopApiArgs({ operation: 'properties.set', args: ['note-1', { Status: 'Done' }] })
    ).not.toThrow()
    expect(() =>
      assertDesktopApiArgs({ operation: 'calendar.getRange', args: ['2026-10-01', '2026-10-02'] })
    ).not.toThrow()
    expect(() =>
      assertDesktopApiArgs({ operation: 'properties.set', args: ['note-1', {}, { merge: true }] })
    ).toThrow(
      'properties.set takes 2 arguments (entityId, properties), but this call passed 3. Nothing was run.'
    )
  })

  it('read back every write with a call the read operation accepts', () => {
    const args = [{ projectId: 'p1', itemId: 'i1', tag: 't', newName: 'n', id: 'c1' }, 'b', 'c']
    for (const operation of AgentMcpDesktopWriteOperations) {
      const readback = desktopWriteReadback({ operation, args })
      if (readback) expect(() => assertDesktopApiArgs(readback.request), operation).not.toThrow()
    }
  })
})
