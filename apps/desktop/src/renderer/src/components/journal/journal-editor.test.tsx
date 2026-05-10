import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JournalEditor } from './journal-editor'

type EditorOptions = {
  extensions: Array<{ name: string; options?: Record<string, unknown> }>
  content: string
  editable: boolean
  onUpdate?: (props: { editor: { getHTML: () => string } }) => void
}

const editorMocks = vi.hoisted(() => {
  const editor = {
    getHTML: vi.fn(() => '<p>current</p>'),
    commands: {
      setContent: vi.fn()
    },
    isFocused: false
  }
  return {
    editor,
    options: undefined as EditorOptions | undefined,
    useEditor: vi.fn((options: EditorOptions) => {
      editorMocks.options = options
      return editor
    }),
    reactRendererInstances: [] as Array<{
      updateProps: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
      ref: { onKeyDown: ReturnType<typeof vi.fn> }
      element: HTMLDivElement
    }>
  }
})

const searchPages = vi.hoisted(() => vi.fn((query: string) => [`page:${query}`]))
const searchTags = vi.hoisted(() => vi.fn((query: string) => [`tag:${query}`]))
const tippyInstances = vi.hoisted(() => [
  {
    setProps: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn()
  }
])

function configurable(name: string) {
  return {
    configure: vi.fn((options: Record<string, unknown>) => ({ name, options }))
  }
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@tiptap/react', () => ({
  useEditor: editorMocks.useEditor,
  EditorContent: ({
    editor,
    className
  }: {
    editor: typeof editorMocks.editor
    className?: string
  }) => (
    <div data-testid="editor-content" className={className}>
      {editor.getHTML()}
    </div>
  ),
  ReactRenderer: vi.fn(function ReactRenderer() {
    const instance = {
      updateProps: vi.fn(),
      destroy: vi.fn(),
      ref: { onKeyDown: vi.fn(() => true) },
      element: document.createElement('div')
    }
    editorMocks.reactRendererInstances.push(instance)
    return instance
  })
}))

vi.mock('@tiptap/starter-kit', () => ({ default: configurable('starter-kit') }))
vi.mock('@tiptap/extension-link', () => ({ default: configurable('link') }))
vi.mock('@tiptap/extension-image', () => ({ default: configurable('image') }))
vi.mock('@tiptap/extension-placeholder', () => ({ default: configurable('placeholder') }))
vi.mock('@tiptap/extension-underline', () => ({ default: { name: 'underline' } }))

vi.mock('tippy.js', () => ({
  default: vi.fn(() => tippyInstances)
}))

vi.mock('@/hooks/use-pages', () => ({
  usePages: () => ({ searchPages })
}))

vi.mock('@/hooks/use-tags', () => ({
  useTags: () => ({ searchTags })
}))

vi.mock('./editor-toolbar', () => ({
  EditorToolbar: ({
    journalId,
    isFocusMode,
    onFocusToggle
  }: {
    journalId?: string
    isFocusMode?: boolean
    onFocusToggle?: () => void
  }) => (
    <button onClick={onFocusToggle}>
      toolbar:{journalId}:{String(isFocusMode)}
    </button>
  )
}))

vi.mock('./extensions/wiki-link', () => ({
  WikiLink: configurable('wiki-link'),
  WikiLinkAutocomplete: () => <div>wiki autocomplete</div>,
  wikiLinkStyles: '.wiki-link{}'
}))

vi.mock('./extensions/tag', () => ({
  Tag: configurable('tag'),
  TagAutocomplete: () => <div>tag autocomplete</div>,
  tagStyles: '.tag{}'
}))

function extension(name: string) {
  const found = editorMocks.options?.extensions.find((item) => item.name === name)
  expect(found).toBeDefined()
  return found as { name: string; options: Record<string, unknown> }
}

describe('JournalEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    editorMocks.options = undefined
    editorMocks.editor.getHTML.mockReturnValue('<p>current</p>')
    editorMocks.editor.commands.setContent.mockClear()
    editorMocks.reactRendererInstances.length = 0
  })

  it('configures the editor, forwards toolbar focus, emits updates, and syncs content props', async () => {
    const user = userEvent.setup()
    const onContentChange = vi.fn()
    const onFocusToggle = vi.fn()

    const { rerender } = render(
      <JournalEditor
        content="<p>initial</p>"
        journalId="2026-05-10"
        isFocusMode
        isActive
        onContentChange={onContentChange}
        onFocusToggle={onFocusToggle}
      />
    )

    expect(editorMocks.useEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '<p>initial</p>',
        editable: true
      }),
      ['editor.placeholder.default', false]
    )
    expect(screen.getByTestId('editor-content')).toHaveClass(
      '[&_.is-editor-empty:first-child::before]:text-muted-foreground'
    )

    await user.click(screen.getByRole('button', { name: 'toolbar:2026-05-10:true' }))
    expect(onFocusToggle).toHaveBeenCalled()

    editorMocks.options?.onUpdate?.({ editor: { getHTML: () => '<p>changed</p>' } })
    expect(onContentChange).toHaveBeenCalledWith('<p>changed</p>')

    rerender(<JournalEditor content="<p>new</p>" readOnly />)
    await waitFor(() =>
      expect(editorMocks.editor.commands.setContent).toHaveBeenCalledWith('<p>new</p>')
    )
    expect(editorMocks.options).toEqual(expect.objectContaining({ editable: false }))
  })

  it('wires wiki-link and tag suggestion render lifecycles', () => {
    render(<JournalEditor />)

    const wikiSuggestion = extension('wiki-link').options.suggestion as {
      items: (props: { query: string }) => string[]
      render: () => {
        onStart: (props: Record<string, unknown>) => void
        onUpdate: (props: Record<string, unknown>) => void
        onKeyDown: (props: { event: KeyboardEvent }) => boolean
        onExit: () => void
      }
    }
    expect(wikiSuggestion.items({ query: 'road' })).toEqual(['page:road'])

    const wikiRenderer = wikiSuggestion.render()
    wikiRenderer.onStart({
      editor: editorMocks.editor,
      clientRect: () => new DOMRect()
    })
    wikiRenderer.onUpdate({ clientRect: () => new DOMRect() })
    expect(tippyInstances[0].setProps).toHaveBeenCalled()

    expect(wikiRenderer.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Escape' }) })).toBe(
      true
    )
    expect(tippyInstances[0].hide).toHaveBeenCalled()
    expect(wikiRenderer.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) })).toBe(
      true
    )
    wikiRenderer.onExit()
    expect(tippyInstances[0].destroy).toHaveBeenCalled()
    expect(editorMocks.reactRendererInstances[0].destroy).toHaveBeenCalled()

    const tagSuggestion = extension('tag').options.suggestion as typeof wikiSuggestion
    expect(tagSuggestion.items({ query: 'sync' })).toEqual(['tag:sync'])
    const tagRenderer = tagSuggestion.render()
    tagRenderer.onStart({
      editor: editorMocks.editor,
      query: 'sy',
      clientRect: () => new DOMRect()
    })
    tagRenderer.onUpdate({ query: 'sync', clientRect: () => new DOMRect() })
    expect(editorMocks.reactRendererInstances[1].updateProps).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'sync' })
    )
    tagRenderer.onExit()
    expect(editorMocks.reactRendererInstances[1].destroy).toHaveBeenCalled()
  })
})
