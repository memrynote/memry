import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTemplates } from './use-templates'

const mocks = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    duplicate: vi.fn()
  },
  events: {
    created: [] as Array<() => void>,
    updated: [] as Array<() => void>,
    deleted: [] as Array<() => void>
  },
  logError: vi.fn()
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

vi.mock('@/services/templates-service', () => ({
  templatesService: mocks.service,
  onTemplateCreated: (callback: () => void) => {
    mocks.events.created.push(callback)
    return vi.fn()
  },
  onTemplateUpdated: (callback: () => void) => {
    mocks.events.updated.push(callback)
    return vi.fn()
  },
  onTemplateDeleted: (callback: () => void) => {
    mocks.events.deleted.push(callback)
    return vi.fn()
  }
}))

describe('useTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.created = []
    mocks.events.updated = []
    mocks.events.deleted = []
    mocks.service.list.mockResolvedValue({
      templates: [{ id: 'tpl-1', name: 'Daily', description: null, icon: null, isBuiltIn: true }]
    })
    mocks.service.get.mockResolvedValue({ id: 'tpl-1', name: 'Daily' })
    mocks.service.create.mockResolvedValue({
      success: true,
      template: { id: 'tpl-2', name: 'Weekly', description: 'Plan', icon: 'W' }
    })
    mocks.service.update.mockResolvedValue({
      success: true,
      template: { id: 'tpl-2', name: 'Week Plan', description: null, icon: null }
    })
    mocks.service.delete.mockResolvedValue({ success: true })
    mocks.service.duplicate.mockResolvedValue({
      success: true,
      template: { id: 'tpl-3', name: 'Daily Copy', description: null, icon: null }
    })
  })

  it('loads, reloads on service events, and exposes template CRUD helpers', async () => {
    const { result } = renderHook(() => useTemplates())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.templates).toHaveLength(1)

    await act(async () => {
      expect(await result.current.getTemplate('tpl-1')).toEqual({ id: 'tpl-1', name: 'Daily' })
      expect(await result.current.createTemplate({ name: 'Weekly', content: '' })).toEqual(
        expect.objectContaining({ id: 'tpl-2' })
      )
    })
    expect(result.current.templates.map((template) => template.name)).toEqual(['Daily', 'Weekly'])

    await act(async () => {
      expect(await result.current.updateTemplate({ id: 'tpl-2', name: 'Week Plan' })).toEqual(
        expect.objectContaining({ name: 'Week Plan' })
      )
      expect(await result.current.duplicateTemplate('tpl-1', 'Daily Copy')).toEqual(
        expect.objectContaining({ id: 'tpl-3' })
      )
      expect(await result.current.deleteTemplate('tpl-1')).toBe(true)
    })
    expect(result.current.templates.map((template) => template.name)).toEqual([
      'Week Plan',
      'Daily Copy'
    ])

    mocks.service.list.mockResolvedValueOnce({
      templates: [{ id: 'tpl-4', name: 'Event Refresh', description: null, icon: null }]
    })
    await act(async () => {
      mocks.events.created[0]()
    })
    await waitFor(() => {
      expect(result.current.templates[0].name).toBe('Event Refresh')
    })
  })

  it('reports load errors and returns null or false from failed helper paths', async () => {
    mocks.service.list.mockRejectedValueOnce(new Error('load failed'))
    const { result } = renderHook(() => useTemplates({ autoLoad: false }))

    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.error).toBe('load failed')

    mocks.service.get.mockRejectedValueOnce(new Error('missing'))
    mocks.service.create.mockResolvedValueOnce({ success: false })
    mocks.service.update.mockRejectedValueOnce(new Error('update failed'))
    mocks.service.delete.mockResolvedValueOnce({ success: false })
    mocks.service.duplicate.mockRejectedValueOnce(new Error('copy failed'))

    await act(async () => {
      expect(await result.current.getTemplate('missing')).toBeNull()
      expect(await result.current.createTemplate({ name: 'Nope', content: '' })).toBeNull()
      expect(await result.current.updateTemplate({ id: 'tpl-1', name: 'Nope' })).toBeNull()
      expect(await result.current.deleteTemplate('tpl-1')).toBe(false)
      expect(await result.current.duplicateTemplate('tpl-1', 'Nope')).toBeNull()
    })
    expect(mocks.logError).toHaveBeenCalled()
  })
})
