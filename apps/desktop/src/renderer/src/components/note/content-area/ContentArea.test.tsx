import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const contentAreaMocks = vi.hoisted(() => ({
  editor: null as any,
  blockNoteOptions: null as any,
  blocks: new Map<string, any>(),
  suggestionControllers: [] as any[],
  formattingToolbarControllers: [] as any[],
  pasteSelect: null as null | ((option: 'url' | 'mention' | 'embed', url: string) => void),
  handleChange: vi.fn(),
  retryAI: vi.fn(),
  openTag: vi.fn(),
  analyzeTaskIntents: vi.fn(),
  tasksService: {
    listProjects: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  notesService: {
    uploadAttachment: vi.fn()
  },
  fetchLinkPreview: vi.fn(),
  createLinkMentionContent: vi.fn(
    (url: string, domain: string, title?: string, favicon?: string) => ({
      type: 'linkMention',
      props: { url, domain, title, favicon }
    })
  ),
  useSyncState: { status: 'error' },
  yjsState: {
    fragment: undefined as unknown,
    isReady: true,
    isRemoteUpdateRef: { current: false }
  },
  aiContext: {
    port: 4315,
    error: null as string | null,
    retry: null as null | (() => void)
  },
  wikiHover: {
    isVisible: false,
    preview: null as unknown,
    position: null as null | { x: number; y: number },
    handleCardMouseEnter: vi.fn(),
    handleCardMouseLeave: vi.fn()
  }
}))

vi.mock('@blocknote/react', () => ({
  useCreateBlockNote: vi.fn((options) => {
    contentAreaMocks.blockNoteOptions = options
    return contentAreaMocks.editor
  }),
  useBlockNoteEditor: vi.fn(() => contentAreaMocks.editor),
  useEditorState: vi.fn(({ selector }) => selector({ editor: contentAreaMocks.editor })),
  FormattingToolbar: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="formatting-toolbar">{children}</div>
  ),
  FormattingToolbarController: ({ formattingToolbar: Toolbar }: { formattingToolbar?: any }) => {
    contentAreaMocks.formattingToolbarControllers.push({ formattingToolbar: Toolbar })
    return (
      <div data-testid="selection-formatting-toolbar">
        {Toolbar ? <Toolbar /> : <div data-testid="default-selection-formatting-toolbar" />}
      </div>
    )
  },
  BasicTextStyleButton: ({ basicTextStyle }: { basicTextStyle: string }) => (
    <button type="button" aria-label={basicTextStyle}>
      {basicTextStyle}
    </button>
  ),
  TextAlignButton: ({ textAlignment }: { textAlignment: string }) => (
    <button type="button" aria-label={`align ${textAlignment}`}>
      {textAlignment}
    </button>
  ),
  ColorStyleButton: () => (
    <button type="button" aria-label="colors">
      colors
    </button>
  ),
  NestBlockButton: () => (
    <button type="button" aria-label="nest">
      nest
    </button>
  ),
  UnnestBlockButton: () => (
    <button type="button" aria-label="unnest">
      unnest
    </button>
  ),
  CreateLinkButton: () => (
    <button type="button" aria-label="create link">
      link
    </button>
  ),
  blockTypeSelectItems: vi.fn(() => [
    { name: 'Paragraph', type: 'paragraph', icon: () => <span /> },
    {
      name: 'Heading',
      type: 'heading',
      props: { level: 1, isToggleable: false },
      icon: () => <span />
    },
    {
      name: 'Heading 2',
      type: 'heading',
      props: { level: 2, isToggleable: false },
      icon: () => <span />
    }
  ]),
  SuggestionMenuController: (props: Record<string, unknown>) => {
    contentAreaMocks.suggestionControllers.push(props)
    return <div data-testid={`suggestion-${props.triggerCharacter}`} />
  },
  getDefaultReactSlashMenuItems: vi.fn(() => [
    { title: 'Paragraph', aliases: ['text'] },
    { title: 'Heading', aliases: ['title'] }
  ])
}))

vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: ({ children, onChange }: { children: React.ReactNode; onChange: () => void }) => (
    <div data-testid="blocknote-view">
      <button type="button" onClick={onChange}>
        change
      </button>
      <div data-testid="editor-root" contentEditable suppressContentEditableWarning>
        <div data-content-type="checkListItem" data-id="standalone">
          checklist target
        </div>
        <div data-id="task-prev">
          <button type="button" role="button" tabIndex={0}>
            task title
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}))

vi.mock('@blocknote/xl-ai', () => ({
  AIMenuController: () => <div data-testid="ai-menu" />,
  getAISlashMenuItems: vi.fn(() => [{ title: 'AI Write', aliases: ['ai'] }])
}))

vi.mock('@blocknote/xl-ai/locales', () => ({ en: {} }))
vi.mock('@blocknote/core/locales', () => ({ en: {} }))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: contentAreaMocks.notesService
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: contentAreaMocks.tasksService
}))

vi.mock('@/sync/use-yjs-collaboration', () => ({
  useYjsCollaboration: vi.fn(() => contentAreaMocks.yjsState)
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: vi.fn(() => ({ state: contentAreaMocks.useSyncState }))
}))

vi.mock('@/hooks/use-wiki-link-hover', () => ({
  useWikiLinkHover: vi.fn(() => contentAreaMocks.wikiHover)
}))

vi.mock('@/contexts/ai-inline-context', () => ({
  useAIInlineContext: vi.fn(() => ({
    ...contentAreaMocks.aiContext,
    retry: contentAreaMocks.retryAI
  }))
}))

vi.mock('@/contexts/sidebar-drill-down', () => ({
  useSidebarDrillDown: vi.fn(() => ({ openTag: contentAreaMocks.openTag }))
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(() => ({ projects: [] }))
}))

vi.mock('@/lib/url-metadata', () => ({
  extractDomain: vi.fn((url: string) => new URL(url).hostname),
  fetchLinkPreview: contentAreaMocks.fetchLinkPreview
}))

vi.mock('@/lib/youtube-utils', () => ({
  extractYouTubeVideoId: vi.fn((url: string) => (url.includes('youtu') ? 'video-1' : null))
}))

vi.mock('./link-mention', () => ({
  createLinkMentionContent: contentAreaMocks.createLinkMentionContent
}))

vi.mock('./scan-task-intents', () => ({
  analyzeTaskIntents: contentAreaMocks.analyzeTaskIntents
}))

vi.mock('./hooks', () => ({
  useBlockNoteSetup: vi.fn(() => ({ aiReady: true })),
  useEditorSync: vi.fn(() => ({ handleChange: contentAreaMocks.handleChange })),
  useWikiLinkSuggestions: vi.fn(() => ({
    getWikiLinkItems: vi.fn(async () => [{ title: 'Wiki' }]),
    handleWikiLinkSelect: vi.fn()
  })),
  useTagSuggestions: vi.fn(() => ({
    handleTagSuggestionSelect: vi.fn()
  })),
  useEditorDragDrop: vi.fn(() => ({
    isDragging: false,
    dropTarget: null,
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn()
  })),
  useEditorFileUpload: vi.fn(),
  useBlockMarqueeSelection: vi.fn(() => ({
    marqueeRect: null,
    highlightRects: [],
    selectedBlockIds: new Set(),
    isActive: false,
    clearSelection: vi.fn()
  })),
  usePasteLinkMenu: vi.fn(({ onSelect }: { onSelect: typeof contentAreaMocks.pasteSelect }) => {
    contentAreaMocks.pasteSelect = onSelect
    return {
      state: {
        isOpen: true,
        position: { x: 4, y: 5 },
        options: ['url', 'mention', 'embed'],
        selectedIndex: 1
      },
      handleSelect: vi.fn()
    }
  })
}))

vi.mock('./wiki-link-menu', () => ({
  WikiLinkMenu: () => <div data-testid="wiki-menu" />
}))

vi.mock('./tag-suggestion-popover', () => ({
  TagSuggestionPopover: () => <div data-testid="tag-suggestions" />
}))

