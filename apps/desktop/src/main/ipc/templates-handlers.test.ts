/**
 * Templates IPC handlers tests
 *
 * @module ipc/templates-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

vi.mock('../vault/templates', () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  duplicateTemplate: vi.fn()
}))

import { registerTemplatesHandlers, unregisterTemplatesHandlers } from './templates-handlers'
import * as templates from '../vault/templates'

describe('templates-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
  })

  afterEach(() => {
    unregisterTemplatesHandlers()
  })

  it('lists and gets templates', async () => {
    registerTemplatesHandlers()
    ;(templates.listTemplates as vi.Mock).mockResolvedValue([{ id: 't1', name: 'Template 1' }])
    ;(templates.getTemplate as vi.Mock).mockReturnValue({ id: 't1', name: 'Template 1' })

    const listResult = await invokeHandler(TemplatesChannels.invoke.LIST)
    expect(listResult).toEqual({ templates: [{ id: 't1', name: 'Template 1' }] })

    const getResult = await invokeHandler(TemplatesChannels.invoke.GET, 't1')
    expect(getResult).toEqual({ id: 't1', name: 'Template 1' })
  })

  it('creates, updates, deletes, and duplicates templates', async () => {
    registerTemplatesHandlers()
    ;(templates.createTemplate as vi.Mock).mockResolvedValue({ id: 't2', name: 'New' })
    ;(templates.updateTemplate as vi.Mock).mockResolvedValue({ id: 't2', name: 'Updated' })
    ;(templates.deleteTemplate as vi.Mock).mockResolvedValue(undefined)
    ;(templates.duplicateTemplate as vi.Mock).mockResolvedValue({ id: 't3', name: 'Copy' })

    const createResult = await invokeHandler(TemplatesChannels.invoke.CREATE, {
      name: 'New',
      tags: [],
      properties: [],
      content: ''
    })
    expect(createResult).toEqual({ success: true, template: { id: 't2', name: 'New' } })

    const updateResult = await invokeHandler(TemplatesChannels.invoke.UPDATE, {
      id: 't2',
      name: 'Updated'
    })
    expect(updateResult).toEqual({ success: true, template: { id: 't2', name: 'Updated' } })

    const deleteResult = await invokeHandler(TemplatesChannels.invoke.DELETE, 't2')
    expect(deleteResult).toEqual({ success: true })

    const duplicateResult = await invokeHandler(TemplatesChannels.invoke.DUPLICATE, {
      id: 't2',
      newName: 'Copy'
    })
    expect(duplicateResult).toEqual({ success: true, template: { id: 't3', name: 'Copy' } })
  })

  it('returns errors when template operations fail', async () => {
    registerTemplatesHandlers()
    ;(templates.createTemplate as vi.Mock).mockRejectedValue(new Error('create failed'))
    const createResult = await invokeHandler(TemplatesChannels.invoke.CREATE, {
      name: 'Bad',
      tags: [],
      properties: [],
      content: ''
    })
    expect(createResult).toEqual({ success: false, error: 'create failed' })
    ;(templates.updateTemplate as vi.Mock).mockRejectedValue(new Error('update failed'))
    const updateResult = await invokeHandler(TemplatesChannels.invoke.UPDATE, {
      id: 't1',
      name: 'Bad'
    })
    expect(updateResult).toEqual({ success: false, error: 'update failed' })
    ;(templates.deleteTemplate as vi.Mock).mockRejectedValue(new Error('delete failed'))
    const deleteResult = await invokeHandler(TemplatesChannels.invoke.DELETE, 't1')
    expect(deleteResult).toEqual({ success: false, error: 'delete failed' })
    ;(templates.duplicateTemplate as vi.Mock).mockRejectedValue(new Error('duplicate failed'))
    const duplicateResult = await invokeHandler(TemplatesChannels.invoke.DUPLICATE, {
      id: 't1',
      newName: 'Copy'
    })
    expect(duplicateResult).toEqual({ success: false, error: 'duplicate failed' })
  })
})
