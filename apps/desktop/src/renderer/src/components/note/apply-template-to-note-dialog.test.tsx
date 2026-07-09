import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApplyTemplateToNoteDialog } from './apply-template-to-note-dialog'

const get = vi.fn()
const applyTemplate = vi.fn()

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [{ id: 'blank', name: 'Blank Note', description: '', icon: '📄', isBuiltIn: true }],
    isLoading: false
  })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  get.mockReset()
  applyTemplate.mockReset()
  ;(
    window as unknown as {
      api: { notes: { get: typeof get; applyTemplate: typeof applyTemplate } }
    }
  ).api = { notes: { get, applyTemplate } }
})

describe('ApplyTemplateToNoteDialog', () => {
  it('empty note: applies full mode without confirmation', async () => {
    get.mockResolvedValue({ id: 'n1', content: '   ' })
    applyTemplate.mockResolvedValue({ success: true, note: { id: 'n1' } })
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<ApplyTemplateToNoteDialog noteId="n1" isOpen onClose={onClose} />)
    // 'blank' is the default selection; click the Apply primary button
    await user.click(screen.getByText('Apply Template'))

    expect(applyTemplate).toHaveBeenCalledWith({ noteId: 'n1', templateId: 'blank', mode: 'full' })
  })

  it('non-empty note: shows confirm, then applies chosen mode', async () => {
    get.mockResolvedValue({ id: 'n1', content: '# Existing content' })
    applyTemplate.mockResolvedValue({ success: true, note: { id: 'n1' } })
    const user = userEvent.setup()

    render(<ApplyTemplateToNoteDialog noteId="n1" isOpen onClose={vi.fn()} />)
    await user.click(screen.getByText('Apply Template'))
    // confirm dialog appears
    await user.click(await screen.findByText('Replace content only'))

    expect(applyTemplate).toHaveBeenCalledWith({ noteId: 'n1', templateId: 'blank', mode: 'body' })
  })
})