vi.mock('./wiki-link-preview-card', () => ({
  WikiLinkPreviewCard: ({
    onTagClick,
    onNoteClick
  }: {
    onTagClick: (tag: string) => void
    onNoteClick?: (noteId: string) => void
  }) => (
    <div data-testid="wiki-preview">
      <button type="button" onClick={() => onTagClick('alpha')}>
        tag alpha
      </button>
      <button type="button" onClick={() => onNoteClick?.('note-b')}>
        note beta
      </button>
    </div>
  )
}))

vi.mock('./block-drop-indicator', () => ({
  BlockDropIndicator: () => <div data-testid="block-drop-indicator" />,
  EmptyDocumentDropIndicator: () => <div data-testid="empty-drop-indicator" />
}))

vi.mock('./callout-block', () => ({
  getCalloutSlashMenuItem: vi.fn(() => ({ title: 'Callout', aliases: ['quote'] }))
}))

vi.mock('./task-block', () => ({
  getTaskSlashMenuItem: vi.fn(() => ({ title: 'Task', aliases: ['todo'] }))
}))

vi.mock('./block-marquee-overlay', () => ({
  BlockMarqueeOverlay: () => <div data-testid="marquee-overlay" />
}))

vi.mock('./paste-link-menu', () => ({
  PasteLinkMenu: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="paste-link-menu" /> : null
}))

vi.mock('./ai-menu', () => ({
  CustomAIMenu: () => null
}))

vi.mock('./editor-schema', () => ({ editorSchema: {} }))

import { ContentArea } from './ContentArea'

function createBlock(id: string, overrides: Record<string, unknown> = {}) {
  const block = {
    id,
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text: id, styles: {} }],
    children: [],
    ...overrides
  }
  contentAreaMocks.blocks.set(id, block)
  return block
}

function resetEditor(): void {
  contentAreaMocks.blocks = new Map()
  const standalone = createBlock('standalone', {
    type: 'checkListItem',
    content: [{ type: 'text', text: 'Standalone #urgent', styles: {} }]
  })
  const subCheck = createBlock('sub-check', {
    type: 'checkListItem',
    content: [{ type: 'text', text: 'Sub task', styles: {} }]
  })
  const draft = createBlock('draft', {
    type: 'taskBlock',
    props: { taskId: '', title: 'Draft title', checked: false, parentTaskId: 'parent-task' }
  })
  const demoted = createBlock('demoted', {
    type: 'taskBlock',
    props: { taskId: 'task-demoted', title: 'Demoted', parentTaskId: '' }
  })
  const orphan = createBlock('orphan', {
    type: 'taskBlock',
    props: { taskId: 'task-orphan', title: 'Orphan', parentTaskId: 'old-parent' }
  })
  const taskPrev = createBlock('task-prev', { type: 'taskBlock' })
  const para = createBlock('para')
  const urlBlock = createBlock('url-block', {
    content: [{ type: 'text', text: 'https://youtu.be/video-1', styles: {} }]
  })

  contentAreaMocks.editor = {
    get document() {
      return [taskPrev, para, subCheck, standalone, draft, demoted, orphan, urlBlock]
    },
    getBlock: vi.fn((id: string) => contentAreaMocks.blocks.get(id)),
    updateBlock: vi.fn((block: any, update: Record<string, unknown>) => {
      if ('type' in update) block.type = update.type
      if ('content' in update) block.content = update.content
      if ('props' in update) block.props = { ...block.props, ...(update.props as object) }
    }),
    insertBlocks: vi.fn(),
    focus: vi.fn(),
    transact: vi.fn((fn: () => void) => fn()),
    getSelection: vi.fn(() => ({ blocks: [para] })),
    getTextCursorPosition: vi.fn(() => ({ block: urlBlock })),
    dictionary: {},
    schema: {
      blockSpecs: {
        paragraph: { config: { propSchema: {} } },
        heading: {
          config: {
            propSchema: {
              level: { default: 1, type: 'number' },
              isToggleable: { default: false, type: 'boolean' }
            }
          }
        },
        callout: {
          config: {
            propSchema: {
              type: { default: 'info', type: 'string' }
            }
          }
        }
      }
    },
    prosemirrorView: { focus: vi.fn(), dom: { blur: vi.fn() } },
    _tiptapEditor: { state: { selection: { empty: true, $from: { parentOffset: 0 } } } }
  }
}

