import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { UnlinkedMentionsSection } from './UnlinkedMentionsSection'

const service = vi.hoisted(() => ({
  getUnlinkedMentions: vi.fn(),
  linkMention: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: service,
  onNoteUpdated: () => () => {},
  onNoteCreated: () => () => {},
  onNoteDeleted: () => () => {}
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.endsWith('.linkAria') ? `Link ${values?.text}` : (key.split('.').at(-1) ?? key)
  })
}))

describe('UnlinkedMentionsSection', () => {
  it('lists mentions once opened and links the chosen one', async () => {
    service.getUnlinkedMentions.mockResolvedValue([
      {
        sourceId: 'src',
        sourcePath: 'Standup.md',
        sourceTitle: 'Standup',
        contexts: [
          { snippet: 'the project plan today', linkStart: 4, linkEnd: 16 },
          { snippet: 'and the roadmap', linkStart: 8, linkEnd: 15 }
        ]
      }
    ])
    service.linkMention.mockResolvedValue({ linked: true })
    const onOpen = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UnlinkedMentionsSection noteId="target" onOpen={onOpen} />
      </QueryClientProvider>
    )

    expect(service.getUnlinkedMentions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'title' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Link roadmap' }))
    await waitFor(() => {
      expect(service.linkMention).toHaveBeenCalledWith({
        sourceId: 'src',
        targetId: 'target',
        ordinal: 1
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Standup' }))
    expect(onOpen).toHaveBeenCalledWith('src', 'Standup')
  })
})
