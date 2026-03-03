import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  onTemplateCreated,
  onTemplateUpdated,
  onTemplateDeleted
} from './templates-service'

describe('templates-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.templates.list = vi.fn().mockResolvedValue({ templates: [] })
    api.templates.get = vi.fn().mockResolvedValue(null)
    api.templates.create = vi.fn().mockResolvedValue({ success: true, template: null })
    api.templates.update = vi.fn().mockResolvedValue({ success: true, template: null })
    api.templates.delete = vi.fn().mockResolvedValue({ success: true })
    api.templates.duplicate = vi.fn().mockResolvedValue({ success: true, template: null })

    api.onTemplateCreated = vi.fn().mockReturnValue(() => {})
    api.onTemplateUpdated = vi.fn().mockReturnValue(() => {})
    api.onTemplateDeleted = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards template CRUD and duplicate operations', async () => {
    await listTemplates()
    expect(api.templates.list).toHaveBeenCalled()

    await getTemplate('tpl-1')
    expect(api.templates.get).toHaveBeenCalledWith('tpl-1')

    const createInput = { name: 'Template', content: 'Hello' }
    await createTemplate(createInput)
    expect(api.templates.create).toHaveBeenCalledWith(createInput)

    const updateInput = { id: 'tpl-1', name: 'Updated' }
    await updateTemplate(updateInput)
    expect(api.templates.update).toHaveBeenCalledWith(updateInput)

    await deleteTemplate('tpl-1')
    expect(api.templates.delete).toHaveBeenCalledWith('tpl-1')

    await duplicateTemplate('tpl-1', 'Copy')
    expect(api.templates.duplicate).toHaveBeenCalledWith('tpl-1', 'Copy')
  })

  it('registers template event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onTemplateCreated = vi.fn(() => unsubscribe)
    api.onTemplateUpdated = vi.fn(() => unsubscribe)
    api.onTemplateDeleted = vi.fn(() => unsubscribe)

    expect(onTemplateCreated(vi.fn())).toBe(unsubscribe)
    expect(onTemplateUpdated(vi.fn())).toBe(unsubscribe)
    expect(onTemplateDeleted(vi.fn())).toBe(unsubscribe)
  })
})