function emptyIntents(currentTaskIds = new Set<string>()) {
  return {
    subtaskCandidate: null,
    standaloneCandidate: null,
    draftTaskBlock: null,
    demotedTaskBlocks: [],
    unindentedTaskBlocks: [],
    currentTaskIds
  }
}

function findTextNode(root: Node, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.data.includes(text)) return node
  }
  throw new Error(`Could not find text node for ${text}`)
}

function installRect(element: Element, rect: Partial<DOMRect>): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      left: rect.left ?? 0,
      top: rect.top ?? 0,
      right: rect.right ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 100,
      height: rect.height ?? 20,
      toJSON: () => ({})
    })
  })
}

function selectEditorText(text: string): void {
  const root = screen.getByTestId('editor-root')
  const container = screen.getByRole('application')
  installRect(container, { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 })

  const textNode = findTextNode(root, text)
  const start = textNode.data.indexOf(text)
  const range = document.createRange()
  range.setStart(textNode, start)
  range.setEnd(textNode, start + text.length)
  Object.defineProperty(range, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 140,
      bottom: 48,
      width: 120,
      height: 18,
      toJSON: () => ({})
    })
  })

  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}

describe('ContentArea', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    contentAreaMocks.suggestionControllers = []
    contentAreaMocks.formattingToolbarControllers = []
    contentAreaMocks.pasteSelect = null
    contentAreaMocks.blockNoteOptions = null
    contentAreaMocks.useSyncState = { status: 'error' }
    contentAreaMocks.yjsState = {
      fragment: undefined,
      isReady: true,
      isRemoteUpdateRef: { current: false }
    }
    contentAreaMocks.aiContext = { port: 4315, error: null, retry: null }
    contentAreaMocks.wikiHover = {
      isVisible: false,
      preview: null,
      position: null,
      handleCardMouseEnter: vi.fn(),
      handleCardMouseLeave: vi.fn()
    }
    contentAreaMocks.handleChange.mockResolvedValue(undefined)
    contentAreaMocks.fetchLinkPreview.mockResolvedValue({
      domain: 'youtu.be',
      title: 'Video',
      favicon: 'icon.png'
    })
    contentAreaMocks.tasksService.listProjects.mockResolvedValue({
      projects: [{ id: 'project-1', name: 'Inbox', isDefault: true }]
    })
    contentAreaMocks.tasksService.get.mockResolvedValue({
      id: 'parent-task',
      projectId: 'project-1'
    })
    contentAreaMocks.tasksService.create.mockResolvedValue({
      success: true,
      task: { id: 'created-task', title: 'Created task', projectId: 'project-1' }
    })
    contentAreaMocks.tasksService.update.mockResolvedValue({ success: true })
    contentAreaMocks.tasksService.delete.mockResolvedValue({ success: true })
    contentAreaMocks.notesService.uploadAttachment.mockResolvedValue({
      success: true,
      path: 'attachments/file.png'
    })
    resetEditor()
  })

  it('shows the collaboration loading skeleton while a synced note is not ready', () => {
    contentAreaMocks.useSyncState = { status: 'syncing' }
    contentAreaMocks.yjsState = {
      fragment: undefined,
      isReady: false,
      isRemoteUpdateRef: { current: false }
    }

    const { container } = render(<ContentArea noteId="note-1" className="custom-class" />)

    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(screen.queryByTestId('blocknote-view')).not.toBeInTheDocument()
  })

  it('renders editor chrome, retry UI, suggestions, wiki preview, and context-menu conversion', async () => {
    contentAreaMocks.aiContext = { port: 4315, error: 'AI offline', retry: null }
    contentAreaMocks.wikiHover = {
      isVisible: true,
      preview: { id: 'note-b', title: 'Beta' },
      position: { x: 10, y: 20 },
      handleCardMouseEnter: vi.fn(),
      handleCardMouseLeave: vi.fn()
    }

    const onInternalLinkClick = vi.fn()
    render(
      <ContentArea
        noteId="note-1"
        stickyToolbar
        onInternalLinkClick={onInternalLinkClick}
        className="content-test"
      />
    )

    expect(screen.getByTestId('formatting-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('ai-menu')).toBeInTheDocument()
    expect(screen.getByTestId('paste-link-menu')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Retry'))
    expect(contentAreaMocks.retryAI).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('tag alpha'))
    expect(contentAreaMocks.openTag).toHaveBeenCalledWith('alpha')
    fireEvent.click(screen.getByText('note beta'))
    expect(onInternalLinkClick).toHaveBeenCalledWith('note-b')

    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    await expect(slashController.getItems('task')).resolves.toEqual([
      expect.objectContaining({ title: 'Task' })
    ])

    fireEvent.contextMenu(screen.getByText('checklist target'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'standalone' }),
      expect.objectContaining({ type: 'taskBlock' })
    )
  })

  it('uses a compact floating selection toolbar with twelve slots', () => {
    render(<ContentArea noteId="note-1" />)

    const toolbar = screen.getByLabelText('Selection formatting')

    expect(screen.getByTestId('selection-formatting-toolbar')).toBeInTheDocument()
    expect(within(toolbar).getAllByRole('button')).toHaveLength(12)
    expect(within(toolbar).getByRole('button', { name: 'More formatting options' })).toBeVisible()
  })

  it('opens a selected-text comment draft only after the toolbar Comment action', async () => {
    render(
      <ContentArea
        noteId="note-1"
        commentTargetType="note"
        commentTargetId="note-1"
        onSaveCommentRequest={vi.fn()}
      />
    )

    selectEditorText('checklist target')

    expect(screen.queryByTestId('comments-rail')).not.toBeInTheDocument()

    const commentButton = await screen.findByRole('button', { name: 'Comment' })
    await act(async () => {})
    fireEvent.mouseDown(commentButton)

    expect(await screen.findByTestId('comments-rail')).toBeInTheDocument()
    expect(screen.getByTestId('comment-composer-quote')).toHaveTextContent('checklist target')
  })

  it('opens a block comment draft from the hover affordance', async () => {
    render(
      <ContentArea
        noteId="note-1"
        commentTargetType="note"
        commentTargetId="note-1"
        onSaveCommentRequest={vi.fn()}
      />
    )

    const block = screen.getByText('checklist target').closest('[data-id]')
    expect(block).toBeTruthy()
    installRect(screen.getByRole('application'), {
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400
    })
    installRect(block!, { left: 10, top: 44, right: 420, bottom: 70, width: 410, height: 26 })

    fireEvent.mouseMove(block!)
    fireEvent.click(await screen.findByRole('button', { name: 'Add comment to block' }))

    expect(await screen.findByTestId('comments-rail')).toBeInTheDocument()
    expect(screen.getByTestId('comment-composer-quote')).toHaveTextContent('checklist target')
  })

  it('turns selected text blocks into the chosen block type from the more menu', async () => {
    render(<ContentArea noteId="note-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More formatting options' }))
    expect(screen.getByText('Turn into')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Heading 2'))

    expect(contentAreaMocks.editor.focus).toHaveBeenCalled()
    expect(contentAreaMocks.editor.transact).toHaveBeenCalled()
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'para' }),
      {
        type: 'heading',
        props: { level: 2, isToggleable: false }
      }
    )
  })

  it('converts task intents and cleans up deleted task blocks on editor changes', async () => {
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set(['existing-task'])),
        subtaskCandidate: { blockId: 'sub-check', parentTaskId: 'parent-task' },
        draftTaskBlock: { blockId: 'draft', title: 'Draft title' },
        demotedTaskBlocks: [
          { blockId: 'demoted', taskId: 'task-demoted', newParentTaskId: 'parent-task' }
        ],
        unindentedTaskBlocks: [{ blockId: 'orphan', taskId: 'task-orphan' }]
      })
      .mockReturnValueOnce(emptyIntents(new Set()))
      .mockReturnValue(emptyIntents(new Set()))

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))

    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(2))
    expect(contentAreaMocks.tasksService.update).toHaveBeenCalledWith({
      id: 'task-demoted',
      parentId: 'parent-task'
    })
    expect(contentAreaMocks.tasksService.update).toHaveBeenCalledWith({
      id: 'task-orphan',
      parentId: null
    })

    fireEvent.click(screen.getByText('change'))
    await waitFor(() =>
      expect(contentAreaMocks.tasksService.delete).toHaveBeenCalledWith('existing-task')
    )
  })

  it('handles paste-link mention and YouTube embed selections', async () => {
    render(<ContentArea noteId="note-1" />)

    contentAreaMocks.pasteSelect?.('mention', 'https://youtu.be/video-1')

    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'url-block' }),
      expect.objectContaining({
        content: [expect.objectContaining({ type: 'linkMention' })]
      })
    )

    await waitFor(() =>
      expect(contentAreaMocks.createLinkMentionContent).toHaveBeenCalledWith(
        'https://youtu.be/video-1',
        'youtu.be',
        'Video',
        'icon.png'
      )
    )

    contentAreaMocks.pasteSelect?.('embed', 'https://youtu.be/video-1')
    expect(contentAreaMocks.editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: 'youtubeEmbed',
          props: { videoId: 'video-1', videoUrl: 'https://youtu.be/video-1' }
        }
      ],
      expect.objectContaining({ id: 'url-block' }),
      'after'
    )

    const plainBlock = createBlock('plain-url-target', {
      content: [{ type: 'text', text: 'No URL here', styles: {} }]
    })
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValueOnce({ block: plainBlock })
    contentAreaMocks.pasteSelect?.('mention', 'https://example.com')
    expect(contentAreaMocks.createLinkMentionContent).toHaveBeenCalledTimes(2)

    contentAreaMocks.editor.getTextCursorPosition.mockReturnValueOnce({ block: plainBlock })
    contentAreaMocks.pasteSelect?.('embed', 'https://example.com')
    expect(contentAreaMocks.editor.insertBlocks).toHaveBeenCalledTimes(1)

    contentAreaMocks.editor.getTextCursorPosition.mockReturnValueOnce({ block: plainBlock })
    contentAreaMocks.pasteSelect?.('url', 'https://example.com')
    expect(contentAreaMocks.editor.insertBlocks).toHaveBeenCalledTimes(1)
  })

  it('exposes upload handling success and failure through the BlockNote config', async () => {
    const { rerender } = render(<ContentArea />)

    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(new File(['a'], 'a.txt'))
    ).rejects.toThrow('Cannot upload')

    rerender(<ContentArea noteId="note-upload" />)
    await waitFor(() => expect(contentAreaMocks.blockNoteOptions).toBeTruthy())

    contentAreaMocks.notesService.uploadAttachment.mockResolvedValueOnce({
      success: false,
      error: 'blocked'
    })
    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(new File(['b'], 'b.txt'))
    ).rejects.toThrow('blocked')

    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(new File(['c'], 'c.txt'))
    ).resolves.toBe('attachments/file.png')
    expect(contentAreaMocks.notesService.uploadAttachment).toHaveBeenCalledWith(
      'note-upload',
      expect.any(File)
    )
  })

  it('debounces standalone checkbox conversion and clears pending conversion on unmount', async () => {
    vi.useFakeTimers()
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'standalone' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'standalone' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'standalone' }
      })

    const { unmount } = render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    fireEvent.click(screen.getByText('change'))
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Standalone #urgent',
        linkedNoteIds: ['note-1']
      })
    )

    contentAreaMocks.tasksService.create.mockClear()
    contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce({
      ...emptyIntents(new Set()),
      standaloneCandidate: { blockId: 'standalone' }
    })
    fireEvent.click(screen.getByText('change'))
    unmount()

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
  })

  it('focuses the previous task title instead of letting Backspace delete task blocks', () => {
    render(<ContentArea noteId="note-1" />)

    const taskTitle = screen.getByText('task title')
    const clickSpy = vi.spyOn(taskTitle, 'click')
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValueOnce({
      block: contentAreaMocks.blocks.get('para')
    })
    fireEvent.keyDown(screen.getByRole('application'), { key: 'Backspace' })

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})
