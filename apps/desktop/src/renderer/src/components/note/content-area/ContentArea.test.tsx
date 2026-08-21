import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders as render } from '@tests/utils/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { getDefaultReactSlashMenuItems } from '@blocknote/react'
import { WIKI_LINK_EDIT_PLUGIN_KEY } from './wiki-link-edit-plugin'

const contentAreaMocks = vi.hoisted(() => ({
  editor: null as any,
  blockNoteOptions: null as any,
  blocks: new Map<string, any>(),
  suggestionControllers: [] as any[],
  pasteSelect: null as
    null | ((option: 'url' | 'mention' | 'embed' | 'bookmark', url: string) => void),
  handleChange: vi.fn(),
  retryAI: vi.fn(),
  openSidebarItem: vi.fn(),
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
  toastError: vi.fn(),
  defaultFileItemClick: vi.fn(),
  openSuggestionMenu: vi.fn(),
  registerPlugin: vi.fn(),
  createLinkMentionContent: vi.fn(
    (url: string, domain: string, title?: string, favicon?: string) => ({
      type: 'linkMention',
      props: { url, domain, title, favicon }
    })
  ),
  useSyncState: { status: 'error' },
  yjsState: {
    fragment: undefined as unknown,
    doc: null as unknown,
    provider: null as unknown,
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
  FormattingToolbar: () => <div data-testid="formatting-toolbar" />,
  FormattingToolbarController: ({
    formattingToolbar
  }: {
    formattingToolbar: () => React.ReactNode
  }) => <div data-testid="formatting-toolbar-controller">{formattingToolbar()}</div>,
  BasicTextStyleButton: () => <button type="button">style</button>,
  ColorStyleButton: () => <button type="button">color</button>,
  CreateLinkButton: () => <button type="button">link</button>,
  NestBlockButton: () => <button type="button">nest</button>,
  TextAlignButton: () => <button type="button">align</button>,
  UnnestBlockButton: () => <button type="button">unnest</button>,
  getFormattingToolbarItems: vi.fn(() => null),
  useBlockNoteEditor: vi.fn(() => contentAreaMocks.editor),
  useComponentsContext: vi.fn(() => ({
    FormattingToolbar: {
      Button: ({ onClick, label }: { onClick: () => void; label: string }) => (
        <button type="button" onClick={onClick}>
          {label}
        </button>
      )
    },
    // `TableBorderHandles` re-points `Generic.Menu.Dropdown` at `.bn-container`
    // so a table menu is not clipped by the table's own scroll wrapper.
    Generic: {
      Menu: {
        Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
        Trigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
        Dropdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
      }
    }
  })),
  useEditorState: vi.fn(() => ({ hasSelection: false, isMultiBlock: false })),
  SuggestionMenuController: (props: Record<string, unknown>) => {
    contentAreaMocks.suggestionControllers.push(props)
    return <div data-testid={`suggestion-${props.triggerCharacter}`} />
  },
  GridSuggestionMenuController: (props: Record<string, unknown>) => {
    contentAreaMocks.suggestionControllers.push(props)
    return <div data-testid={`grid-suggestion-${props.triggerCharacter}`} />
  },
  getDefaultReactSlashMenuItems: vi.fn(() => [
    { key: 'paragraph', title: 'Paragraph', aliases: ['text'] },
    { key: 'heading', title: 'Heading', aliases: ['title'] },
    { key: 'image', title: 'Image', aliases: ['image', 'img', 'picture'], group: 'Media' },
    {
      key: 'file',
      title: 'File',
      subtext: 'Embedded file',
      aliases: ['file', 'upload'],
      group: 'Media',
      onItemClick: contentAreaMocks.defaultFileItemClick
    }
  ]),
  FilePanelController: () => <div data-testid="file-panel-controller" />,
  UploadTab: () => <div data-testid="upload-tab" />,
  // `TableBorderHandles` reaches for the table-handle extension so the nubs on
  // the cell borders can open BlockNote's own row/column/cell menus. It renders
  // nothing until a cell is hovered, which jsdom (no layout) never reports —
  // these only have to exist.
  useExtension: vi.fn(() => ({ freezeHandles: vi.fn(), unfreezeHandles: vi.fn() })),
  useEditorSelectionChange: vi.fn(),
  useEditorChange: vi.fn(),
  ComponentsContext: {
    Provider: ({ children }: { children: React.ReactNode }) => children
  },
  TableCellMenu: () => <div data-testid="table-cell-menu" />,
  TableHandleMenu: () => <div data-testid="table-handle-menu" />
}))

vi.mock('sonner', () => ({
  toast: { error: contentAreaMocks.toastError, success: vi.fn() }
}))

vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: ({ children, onChange }: { children: React.ReactNode; onChange: () => void }) => (
    <div data-testid="blocknote-view">
      <button type="button" onClick={onChange}>
        change
      </button>
      <div data-content-type="checkListItem" data-id="standalone">
        checklist target
      </div>
      <div data-id="task-prev">
        <button type="button" role="button" tabIndex={0}>
          task title
        </button>
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

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: vi.fn(() => ({ openSidebarItem: contentAreaMocks.openSidebarItem }))
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
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'

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

function textCell(text: string): any[] {
  return [{ type: 'text', text, styles: {} }]
}

// A table block's content is `{ type: 'tableContent', rows }`, not the inline
// array every other block carries.
function createTableBlock(id: string, rows: any[][]): any {
  return createBlock(id, {
    type: 'table',
    content: { type: 'tableContent', rows: rows.map((cells) => ({ cells })) }
  })
}

// `editor.document` is a getter over a fixed block list; swap in a document the
// test owns so the link-preview walk has something to find.
function setDocument(blocks: any[]): void {
  Object.defineProperty(contentAreaMocks.editor, 'document', {
    value: blocks,
    configurable: true
  })
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
    getExtension: vi.fn(() => ({ openSuggestionMenu: contentAreaMocks.openSuggestionMenu })),
    getTextCursorPosition: vi.fn(() => ({ block: urlBlock })),
    prosemirrorView: {
      focus: vi.fn(),
      dom: { blur: vi.fn() },
      // `TableBorderHandles` reads the caret's cell off the selection to ring
      // it; jsdom has no table here, so this only has to resolve to nothing.
      isDestroyed: false,
      state: { selection: { from: 0 } },
      domAtPos: vi.fn(() => ({ node: document.body, offset: 0 }))
    },
    _tiptapEditor: {
      state: { selection: { empty: true, $from: { parentOffset: 0 } } },
      destroy: vi.fn(),
      registerPlugin: contentAreaMocks.registerPlugin,
      unregisterPlugin: vi.fn()
    }
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

describe('ContentArea', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    contentAreaMocks.suggestionControllers = []
    contentAreaMocks.pasteSelect = null
    contentAreaMocks.blockNoteOptions = null
    contentAreaMocks.useSyncState = { status: 'error' }
    contentAreaMocks.yjsState = {
      fragment: undefined,
      doc: null,
      provider: null,
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
      favicon: 'icon.png',
      siteName: 'YouTube'
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

  it('destroys the editor and releases the window handle when it unmounts', async () => {
    const editor = contentAreaMocks.editor
    const win = window as unknown as { ProseMirror?: unknown }
    // `useCreateBlockNote` parks the newest instance here; nothing ever clears it.
    win.ProseMirror = editor._tiptapEditor

    const { unmount } = render(<ContentArea noteId="note-1" />)
    expect(editor._tiptapEditor.destroy).not.toHaveBeenCalled()

    unmount()
    // Teardown is deferred by a microtask so StrictMode's remount can cancel it.
    await Promise.resolve()

    expect(editor._tiptapEditor.destroy).toHaveBeenCalledTimes(1)
    expect(win.ProseMirror).toBeUndefined()
  })

  it('leaves no DOM listener or animation frame behind after unmount', () => {
    const addEventListener = EventTarget.prototype.addEventListener
    const removeEventListener = EventTarget.prototype.removeEventListener
    const requestAnimationFrame = window.requestAnimationFrame
    const cancelAnimationFrame = window.cancelAnimationFrame

    const live = new Set<string>()
    const key = (target: EventTarget, type: string, listener: unknown, options: unknown): string =>
      `${(target as { tagName?: string }).tagName ?? target.constructor.name}:${type}:${
        (listener as { name?: string })?.name ?? 'anon'
      }:${typeof options === 'object' ? JSON.stringify(options) : String(options)}`

    // React 19 installs its delegated root listeners on the test container and
    // deliberately keeps them past unmount — they are the runtime's, not ours.
    const isReactRootListener = (listener: unknown): boolean =>
      typeof listener === 'function' && /^bound dispatch/.test(listener.name)

    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: never,
      options?: never
    ) {
      if (!isReactRootListener(listener)) live.add(key(this, type, listener, options))
      return addEventListener.call(this, type, listener, options)
    }
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: never,
      options?: never
    ) {
      live.delete(key(this, type, listener, options))
      return removeEventListener.call(this, type, listener, options)
    }

    const liveFrames = new Set<number>()
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      const handle = requestAnimationFrame(callback)
      liveFrames.add(handle)
      return handle
    }
    window.cancelAnimationFrame = (handle: number): void => {
      liveFrames.delete(handle)
      cancelAnimationFrame(handle)
    }

    try {
      const { unmount } = render(<ContentArea noteId="note-1" />)
      live.clear()
      liveFrames.clear()
      const { unmount: unmountTracked } = render(<ContentArea noteId="note-2" />)
      expect(live.size).toBeGreaterThan(0)

      unmountTracked()
      unmount()

      expect([...live]).toEqual([])
      expect([...liveFrames]).toEqual([])
    } finally {
      EventTarget.prototype.addEventListener = addEventListener
      EventTarget.prototype.removeEventListener = removeEventListener
      window.requestAnimationFrame = requestAnimationFrame
      window.cancelAnimationFrame = cancelAnimationFrame
    }
  })

  it('shows the collaboration loading skeleton while a synced note is not ready', () => {
    contentAreaMocks.useSyncState = { status: 'syncing' }
    contentAreaMocks.yjsState = {
      fragment: undefined,
      doc: null,
      provider: null,
      isReady: false,
      isRemoteUpdateRef: { current: false }
    }

    const { container } = render(<ContentArea noteId="note-1" className="custom-class" />)

    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(screen.queryByTestId('blocknote-view')).not.toBeInTheDocument()
  })

  // BlockNote 0.47 defaults `tables.headers` to false, which removes the table
  // handle menu's header-row toggle entirely — while the markdown the note is
  // saved as always writes a header separator. The editor has to offer the row
  // the file format is going to insist on.
  it('enables the table header row toggle', () => {
    render(<ContentArea noteId="note-1" />)

    expect(contentAreaMocks.blockNoteOptions.tables).toMatchObject({ headers: true })
  })

  // Same default, same consequence: BlockNote hides the cell colour menu unless
  // both flags are on, which left a table the one place in a note where colour
  // could not be reached (#1639).
  it('enables the table cell colour menu', () => {
    render(<ContentArea noteId="note-1" />)

    expect(contentAreaMocks.blockNoteOptions.tables).toMatchObject({
      cellBackgroundColor: true,
      cellTextColor: true
    })
  })

  // The signed-out clobber: with no session the editor was never bound to a
  // Y.Doc, so keystrokes reached markdown alone and the sign-in that rebuilt the
  // doc from the server wrote it back over them. The local doc is the editor's
  // store; the session only decides whether anything is synced.
  it.each([
    ['never signed in', 'unknown'],
    ['signed out', 'error'],
    ['sync paused', 'paused']
  ])('binds the local Y.Doc with no sync session (%s)', (_case, status) => {
    contentAreaMocks.useSyncState = { status }
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('blocks')
    contentAreaMocks.yjsState = {
      fragment,
      doc,
      provider: { doc, isSynced: false },
      isReady: true,
      isRemoteUpdateRef: { current: false }
    }

    render(<ContentArea noteId="note-1" />)

    expect(vi.mocked(useYjsCollaboration)).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 'note-1', enabled: true })
    )
    expect(contentAreaMocks.blockNoteOptions.collaboration.fragment).toBe(fragment)
  })

  it('waits for the local Y.Doc binding with no sync session instead of opening a markdown editor', () => {
    // `useCreateBlockNote` builds its collaboration extension exactly once, so a
    // fragment that arrives after the editor exists can never attach. Rendering
    // a non-collaborative editor here would be a decision, not a placeholder.
    contentAreaMocks.useSyncState = { status: 'unknown' }
    contentAreaMocks.yjsState = {
      fragment: undefined,
      doc: null,
      provider: null,
      isReady: false,
      isRemoteUpdateRef: { current: false }
    }

    const { container } = render(<ContentArea noteId="note-1" />)

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
    expect(contentAreaMocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tag', entityId: 'alpha' })
    )
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

  it('persists review marks into Yjs metadata while collaboration is active', async () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('blocks')
    contentAreaMocks.useSyncState = { status: 'idle' }
    contentAreaMocks.yjsState = {
      fragment,
      doc,
      provider: { doc, isSynced: true },
      isReady: true,
      isRemoteUpdateRef: { current: false }
    }

    render(
      <ContentArea
        noteId="note-1"
        review={{
          plainMarkdown: '',
          marks: [
            {
              id: 'add-1',
              kind: 'addition',
              visibleText: 'added',
              start: 5,
              end: 10
            }
          ],
          hoveredMarkId: null
        }}
      />
    )

    await waitFor(() =>
      expect(doc.getArray('criticMarkupMarks').toArray()).toEqual([
        expect.objectContaining({
          id: 'add-1',
          kind: 'addition',
          visibleText: 'added',
          start: 5,
          end: 10
        })
      ])
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
        'icon.png',
        'YouTube'
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

  it('turns a URL pasted into a table cell into a mention without touching the rest of the table', async () => {
    const tableBlock = createTableBlock('table-mention', [
      [textCell('Docs')],
      [textCell('see https://youtu.be/video-1 for more')]
    ])
    setDocument([tableBlock])

    render(<ContentArea noteId="note-1" />)

    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: tableBlock })
    contentAreaMocks.pasteSelect?.('mention', 'https://youtu.be/video-1')

    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'table-mention' }),
      {
        content: {
          type: 'tableContent',
          rows: [
            { cells: [textCell('Docs')] },
            { cells: [[expect.objectContaining({ type: 'linkMention' })]] }
          ]
        }
      }
    )

    // The preview fetch re-finds the mention by walking the document, which
    // also has to see into the table, and enriches it in place.
    await waitFor(() =>
      expect(contentAreaMocks.createLinkMentionContent).toHaveBeenCalledWith(
        'https://youtu.be/video-1',
        'youtu.be',
        'Video',
        'icon.png',
        'YouTube'
      )
    )
    expect(tableBlock.content.rows[1].cells[0][0]).toMatchObject({
      type: 'linkMention',
      props: { title: 'Video' }
    })
    expect(tableBlock.content.rows[0].cells[0]).toEqual(textCell('Docs'))
  })

  it('drops the URL from its table cell and puts the embed or bookmark after the table', async () => {
    const tableBlock = createTableBlock('table-embed', [
      [
        { type: 'tableCell', props: { colspan: 1 }, content: [] },
        {
          type: 'tableCell',
          props: { colspan: 1 },
          content: [{ type: 'text', text: 'https://youtu.be/video-1', styles: {} }]
        }
      ]
    ])
    setDocument([tableBlock])

    render(<ContentArea noteId="note-1" />)

    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: tableBlock })
    contentAreaMocks.pasteSelect?.('embed', 'https://youtu.be/video-1')

    expect(tableBlock.content.rows[0].cells[1]).toEqual({
      type: 'tableCell',
      props: { colspan: 1 },
      content: []
    })
    expect(contentAreaMocks.editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: 'youtubeEmbed',
          props: { videoId: 'video-1', videoUrl: 'https://youtu.be/video-1' }
        }
      ],
      expect.objectContaining({ id: 'table-embed' }),
      'after'
    )

    const bookmarkTable = createTableBlock('table-bookmark', [
      [textCell('https://example.com/post')]
    ])
    setDocument([bookmarkTable])
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: bookmarkTable })
    contentAreaMocks.pasteSelect?.('bookmark', 'https://example.com/post')

    expect(bookmarkTable.content.rows[0].cells[0]).toEqual([])
    expect(contentAreaMocks.editor.insertBlocks).toHaveBeenLastCalledWith(
      [{ type: 'bookmark', props: { url: 'https://example.com/post', domain: 'example.com' } }],
      expect.objectContaining({ id: 'table-bookmark' }),
      'after'
    )
  })

  it('leaves a table alone when the pasted URL is in none of its cells', () => {
    const tableBlock = createTableBlock('table-miss', [[textCell('nothing here')]])
    setDocument([tableBlock])

    render(<ContentArea noteId="note-1" />)

    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: tableBlock })
    contentAreaMocks.pasteSelect?.('mention', 'https://example.com/post')

    expect(contentAreaMocks.editor.updateBlock).not.toHaveBeenCalled()
    expect(tableBlock.content.rows[0].cells[0]).toEqual(textCell('nothing here'))
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

    expect(contentAreaMocks.toastError).toHaveBeenCalledWith('blocked')

    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(new File(['c'], 'c.txt'))
    ).resolves.toBe('attachments/file.png')
    expect(contentAreaMocks.notesService.uploadAttachment).toHaveBeenCalledWith(
      'note-upload',
      expect.any(File)
    )
  })

  it('returns full file-block props for a file block and a bare url for an image block', async () => {
    render(<ContentArea noteId="note-upload" />)
    await waitFor(() => expect(contentAreaMocks.blockNoteOptions).toBeTruthy())

    createBlock('pdf-block', { type: 'file', props: {} })
    createBlock('image-block', { type: 'image', props: {} })

    contentAreaMocks.notesService.uploadAttachment.mockResolvedValueOnce({
      success: true,
      path: 'attachments/manual.pdf',
      name: 'manual.pdf',
      size: 4096,
      mimeType: 'application/pdf',
      type: 'file'
    })
    // Without size + mimeType the block renders the download card instead of
    // the inline PDF viewer — the whole point of this shape.
    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(
        new File(['p'], 'manual.pdf', { type: 'application/pdf' }),
        'pdf-block'
      )
    ).resolves.toEqual({
      props: {
        url: 'attachments/manual.pdf',
        name: 'manual.pdf',
        size: 4096,
        mimeType: 'application/pdf'
      }
    })

    // Image blocks have no size/mimeType props; unknown props break them.
    contentAreaMocks.notesService.uploadAttachment.mockResolvedValueOnce({
      success: true,
      path: 'attachments/shot.png',
      name: 'shot.png',
      size: 128,
      mimeType: 'image/png',
      type: 'image'
    })
    await expect(
      contentAreaMocks.blockNoteOptions.uploadFile(
        new File(['i'], 'shot.png', { type: 'image/png' }),
        'image-block'
      )
    ).resolves.toBe('attachments/shot.png')
  })

  it('offers a PDF slash item that runs the default file item', async () => {
    render(<ContentArea noteId="note-1" />)

    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const items = await slashController.getItems('pdf')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'pdf', group: 'Media' })

    items[0].onItemClick()
    expect(contentAreaMocks.defaultFileItemClick).toHaveBeenCalledTimes(1)

    // `/photo` is a new alias on BlockNote's image item.
    await expect(slashController.getItems('photo')).resolves.toEqual([
      expect.objectContaining({ key: 'image' })
    ])
  })

  it('inserts new tables with the header row markdown is going to give them anyway', async () => {
    const defaultTableClick = vi.fn()
    const table = {
      id: 'new-table',
      type: 'table',
      content: {
        type: 'tableContent',
        columnWidths: [null, null],
        rows: [{ cells: [{}, {}] }, { cells: [{}, {}] }]
      }
    }
    vi.mocked(getDefaultReactSlashMenuItems).mockReturnValueOnce([
      { key: 'table', title: 'Table', group: 'Basic blocks', onItemClick: defaultTableClick }
    ] as never)
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: table })

    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const items = await slashController.getItems('table')

    items[0].onItemClick()

    expect(defaultTableClick).toHaveBeenCalledTimes(1)
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      table,
      expect.objectContaining({
        type: 'table',
        content: expect.objectContaining({ headerRows: 1 })
      })
    )
  })

  it('registers the wiki-link edit plugin, prepended, through the undo-safe wrapper', () => {
    render(<ContentArea noteId="note-1" />)

    const call = contentAreaMocks.registerPlugin.mock.calls.find(
      ([plugin]) => plugin?.spec?.key === WIKI_LINK_EDIT_PLUGIN_KEY
    )
    expect(call).toBeDefined()

    // Prepended, or the default Backspace keymap deletes the chip before the
    // plugin ever sees the key.
    const [plugin, handlePlugins] = call!
    expect(handlePlugins(plugin, ['existing'])).toEqual([plugin, 'existing'])
  })

  it('offers a "link to note" slash item that hands over to the [[ menu', async () => {
    render(<ContentArea noteId="note-1" />)

    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const items = await slashController.getItems('wikilink')
    expect(items).toHaveLength(1)

    items[0].onItemClick()
    // Through the suggestion plugin's own opener, so `[[` reaches the doc with
    // the plugin state that makes the wiki-link menu open.
    expect(contentAreaMocks.openSuggestionMenu).toHaveBeenCalledWith('[[', {
      deleteTriggerCharacter: true
    })
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
        // `#urgent` is a tag now, so it leaves the title and lands on the task.
        title: 'Standalone',
        tags: ['urgent'],
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
