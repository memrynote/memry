import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentMcpDesktopOperations,
  AgentMcpDesktopWriteOperations,
  type AgentMcpDesktopOperation
} from '@memry/contracts/agent-mcp-channels'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
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
import { createGeneratedRpcApi } from '../../../../../preload/generated-rpc'
import { ipcRenderer } from 'electron'
import { rpcDomains } from '@memry/rpc'
import {
  AGENT_DESKTOP_OPERATION_PARAMS,
  desktopOperationJsonSchema,
  desktopOperationParamNames,
  desktopOperationRequiredCount
} from '@memry/contracts/agent-desktop-api-args'
import { AgentToolError } from '../../errors'
import { assertDesktopApiArgs } from '../desktop-api-params'
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
  it('name and forward every parameter of the preload function behind each hand-written operation', async () => {
    const mismatches: string[] = []
    for (const operation of AgentMcpDesktopOperations) {
      const [domain, method] = operation.split('.')
      const fn = handWrittenApis[domain]?.[method]
      if (fn === undefined) continue
      if (typeof fn !== 'function') {
        mismatches.push(`${operation}: preload is not a function`)
        continue
      }
      const params = desktopOperationParamNames(operation)
      const source = /^(?:async\s*)?(?:function\s*\w*\s*)?\(([^)]*)\)/.exec(fn.toString())
      const names = (source?.[1] ?? '')
        .split(',')
        .map((param) => param.split('=')[0].trim())
        .filter(Boolean)
      if (names.join(',') !== params.join(',')) {
        mismatches.push(`${operation}: table (${params.join(', ')}), preload (${names.join(', ')})`)
      }
      const sentinels = params.map((name) => `sentinel-${name}`)
      vi.mocked(ipcRenderer.invoke).mockClear()
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(undefined)
      await (fn as (...args: unknown[]) => unknown)(...sentinels)
      const sent = JSON.stringify(vi.mocked(ipcRenderer.invoke).mock.calls)
      const dropped = sentinels.filter((sentinel) => !sent.includes(JSON.stringify(sentinel)))
      if (dropped.length > 0) mismatches.push(`${operation}: preload drops ${dropped.join(', ')}`)
    }
    expect(mismatches).toEqual([])
  })

  it('name the parameters of every generated operation as its RPC spec does', () => {
    const mismatches: string[] = []
    for (const operation of AgentMcpDesktopOperations) {
      const [domain, method] = operation.split('.')
      if (handWrittenApis[domain]?.[method] !== undefined) continue
      const spec = (
        rpcDomains.find((candidate) => candidate.name === domain)?.methods as
          Record<string, { params: readonly string[] }> | undefined
      )?.[method]
      // The responder still takes the older (start, end) string pair.
      const expected =
        operation === 'calendar.getRange' ? ['inputOrStart', 'end'] : (spec?.params ?? [])
      if (desktopOperationParamNames(operation).join(',') !== expected.join(',')) {
        mismatches.push(
          `${operation}: contract (${desktopOperationParamNames(operation).join(', ')}), rpc (${expected.join(', ')})`
        )
      }
    }
    expect(mismatches).toEqual([])
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
    // Each argument takes the kind its parameter declares, so the write itself
    // would pass and only the read-back request is under test.
    const object = { projectId: 'p1', itemId: 'i1', noteId: 'n1', tag: 't', newName: 'n', id: 'c1' }
    const sample = (item: { type?: unknown } | undefined, index: number): unknown => {
      if (item?.type === 'string') return `arg${index}`
      if (item?.type === 'array') return [`arg${index}`]
      if (item?.type === 'number' || item?.type === 'integer') return 1
      if (item?.type === 'boolean') return true
      return object
    }
    for (const operation of AgentMcpDesktopWriteOperations) {
      const names = desktopOperationParamNames(operation)
      const items = desktopOperationJsonSchema(operation).prefixItems ?? []
      const args = items.map((item, index) =>
        names[index] === 'scope' ? { kind: 'folder', path: 'a' } : sample(item, index)
      )
      const readback = desktopWriteReadback({ operation, args })
      if (readback) expect(() => assertDesktopApiArgs(readback.request), operation).not.toThrow()
    }
  })

  it('accept null for exactly the optional arguments the preload, responder or handler reads as left out', async () => {
    const generatedInvoke = vi.fn(async () => undefined)
    const generatedApis = createGeneratedRpcApi({
      invoke: generatedInvoke as never,
      invokeSync: vi.fn() as never,
      subscribe: vi.fn() as never
    }) as unknown as Record<string, Record<string, unknown>>
    const sentToMain = async (
      fn: (...args: unknown[]) => unknown,
      args: unknown[]
    ): Promise<unknown[]> => {
      vi.mocked(ipcRenderer.invoke).mockClear()
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(undefined)
      generatedInvoke.mockClear()
      await fn(...args)
      return [...vi.mocked(ipcRenderer.invoke).mock.calls, ...generatedInvoke.mock.calls]
    }
    // Null passes the preload unchanged here; the code after it reads it as left out.
    const pastPreload = new Set([
      // inbox-handlers passes input to filing.convertToTask, which reads input?.projectId etc.
      'inbox.convertToTask:input',
      // The responder builds the range from args[0] alone unless both are strings.
      'calendar.getRange:end'
    ])

    const mismatches: string[] = []
    const acceptsNull: string[] = []
    for (const operation of AgentMcpDesktopOperations) {
      const [domain, method] = operation.split('.')
      const fn = (handWrittenApis[domain]?.[method] ?? generatedApis[domain]?.[method]) as (
        ...args: unknown[]
      ) => unknown
      const params = Object.entries(AGENT_DESKTOP_OPERATION_PARAMS[operation])
      for (let index = desktopOperationRequiredCount(operation); index < params.length; index++) {
        const [name, schema] = params[index]
        const id = `${operation}:${name}`
        const leading = params.slice(0, index).map(([param]) => `sentinel-${param}`)
        const readsNullAsAbsent =
          pastPreload.has(id) ||
          isDeepStrictEqual(await sentToMain(fn, [...leading, null]), await sentToMain(fn, leading))
        const accepts = schema.safeParse(null).success
        if (accepts) acceptsNull.push(id)
        if (readsNullAsAbsent !== accepts) {
          mismatches.push(
            `${id}: ${readsNullAsAbsent ? 'read as left out' : 'passed on as null'}, ` +
              `schema ${accepts ? 'accepts' : 'refuses'} null`
          )
        }
      }
    }
    expect(mismatches).toEqual([])
    expect(acceptsNull.sort()).toEqual([
      'bookmarks.list:options',
      'calendar.getRange:end',
      'calendar.listEvents:options',
      'canvas.create:input',
      'inbox.convertToTask:input',
      'inbox.getFilingHistory:options',
      'inbox.getJobs:options',
      'inbox.linkToNote:tags',
      'inbox.list:options',
      'inbox.listArchived:options',
      'notes.list:options',
      'reminders.list:options',
      'tasks.getUpcoming:days',
      'tasks.list:options'
    ])
  })

  it('publish null as allowed for an optional argument that accepts it', () => {
    expect(desktopOperationJsonSchema('notes.list').prefixItems?.[0]).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }])
    })
    expect(desktopOperationJsonSchema('inbox.linkToNote').prefixItems?.[2]).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }])
    })
    expect(() =>
      assertDesktopApiArgs({ operation: 'reminders.getUpcoming', args: [null] })
    ).toThrow('days: expected number, got null')
  })

  it('refuse a key inside an input object that the IPC handler would drop', () => {
    const define = (input: unknown) =>
      assertDesktopApiArgs({ operation: 'notes.createPropertyDefinition', args: [input] })

    expect(() => define({ name: 'mood', type: 'select', optionz: [] })).toThrow(
      'notes.createPropertyDefinition does not take input.optionz. Nothing was run.'
    )
    expect(() =>
      define({ name: 'mood', type: 'select', options: [{ value: 'Calm', color: 'sky', tint: 1 }] })
    ).toThrow('notes.createPropertyDefinition does not take input.options.0.tint. Nothing was run.')
    expect(() =>
      define({ name: 'mood', type: 'select', options: [{ value: 'Calm', color: 'sky' }] })
    ).not.toThrow()
  })
})

