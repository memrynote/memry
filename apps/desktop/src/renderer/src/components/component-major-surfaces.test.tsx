import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ListView } from './list-view'
import { AuthorAvatar, SocialCardContent, SocialPreview } from './social-card'
import {
  detectPlatformFromUrl,
  extractHandleFromUrl,
  getPlatformColor,
  getPlatformName
} from './social-card-utils'
import { OutlineInfoPanel } from './shared/outline-info-panel'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useRetryTranscription: () => ({
    mutate: vi.fn()
  }),
  // ListView mounts the detail panel, which renames an item through this one.
  useUpdateInboxItem: () => ({
    mutate: vi.fn()
  })
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  isInputFocused: vi.fn(() => false)
}))

vi.mock('@/components/quick-file-dropdown', () => ({
  getFilteredFolders: (folders: unknown[]) => folders.slice(0, 5)
}))

vi.mock('@/components/inbox', () => ({
  InboxListSection: ({
    title,
    count,
    children
  }: {
    title: string
    count: number
    children: ReactNode
  }) => (
    <section>
      <h2>
        {title}:{count}
      </h2>
      {children}
    </section>
  ),
  InboxListItem: ({
    item,
    isQuickFileActive,
    quickFileQuery,
    folders,
    onPreview,
    onArchive,
    onSnooze,
    onQuickFileQueryChange,
    onQuickFileSubmit,
    onQuickFileCancel,
    onQuickFileArrowDown,
    onQuickFileArrowUp,
    onQuickFileFolderSelect,
    onRetryTranscription
  }: {
    item: { id: string; title: string }
    isQuickFileActive: boolean
    quickFileQuery: string
    folders: Array<{ id: string; name: string }>
    onPreview: (id: string) => void
    onArchive: (id: string) => void
    onSnooze?: (id: string, until: string) => void
    onQuickFileQueryChange: (query: string) => void
    onQuickFileSubmit: () => void
    onQuickFileCancel: () => void
    onQuickFileArrowDown: () => void
    onQuickFileArrowUp: () => void
    onQuickFileFolderSelect: (folder: { id: string; name: string }) => void
    onRetryTranscription: (id: string) => void
  }) => (
    <article data-item-id={item.id}>
      <button type="button" onClick={() => onPreview(item.id)}>
        {item.title}
      </button>
      <button type="button" onClick={() => onArchive(item.id)}>
        archive {item.id}
      </button>
      <button type="button" onClick={() => onSnooze?.(item.id, '2026-05-11T00:00:00.000Z')}>
        snooze {item.id}
      </button>
      <button type="button" onClick={() => onRetryTranscription(item.id)}>
        retry {item.id}
      </button>
      {isQuickFileActive && (
        <div>
          <span>quick file {item.id}</span>
          <span>query {quickFileQuery}</span>
          <button type="button" onClick={() => onQuickFileQueryChange('work')}>
            query
          </button>
          <button type="button" onClick={onQuickFileArrowDown}>
            down
          </button>
          <button type="button" onClick={onQuickFileArrowUp}>
            up
          </button>
          <button type="button" onClick={onQuickFileSubmit}>
            submit
          </button>
          <button type="button" onClick={onQuickFileCancel}>
            cancel
          </button>
          <button type="button" onClick={() => onQuickFileFolderSelect(folders[1])}>
            choose folder
          </button>
        </div>
      )}
    </article>
  )
}))

function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function makeItem(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'link',
    title: `Item ${id}`,
    content: `Content ${id}`,
    sourceUrl: `https://example.com/${id}`,
    processingStatus: 'completed',
    createdAt,
    ...overrides
  }
}

describe('OutlineInfoPanel', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders nothing without headings and expands outline/stats on hover', () => {
    const onHeadingClick = vi.fn()
    const { container, rerender } = render(<OutlineInfoPanel headings={[]} />)
    expect(container.firstChild).toBeNull()

    rerender(
      <OutlineInfoPanel
        headings={[
          { id: 'h1', level: 1, text: 'Intro', position: 1 },
          { id: 'h2', level: 3, text: 'Details', position: 2 }
        ]}
        activeHeadingId="h2"
        onHeadingClick={onHeadingClick}
        stats={{
          wordCount: 401,
          characterCount: 2200,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: 'not-a-date'
        }}
      />
    )

    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.getByText('Intro')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('outline.words {"count":401}')).toBeInTheDocument()
    expect(screen.getByText('10.05.2026')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Details'))
    expect(onHeadingClick).toHaveBeenCalledWith('h2')
  })

  it('fades out and unpins after mouse leave', () => {
    vi.useFakeTimers()
    const { container } = render(
      <OutlineInfoPanel headings={[{ id: 'h1', level: 1, text: 'Intro', position: 1 }]} />
    )

    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.getByText('Intro')).toBeInTheDocument()
    fireEvent.mouseLeave(container.firstChild as Element)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByText('Intro')).not.toBeInTheDocument()
  })
})

