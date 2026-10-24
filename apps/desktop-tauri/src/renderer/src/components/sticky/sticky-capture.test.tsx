import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StickyDraft } from '@memry/contracts/sticky-api'
import { STICKY_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { StickyCapture } from './sticky-capture'

const mocks = vi.hoisted(() => ({
  flags: { tasks: true, journal: true } as Record<string, boolean>
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mocks.flags[key] ?? true })
}))

const INPUT = 'sticky.inputLabel'

function draft(overrides: Partial<StickyDraft> = {}): StickyDraft {
  return {
    id: 'draft-1',
    content: 'Buy oat milk',
    kind: 'note',
    createdAt: '2026-05-01T10:00:00.000Z',
    modifiedAt: '2026-05-01T10:00:00.000Z',
    ...overrides
  }
}

function stickyApi(session: { draftId: string | null }, drafts: StickyDraft[] = []) {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    listDrafts: vi.fn().mockResolvedValue(drafts),
    saveDraft: vi.fn(async (input: { id?: string; content: string; kind: StickyDraft['kind'] }) =>
      draft({ id: input.id ?? 'draft-new', content: input.content, kind: input.kind })
    ),
    deleteDraft: vi.fn().mockResolvedValue({ success: true }),
    send: vi.fn(),
    undoSend: vi.fn(),
    openTarget: vi.fn().mockResolvedValue(undefined),
    tuck: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined)
  }
}

let sticky: ReturnType<typeof stickyApi>

function setup(session: { draftId: string | null }, drafts: StickyDraft[] = []): void {
  sticky = stickyApi(session, drafts)
  const api = (window as any).api
  api.sticky = sticky
  api.settings = {
    ...api.settings,
    getStickySettings: vi.fn().mockResolvedValue({ ...STICKY_SETTINGS_DEFAULTS, lastKind: 'task' })
  }
}

async function renderSticky(): Promise<HTMLTextAreaElement> {
  render(<StickyCapture />)
  const input = screen.getByLabelText(INPUT) as HTMLTextAreaElement
  await waitFor(() => expect(input).not.toBeDisabled())
  return input
}

describe('StickyCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.flags = { tasks: true, journal: true }
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
  })

  it('opens on the draft main chose and keeps editing it under the same id', async () => {
    setup({ draftId: 'draft-1' }, [draft({ kind: 'journal' })])
    const input = await renderSticky()

    expect(input).toHaveValue('Buy oat milk')
    expect(screen.getByRole('radio', { name: 'sticky.kinds.journal' })).toBeChecked()

    fireEvent.change(input, { target: { value: 'Buy oat milk and bread' } })
    await waitFor(() =>
      expect(sticky.saveDraft).toHaveBeenCalledWith({
        id: 'draft-1',
        content: 'Buy oat milk and bread',
        kind: 'journal'
      })
    )
    expect(await screen.findByText('sticky.saved')).toBeInTheDocument()
  })

  it('starts blank with the remembered kind and only shows kinds whose module is on', async () => {
    mocks.flags.journal = false
    setup({ draftId: null })
    await renderSticky()

    expect(screen.getByRole('radio', { name: 'sticky.kinds.task' })).toBeChecked()
    expect(screen.queryByRole('radio', { name: 'sticky.kinds.journal' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '1', metaKey: true })
    expect(screen.getByRole('radio', { name: 'sticky.kinds.note' })).toBeChecked()
    fireEvent.keyDown(window, { key: '3', metaKey: true })
    expect(screen.getByRole('radio', { name: 'sticky.kinds.note' })).toBeChecked()
  })

  it('sends the draft, confirms, and Undo brings the text back', async () => {
    setup({ draftId: 'draft-1' }, [draft()])
    sticky.send.mockResolvedValue({
      success: true,
      kind: 'note',
      targetId: 'note-9',
      title: 'Buy oat milk',
      undoToken: 'undo-1'
    })
    sticky.undoSend.mockResolvedValue({ success: true, draft: draft({ id: 'draft-2' }) })
    const input = await renderSticky()

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(sticky.send).toHaveBeenCalledWith({
        draftId: 'draft-1',
        content: 'Buy oat milk',
        kind: 'note'
      })
    )
    expect(await screen.findByText('sticky.sent.note')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    await waitFor(() => expect(sticky.undoSend).toHaveBeenCalledWith('undo-1'))
    expect(await screen.findByLabelText(INPUT)).toHaveValue('Buy oat milk')
  })

  it('offers Open but no Undo after a journal send, and Open asks main for the target', async () => {
    setup({ draftId: 'draft-1' }, [draft({ kind: 'journal' })])
    sticky.send.mockResolvedValue({
      success: true,
      kind: 'journal',
      targetId: '2026-05-01',
      title: '',
      undoToken: null
    })
    const input = await renderSticky()

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await screen.findByText('sticky.sent.journal')
    expect(screen.queryByText(/sticky\.undo/)).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    expect(sticky.openTarget).toHaveBeenCalledWith({ kind: 'journal', targetId: '2026-05-01' })
  })

  it('keeps the draft and shows the error when a send fails', async () => {
    setup({ draftId: 'draft-1' }, [draft({ kind: 'task' })])
    sticky.send.mockResolvedValue({ success: false, error: 'Tasks are off' })
    const input = await renderSticky()

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(await screen.findByText('Tasks are off')).toBeInTheDocument()
    expect(input).toHaveValue('Buy oat milk')
    expect(sticky.deleteDraft).not.toHaveBeenCalled()
  })

  it('writes pending text before Esc tucks the sticky away', async () => {
    setup({ draftId: null })
    const input = await renderSticky()

    fireEvent.change(input, { target: { value: 'half a thought' } })
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(sticky.tuck).toHaveBeenCalled())
    expect(sticky.saveDraft).toHaveBeenCalledWith({ content: 'half a thought', kind: 'task' })
    expect(sticky.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      sticky.tuck.mock.invocationCallOrder[0]
    )
  })

  it('deletes the draft when its text is cleared, so Esc leaves nothing behind', async () => {
    setup({ draftId: 'draft-1' }, [draft()])
    const input = await renderSticky()

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(sticky.tuck).toHaveBeenCalled())
    expect(sticky.deleteDraft).toHaveBeenCalledWith('draft-1')
  })

  it('deletes with ⌘⌫ and Undo restores the text as a new draft', async () => {
    setup({ draftId: 'draft-1' }, [draft()])
    const input = await renderSticky()

    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true })
    await waitFor(() => expect(sticky.deleteDraft).toHaveBeenCalledWith('draft-1'))
    expect(input).toHaveValue('')

    fireEvent.click(await screen.findByText(/sticky\.undo/))
    expect(input).toHaveValue('Buy oat milk')
    await waitFor(() =>
      expect(sticky.saveDraft).toHaveBeenCalledWith({ content: 'Buy oat milk', kind: 'note' })
    )
  })

  it('sends a lone link as text to the chosen kind', async () => {
    setup({ draftId: 'draft-1' }, [draft({ content: 'example.com', kind: 'task' })])
    sticky.send.mockResolvedValue({
      success: true,
      kind: 'task',
      targetId: 'task-1',
      title: 'example.com',
      undoToken: 'undo-1'
    })
    const input = await renderSticky()

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(sticky.send).toHaveBeenCalledWith({
        draftId: 'draft-1',
        content: 'example.com',
        kind: 'task'
      })
    )
  })
})
