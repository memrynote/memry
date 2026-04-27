import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentArea } from './ContentArea'

const {
  mockUseCreateBlockNote,
  mockUseYjsCollaboration,
  mockUseSync,
  mockUseEditorSync,
  mockReplaceBlocks
} = vi.hoisted(() => ({
  mockUseCreateBlockNote: vi.fn(),
  mockUseYjsCollaboration: vi.fn(),
  mockUseSync: vi.fn(),
  mockUseEditorSync: vi.fn(),
  mockReplaceBlocks: vi.fn()
}))

vi.mock('@blocknote/react', () => ({
  SuggestionMenuController: () => null,
  FormattingToolbar: () => null,
  getDefaultReactSlashMenuItems: () => [],
  useCreateBlockNote: mockUseCreateBlockNote
}))

vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: () => <div data-testid="block-note-view" />
}))

vi.mock('@blocknote/xl-ai', () => ({
  AIMenuController: () => null,
  getAISlashMenuItems: () => []
}))

vi.mock('@blocknote/xl-ai/locales', () => ({ en: {} }))
vi.mock('@blocknote/core/locales', () => ({ en: {} }))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' })
}))

vi.mock('@/sync/use-yjs-collaboration', () => ({
  useYjsCollaboration: mockUseYjsCollaboration
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: mockUseSync
}))

vi.mock('@/contexts/ai-inline-context', () => ({
  useAIInlineContext: () => ({ port: null, error: null, retry: vi.fn() })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({ projects: [] })
}))

vi.mock('@/contexts/sidebar-drill-down', () => ({
  useSidebarDrillDown: () => ({ openTag: vi.fn() })
}))

vi.mock('@/hooks/use-wiki-link-hover', () => ({
  useWikiLinkHover: () => ({
    isVisible: false,
    preview: null,
    position: null,
    handleCardMouseEnter: vi.fn(),
    handleCardMouseLeave: vi.fn()
  })
}))

vi.mock('@/components/reminder', () => ({
  HighlightReminderPopover: () => null,
  useTextSelection: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { uploadAttachment: vi.fn() }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjects: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('./ai-menu', () => ({ CustomAIMenu: () => null }))
vi.mock('./wiki-link-menu', () => ({ WikiLinkMenu: () => null }))
vi.mock('./tag-suggestion-popover', () => ({ TagSuggestionPopover: () => null }))
vi.mock('./wiki-link-preview-card', () => ({ WikiLinkPreviewCard: () => null }))
vi.mock('./block-drop-indicator', () => ({
  BlockDropIndicator: () => null,
  EmptyDocumentDropIndicator: () => null
}))
vi.mock('./callout-block', () => ({
  getCalloutSlashMenuItem: () => ({ title: 'Callout' })
}))
vi.mock('./task-block', () => ({
  getTaskSlashMenuItem: () => ({ title: 'Task' })
}))
vi.mock('./block-marquee-overlay', () => ({ BlockMarqueeOverlay: () => null }))
vi.mock('./paste-link-menu', () => ({ PasteLinkMenu: () => null }))
vi.mock('./editor-schema', () => ({ editorSchema: {} }))
vi.mock('./scan-task-intents', () => ({
  analyzeTaskIntents: () => ({
    subtaskCandidate: null,
    standaloneCandidate: null,
    currentTaskIds: new Set<string>(),
    draftTaskBlock: null,
    demotedTaskBlocks: [],
    unindentedTaskBlocks: []
  })
}))
vi.mock('./hooks', () => ({
  useBlockNoteSetup: () => ({ aiReady: false }),
  useBlockMarqueeSelection: () => ({ marqueeRect: null, highlightRects: [] }),
  useEditorDragDrop: () => ({
    isDragging: false,
    dropTarget: null,
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn()
  }),
  useEditorFileUpload: vi.fn(),
  useEditorSync: mockUseEditorSync,
  useTagSuggestions: () => ({ handleTagSuggestionSelect: vi.fn() }),
  useWikiLinkSuggestions: () => ({
    getWikiLinkItems: vi.fn(async () => []),
    handleWikiLinkSelect: vi.fn()
  }),
  usePasteLinkMenu: () => ({
    state: { isOpen: false, position: null, options: [], selectedIndex: 0 },
    handleSelect: vi.fn()
  })
}))

function createEditor() {
  return {
    document: [],
    replaceBlocks: mockReplaceBlocks,
    getBlock: vi.fn(),
    updateBlock: vi.fn(),
    getTextCursorPosition: vi.fn(() => null)
  }
}

function remoteUpdateRef() {
  return { current: false }
}

describe('ContentArea collaboration binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSync.mockReturnValue({ state: { status: 'idle' } })
    mockUseCreateBlockNote.mockReturnValue(createEditor())
    mockUseEditorSync.mockReturnValue({
      handleChange: vi.fn(),
      isContentReadyRef: { current: true },
      prevInlineTagsRef: { current: [] },
      lastNormalizedTagsRef: { current: '' }
    })
  })

  it('passes the ready Yjs fragment into BlockNote collaboration', () => {
    const fragment = { fragment: true }
    mockUseYjsCollaboration.mockReturnValue({
      fragment,
      provider: {},
      isReady: true,
      isRemoteUpdateRef: remoteUpdateRef()
    })

    render(<ContentArea noteId="note-ready" initialContent="legacy body" contentType="markdown" />)

    expect(screen.getByTestId('block-note-view')).toBeTruthy()
    expect(mockUseCreateBlockNote).toHaveBeenCalledWith(
      expect.objectContaining({
        collaboration: {
          fragment,
          user: { name: 'Local User', color: '#3b82f6' }
        }
      })
    )
    expect(mockUseEditorSync).toHaveBeenCalledWith(
      expect.objectContaining({ yjsFragment: fragment, initialContent: 'legacy body' })
    )
  })

  it('keeps note content in the loading state while collaboration is not ready', () => {
    mockUseYjsCollaboration.mockReturnValue({
      fragment: null,
      provider: null,
      isReady: false,
      isRemoteUpdateRef: remoteUpdateRef()
    })

    const { container } = render(
      <ContentArea noteId="note-loading" initialContent="legacy body" contentType="markdown" />
    )

    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(mockUseCreateBlockNote).not.toHaveBeenCalled()
    expect(mockUseEditorSync).not.toHaveBeenCalled()
    expect(mockReplaceBlocks).not.toHaveBeenCalled()
  })

  it('does not fall back to string content when a ready note has no Yjs fragment', () => {
    mockUseYjsCollaboration.mockReturnValue({
      fragment: null,
      provider: {},
      isReady: true,
      isRemoteUpdateRef: remoteUpdateRef()
    })

    const { container } = render(
      <ContentArea noteId="note-no-fragment" initialContent="legacy body" contentType="markdown" />
    )

    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(mockUseCreateBlockNote).not.toHaveBeenCalled()
    expect(mockUseEditorSync).not.toHaveBeenCalled()
    expect(mockReplaceBlocks).not.toHaveBeenCalled()
  })
})