function validationError(operation: AgentMcpDesktopOperation, args: unknown[]): AgentToolError {
  try {
    assertDesktopApiArgs({ operation, args })
  } catch (error) {
    if (error instanceof AgentToolError) return error
    throw error
  }
  throw new Error(`${operation} accepted ${JSON.stringify(args)}`)
}

describe('desktop API argument validation', () => {
  it('names the field, the allowed values and what was sent for an enum', () => {
    const error = validationError('notes.ensurePropertyDefinition', ['mood', 'text'])
    expect(error.code).toBe('VALIDATION')
    expect(error.message).toBe(
      'notes.ensurePropertyDefinition arguments do not match its schema: ' +
        'type: expected one of "status", "select", "multiselect", got "text". Nothing was run. ' +
        'vault_desktop_describe with operation "notes.ensurePropertyDefinition" returns the ' +
        'full argument schema.'
    )
    expect(error.details).toMatchObject({
      operation: 'notes.ensurePropertyDefinition',
      issues: [
        {
          field: 'type',
          expected: 'one of "status", "select", "multiselect"',
          allowed: ['status', 'select', 'multiselect'],
          received: '"text"'
        }
      ]
    })
  })

  it('names a nested field by its path from the parameter', () => {
    expect(
      validationError('notes.createPropertyDefinition', [{ name: 'mood', type: 'txt' }]).message
    ).toContain(
      'input.type: expected one of "text", "number", "checkbox", "date", "url", "status", ' +
        '"select", "multiselect", got "txt"'
    )
  })

  it('spells out each shape a union argument takes', () => {
    expect(validationError('folderView.getViews', ['Projects']).message).toContain(
      'scope: expected { kind: "folder", path: string } | ' +
        '{ kind: "tag", tag: string, andTags?: string[] }, got "Projects"'
    )
    expect(
      validationError('folderView.getViews', [{ type: 'folder', path: 'a' }]).message
    ).toContain('scope.kind: expected one of "folder", "tag", got nothing')
    expect(validationError('folderView.getViews', [{ kind: 'folder' }]).message).toContain(
      'scope.path: expected string, got nothing'
    )
  })

  it('names the expected type of a positional argument', () => {
    expect(validationError('notes.get', [5]).message).toContain('id: expected string, got 5')
    expect(validationError('journal.getHeatmap', ['2026']).message).toContain(
      'year: expected integer, got "2026"'
    )
    expect(validationError('notes.get', []).message).toContain('id: expected string, got nothing')
  })

  it('lists every failing field in one reply', () => {
    const error = validationError('notes.rename', [1, null])
    expect(error.message).toContain('id: expected string, got 1')
    expect(error.message).toContain('newTitle: expected string, got null')
    expect(error.details?.issues).toHaveLength(2)
  })

  it('accepts what the IPC handler accepts', () => {
    const valid: Array<[AgentMcpDesktopOperation, unknown[]]> = [
      ['notes.ensurePropertyDefinition', ['mood', 'select']],
      ['folderView.getViews', [{ kind: 'tag', tag: 'work' }]],
      ['notes.list', []],
      ['notes.list', [{ folder: 'a', limit: 5 }]],
      ['tasks.getUpcoming', []],
      ['inbox.convertToTask', ['i1']],
      ['settings.setGeneralSettings', [{ startOnBoot: true }]]
    ]
    for (const [operation, args] of valid) {
      expect(() => assertDesktopApiArgs({ operation, args }), operation).not.toThrow()
    }
  })
})
