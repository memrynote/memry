import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders as render } from '@tests/utils/render'
import { useSyncExternalStore } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { getDefaultReactSlashMenuItems } from '@blocknote/react'
import { serializeCriticMarkup } from '@memry/shared'
import { WIKI_LINK_EDIT_PLUGIN_KEY } from './wiki-link-edit-plugin'

const contentAreaMocks = vi.hoisted(() => ({
  editor: null as any,
  blockNoteOptions: null as any,
  blocks: new Map<string, any>(),
  suggestionControllers: [] as any[],
  sideMenuControllers: [] as any[],
  pasteSelect: null as
    null | ((option: 'url' | 'mention' | 'embed' | 'bookmark', url: string) => void),
  handleChange: vi.fn(),
  flushPendingMarkdown: vi.fn(async (_deliver?: (markdown: string) => void) => {}),
  retryAI: vi.fn(),
  openSidebarItem: vi.fn(),
  analyzeTaskIntents: vi.fn(),
  editorSettings: {
    isLoading: true,
    settings: { convertChecklistsToTasks: true }
  },
  editorSettingsListeners: new Set<() => void>(),
  tasksService: {
    listProjects: vi.fn(),
    listForItem: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    bulkDelete: vi.fn()
  },
  getTaskSettings: vi.fn(),
  notesService: {
    uploadAttachment: vi.fn(),
    get: vi.fn()
  },
  templatesService: {
    list: vi.fn(),
    get: vi.fn()
  },
  insertTemplateBlocks: vi.fn(),
  fetchLinkPreview: vi.fn(),
  toastError: vi.fn(),
  toast: vi.fn(),
  defaultFileItemClick: vi.fn(),
  pickImageForCell: vi.fn(),
  openSuggestionMenu: vi.fn(),
  registerPlugin: vi.fn(),
  createLinkMentionContent: vi.fn(
    (url: string, domain: string, title?: string, favicon?: string) => ({
      type: 'linkMention',
      props: { url, domain, title, favicon }
    })
  ),
  useSyncState: { status: 'error' },
  editorChanges: [] as unknown[],
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

// The picker itself is covered by `attachment-picker-dialog.test.tsx`; here
// only the routing matters, so it stands in as a probe for which kind was asked
// for. Rendering the real one would reach `listVaultAttachments` over IPC.
vi.mock('./attachment-picker-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachment-picker-dialog')>()),
  AttachmentPickerDialog: ({ kind }: { kind: string }) => (
    <div data-testid="attachment-picker-dialog" data-kind={kind} />
  )
}))

vi.mock('./toolbar-block-type-select', () => ({
  ToolbarBlockTypeSelect: () => <button type="button">block type</button>
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
  // ContentArea pulls the canonical markdown serializer in for the block side
  // menu's "Move to", and that module reaches the custom block specs — so the
  // spec factory has to exist even though no block is rendered here.
  createReactBlockSpec: vi.fn((config: unknown) => ({ config, implementation: {} })),
  useExtensionState: vi.fn(() => undefined),
  SideMenu: () => <div data-testid="side-menu" />,
  SideMenuController: (props: Record<string, unknown>) => {
    contentAreaMocks.sideMenuControllers.push(props)
    return <div data-testid="side-menu-controller" />
  },
  BlockColorsItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RemoveBlockItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  TableHandleMenu: () => <div data-testid="table-handle-menu" />,
  // The keyboard menu's items, for the same reason: it only renders once the
  // caret is measured inside a cell, which needs layout jsdom does not have.
  AddButton: () => <div data-testid="table-add-button" />,
  DeleteButton: () => <div data-testid="table-delete-button" />
}))

vi.mock('sonner', () => ({
  toast: Object.assign(contentAreaMocks.toast, {
    error: contentAreaMocks.toastError,
    success: vi.fn()
  })
}))

vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: ({
    children,
    onChange
  }: {
    children: React.ReactNode
    onChange: (editor: unknown, context: { getChanges: () => unknown[] }) => void
  }) => (
    <div data-testid="blocknote-view">
      <button
        type="button"
        onClick={() => onChange(null, { getChanges: () => contentAreaMocks.editorChanges })}
      >
        change
      </button>
      {/* BlockNote's shape: the id is on the block, the type on its content. */}
      <div data-id="standalone">
        <div data-content-type="checkListItem">checklist target</div>
      </div>
      <div data-id="obsidian-check">
        <div data-content-type="checkListItem">obsidian checklist target</div>
      </div>
      <div data-id="blocked-check">
        <div data-content-type="checkListItem">blocked checklist target</div>
      </div>
      <div data-id="long-tag-check">
        <div data-content-type="checkListItem">long tag checklist target</div>
      </div>
      <div data-id="task-prev">
        <button type="button" data-task-title-trigger="">
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

vi.mock('@/services/templates-service', () => ({
  templatesService: contentAreaMocks.templatesService,
  onTemplateCreated: vi.fn(() => vi.fn()),
  onTemplateUpdated: vi.fn(() => vi.fn()),
  onTemplateDeleted: vi.fn(() => vi.fn())
}))

vi.mock('./insert-template', () => ({
  insertTemplateBlocks: contentAreaMocks.insertTemplateBlocks
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: contentAreaMocks.tasksService,
  // The task prefetch provider re-reads the note's project links whenever a
  // project changes, so the editor mounts a subscription here.
  onProjectUpdated: () => vi.fn()
}))

vi.mock('@/sync/use-yjs-collaboration', () => ({
  useYjsCollaboration: vi.fn(() => contentAreaMocks.yjsState)
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: vi.fn(() => ({ state: contentAreaMocks.useSyncState })),
  // Tolerant by contract: null must read as "no sync information", which keeps
  // the body-sync pending hint out of every test that is not about it.
  useSyncOptional: vi.fn(() => null)
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

// Unread by default: a read setting that is on rescans the note once, and that
// extra analyzer call would take the intents a test queues for its own changes.
vi.mock('@/hooks/use-editor-settings', () => ({
  useEditorSettings: () =>
    useSyncExternalStore(
      (listener) => {
        contentAreaMocks.editorSettingsListeners.add(listener)
        return () => contentAreaMocks.editorSettingsListeners.delete(listener)
      },
      () => contentAreaMocks.editorSettings
    )
}))

vi.mock('./hooks', () => ({
  useBlockNoteSetup: vi.fn(() => ({ aiReady: true })),
  useEditorSync: vi.fn(() => ({
    handleChange: contentAreaMocks.handleChange,
    flushPendingMarkdown: contentAreaMocks.flushPendingMarkdown
  })),
  useWikiLinkSuggestions: vi.fn(() => ({
    getWikiLinkItems: vi.fn(async () => [{ title: 'Wiki' }]),
    handleWikiLinkSelect: vi.fn()
  })),
  useWikiLinkBroken: vi.fn(),
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
  useTableCellImage: vi.fn(() => ({
    pickImageForCell: contentAreaMocks.pickImageForCell
  })),
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
import type * as ScanTaskIntents from './scan-task-intents'
import { markTaskRemovalsHandled } from './task-removal'
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

const OBSIDIAN_LINE = 'Buy milk #Errand 📅 2026-01-01 ⏫ ✅ 2026-01-07 ❌ 2026-01-08'
const OBSIDIAN_SUB_LINE = 'Book flight 📅 2026-01-01 ⏫'
const BLOCKED_LINE = 'Buy milk 🆔 dcf64c 📅 2026-01-01'
const LONG_TAG = '#' + 'a'.repeat(75)
const LONG_TAG_LINE = `Buy milk ${LONG_TAG} 📅 2026-01-01`

function resetEditor(): void {
  contentAreaMocks.blocks = new Map()
  const standalone = createBlock('standalone', {
    type: 'checkListItem',
    content: [{ type: 'text', text: 'Standalone #urgent', styles: {} }]
  })
  createBlock('obsidian-check', {
    type: 'checkListItem',
    content: [{ type: 'text', text: OBSIDIAN_LINE, styles: {} }]
  })
  createBlock('obsidian-sub', {
    type: 'checkListItem',
    content: [{ type: 'text', text: OBSIDIAN_SUB_LINE, styles: {} }]
  })
  createBlock('blocked-check', {
    type: 'checkListItem',
    content: [{ type: 'text', text: BLOCKED_LINE, styles: {} }]
  })
  createBlock('long-tag-check', {
    type: 'checkListItem',
    content: [{ type: 'text', text: LONG_TAG_LINE, styles: {} }]
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
    // Plain text runs only: every checkbox built above is one.
    // `checkbox-task-conversion.test.ts` covers the real serializer.
    blocksToMarkdownLossy: vi.fn(
      ([block]: any[]) => `- [ ] ${block.content.map((c: any) => c.text).join('')}`
    ),
    // `getDiagramSlashMenuItems` only offers its row when the editor's schema
    // actually carries the block, so the stub has to say whether it does. The
    // real schema does (`editor-schema.ts`), and the parity gate in
    // `editor-schema.test.ts` is what proves that; here it only has to be
    // present so the row is built. The empty `dictionary` is what makes the
    // package fall back to its bundled English strings — which ContentArea then
    // relabels with Memry's own, so nothing in this file reads them.
    schema: { blockSchema: { diagram: {} } },
    dictionary: {},
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

// The real analyzer refuses to re-offer a block that was added to
// `dismissedBlocksRef`, and that set is private to ContentArea. Standing in for
// it here is what makes a retry test a retry test: a draft the code dismissed
// on a failed attempt is one this never offers again.
function draftUnlessDismissed(_blocks: unknown, dismissed: Set<string>) {
  return {
    ...emptyIntents(new Set()),
    draftTaskBlock: dismissed.has('draft') ? null : { blockId: 'draft', title: 'Draft title' }
  }
}

function emptyIntents(currentTaskIds = new Set<string>()) {
  return {
    subtaskCandidate: null,
    standaloneCandidate: null,
    plainByContext: [] as string[],
    emptyCheckbox: null,
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
    // The editor scans the content it opened with once on mount, before any
    // `change`. That first call gets empty intents here, so the values a test
    // queues with `mockReturnValueOnce` still land on the changes it fires.
    contentAreaMocks.analyzeTaskIntents
      .mockReset()
      .mockReturnValue(emptyIntents())
      .mockReturnValueOnce(emptyIntents())
    contentAreaMocks.suggestionControllers = []
    contentAreaMocks.sideMenuControllers = []
    contentAreaMocks.pasteSelect = null
    contentAreaMocks.blockNoteOptions = null
    contentAreaMocks.useSyncState = { status: 'error' }
    contentAreaMocks.editorChanges = []
    contentAreaMocks.editorSettings = {
      isLoading: true,
      settings: { convertChecklistsToTasks: true }
    }
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
    contentAreaMocks.tasksService.listForItem.mockResolvedValue([])
    contentAreaMocks.getTaskSettings.mockResolvedValue({ defaultProjectId: null })
    ;(window.api.settings as unknown as Record<string, unknown>).getTaskSettings =
      contentAreaMocks.getTaskSettings
    contentAreaMocks.tasksService.get.mockResolvedValue({
      id: 'parent-task',
      projectId: 'project-1'
    })
    contentAreaMocks.tasksService.create.mockResolvedValue({
      success: true,
      task: { id: 'created-task', title: 'Created task', projectId: 'project-1' }
    })
    contentAreaMocks.tasksService.complete.mockResolvedValue({ success: true })
    contentAreaMocks.tasksService.update.mockResolvedValue({ success: true })
    contentAreaMocks.tasksService.delete.mockResolvedValue({ success: true })
    contentAreaMocks.tasksService.bulkDelete.mockResolvedValue({ success: true, count: 1 })
    contentAreaMocks.notesService.uploadAttachment.mockResolvedValue({
      success: true,
      path: 'attachments/file.png'
    })
    contentAreaMocks.notesService.get.mockResolvedValue({
      id: 'note-1',
      path: 'Notes/My note.md',
      title: 'My note'
    })
    contentAreaMocks.templatesService.list.mockResolvedValue({
      templates: [
        { id: 'meeting', name: 'Meeting Notes', description: 'Agenda and actions', isBuiltIn: true }
      ]
    })
    contentAreaMocks.templatesService.get.mockResolvedValue({
      id: 'meeting',
      name: 'Meeting Notes',
      content: '# {{title}}\n\nAgenda'
    })
    contentAreaMocks.insertTemplateBlocks.mockResolvedValue({ ok: true, insertedBlockIds: ['b1'] })
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
    // Teardown is deferred by a microtask so StrictMode's remount can cancel it,
    // then waits for the markdown flush.
    await waitFor(() => expect(editor._tiptapEditor.destroy).toHaveBeenCalledTimes(1))
    expect(win.ProseMirror).toBeUndefined()
  })

  // The flush lands after the page has unmounted or moved to another note, so
  // the page's live review state is no longer this document's (#1900).
  it("merges a teardown flush with its own review marks, not the page's live review state", async () => {
    const onMarkdownChange = vi.fn()
    const onPlainMarkdownChange = vi.fn((markdown: string) => `live:${markdown}`)
    const marks = [
      { id: 'add-1', kind: 'addition' as const, visibleText: 'Typed', start: 0, end: 5 }
    ]
    contentAreaMocks.flushPendingMarkdown.mockImplementationOnce(async (deliver) => {
      deliver?.('Typed on close')
    })

    const { unmount } = render(
      <ContentArea
        noteId="note-1"
        onMarkdownChange={onMarkdownChange}
        review={{ plainMarkdown: '', marks, hoveredMarkId: null, onPlainMarkdownChange }}
      />
    )
    unmount()

    const expected = serializeCriticMarkup('Typed on close', marks)
    expect(expected).not.toBe('Typed on close')
    await waitFor(() => expect(onMarkdownChange).toHaveBeenCalledWith(expected))
    expect(onPlainMarkdownChange).not.toHaveBeenCalled()
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

  // The note is open on two devices. The checkbox typed on one reaches the
  // other as a Yjs update; converting it there too made two rows for one line,
  // and each side then deleted the id Yjs dropped, so both rows were lost.
  it('leaves a checkbox that arrived from another device to the device that typed it', async () => {
    const remoteRef = { current: false }
    contentAreaMocks.yjsState = { ...contentAreaMocks.yjsState, isRemoteUpdateRef: remoteRef }
    contentAreaMocks.analyzeTaskIntents.mockImplementation(() =>
      emptyIntents(new Set(['existing-task']))
    )
    render(<ContentArea noteId="note-1" />)
    contentAreaMocks.analyzeTaskIntents.mockClear()
    contentAreaMocks.analyzeTaskIntents.mockImplementation(() => emptyIntents(new Set()))

    remoteRef.current = true
    contentAreaMocks.editorChanges = [
      { type: 'insert', block: { id: 'remote-check' } },
      { type: 'update', block: { id: 'remote-draft' } }
    ]
    fireEvent.click(screen.getByText('change'))
    remoteRef.current = false

    // A local edit elsewhere must not pick the remote blocks up either.
    contentAreaMocks.editorChanges = [{ type: 'update', block: { id: 'local-para' } }]
    fireEvent.click(screen.getByText('change'))

    const exclusions = contentAreaMocks.analyzeTaskIntents.mock.calls.at(-1)?.[1] as Set<string>
    expect(exclusions.has('remote-check')).toBe(true)
    expect(exclusions.has('remote-draft')).toBe(true)
    // The remote pass moved the baseline, so the local pass deletes nothing.
    expect(contentAreaMocks.tasksService.delete).not.toHaveBeenCalled()

    // Editing the block here makes it this device's to convert.
    contentAreaMocks.editorChanges = [{ type: 'update', block: { id: 'remote-check' } }]
    fireEvent.click(screen.getByText('change'))
    const reclaimed = contentAreaMocks.analyzeTaskIntents.mock.calls.at(-1)?.[1] as Set<string>
    expect(reclaimed.has('remote-check')).toBe(false)
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
  })

  it('converts task intents and asks about deleted task blocks on editor changes', async () => {
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
    // The block is gone; the task is asked about, never deleted on the spot.
    const dialog = await screen.findByTestId('task-removal-dialog')
    expect(contentAreaMocks.tasksService.delete).not.toHaveBeenCalled()
    expect(contentAreaMocks.tasksService.bulkDelete).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    await waitFor(() =>
      expect(contentAreaMocks.tasksService.bulkDelete).toHaveBeenCalledWith(['existing-task'])
    )
    await waitFor(() => expect(screen.queryByTestId('task-removal-dialog')).toBeNull())
    // Closing after delete must not also run keep.
    expect(contentAreaMocks.tasksService.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-task' })
    )
  })

  describe('plain checkboxes', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    // One conversion through the immediate (subtask) path, so the tests do not
    // wait out the standalone debounce. `created-task` lands on `sub-check`.
    async function convertSubCheck(): Promise<void> {
      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'sub-check', parentTaskId: 'parent-task' }
      })
      fireEvent.click(screen.getByText('change'))
      await waitFor(() =>
        expect(contentAreaMocks.blocks.get('sub-check').props.taskId).toBe('created-task')
      )
      // The id is on the block now: the next change takes it as the baseline.
      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce(
        emptyIntents(new Set(['created-task']))
      )
      fireEvent.click(screen.getByText('change'))
    }

    it('makes a checkbox that continues a plain list plain, off the undo stack', () => {
      const meta = vi.fn()
      contentAreaMocks.editor.transact = vi.fn((fn: (tr: unknown) => void) => fn({ setMeta: meta }))
      render(<ContentArea noteId="note-1" />)

      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce({
        ...emptyIntents(),
        plainByContext: ['standalone']
      })
      fireEvent.click(screen.getByText('change'))

      expect(meta).toHaveBeenCalledWith('addToHistory', false)
      expect(contentAreaMocks.blocks.get('standalone').props.plain).toBe(true)
      // Blocks the note opened with are named, so the analyzer converts those
      // rather than continuing a plain list with them.
      const options = contentAreaMocks.analyzeTaskIntents.mock.calls.at(-1)?.[2]
      expect([...options.openedBlockIds]).toEqual(
        expect.arrayContaining(['standalone', 'sub-check', 'para'])
      )
      expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    })

    it('undoing a conversion leaves a plain checkbox and deletes the task, without asking', async () => {
      render(<ContentArea noteId="note-1" />)
      await convertSubCheck()

      // Undo: the checkbox is back where the task block was.
      const block = contentAreaMocks.blocks.get('sub-check')
      block.type = 'checkListItem'
      block.props = { checked: false }
      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce(emptyIntents(new Set()))
      fireEvent.click(screen.getByText('change'))

      expect(block.props.plain).toBe(true)
      await waitFor(() =>
        expect(contentAreaMocks.tasksService.delete).toHaveBeenCalledWith('created-task')
      )
      expect(screen.queryByTestId('task-removal-dialog')).toBeNull()
    })

    it('deletes the task when the conversion is undone before the row exists', async () => {
      let resolveCreate: (value: unknown) => void = () => {}
      contentAreaMocks.tasksService.create.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCreate = resolve
        })
      )
      render(<ContentArea noteId="note-1" />)
      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'sub-check', parentTaskId: 'parent-task' }
      })
      fireEvent.click(screen.getByText('change'))
      await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())

      const block = contentAreaMocks.blocks.get('sub-check')
      block.type = 'checkListItem'
      block.props = { checked: false }
      resolveCreate({ success: true, task: { id: 'late-task', title: 'Sub task' } })

      await waitFor(() =>
        expect(contentAreaMocks.tasksService.delete).toHaveBeenCalledWith('late-task')
      )
      expect(block.type).toBe('checkListItem')
      expect(block.props.plain).toBe(true)
    })

    it('says once, on the first conversion, how to keep a checkbox', async () => {
      render(<ContentArea noteId="note-1" />)
      await convertSubCheck()

      expect(contentAreaMocks.toast).toHaveBeenCalledTimes(1)
      const [message, options] = contentAreaMocks.toast.mock.calls[0]
      expect(message).toBe('Checkbox turned into a task')

      // Its action is the undo, from a button.
      act(() => options.action.onClick())
      const block = contentAreaMocks.blocks.get('sub-check')
      expect(block.type).toBe('checkListItem')
      expect(block.props.plain).toBe(true)
      await waitFor(() =>
        expect(contentAreaMocks.tasksService.delete).toHaveBeenCalledWith('created-task')
      )

      // And the removal that follows is not asked about.
      contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce(emptyIntents(new Set()))
      fireEvent.click(screen.getByText('change'))
      expect(screen.queryByTestId('task-removal-dialog')).toBeNull()

      // A second conversion says nothing.
      contentAreaMocks.toast.mockClear()
      contentAreaMocks.blocks.get('sub-check').props.taskId = ''
      contentAreaMocks.blocks.get('sub-check').type = 'checkListItem'
      await convertSubCheck()
      expect(contentAreaMocks.toast).not.toHaveBeenCalled()
    })
  })

  describe('a task block leaving the note', () => {
    function removeExistingTaskOnNextChange(): void {
      contentAreaMocks.analyzeTaskIntents
        .mockReturnValueOnce(emptyIntents(new Set(['existing-task'])))
        .mockReturnValueOnce(emptyIntents(new Set()))
        .mockReturnValue(emptyIntents(new Set()))
      contentAreaMocks.tasksService.get.mockResolvedValue({
        id: 'existing-task',
        linkedNoteIds: ['note-1', 'other-note']
      })
    }

    it('keeps the task and drops this note from its links when the user keeps it', async () => {
      removeExistingTaskOnNextChange()
      render(<ContentArea noteId="note-1" />)

      fireEvent.click(screen.getByText('change'))
      fireEvent.click(screen.getByText('change'))
      const dialog = await screen.findByTestId('task-removal-dialog')
      expect(within(dialog).getByText('Task removed from this note')).toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep in Tasks' }))
      await waitFor(() =>
        expect(contentAreaMocks.tasksService.update).toHaveBeenCalledWith({
          id: 'existing-task',
          linkedNoteIds: ['other-note']
        })
      )
      expect(contentAreaMocks.tasksService.bulkDelete).not.toHaveBeenCalled()
      expect(contentAreaMocks.tasksService.delete).not.toHaveBeenCalled()
    })

    it('links the note again when undo brings a kept task back', async () => {
      contentAreaMocks.analyzeTaskIntents
        .mockReturnValueOnce(emptyIntents(new Set(['existing-task'])))
        .mockReturnValueOnce(emptyIntents(new Set()))
        .mockReturnValueOnce(emptyIntents(new Set(['existing-task'])))
        .mockReturnValue(emptyIntents(new Set(['existing-task'])))
      contentAreaMocks.tasksService.get
        .mockResolvedValueOnce({ id: 'existing-task', linkedNoteIds: ['note-1'] })
        .mockResolvedValue({ id: 'existing-task', linkedNoteIds: [] })
      render(<ContentArea noteId="note-1" />)

      fireEvent.click(screen.getByText('change'))
      fireEvent.click(screen.getByText('change'))
      const dialog = await screen.findByTestId('task-removal-dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep in Tasks' }))
      await waitFor(() =>
        expect(contentAreaMocks.tasksService.update).toHaveBeenCalledWith({
          id: 'existing-task',
          linkedNoteIds: []
        })
      )

      fireEvent.click(screen.getByText('change'))
      await waitFor(() =>
        expect(contentAreaMocks.tasksService.update).toHaveBeenLastCalledWith({
          id: 'existing-task',
          linkedNoteIds: ['note-1']
        })
      )
    })

    it('treats a cut as a move: no prompt, no delete, the note unlinked', async () => {
      removeExistingTaskOnNextChange()
      render(<ContentArea noteId="note-1" />)

      fireEvent.click(screen.getByText('change'))
      fireEvent.cut(screen.getByTestId('blocknote-view'))
      fireEvent.click(screen.getByText('change'))

      await waitFor(() =>
        expect(contentAreaMocks.tasksService.update).toHaveBeenCalledWith({
          id: 'existing-task',
          linkedNoteIds: ['other-note']
        })
      )
      expect(screen.queryByTestId('task-removal-dialog')).toBeNull()
      expect(contentAreaMocks.tasksService.delete).not.toHaveBeenCalled()
    })

    it('stays out of a removal the task renderer already handled', async () => {
      removeExistingTaskOnNextChange()
      render(<ContentArea noteId="note-1" />)

      fireEvent.click(screen.getByText('change'))
      markTaskRemovalsHandled(contentAreaMocks.editor, ['existing-task'])
      fireEvent.click(screen.getByText('change'))

      await act(async () => {})
      expect(screen.queryByTestId('task-removal-dialog')).toBeNull()
      expect(contentAreaMocks.tasksService.update).not.toHaveBeenCalled()
      expect(contentAreaMocks.tasksService.bulkDelete).not.toHaveBeenCalled()
    })
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

  // #2161: there is no "existing attachment" command any more. Every command
  // that wants a file opens the one picker, which offers upload AND the vault's
  // own files, narrowed to the kind the command named. Running BlockNote's own
  // file item instead would reach the upload-only panel and hide the vault.
  it.each([
    ['pdf', 'pdf', 'pdf'],
    ['media', 'media', 'media'],
    ['image', 'image', 'image'],
    ['file', 'file', 'file']
  ])('routes /%s to the attachment picker, narrowed to %s', async (query, key, kind) => {
    render(<ContentArea noteId="note-1" />)

    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const items = await slashController.getItems(query)
    const item = items.find((candidate: { key?: string }) => candidate.key === key)
    expect(item).toBeDefined()

    await act(async () => {
      item.onItemClick()
    })

    expect(contentAreaMocks.defaultFileItemClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachment-picker-dialog')).toHaveAttribute('data-kind', kind)
  })

  it('keeps /photo on the image item rather than splitting it across two rows', async () => {
    render(<ContentArea noteId="note-1" />)

    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    await expect(slashController.getItems('photo')).resolves.toEqual([
      expect.objectContaining({ key: 'image' })
    ])
  })

  it('swaps the Image slash item for the in-cell picker while the caret is in a cell', async () => {
    // #given a caret inside a table cell. BlockNote's own Image item inserts a
    // BLOCK, which a cell cannot hold: it lands after the whole table and takes
    // the caret with it, leaving the cell empty (#1640).
    contentAreaMocks.editor.transact = (run: (tr: unknown) => unknown) =>
      run({
        selection: {
          $from: {
            depth: 3,
            node: (depth: number) => ({
              type: { name: ['table', 'tableRow', 'tableCell'][depth - 1] }
            })
          }
        }
      })
    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    // #when
    const [imageItem] = await slashController.getItems('image')

    // #then the same row, relabelled by nothing — it just picks a file and
    // inserts the inline node instead of a block
    expect(imageItem).toMatchObject({ key: 'image', title: 'Image' })
    imageItem.onItemClick()
    expect(contentAreaMocks.pickImageForCell).toHaveBeenCalledTimes(1)
  })

  it('leaves the Image slash item alone outside a table cell', async () => {
    // #given the ordinary case — the block image, with its caption and resize
    // handle, is the right answer everywhere else
    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    // #when
    const [imageItem] = await slashController.getItems('image')

    // #then
    imageItem.onItemClick?.()
    expect(contentAreaMocks.pickImageForCell).not.toHaveBeenCalled()
  })

  it('makes a plain checkbox from the Check List row, outside a table cell', async () => {
    vi.mocked(getDefaultReactSlashMenuItems).mockReturnValueOnce([
      { key: 'check_list', title: 'Check List', group: 'Basic blocks', onItemClick: vi.fn() }
    ] as never)
    const empty = createBlock('empty-line', { content: [] })
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: empty })
    contentAreaMocks.editor.setTextCursorPosition = vi.fn()
    contentAreaMocks.editor.schema = {
      blockSchema: { diagram: {}, paragraph: { content: 'inline' } }
    }
    // BlockNote's helper reads the updated block back to place the caret.
    contentAreaMocks.editor.updateBlock.mockImplementationOnce(
      (block: any, update: Record<string, unknown>) => ({ ...block, ...update })
    )

    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const [checkList] = await slashController.getItems('check')
    checkList.onItemClick()

    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(empty, {
      type: 'checkListItem',
      props: { plain: true }
    })
  })

  it('asks for a size before /table inserts anything, then inserts that size', async () => {
    // #given an empty line, and BlockNote's own `/table` row, which would
    // insert a fixed 2x3 table straight away
    const defaultTableClick = vi.fn()
    vi.mocked(getDefaultReactSlashMenuItems).mockReturnValueOnce([
      { key: 'table', title: 'Table', group: 'Basic blocks', onItemClick: defaultTableClick }
    ] as never)
    const empty = createBlock('empty-line', { content: [] })
    contentAreaMocks.editor.getTextCursorPosition.mockReturnValue({ block: empty })
    contentAreaMocks.editor.setTextCursorPosition = vi.fn()
    contentAreaMocks.editor.focus = vi.fn()
    // BlockNote's helper reads the caret block's content kind to place the caret.
    contentAreaMocks.editor.schema = {
      blockSchema: { diagram: {}, paragraph: { content: 'inline' }, table: { content: 'table' } }
    }
    contentAreaMocks.editor.updateBlock.mockImplementationOnce(
      (block: any, update: Record<string, unknown>) => ({ ...block, ...update })
    )
    const tiptap = contentAreaMocks.editor._tiptapEditor as Record<string, unknown>
    const caretView = {
      state: { selection: { from: 1 } },
      coordsAtPos: vi.fn(() => ({ left: 10, right: 10, top: 20, bottom: 36 })),
      // `TableBorderHandles` reads the same view; no table here.
      domAtPos: vi.fn(() => ({ node: document.body, offset: 0 }))
    }
    tiptap.editorView = caretView
    tiptap.view = caretView

    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const [tableItem] = await slashController.getItems('table')

    // #when the row is picked
    act(() => tableItem.onItemClick())

    // #then the grid is up and nothing is inserted yet
    const grid = await screen.findByRole('application', { name: /table size/i })
    expect(defaultTableClick).not.toHaveBeenCalled()
    expect(contentAreaMocks.editor.updateBlock).not.toHaveBeenCalled()

    // #when a 4-row, 2-column size is chosen from the keyboard
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    fireEvent.keyDown(grid, { key: 'ArrowLeft' })
    fireEvent.keyDown(grid, { key: 'Enter' })

    // #then that table replaces the empty line, header row included, because
    // markdown is going to give it one anyway
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(empty, {
      type: 'table',
      content: {
        type: 'tableContent',
        headerRows: 1,
        rows: Array.from({ length: 4 }, () => ({ cells: ['', ''] }))
      }
    })
    expect(screen.queryByRole('application', { name: /table size/i })).not.toBeInTheDocument()
  })

  it('closes the /table size grid on Escape with nothing inserted', async () => {
    vi.mocked(getDefaultReactSlashMenuItems).mockReturnValueOnce([
      { key: 'table', title: 'Table', group: 'Basic blocks', onItemClick: vi.fn() }
    ] as never)
    contentAreaMocks.editor.focus = vi.fn()
    const tiptap = contentAreaMocks.editor._tiptapEditor as Record<string, unknown>
    const caretView = {
      state: { selection: { from: 1 } },
      coordsAtPos: vi.fn(() => ({ left: 10, right: 10, top: 20, bottom: 36 })),
      domAtPos: vi.fn(() => ({ node: document.body, offset: 0 }))
    }
    tiptap.editorView = caretView
    tiptap.view = caretView

    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )
    const [tableItem] = await slashController.getItems('table')
    act(() => tableItem.onItemClick())
    const grid = await screen.findByRole('application', { name: /table size/i })

    fireEvent.keyDown(grid, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('application', { name: /table size/i })).not.toBeInTheDocument()
    )
    expect(contentAreaMocks.editor.focus).toHaveBeenCalled()
    expect(contentAreaMocks.editor.updateBlock).not.toHaveBeenCalled()
  })

  it('offers the diagram row under /mermaid, in Memry’s words', async () => {
    // #given the row comes from `@blocknote/diagram-block`, which carries the
    // aliases (mermaid, flowchart, chart, graph) and the insert; only the two
    // strings a reader sees are Memry's, because the package's dictionary is
    // English-only and the rest of this menu is translated.
    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    // #when the word the issue named, which is an ALIAS — the title is "Diagram"
    const items = await slashController.getItems('mermaid')

    // #then
    expect(items).toEqual([
      expect.objectContaining({
        title: 'Diagram',
        subtext: 'Flowchart, sequence or Gantt chart from Mermaid source'
      })
    ])
  })

  it('drops the diagram row while the caret is in a table cell', async () => {
    // #given a caret inside a cell. A diagram is a BLOCK, so BlockNote lands it
    // after the whole table and takes the caret with it (#1640) — and unlike
    // image and check there is no inline form to offer instead.
    contentAreaMocks.editor.transact = (run: (tr: unknown) => unknown) =>
      run({
        selection: {
          $from: {
            depth: 3,
            node: (depth: number) => ({
              type: { name: ['table', 'tableRow', 'tableCell'][depth - 1] }
            })
          }
        }
      })
    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    // #when / #then
    expect(await slashController.getItems('mermaid')).toEqual([])
  })

  it('offers the view row under /view, and not in a table cell', async () => {
    // #given
    render(<ContentArea noteId="note-1" />)
    const slashController = contentAreaMocks.suggestionControllers.find(
      (controller) => controller.triggerCharacter === '/'
    )

    // #when / #then an alias finds it too
    expect(await slashController.getItems('database')).toEqual([
      expect.objectContaining({
        title: 'View',
        subtext: 'A live list of notes from a folder, a tag or the whole vault'
      })
    ])

    // #given a caret inside a cell: a view is a block (#1640)
    contentAreaMocks.editor.transact = (run: (tr: unknown) => unknown) =>
      run({
        selection: {
          $from: {
            depth: 3,
            node: (depth: number) => ({
              type: { name: ['table', 'tableRow', 'tableCell'][depth - 1] }
            })
          }
        }
      })

    // #then
    expect(await slashController.getItems('database')).toEqual([])
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

  const latestSlashController = (): any => {
    const controllers = contentAreaMocks.suggestionControllers.filter(
      (candidate) => candidate.triggerCharacter === '/'
    )
    return controllers[controllers.length - 1]
  }

  const slashItems = async (query: string): Promise<any[]> =>
    latestSlashController().getItems(query)

  const templateRowTitles = async (query: string): Promise<string[]> =>
    (await slashItems(query)).filter((item) => item.group === 'Templates').map((item) => item.title)

  it('keeps the per-template rows out of the cold menu and offers one row to open the picker', async () => {
    render(<ContentArea noteId="note-1" />)
    await waitFor(async () => expect(await templateRowTitles('meeting')).toEqual(['Meeting Notes']))

    const cold = await slashItems('')

    expect(cold).toContainEqual(expect.objectContaining({ title: 'Insert template content…' }))
    expect(cold.some((item) => item.group === 'Templates')).toBe(false)
  })

  it('describes each per-template row with the template it inserts', async () => {
    render(<ContentArea noteId="note-1" />)

    await waitFor(async () =>
      expect(await slashItems('meeting')).toEqual([
        expect.objectContaining({
          title: 'Meeting Notes',
          group: 'Templates',
          subtext: 'Agenda and actions'
        })
      ])
    )
  })

  it('inserts the template named by its own row at the block the caret was on', async () => {
    render(<ContentArea noteId="note-1" />)
    await waitFor(async () => expect(await templateRowTitles('meeting')).toEqual(['Meeting Notes']))

    const [row] = await slashItems('meeting')
    await act(async () => {
      row.onItemClick()
    })

    await waitFor(() =>
      expect(contentAreaMocks.insertTemplateBlocks).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '# {{title}}\n\nAgenda',
          noteTitle: 'My note',
          notePath: 'Notes/My note.md',
          referenceBlockId: 'url-block',
          placement: 'replace-if-empty'
        })
      )
    )
  })

  it('opens the picker from the slash row and inserts the template it returns', async () => {
    contentAreaMocks.templatesService.list.mockResolvedValue({
      templates: [{ id: 'review', name: 'Weekly Review', isBuiltIn: false }]
    })
    contentAreaMocks.templatesService.get.mockResolvedValue({
      id: 'review',
      name: 'Weekly Review',
      content: 'Wins'
    })
    render(<ContentArea noteId="note-1" />)
    await waitFor(() => expect(contentAreaMocks.templatesService.list).toHaveBeenCalled())

    const [row] = (await slashItems('')).filter((item) => item.title === 'Insert template content…')
    await act(async () => {
      row.onItemClick()
    })
    fireEvent.click(await screen.findByText('Weekly Review'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Apply Template/i }))
    })

    await waitFor(() =>
      expect(contentAreaMocks.insertTemplateBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Wins', referenceBlockId: 'url-block' })
      )
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the picker without inserting when it is dismissed', async () => {
    render(<ContentArea noteId="note-1" />)
    await waitFor(() => expect(contentAreaMocks.templatesService.list).toHaveBeenCalled())

    const [row] = (await slashItems('')).filter((item) => item.title === 'Insert template content…')
    await act(async () => {
      row.onItemClick()
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Cancel/i }))
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(contentAreaMocks.insertTemplateBlocks).not.toHaveBeenCalled()
  })

  it('reports a template that cannot be read, inserts nothing, and keeps the note intact', async () => {
    contentAreaMocks.templatesService.get.mockResolvedValue(null)
    render(<ContentArea noteId="note-1" />)
    await waitFor(async () => expect(await templateRowTitles('meeting')).toEqual(['Meeting Notes']))

    const [row] = await slashItems('meeting')
    await act(async () => {
      row.onItemClick()
    })

    await waitFor(() => expect(contentAreaMocks.toastError).toHaveBeenCalled())
    expect(contentAreaMocks.insertTemplateBlocks).not.toHaveBeenCalled()
  })

  it('reports a template whose body has nothing to insert', async () => {
    contentAreaMocks.insertTemplateBlocks.mockResolvedValue({ ok: false, reason: 'empty' })
    render(<ContentArea noteId="note-1" />)
    await waitFor(async () => expect(await templateRowTitles('meeting')).toEqual(['Meeting Notes']))

    const [row] = await slashItems('meeting')
    await act(async () => {
      row.onItemClick()
    })

    await waitFor(() => expect(contentAreaMocks.toastError).toHaveBeenCalled())
  })

  it('reports an insert that throws instead of leaving the caret in a half-applied note', async () => {
    contentAreaMocks.insertTemplateBlocks.mockRejectedValue(new Error('parse blew up'))
    render(<ContentArea noteId="note-1" />)
    await waitFor(async () => expect(await templateRowTitles('meeting')).toEqual(['Meeting Notes']))

    const [row] = await slashItems('meeting')
    await act(async () => {
      row.onItemClick()
    })

    await waitFor(() => expect(contentAreaMocks.toastError).toHaveBeenCalled())
  })

  it('opens the template picker at the caret when the note menu asks for it', async () => {
    const openTemplateInsert = { current: null } as React.RefObject<(() => void) | null>
    render(<ContentArea noteId="note-1" openTemplateInsertRef={openTemplateInsert} />)
    await waitFor(() => expect(openTemplateInsert.current).toBeTypeOf('function'))

    await act(async () => {
      openTemplateInsert.current?.()
    })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(contentAreaMocks.editor.getTextCursorPosition).toHaveBeenCalled()
  })

  it('still opens the picker when the editor has no text cursor to read', async () => {
    // The menu is reachable without ever putting a caret in the body. With no
    // cursor, the last block anchors the insert instead of the call throwing.
    contentAreaMocks.editor.getTextCursorPosition.mockImplementation(() => {
      throw new Error('no text cursor')
    })
    const openTemplateInsert = { current: null } as React.RefObject<(() => void) | null>
    render(<ContentArea noteId="note-1" openTemplateInsertRef={openTemplateInsert} />)
    await waitFor(() => expect(openTemplateInsert.current).toBeTypeOf('function'))

    await act(async () => {
      openTemplateInsert.current?.()
    })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('hides both template surfaces while the caret is in a table cell', async () => {
    // A template is a block insert, and a cell cannot hold one: it lands after
    // the whole table and takes the caret with it (#1640).
    contentAreaMocks.editor.transact = (run: (tr: unknown) => unknown) =>
      run({
        selection: {
          $from: {
            depth: 3,
            node: (depth: number) => ({
              type: { name: ['table', 'tableRow', 'tableCell'][depth - 1] }
            })
          }
        }
      })
    render(<ContentArea noteId="note-1" />)
    await waitFor(() => expect(contentAreaMocks.templatesService.list).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    const cold = await slashItems('')
    expect(cold.some((item) => item.title === 'Insert template content…')).toBe(false)
    await expect(slashItems('meeting')).resolves.toEqual([])
  })

  it('converts a standalone checkbox in the same change, without a debounce', async () => {
    contentAreaMocks.analyzeTaskIntents.mockReturnValueOnce({
      ...emptyIntents(new Set()),
      standaloneCandidate: { blockId: 'standalone' }
    })

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    // The block is rewritten to a taskBlock synchronously, so the plain
    // checkbox never paints.
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'taskBlock' })
    )

    await waitFor(() =>
      expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // `#urgent` is a tag now, so it leaves the title and lands on the task.
          title: 'Standalone',
          tags: ['urgent'],
          linkedNoteIds: ['note-1']
        })
      )
    )
  })

  // y-prosemirror renders the Y.Doc into the view while it mounts, before
  // BlockNoteView subscribes `onChange`, so the content a note opens with never
  // produces a change. An Obsidian Tasks line in a file written outside Memry
  // is exactly that content.
  it('converts a checkbox the note opened with, without waiting for a change', async () => {
    vi.useFakeTimers()
    contentAreaMocks.analyzeTaskIntents.mockReset().mockReturnValue({
      ...emptyIntents(new Set()),
      standaloneCandidate: { blockId: 'standalone' }
    })

    render(<ContentArea noteId="note-1" />)

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Standalone', linkedNoteIds: ['note-1'] })
    )
  })

  it('imports an Obsidian Tasks checkbox into the task it describes', async () => {
    vi.useFakeTimers()
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-check' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-check' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-check' }
      })

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Buy milk',
        priority: 3,
        dueDate: '2026-01-01',
        // The cancelled date has no column, so the whole line is kept.
        description: OBSIDIAN_LINE,
        tags: ['Errand']
      })
    )
    expect(contentAreaMocks.tasksService.complete).toHaveBeenCalledWith({
      id: 'created-task',
      // The plugin wrote a calendar date, so the instant is local midnight on it.
      completedAt: new Date(2026, 0, 7).toISOString()
    })
    // The plugin fields left the block, so the markdown line the `{task:<id>}`
    // suffix lands on is the description alone.
    expect(contentAreaMocks.blocks.get('obsidian-check').props.title).toBe('Buy milk #Errand')
  })

  it('creates a converted checkbox in the project the note belongs to (#2271)', async () => {
    // #given a note linked to a project that is not the inbox
    contentAreaMocks.tasksService.listProjects.mockResolvedValue({
      projects: [
        { id: 'project-1', name: 'Inbox', isDefault: true, isArchived: false },
        { id: 'project-2', name: 'Work', isDefault: false, isArchived: false }
      ]
    })
    contentAreaMocks.tasksService.listForItem.mockResolvedValue([{ id: 'project-2', name: 'Work' }])
    contentAreaMocks.getTaskSettings.mockResolvedValue({ defaultProjectId: 'project-1' })

    render(<ContentArea noteId="note-1" />)

    // #when a checklist line in it is converted to a task
    fireEvent.contextMenu(screen.getByText('checklist target'))

    // #then the note's project wins over the settings default and the inbox
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())
    expect(contentAreaMocks.tasksService.listForItem).toHaveBeenCalledWith('note', 'note-1')
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-2' })
    )
  })

  it('refuses a line the plugin needs intact, however the conversion is asked for', async () => {
    // The analyzer refuses this line, but the context menu reaches the
    // converter directly. Converting it drops the id another note's ⛔ names.
    render(<ContentArea noteId="note-1" />)

    fireEvent.contextMenu(screen.getByText('blocked checklist target'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(contentAreaMocks.blocks.get('blocked-check').type).toBe('checkListItem')
    expect(contentAreaMocks.blocks.get('blocked-check').content).toEqual([
      { type: 'text', text: BLOCKED_LINE, styles: {} }
    ])
    expect(contentAreaMocks.toastError).toHaveBeenCalled()
  })

  describe('with checklist conversion switched off', () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof ScanTaskIntents>('./scan-task-intents')
      contentAreaMocks.analyzeTaskIntents.mockReset().mockImplementation(actual.analyzeTaskIntents)
      setDocument([contentAreaMocks.blocks.get('standalone')])
      contentAreaMocks.editorSettings = {
        isLoading: false,
        settings: { convertChecklistsToTasks: false }
      }
    })

    it('keeps a checklist item a checkbox, and converts it once the setting is on', async () => {
      render(<ContentArea noteId="note-1" />)
      fireEvent.click(screen.getByText('change'))
      await act(async () => {
        await Promise.resolve()
      })

      expect(contentAreaMocks.blocks.get('standalone').type).toBe('checkListItem')
      expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()

      act(() => {
        contentAreaMocks.editorSettings = {
          isLoading: false,
          settings: { convertChecklistsToTasks: true }
        }
        for (const listener of contentAreaMocks.editorSettingsListeners) listener()
      })

      await waitFor(() =>
        expect(contentAreaMocks.blocks.get('standalone').props.taskId).toBe('created-task')
      )
      expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Standalone', tags: ['urgent'] })
      )
    })

    it('does not convert before the setting is read', async () => {
      contentAreaMocks.editorSettings = {
        isLoading: true,
        settings: { convertChecklistsToTasks: true }
      }
      render(<ContentArea noteId="note-1" />)
      await act(async () => {
        await Promise.resolve()
      })

      expect(contentAreaMocks.blocks.get('standalone').type).toBe('checkListItem')
      expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    })

    it('still converts a checkbox by right-click', async () => {
      render(<ContentArea noteId="note-1" />)

      fireEvent.contextMenu(screen.getByText('checklist target'))

      await waitFor(() =>
        expect(contentAreaMocks.blocks.get('standalone').props.taskId).toBe('created-task')
      )
    })
  })

  // The template editor mounts this way (#2331): a checkbox in a template is
  // not a task, and a right-click must not mint one either.
  it('leaves a right-clicked checkbox alone in an editor that runs no side effects', async () => {
    render(<ContentArea runSideEffects={false} />)

    fireEvent.contextMenu(screen.getByText('checklist target'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(contentAreaMocks.blocks.get('standalone').type).toBe('checkListItem')
  })

  it('ticks the box for a line the plugin had already marked done', async () => {
    render(<ContentArea noteId="note-1" />)

    fireEvent.contextMenu(screen.getByText('obsidian checklist target'))
    await waitFor(() => expect(contentAreaMocks.tasksService.complete).toHaveBeenCalled())

    // `- [ ] Buy milk {task:id}` against a non-null completedAt is exactly what
    // the markdown reconciler undoes on the next save of the note.
    await waitFor(() =>
      expect(contentAreaMocks.blocks.get('obsidian-check').props.checked).toBe(true)
    )
  })

  it('keeps the block wired to its task when the completion call is rejected', async () => {
    contentAreaMocks.tasksService.complete.mockRejectedValue(new Error('rejected'))

    render(<ContentArea noteId="note-1" />)

    fireEvent.contextMenu(screen.getByText('obsidian checklist target'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())

    // The row exists. A block left on `taskId: ''` renders a task nothing on
    // disk or in the database can ever find again.
    await waitFor(() =>
      expect(contentAreaMocks.blocks.get('obsidian-check').props.taskId).toBe('created-task')
    )
  })

  it('drops a tag longer than the task contract takes', async () => {
    render(<ContentArea noteId="note-1" />)

    fireEvent.contextMenu(screen.getByText('long tag checklist target'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())

    const { tags } = contentAreaMocks.tasksService.create.mock.calls[0][0]
    // `TaskCreateSchema` caps a tag at 50 characters and the list at 20. An
    // over-long tag rejects the whole create, so the task never arrives.
    expect(tags).toEqual([])
  })

  it('lifts the plugin fields off a nested line as well as a top-level one', async () => {
    contentAreaMocks.analyzeTaskIntents.mockReturnValue({
      ...emptyIntents(new Set()),
      subtaskCandidate: { blockId: 'obsidian-sub', parentTaskId: 'parent-task' }
    })

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'parent-task',
        title: 'Book flight',
        priority: 3,
        dueDate: '2026-01-01',
        description: OBSIDIAN_SUB_LINE
      })
    )
    // Left on the block, the due date would be serialized behind Memry's
    // suffix, where the plugin's end-anchored regex can no longer see it.
    expect(contentAreaMocks.blocks.get('obsidian-sub').props.title).toBe('Book flight')
  })

  // #1907 — `convertCheckboxToTask` rewrites the checkbox to a `taskBlock`
  // with `taskId: ''` before the row exists. If the create never lands, the
  // block used to keep that shape forever: a task-looking row whose every
  // control early-returns on the empty id. A checkbox Memry has no row for
  // must stay a checkbox.
  it('reverts a checkbox to a checklist item when the task create fails', async () => {
    vi.useFakeTimers()
    const obsidian = createBlock('obsidian-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk 2026-09-01', styles: {} }]
    })
    contentAreaMocks.tasksService.create.mockResolvedValue({
      success: false,
      error: 'Task not found'
    })
    // Twice: once for the onChange that schedules, once for the re-scan the
    // debounce timer runs before it converts.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalled()
    expect(obsidian.type).toBe('checkListItem')
    expect(obsidian.content).toEqual([{ type: 'text', text: 'Buy milk 2026-09-01', styles: {} }])
  })

  it('reverts a checkbox to a checklist item when there is no project to create into', async () => {
    vi.useFakeTimers()
    const obsidian = createBlock('obsidian-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.listProjects.mockResolvedValue({ projects: [] })
    // Twice: once for the onChange that schedules, once for the re-scan the
    // debounce timer runs before it converts.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.listProjects).toHaveBeenCalled()
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(obsidian.type).toBe('checkListItem')
    expect(obsidian.content).toEqual([{ type: 'text', text: 'Buy milk', styles: {} }])
  })

  it('reverts a checkbox to a checklist item when the project lookup rejects', async () => {
    vi.useFakeTimers()
    const obsidian = createBlock('obsidian-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.listProjects.mockRejectedValue(new Error('no vault open'))
    // Twice: once for the onChange that schedules, once for the re-scan the
    // debounce timer runs before it converts.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'obsidian-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.listProjects).toHaveBeenCalled()
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(obsidian.type).toBe('checkListItem')
    expect(obsidian.content).toEqual([{ type: 'text', text: 'Buy milk', styles: {} }])
  })

  // The nested path carries the same #1907 rule. `convertCheckboxToSubtask`
  // also writes `taskId: ''` up front, so each of its three failure exits has
  // to put the checkbox back. Unlike the standalone path it is not debounced,
  // so these run on real timers.
  it('reverts a nested checkbox to a checklist item when the parent task is gone', async () => {
    const nested = createBlock('nested-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.get.mockResolvedValue(null)
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'nested-line', parentTaskId: 'parent-task' }
      })
      .mockReturnValue(emptyIntents(new Set()))

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await waitFor(() =>
      expect(contentAreaMocks.tasksService.get).toHaveBeenCalledWith('parent-task')
    )
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nested-line' }),
      expect.objectContaining({ type: 'taskBlock' })
    )
    await waitFor(() => expect(nested.type).toBe('checkListItem'))
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(nested.content).toEqual([{ type: 'text', text: 'Buy milk', styles: {} }])
  })

  it('reverts a nested checkbox to a checklist item when the subtask create fails', async () => {
    const nested = createBlock('nested-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.create.mockResolvedValue({
      success: false,
      error: 'Task not found'
    })
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'nested-line', parentTaskId: 'parent-task' }
      })
      .mockReturnValue(emptyIntents(new Set()))

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalled())
    expect(contentAreaMocks.editor.updateBlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nested-line' }),
      expect.objectContaining({ type: 'taskBlock' })
    )
    await waitFor(() => expect(nested.type).toBe('checkListItem'))
    expect(nested.content).toEqual([{ type: 'text', text: 'Buy milk', styles: {} }])
  })

  it('reverts a nested checkbox to a checklist item when the parent lookup rejects', async () => {
    const nested = createBlock('nested-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.get.mockRejectedValue(new Error('no vault open'))
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'nested-line', parentTaskId: 'parent-task' }
      })
      .mockReturnValue(emptyIntents(new Set()))

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await waitFor(() =>
      expect(contentAreaMocks.tasksService.get).toHaveBeenCalledWith('parent-task')
    )
    await waitFor(() => expect(nested.type).toBe('checkListItem'))
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(nested.content).toEqual([{ type: 'text', text: 'Buy milk', styles: {} }])
  })

  it('does not resurrect a checkbox the user deleted while the conversion was in flight', async () => {
    createBlock('nested-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.get.mockImplementation(async () => {
      contentAreaMocks.blocks.delete('nested-line')
      throw new Error('no vault open')
    })
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        subtaskCandidate: { blockId: 'nested-line', parentTaskId: 'parent-task' }
      })
      .mockReturnValue(emptyIntents(new Set()))

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await waitFor(() =>
      expect(contentAreaMocks.tasksService.get).toHaveBeenCalledWith('parent-task')
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.editor.updateBlock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'checkListItem' })
    )
  })

  // Defense in depth for the Tab race: the block picked up a `parentTaskId`
  // between the onChange that scheduled the conversion and the debounce
  // firing, so the row has to land in the parent's project, not the default.
  it('creates a raced standalone checkbox into its live parent task project', async () => {
    vi.useFakeTimers()
    createBlock('raced-line', {
      type: 'checkListItem',
      props: { checked: false, parentTaskId: 'parent-task' },
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.listProjects.mockResolvedValue({
      projects: [{ id: 'project-default', name: 'Inbox', isDefault: true }]
    })
    contentAreaMocks.tasksService.get.mockResolvedValue({
      id: 'parent-task',
      projectId: 'project-parent'
    })
    // Twice: once for the onChange that schedules, once for the re-scan the
    // debounce timer runs before it converts.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'raced-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'raced-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.get).toHaveBeenCalledWith('parent-task')
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-parent', parentId: 'parent-task' })
    )
  })

  // A failed parent lookup on the raced path is swallowed, not fatal: the row
  // still gets created, it just falls back to the default project. Losing the
  // project is better than leaving a `taskId: ''` block behind.
  it('still creates a raced standalone checkbox when the parent lookup rejects', async () => {
    vi.useFakeTimers()
    createBlock('raced-line', {
      type: 'checkListItem',
      props: { checked: false, parentTaskId: 'parent-task' },
      content: [{ type: 'text', text: 'Buy milk', styles: {} }]
    })
    contentAreaMocks.tasksService.listProjects.mockResolvedValue({
      projects: [{ id: 'project-default', name: 'Inbox', isDefault: true }]
    })
    contentAreaMocks.tasksService.get.mockRejectedValue(new Error('no vault open'))
    // Twice: once for the onChange that schedules, once for the re-scan the
    // debounce timer runs before it converts.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'raced-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'raced-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-default', parentId: 'parent-task' })
    )
  })

  // #2271 — the stranded `{task:}` lines in real vaults. The block is
  // rewritten to a `taskBlock` before the row exists, and an empty line has no
  // title to create from, so the create is refused and the block keeps
  // `taskId: ''` — a task-looking row whose every control is dead.
  it('leaves a checkbox with no text alone instead of converting it into an id-less task block', async () => {
    vi.useFakeTimers()
    const empty = createBlock('empty-line', {
      type: 'checkListItem',
      content: []
    })
    // The analyzer declines empty lines, so only a direct caller (the context
    // menu) reaches the converter with one. Mocked here as if it had.
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'empty-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'empty-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(empty.type).toBe('checkListItem')
    // Not even transiently: the rewrite is what strands the block.
    expect(contentAreaMocks.editor.updateBlock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'empty-line' }),
      expect.objectContaining({ type: 'taskBlock' })
    )
  })

  // Same stranding, one step later: the line has text, but quick-add eats all
  // of it. The block was already rewritten optimistically, so #1991's "leave
  // it as a checkbox" only holds if the checkbox is put back.
  it('restores the checkbox when the line is nothing but quick-add tokens', async () => {
    vi.useFakeTimers()
    const tokensOnly = createBlock('tokens-line', {
      type: 'checkListItem',
      content: [{ type: 'text', text: '#errand', styles: {} }]
    })
    contentAreaMocks.analyzeTaskIntents
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'tokens-line' }
      })
      .mockReturnValueOnce({
        ...emptyIntents(new Set()),
        standaloneCandidate: { blockId: 'tokens-line' }
      })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()
    expect(tokensOnly.type).toBe('checkListItem')
    expect(tokensOnly.content).toEqual([{ type: 'text', text: '#errand', styles: {} }])
  })

  // The draft path used to mark the block dismissed on the way in and never
  // take it back, so a draft that could not be created *yet* was never
  // created at all: the block in the report with an empty title and no id.
  it('retries a draft task once the projects it needs have loaded', async () => {
    contentAreaMocks.tasksService.listProjects.mockResolvedValueOnce({ projects: [] })
    contentAreaMocks.analyzeTaskIntents.mockImplementation(draftUnlessDismissed)

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(contentAreaMocks.tasksService.listProjects).toHaveBeenCalledTimes(1))
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('change'))
    await waitFor(() =>
      expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Draft title' })
      )
    )
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1)
  })

  it('retries a draft task after the project lookup rejects', async () => {
    contentAreaMocks.tasksService.listProjects.mockRejectedValueOnce(new Error('no vault open'))
    contentAreaMocks.analyzeTaskIntents.mockImplementation(draftUnlessDismissed)

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(contentAreaMocks.tasksService.listProjects).toHaveBeenCalledTimes(1))
    expect(contentAreaMocks.tasksService.create).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1))
  })

  it('creates a draft task once even when onChange fires repeatedly', async () => {
    contentAreaMocks.analyzeTaskIntents.mockImplementation(draftUnlessDismissed)

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    fireEvent.click(screen.getByText('change'))
    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1)
  })

  // The renderer rewrites the block's title prop on a debounce while the user
  // types, and each write is another onChange. Keying de-duplication on the
  // title alone would let "Buy mil" and "Buy milk" mint two rows for one block.
  it('creates one row for a draft whose title changes while the create is in flight', async () => {
    let releaseProjects: (value: { projects: unknown[] }) => void = () => {}
    contentAreaMocks.tasksService.listProjects.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseProjects = resolve
      })
    )
    const titles = ['Buy mil', 'Buy milk']
    let seen = 0
    contentAreaMocks.analyzeTaskIntents.mockImplementation(() => ({
      ...emptyIntents(new Set()),
      draftTaskBlock: {
        blockId: 'draft',
        title: titles[Math.min(seen++, titles.length - 1)]
      }
    }))

    render(<ContentArea noteId="note-1" />)

    fireEvent.click(screen.getByText('change'))
    fireEvent.click(screen.getByText('change'))

    await act(async () => {
      releaseProjects({ projects: [{ id: 'project-1', name: 'Inbox', isDefault: true }] })
      await Promise.resolve()
    })
    await waitFor(() => expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1))

    // The second onChange saw a different title, so the attempt key alone would
    // have let it through; only the in-flight guard holds it back.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledTimes(1)
    expect(contentAreaMocks.tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Buy mil' })
    )
  })

  // The row is tickable while the create is in flight (the draft controls are
  // live so a project picked early is not lost). Writing a hardcoded `checked`
  // back with the new id would clear that tick, and the markdown reconciler
  // would then un-complete the row it belongs to.
  it('keeps a tick made while the draft create was in flight', async () => {
    contentAreaMocks.analyzeTaskIntents.mockImplementation(draftUnlessDismissed)
    contentAreaMocks.tasksService.create.mockImplementation(async () => {
      const live = contentAreaMocks.blocks.get('draft')
      live.props = { ...live.props, checked: true }
      return { success: true, task: { id: 'created-task', title: 'Draft title' } }
    })

    render(<ContentArea noteId="note-1" />)
    fireEvent.click(screen.getByText('change'))

    await waitFor(() =>
      expect(contentAreaMocks.blocks.get('draft').props.taskId).toBe('created-task')
    )
    expect(contentAreaMocks.blocks.get('draft').props.checked).toBe(true)
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
