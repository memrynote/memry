import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  onTemplateCreated
} from './templates-service'

const commands = vi.hoisted(() => ({
  templatesList: vi.fn(),
  templatesGet: vi.fn(),
  templatesCreate: vi.fn(),
  templatesUpdate: vi.fn(),
  templatesDelete: vi.fn(),
  templatesDuplicate: vi.fn()
}))
const events = vi.hoisted(() => ({
  templateCreatedEvent: { listen: vi.fn() },
  templateUpdatedEvent: { listen: vi.fn() },
  templateDeletedEvent: { listen: vi.fn() }
}))

vi.mock('../../../generated/bindings', () => ({ commands, events }))

const view = {
  id: 'tpl-1',
  name: 'Weekly',
  description: null,
  icon: null,
  isBuiltIn: false,
  tags: ['weekly'],
  properties: [{ name: 'Stage', type: 'select', value: 'Draft', options: ['Draft'] }],
  content: 'Body',
  createdAt: '2025-10-09T08:53:20.000Z',
  modifiedAt: '2025-10-09T08:53:20.000Z'
}

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
})

describe('templates-service', () => {
  it('answers a write with the template, a missing description left out', async () => {
    commands.templatesCreate.mockResolvedValue(view)
    const input = { name: 'Weekly', content: 'Body' }

    const created = await createTemplate(input)

    expect(commands.templatesCreate).toHaveBeenCalledWith(input)
    expect(created).toEqual({ success: true, template: { ...view, description: undefined } })
  })

  it('answers a refused write with its message, as Electron withErrorHandler does', async () => {
    commands.templatesUpdate.mockRejectedValue({
      kind: 'invalid',
      code: 'invalid',
      message: 'built-in template `blank` cannot be changed'
    })
    commands.templatesDelete.mockRejectedValue({
      kind: 'not_found',
      code: 'not_found',
      message: 'not found: template x'
    })

    await expect(updateTemplate({ id: 'blank', name: 'x' })).resolves.toEqual({
      success: false,
      template: null,
      error: 'built-in template `blank` cannot be changed'
    })
    await expect(deleteTemplate('x')).resolves.toEqual({
      success: false,
      error: 'not found: template x'
    })
  })

  it('lists, reads, duplicates and deletes through the commands', async () => {
    commands.templatesList.mockResolvedValue([
      { id: 'blank', name: 'Blank Note', description: 'Start', icon: '📄', isBuiltIn: true },
      { id: 'tpl-1', name: 'Weekly', description: null, icon: null, isBuiltIn: false }
    ])
    commands.templatesGet.mockResolvedValue(null)
    commands.templatesDuplicate.mockResolvedValue({ ...view, id: 'tpl-2' })
    commands.templatesDelete.mockResolvedValue(null)

    const listed = await listTemplates()
    expect(listed.templates[1]).toEqual({
      id: 'tpl-1',
      name: 'Weekly',
      description: undefined,
      icon: null,
      isBuiltIn: false
    })
    await expect(getTemplate('gone')).resolves.toBeNull()
    expect(commands.templatesGet).toHaveBeenCalledWith('gone')
    await expect(duplicateTemplate('tpl-1', 'Copy')).resolves.toMatchObject({
      success: true,
      template: { id: 'tpl-2' }
    })
    expect(commands.templatesDuplicate).toHaveBeenCalledWith('tpl-1', 'Copy')
    await expect(deleteTemplate('tpl-1')).resolves.toEqual({ success: true })
  })

  it('hands each template event to the subscriber until it unsubscribes', async () => {
    let handler: ((event: { payload: { id: string } }) => void) | undefined
    const unlisten = vi.fn()
    events.templateCreatedEvent.listen.mockImplementation(async (h) => {
      handler = h
      return unlisten
    })
    const callback = vi.fn()

    const unsubscribe = onTemplateCreated(callback)
    await Promise.resolve()
    handler?.({ payload: { id: 'tpl-1' } })
    unsubscribe()
    handler?.({ payload: { id: 'tpl-2' } })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ id: 'tpl-1' })
  })
})
