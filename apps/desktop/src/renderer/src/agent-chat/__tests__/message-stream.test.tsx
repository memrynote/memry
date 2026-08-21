import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Message } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockOpenTab = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  // The transcript keeps its scroll position in tab state; these tests render
  // it outside a tab, where that degrades to no persistence at all.
  useTabActionsOptional: () => null,
  useTabActions: () => ({ openTab: mockOpenTab })
}))

import { MessageStream } from '../message-stream'
import { clearVaultItemIconCache } from '../messages/use-vault-item-icon'

const mockApproveTool = vi.fn()
const mockPreviewDiff = vi.fn()
const mockGetNote = vi.fn()

function message(input: {
  id: string
  role: Message['role']
  content: Message['content']
  attachments?: Message['attachments']
  status?: Message['status']
  toolCallId?: string | null
}): Message {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role: input.role,
    content: input.content,
    toolCallId: input.toolCallId ?? null,
    attachments: input.attachments ?? [],
    status: input.status ?? 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

describe('MessageStream', () => {
  beforeEach(() => {
    mockApproveTool.mockReset()
    mockOpenTab.mockReset()
    mockPreviewDiff.mockReset()
    mockPreviewDiff.mockResolvedValue({
      title: 'Planning note',
      current: 'old',
      candidate: 'old\n\nnew'
    })
    mockUseAgentOptional.mockReturnValue(null)
    clearVaultItemIconCache()
    mockGetNote.mockReset()
    mockGetNote.mockResolvedValue(null)
    ;(
      window.api as typeof window.api & {
        agent?: { previewDiff: typeof mockPreviewDiff }
        notes?: { get: typeof mockGetNote }
      }
    ).agent = {
      previewDiff: mockPreviewDiff
    }
    ;(window.api as typeof window.api & { notes?: { get: typeof mockGetNote } }).notes = {
      get: mockGetNote
    }
  })

  it('renders all stored agent message roles', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'user-1',
            role: 'user',
            content: { role: 'user', data: { text: 'Create a task' } }
          }),
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'I can do that.' } }
          }),
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'pending'
              }
            }
          }),
          message({
            id: 'tool-result-1',
            role: 'tool_result',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_result',
              data: { ok: true, data: { id: 'task-1' } }
            }
          }),
          message({
            id: 'system-1',
            role: 'system',
            content: {
              role: 'system',
              data: { kind: 'context_attached', payload: { label: 'Today' } }
            }
          })
        ]}
      />
    )

    expect(screen.getByText('Create a task')).toBeInTheDocument()
    expect(screen.getByText('I can do that.')).toBeInTheDocument()
    expect(screen.getByText('context_attached')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /1 step/i }))

    expect(screen.getByText('Creating task')).toBeInTheDocument()
    expect(screen.getByText('Tool result')).toBeInTheDocument()
  })

  it('collapses consecutive tool calls into one activity group', () => {
    render(
      <MessageStream
        inFlight
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_desktop_read',
                args: { operation: 'settings.get' },
                status: 'output-available'
              }
            }
          }),
          message({
            id: 'tool-call-2',
            role: 'tool_call',
            toolCallId: 'tool-2',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_search_notes',
                args: { query: 'milk' },
                status: 'input-available'
              }
            }
          })
        ]}
      />
    )

    const trigger = screen.getByRole('button', { name: /Searching notes/i })
    expect(trigger.querySelector('.agent-thinking-pixels')).not.toBeNull()
    expect(screen.queryByText('Reading app data')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(screen.getByText('Reading app data')).toBeInTheDocument()
    expect(screen.getAllByText('Searching notes')).toHaveLength(2)
  })

  it('labels a settled activity group by step count without a spinner', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: { tool: 'vault_read_note', args: { id: 'a' }, status: 'output-available' }
            }
          }),
          message({
            id: 'tool-call-2',
            role: 'tool_call',
            toolCallId: 'tool-2',
            content: {
              role: 'tool_call',
              data: { tool: 'vault_read_note', args: { id: 'b' }, status: 'output-available' }
            }
          })
        ]}
      />
    )

    const trigger = screen.getByRole('button', { name: /2 steps/i })
    expect(trigger.querySelector('.agent-thinking-pixels')).toBeNull()
    expect(screen.queryByText('Reading note')).not.toBeInTheDocument()
  })

  it('stops the activity spinner once the turn is no longer in flight', () => {
    const messages = [
      message({
        id: 'tool-call-1',
        role: 'tool_call',
        toolCallId: 'tool-1',
        content: {
          role: 'tool_call',
          data: { tool: 'vault_desktop_read', args: {}, status: 'input-available' }
        }
      }),
      message({
        id: 'tool-call-2',
        role: 'tool_call',
        toolCallId: 'tool-2',
        content: {
          role: 'tool_call',
          data: { tool: 'vault_desktop_read', args: {}, status: 'input-available' }
        }
      })
    ]

    const { rerender } = render(<MessageStream inFlight messages={messages} />)

    expect(
      screen
        .getByRole('button', { name: /Reading app data/i })
        .querySelector('.agent-thinking-pixels')
    ).not.toBeNull()

    // The backend never reported results, so only the turn ending can settle the group.
    rerender(<MessageStream inFlight={false} messages={messages} />)

    const settled = screen.getByRole('button', { name: /2 steps/i })
    expect(settled.querySelector('.agent-thinking-pixels')).toBeNull()
  })

  it('keeps an activity group open while a tool waits for approval', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: { tool: 'vault_read_note', args: { id: 'a' }, status: 'output-available' }
            }
          }),
          message({
            id: 'tool-call-2',
            role: 'tool_call',
            toolCallId: 'tool-2',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_delete_note',
                args: { id: 'b' },
                status: 'approval-requested'
              }
            }
          })
        ]}
      />
    )

    expect(screen.getAllByText('Deleting note')).toHaveLength(2)
    expect(screen.getByText('Reading note')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /Deleting note/i })[0])

    expect(screen.getByText('Reading note')).toBeInTheDocument()
  })

  it('renders user message attachment labels', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'user-1',
            role: 'user',
            content: { role: 'user', data: { text: 'Summarize this' } },
            attachments: [
              {
                kind: 'note',
                refId: 'note-1',
                label: 'Planning note',
                snapshot: { mode: 'reference_only', refId: 'note-1' }
              }
            ]
          })
        ]}
      />
    )

    expect(screen.getByText('Planning note')).toBeInTheDocument()
  })

  it('renders inline user mention refs as clickable tags', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'user-1',
            role: 'user',
            content: { role: 'user', data: { text: '@Vim Motions what is about?' } },
            attachments: [
              {
                kind: 'note',
                refId: 'note-vim',
                label: 'Vim Motions',
                snapshotAt: 100,
                snapshot: { mode: 'reference_only', id: 'note-vim' }
              }
            ]
          })
        ]}
      />
    )

    const mention = screen.getByRole('link', { name: '@Vim Motions' })
    expect(mention).toHaveClass('rounded-full')
    expect(mention.getAttribute('href')).toBe('memry://note/note-vim')

    fireEvent.click(mention)

    expect(mockOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Vim Motions',
        path: '/note/note-vim',
        entityId: 'note-vim'
      })
    )
  })

  it('ignores non-user content in user message rendering', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-as-user',
            role: 'user',
            content: { role: 'assistant', data: { text: 'Hidden' } }
          })
        ]}
      />
    )

    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('allows chat text selection', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'Highlight me' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('log')).toHaveClass('select-text')
  })

  it('renders assistant markdown as rich message content', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: '# Plan\n\n- Create the task' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByText('Create the task')).toBeInTheDocument()
  })

  it('renders assistant memrynote refs as clickable links with a sources footer', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: 'See [Movies](memry://note/note-1).',
                sources: [
                  {
                    kind: 'note',
                    id: 'note-1',
                    title: 'Movies',
                    href: 'memry://note/note-1',
                    icon: '🎬'
                  }
                ]
              }
            }
          })
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'Movies' })
    expect(link).toHaveAttribute('href', 'memry://note/note-1')
    // The turn listed this link as a source, so it reads as an inline citation.
    expect(link).toHaveClass('agent-source-chip')
    expect(link).toHaveClass('items-center')
    expect(link).not.toHaveClass('items-baseline')
    expect(link).toHaveTextContent('🎬Movies')
    const linkIcon = link.querySelector('[data-agent-link-icon="note-custom"]')
    expect(linkIcon).not.toBeNull()
    expect(linkIcon?.classList.contains('align-middle')).toBe(true)
    const sourcesTrigger = screen.getByRole('button', { name: /1 source/i })
    expect(sourcesTrigger).toBeInTheDocument()

    fireEvent.click(link)

    expect(mockOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Movies',
        path: '/note/note-1',
        entityId: 'note-1'
      })
    )

    fireEvent.click(sourcesTrigger)
    // The list row names its kind after the title, so match on the title alone.
    expect(screen.getAllByRole('link', { name: /Movies/ })).toHaveLength(2)
    expect(
      screen
        .getAllByRole('link', { name: /Movies/ })[1]
        ?.querySelector('[data-agent-link-icon="note-custom"]')
    ).not.toBeNull()
  })

  it('repaints live memrynote links when source metadata arrives after the text', () => {
    const assistantWithoutSources = message({
      id: 'assistant-1',
      role: 'assistant',
      content: {
        role: 'assistant',
        data: { text: 'See [Movies](memry://note/note-1).' }
      }
    })
    const assistantWithSources = message({
      id: 'assistant-1',
      role: 'assistant',
      content: {
        role: 'assistant',
        data: {
          text: 'See [Movies](memry://note/note-1).',
          sources: [
            {
              kind: 'note',
              id: 'note-1',
              title: 'Movies',
              href: 'memry://note/note-1',
              icon: '🎬'
            }
          ]
        }
      }
    })

    const { rerender } = render(<MessageStream messages={[assistantWithoutSources]} />)

    expect(
      screen
        .getByRole('link', { name: 'Movies' })
        .querySelector('[data-agent-link-icon="note-default"]')
    ).not.toBeNull()

    rerender(<MessageStream messages={[assistantWithSources]} />)

    const link = screen.getByRole('link', { name: 'Movies' })
    expect(link.querySelector('[data-agent-link-icon="note-custom"]')).not.toBeNull()
    expect(link.querySelector('[data-agent-link-icon="note-default"]')).toBeNull()
  })

  it('uses the source icon instead of duplicating a provider-emitted note icon label', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: 'See [🎬 Movies](memry://note/note-1).',
                sources: [
                  {
                    kind: 'note',
                    id: 'note-1',
                    title: 'Movies',
                    href: 'memry://note/note-1',
                    icon: '🎬'
                  }
                ]
              }
            }
          })
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'Movies' })
    expect(link.querySelector('[data-agent-link-icon="note-custom"]')).not.toBeNull()
    expect(link.querySelector('[data-agent-link-label]')).toHaveTextContent('Movies')
  })

  it('resolves note icons from the vault even when no source metadata exists', async () => {
    mockGetNote.mockResolvedValue({ id: 'note-1', title: 'Watchlist 2026', emoji: '🎬' })

    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: { text: '[Watchlist 2026](memry://note/note-1)' }
            }
          })
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'Watchlist 2026' })

    await waitFor(() => {
      expect(link.querySelector('[data-agent-link-icon="note-custom"]')).toHaveTextContent('🎬')
    })
    expect(link.querySelector('[data-agent-link-icon="note-default"]')).toBeNull()
    expect(mockGetNote).toHaveBeenCalledWith('note-1')
  })

  it('keeps the default icon when the vault says the note has none', async () => {
    mockGetNote.mockResolvedValue({ id: 'note-1', title: 'Plain', emoji: null })

    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: { text: '[Plain](memry://note/note-1)' }
            }
          })
        ]}
      />
    )

    await waitFor(() => expect(mockGetNote).toHaveBeenCalledWith('note-1'))
    const link = screen.getByRole('link', { name: 'Plain' })
    expect(link.querySelector('[data-agent-link-icon="note-default"]')).not.toBeNull()
  })

  it('lifts an emoji written into the link label into the item icon slot', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: [
                  '[Watchlist 2026 🎬](memry://note/note-1)',
                  '[🎧 Podcasts](memry://note/note-2)',
                  '[Plain note](memry://note/note-3)'
                ].join(' ')
              }
            }
          })
        ]}
      />
    )

    const trailing = screen.getByRole('link', { name: 'Watchlist 2026' })
    expect(trailing.querySelector('[data-agent-link-icon="note-custom"]')).toHaveTextContent('🎬')
    expect(trailing.querySelector('[data-agent-link-icon="note-default"]')).toBeNull()

    const leading = screen.getByRole('link', { name: 'Podcasts' })
    expect(leading.querySelector('[data-agent-link-icon="note-custom"]')).toHaveTextContent('🎧')

    expect(
      screen
        .getByRole('link', { name: 'Plain note' })
        .querySelector('[data-agent-link-icon="note-default"]')
    ).not.toBeNull()
  })

  it('renders item-type icons for non-note memrynote links', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: [
                  '[Spec](memry://inbox/inbox-1)',
                  '[Tweet](memry://inbox/inbox-2)',
                  '[Quote](memry://inbox/inbox-3)',
                  '[Today](memry://journal/2026-05-13)',
                  '[Planning](memry://calendar/event/event-1?date=2026-05-13)'
                ].join(' '),
                sources: [
                  {
                    kind: 'inbox',
                    id: 'inbox-1',
                    title: 'Spec',
                    href: 'memry://inbox/inbox-1',
                    itemType: 'pdf'
                  },
                  {
                    kind: 'inbox',
                    id: 'inbox-2',
                    title: 'Tweet',
                    href: 'memry://inbox/inbox-2',
                    itemType: 'social',
                    visualType: 'twitter'
                  },
                  {
                    kind: 'inbox',
                    id: 'inbox-3',
                    title: 'Quote',
                    href: 'memry://inbox/inbox-3',
                    itemType: 'clip',
                    visualType: 'quote'
                  },
                  {
                    kind: 'journal',
                    id: '2026-05-13',
                    title: 'Today',
                    href: 'memry://journal/2026-05-13'
                  },
                  {
                    kind: 'calendar_event',
                    id: 'event-1',
                    title: 'Planning',
                    href: 'memry://calendar/event/event-1?date=2026-05-13',
                    visualType: 'event'
                  }
                ]
              }
            }
          })
        ]}
      />
    )

    expect(
      screen.getByRole('link', { name: 'Spec' }).querySelector('[data-agent-link-icon="inbox-pdf"]')
    ).not.toBeNull()
    expect(
      screen
        .getByRole('link', { name: 'Tweet' })
        .querySelector('[data-agent-link-icon="inbox-twitter"]')
    ).not.toBeNull()
    expect(
      screen
        .getByRole('link', { name: 'Quote' })
        .querySelector('[data-agent-link-icon="inbox-quote"]')
    ).not.toBeNull()
    expect(
      screen.getByRole('link', { name: 'Today' }).querySelector('[data-agent-link-icon="journal"]')
    ).not.toBeNull()
    expect(
      screen
        .getByRole('link', { name: 'Planning' })
        .querySelector('[data-agent-link-icon="calendar-event"]')
    ).not.toBeNull()
  })

  it('opens non-note memrynote links in the matching workspace surface', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: [
                  '[Task](memry://task/task-1)',
                  '[Inbox Capture](memry://inbox/inbox-1)',
                  '[Journal](memry://journal/2026-05-14)',
                  '[Event](memry://calendar/event/event-1?date=2026-05-14)',
                  '[Project](memry://project/project-1)',
                  '[Folder](memry://folder/Research%2FMovies)'
                ].join(' ')
              }
            }
          })
        ]}
      />
    )

    fireEvent.click(screen.getByRole('link', { name: 'Task' }))
    fireEvent.click(screen.getByRole('link', { name: 'Inbox Capture' }))
    fireEvent.click(screen.getByRole('link', { name: 'Journal' }))
    fireEvent.click(screen.getByRole('link', { name: 'Event' }))
    fireEvent.click(screen.getByRole('link', { name: 'Project' }))
    fireEvent.click(screen.getByRole('link', { name: 'Folder' }))

    expect(mockOpenTab).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'tasks',
        path: '/tasks',
        viewState: { openTaskId: 'task-1' }
      })
    )
    expect(mockOpenTab).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'inbox',
        path: '/inbox',
        viewState: expect.objectContaining({
          focusInboxItemId: 'inbox-1',
          focusedAt: expect.any(Number)
        })
      })
    )
    expect(mockOpenTab).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        type: 'journal',
        path: '/journal/2026-05-14',
        entityId: '2026-05-14',
        viewState: { date: '2026-05-14' }
      })
    )
    expect(mockOpenTab).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        type: 'calendar',
        path: '/calendar',
        viewState: expect.objectContaining({
          focusCalendarEventId: 'event-1',
          focusDate: '2026-05-14',
          focusedAt: expect.any(Number)
        })
      })
    )
    expect(mockOpenTab).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        type: 'project',
        title: 'Project',
        path: '/project/project-1',
        entityId: 'project-1'
      })
    )
    expect(mockOpenTab).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        type: 'folder',
        title: 'Folder',
        path: '/folder/Research%2FMovies',
        entityId: 'Research/Movies'
      })
    )
  })

  it('does not open workspace tabs for external or malformed memrynote links', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: [
                  '[External](https://example.com)',
                  '[Malformed](memry://calendar/not-an-event)'
                ].join(' ')
              }
            }
          })
        ]}
      />
    )

    fireEvent.click(screen.getByRole('link', { name: 'External' }))
    fireEvent.click(screen.getByRole('link', { name: 'Malformed' }))

    expect(mockOpenTab).not.toHaveBeenCalled()
  })

  it('omits the assistant sources footer when no memrynote refs exist', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'No linked items here.' } }
          })
        ]}
      />
    )

    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument()
  })

  it('renders a waiting indicator for an empty streaming assistant message', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            status: 'streaming',
            content: { role: 'assistant', data: { text: '' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('status', { name: 'Agent is thinking' })).toBeInTheDocument()
  })

  it('renders tool calls as collapsed tool details by default', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'input-available'
              }
            }
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Creating task/i })).toBeInTheDocument()
    expect(screen.queryByText('vault_create_task')).not.toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Creating task/i }))

    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('vault_create_task')).toBeInTheDocument()
  })

  it('renders completed tool output in the same collapsed tool block', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_read_note',
                args: { id: 'note-1' },
                status: 'output-available',
                output: { title: 'Planning' }
              }
            }
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Reading note/i })).toBeInTheDocument()
    expect(screen.queryByText('vault_read_note')).not.toBeInTheDocument()
    expect(screen.queryByText('Planning')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reading note/i }))

    expect(screen.getByText('vault_read_note')).toBeInTheDocument()
    expect(screen.getByText(/Planning/)).toBeInTheDocument()
  })

  it('humanizes MCP tool names without adding active lighting', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'mcp__memry__vault_read_note',
                args: { id: 'note-1' },
                status: 'input-available'
              }
            }
          })
        ]}
      />
    )

    expect(screen.getByText('Reading note')).not.toHaveClass('agent-tool-label-active')
    expect(screen.queryByText('mcp__memry__vault_read_note')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reading note/i }))

    expect(screen.getByText('mcp__memry__vault_read_note')).toBeInTheDocument()
  })

  it('renders MCP tool rows as subdued plain text and toggles details from the visible label', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'mcp__memry__vault_create_note',
                args: { title: 'Draft' },
                status: 'input-available'
              }
            }
          })
        ]}
      />
    )

    const trigger = screen.getByRole('button', { name: /Creating note/i })
    const toolRoot = trigger.parentElement as HTMLElement

    expect(toolRoot).not.toHaveClass('border')
    expect(toolRoot).not.toHaveClass('border-sidebar-border')
    expect(toolRoot).not.toHaveClass('bg-sidebar-accent/40')
    expect(trigger).toHaveClass('text-muted-foreground')
    expect(trigger.querySelector('svg')).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Creating note'))

    expect(screen.getByText('Parameters')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Creating note'))

    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
  })

  it('approves pending tool calls inline without a dialog', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: { title: 'Buy milk' },
            requiresDiff: false
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'pending'
              }
            }
          })
        ]}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Creating task/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'allow' }
      })
    })
  })

  it('submits edited pending tool args inline', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: { title: 'Buy milk' },
            requiresDiff: false
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'pending'
              }
            }
          })
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Creating task/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit and allow' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"title":"Edited"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply edits' }))

    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'edit_allow', editedArgs: { title: 'Edited' } }
      })
    })
  })

  it('loads and applies diff approvals inline without a dialog', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_update_note',
            args: {
              id: 'note-1',
              mode: 'append',
              content_markdown: 'new'
            },
            requiresDiff: true
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_update_note',
                args: {
                  id: 'note-1',
                  mode: 'append',
                  content_markdown: 'new'
                },
                status: 'pending'
              }
            }
          })
        ]}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Updating note/i }))
    const candidate = await screen.findByRole('textbox', { name: 'Candidate' })
    fireEvent.change(candidate, { target: { value: 'edited full note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply edited' }))

    expect(mockPreviewDiff).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'tool-1'
    })
    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: {
          kind: 'edit_allow',
          editedArgs: {
            id: 'note-1',
            mode: 'replace',
            content_markdown: 'edited full note'
          }
        }
      })
    })
  })
})
