import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VIEW } from '@memry/contracts/folder-view-api'
import { folderViewService } from './folder-view-service'

const commands = vi.hoisted(() => ({
  folderViewGetConfig: vi.fn(),
  folderViewSetConfig: vi.fn(),
  folderViewGetViews: vi.fn(),
  folderViewSetView: vi.fn(),
  folderViewDeleteView: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
})

describe('folderViewService.getViews', () => {
  it('shows the default view when a scope saved none, a tag fields between title and modified', async () => {
    commands.folderViewGetViews.mockResolvedValueOnce({
      views: null,
      defaultIndex: 0,
      fieldColumns: null
    })
    await expect(folderViewService.getViews({ kind: 'folder', path: 'A' })).resolves.toEqual({
      views: [DEFAULT_VIEW],
      defaultIndex: 0
    })

    commands.folderViewGetViews.mockResolvedValueOnce({
      views: null,
      defaultIndex: 0,
      fieldColumns: ['Stage', 'Owner']
    })
    const { views } = await folderViewService.getViews({ kind: 'tag', tag: 'project' })
    expect(views[0].name).toBe(DEFAULT_VIEW.name)
    expect(views[0].columns).toEqual([
      { id: 'title', width: 250 },
      { id: 'Stage', width: 150 },
      { id: 'Owner', width: 150 },
      { id: 'modified', width: 130 }
    ])
  })

  it('hands saved views on with the default index', async () => {
    const saved = [{ name: 'A' }, { name: 'B', default: true }]
    commands.folderViewGetViews.mockResolvedValueOnce({
      views: saved,
      defaultIndex: 1,
      fieldColumns: null
    })
    await expect(folderViewService.getViews({ kind: 'folder', path: '' })).resolves.toEqual({
      views: saved,
      defaultIndex: 1
    })
  })
})

describe('folderViewService.getConfig', () => {
  it('fills the default view and keeps the formulas of a folder that saved no view', async () => {
    commands.folderViewGetConfig.mockResolvedValueOnce({
      inherit: true,
      icon: null,
      formulas: { double: 'n * 2' }
    })
    await expect(folderViewService.getConfig('Work')).resolves.toEqual({
      config: { path: 'Work', inherit: true, formulas: { double: 'n * 2' }, views: [DEFAULT_VIEW] },
      isDefault: true
    })

    commands.folderViewGetConfig.mockResolvedValueOnce(null)
    await expect(folderViewService.getConfig('None')).resolves.toEqual({
      config: { path: 'None', views: [DEFAULT_VIEW] },
      isDefault: true
    })
  })

  it('answers the saved views as the file holds them', async () => {
    commands.folderViewGetConfig.mockResolvedValueOnce({ inherit: true, views: [{ name: 'A' }] })
    await expect(folderViewService.getConfig('Work')).resolves.toEqual({
      config: { path: 'Work', inherit: true, views: [{ name: 'A' }] },
      isDefault: false
    })
  })
})

describe('folderViewService writes', () => {
  it('answers a refused view write as success false with its message', async () => {
    commands.folderViewSetView.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'view_name_conflict',
      message: 'A view named "B" already exists'
    })
    const scope = { kind: 'folder' as const, path: 'A' }
    await expect(
      folderViewService.setView(scope, { ...DEFAULT_VIEW, name: 'B' }, 'A')
    ).resolves.toEqual({ success: false, error: 'A view named "B" already exists' })
    expect(commands.folderViewSetView).toHaveBeenCalledWith(
      scope,
      { ...DEFAULT_VIEW, name: 'B' },
      'A'
    )

    commands.folderViewDeleteView.mockResolvedValueOnce(null)
    await expect(folderViewService.deleteView(scope, 'B')).resolves.toEqual({ success: true })
  })

  it('sends a key the caller cleared with undefined as null, so the file drops it', async () => {
    commands.folderViewSetConfig.mockResolvedValueOnce(null)
    const summaries = { title: { type: 'count' as const } }
    await folderViewService.setConfig('A', { formulas: undefined, summaries })
    expect(commands.folderViewSetConfig).toHaveBeenCalledWith('A', { formulas: null, summaries })
  })

  it('rejects a config write that fails, so the folder view surfaces it', async () => {
    commands.folderViewSetConfig.mockRejectedValueOnce(new Error('disk full'))
    await expect(folderViewService.setConfig('A', { formulas: {} })).rejects.toThrow('disk full')
  })
})
