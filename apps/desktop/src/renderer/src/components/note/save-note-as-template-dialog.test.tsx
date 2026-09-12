import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const openTab = vi.hoisted(() => vi.fn())
const flushAllPendingSaves = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab }) }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('@/lib/save-registry', () => ({ flushAllPendingSaves }))

import { SaveNoteAsTemplateDialog } from './save-note-as-template-dialog'

const getNote = vi.fn()
const getProperties = vi.fn()
const createTemplate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  flushAllPendingSaves.mockResolvedValue(undefined)
  getNote.mockResolvedValue({
    id: 'n1',
    title: 'Weekly review',
    content: '# Weekly review\n\nWhat went well?',
    tags: ['review', 'review', 'weekly']
  })
  getProperties.mockResolvedValue([
    { name: 'Stage', type: 'status', value: 'todo' },
    { name: 'Related', type: 'relation', value: ['memry://note/2'] }
  ])
  createTemplate.mockResolvedValue({
    success: true,
    template: { id: 'tpl1', name: 'Weekly review' }
  })
  ;(window as unknown as { api: unknown }).api = {
    notes: { get: getNote },
    properties: { get: getProperties },
    templates: { create: createTemplate }
  }
})

async function openDialog(onClose = vi.fn()) {
  const user = userEvent.setup()
  render(<SaveNoteAsTemplateDialog noteId="n1" isOpen onClose={onClose} />)
  const input = await screen.findByDisplayValue('Weekly review')
  return { user, input, onClose }
}

describe('SaveNoteAsTemplateDialog', () => {
  it('pre-fills the name from the note title, after flushing pending saves', async () => {
    await openDialog()
    expect(flushAllPendingSaves).toHaveBeenCalled()
  })

  it('saves the mapped template and closes', async () => {
    const { user, onClose } = await openDialog()

    await user.click(screen.getByText('saveNoteAsTemplate.save'))

    expect(createTemplate).toHaveBeenCalledWith({
      name: 'Weekly review',
      tags: ['review', 'weekly'],
      properties: [{ name: 'Stage', type: 'select', value: 'todo' }],
      content: '# Weekly review\n\nWhat went well?'
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('offers to open the new template in its editor', async () => {
    const { user } = await openDialog()

    await user.click(screen.getByText('saveNoteAsTemplate.save'))

    const [, options] = toastSuccess.mock.calls[0] as [string, { action: { onClick: () => void } }]
    options.action.onClick()
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', path: '/templates/tpl1' })
    )
  })

  it('reports a failed create and stays open', async () => {
    createTemplate.mockResolvedValue({ success: false, template: null, error: 'name taken' })
    const { user, onClose } = await openDialog()

    await user.click(screen.getByText('saveNoteAsTemplate.save'))

    expect(toastError).toHaveBeenCalledWith('name taken')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('Weekly review')).toBeInTheDocument()
  })

  it('refuses a blank name', async () => {
    const { user, input } = await openDialog()

    await user.clear(input)
    await user.click(screen.getByText('saveNoteAsTemplate.save'))
    await user.type(input, '   {Enter}')

    expect(createTemplate).not.toHaveBeenCalled()
  })
})