describe('social card surfaces', () => {
  it('detects platforms, handles avatar fallback, and renders compact/list/preview states', () => {
    expect(detectPlatformFromUrl('https://x.com/kaan/status/1')).toBe('twitter')
    expect(detectPlatformFromUrl('https://example.com/post')).toBe('other')
    expect(extractHandleFromUrl('https://twitter.com/memry/status/1')).toBe('@memry')
    expect(extractHandleFromUrl('not a url')).toBe('')
    expect(getPlatformName('twitter')).toBe('X')
    expect(getPlatformColor('other')).toContain('muted')

    const { rerender } = render(
      <AuthorAvatar
        avatarUrl="https://example.com/avatar.png"
        authorName="Kaan Oz"
        platform="twitter"
      />
    )
    fireEvent.error(screen.getByAltText('Kaan Oz'))
    expect(screen.getByText('KO')).toBeInTheDocument()

    rerender(
      <SocialCardContent
        title="Post title"
        content={null}
        sourceUrl="https://x.com/memry/status/1"
        processingStatus="pending"
      />
    )
    expect(screen.getByText('phaseF.componentsSocialCard.loadingPost')).toBeInTheDocument()

    rerender(
      <SocialCardContent
        title="Post title"
        content="Social body"
        sourceUrl="https://x.com/memry/status/1"
        processingStatus="completed"
        variant="list"
      />
    )
    expect(screen.getByText('Post title')).toBeInTheDocument()
    expect(screen.getByText('@memry')).toBeInTheDocument()

    rerender(
      <SocialPreview
        title="Preview title"
        content="Fallback body"
        sourceUrl="https://x.com/memry/status/1"
        processingStatus="completed"
        metadata={{
          platform: 'twitter',
          authorName: 'memrynote Team',
          authorHandle: '@memry',
          authorAvatar: null,
          postContent: 'Full post',
          timestamp: '2026-05-10T00:00:00.000Z',
          mediaUrls: ['https://example.com/1.png', 'https://example.com/2.png']
        }}
      />
    )
    expect(screen.getByText('memrynote Team')).toBeInTheDocument()
    expect(screen.getByText('Full post')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveTextContent('phaseF.componentsSocialCard.viewOn')

    rerender(
      <SocialPreview
        title="Broken"
        content={null}
        sourceUrl={null}
        processingStatus="failed"
        metadata={null}
      />
    )
    expect(
      screen.getByText(
        'phaseF.componentsSocialCard.failedToLoadPostContentThePostMayBePrivateOrDeleted'
      )
    ).toBeInTheDocument()
  })
})

describe('ListView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api.notes.getFolders = vi
      .fn()
      .mockResolvedValue([{ path: 'Work' }, { path: 'Personal' }])
    window.open = vi.fn()
  })

  it('renders grouped inbox items and handles mouse, keyboard, selection, archive, and quick-file flows', async () => {
    const onPreview = vi.fn()
    const onArchive = vi.fn()
    const onSnooze = vi.fn()
    const onQuickFile = vi.fn()
    const onSelectionChange = vi.fn()
    const onFocusedItemChange = vi.fn()

    render(
      withQueryClient(
        <ListView
          items={[
            makeItem('one', new Date().toISOString(), { sourceUrl: 'https://example.com/one' }),
            makeItem('two', '2026-01-01T00:00:00.000Z')
          ]}
          selectedItemIds={new Set()}
          density="compact"
          onPreview={onPreview}
          onArchive={onArchive}
          onSnooze={onSnooze}
          onQuickFile={onQuickFile}
          onSelectionChange={onSelectionChange}
          onFocusedItemChange={onFocusedItemChange}
        />
      )
    )

    expect(screen.getByRole('list', { name: 'list.ariaLabel' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Item one'))
    expect(onPreview).toHaveBeenCalledWith('one')

    fireEvent.keyDown(document, { key: ' ' })
    expect(onPreview).toHaveBeenCalledWith('one')

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(onFocusedItemChange).toHaveBeenCalledWith('two')

    fireEvent.keyDown(document, { key: 'x' })
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['two']))

    fireEvent.keyDown(document, { key: 'o' })
    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/two',
      '_blank',
      'noopener,noreferrer'
    )

    fireEvent.click(screen.getByText('archive one'))
    expect(onArchive).toHaveBeenCalledWith('one')

    fireEvent.click(screen.getByText('snooze one'))
    expect(onSnooze).toHaveBeenCalledWith('one', '2026-05-11T00:00:00.000Z')

    fireEvent.keyDown(document, { key: 'f' })
    expect(await screen.findByText('quick file two')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'query' }))
    expect(screen.getByText('query work')).toBeInTheDocument()
    fireEvent.click(screen.getByText('down'))
    fireEvent.click(screen.getByText('up'))
    await waitFor(() => expect(window.api.notes.getFolders).toHaveBeenCalled())
    fireEvent.click(screen.getByText('choose folder'))
    expect(onQuickFile).toHaveBeenCalledWith('two', 'Work')

    fireEvent.keyDown(document, { key: 'a', metaKey: true })
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['one', 'two']))
  })
})
