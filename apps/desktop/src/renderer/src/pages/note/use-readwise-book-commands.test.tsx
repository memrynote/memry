import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { toast } from 'sonner'
import type { Note } from '@/hooks/use-notes-query'
import { Picker } from '@/components/ui/picker'
import { ReadwiseMenuGroup } from '@/components/note/readwise-menu-group'
import { ReadwiseReimportDialog } from '@/components/note/readwise-reimport-dialog'
import { useReadwiseBookCommands } from './use-readwise-book-commands'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const readwiseNote = {
  id: 'n1',
  frontmatter: { readwise_url: 'https://readwise.io/bookreview/1' }
} as unknown as Note
const plainNote = { id: 'n2', frontmatter: {} } as unknown as Note

describe('Readwise book commands in the note UI (D16)', () => {
  let i18n: I18nInstance
  const status = vi.fn()
  const reimportBook = vi.fn()
  const refreshBook = vi.fn()

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    status.mockResolvedValue({ thisDevicePulls: true, pullingDeviceName: null })
    reimportBook.mockResolvedValue({ success: true })
    refreshBook.mockResolvedValue({ success: true })
    ;(window as unknown as { api: unknown }).api = {
      import: { readwise: { status, reimportBook, refreshBook } }
    }
  })

  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  )

  it('offers nothing on a note without a Readwise link, and never asks main', () => {
    const { result } = renderHook(() => useReadwiseBookCommands(plainNote), { wrapper })
    expect(result.current.isLinked).toBe(false)
    expect(status).not.toHaveBeenCalled()
  })

  it('runs re-import and refresh for the note and says so', async () => {
    const { result } = renderHook(() => useReadwiseBookCommands(readwiseNote), { wrapper })
    expect(result.current.isLinked).toBe(true)

    await result.current.reimport()
    expect(reimportBook).toHaveBeenCalledWith({ noteId: 'n1' })
    expect(toast.success).toHaveBeenCalledWith('Re-imported from Readwise')

    await result.current.refresh()
    expect(refreshBook).toHaveBeenCalledWith({ noteId: 'n1' })
    expect(toast.success).toHaveBeenCalledWith('Book info refreshed')
  })

  it("shows main's refusal instead of a success", async () => {
    reimportBook.mockResolvedValue({ success: false, error: 'Readwise syncs on another device.' })
    const { result } = renderHook(() => useReadwiseBookCommands(readwiseNote), { wrapper })
    await result.current.reimport()
    expect(toast.error).toHaveBeenCalledWith('Readwise syncs on another device.')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('learns from main that another device pulls', async () => {
    status.mockResolvedValue({ thisDevicePulls: false, pullingDeviceName: 'MacBook Pro' })
    const { result } = renderHook(() => useReadwiseBookCommands(readwiseNote), { wrapper })
    await waitFor(() => {
      expect(result.current.pullsHere).toBe(false)
    })
    expect(result.current.pullingDeviceName).toBe('MacBook Pro')
  })

  const labels = {
    'note.readwiseReimport': 'Re-import from Readwise',
    'note.readwiseRefresh': 'Refresh book info'
  } as const
  const menu = (pullsHere: boolean, name: string | null) => (
    <I18nextProvider i18n={i18n}>
      <Picker open>
        <Picker.Trigger asChild>
          <button type="button">more</button>
        </Picker.Trigger>
        <Picker.Content>
          <Picker.List>
            <ReadwiseMenuGroup
              readwise={{
                isLinked: true,
                pullsHere,
                pullingDeviceName: name,
                reimport: vi.fn(),
                refresh: vi.fn()
              }}
              labels={labels}
            />
          </Picker.List>
        </Picker.Content>
      </Picker>
    </I18nextProvider>
  )

  it('enables both menu items on the pulling device', () => {
    render(menu(true, null))
    expect(screen.getByText('Readwise')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Re-import from Readwise' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Refresh book info' })).toBeEnabled()
    expect(screen.queryByText(/Readwise syncs on/)).not.toBeInTheDocument()
  })

  it('disables both items elsewhere and names the pulling device', () => {
    render(menu(false, 'MacBook Pro'))
    expect(screen.getByRole('option', { name: 'Re-import from Readwise' })).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Refresh book info' })).toBeDisabled()
    expect(screen.getByText('Readwise syncs on MacBook Pro.')).toBeInTheDocument()
  })

  it('confirms the re-import with the artboard copy, and Cancel runs nothing', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ReadwiseReimportDialog
          open
          onOpenChange={onOpenChange}
          title="Atomic Habits"
          onConfirm={onConfirm}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Re-import “Atomic Habits” from Readwise?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The Readwise section is rewritten from scratch. Anything you wrote inside it is lost.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("Text outside the section and the note's properties stay as they are.")
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Re-import' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
