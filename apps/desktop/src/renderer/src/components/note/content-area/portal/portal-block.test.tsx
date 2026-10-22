/**
 * The portal block around its window: the states it names, the bytes it keeps,
 * and the edits its own controls make to the definition. The nested editor is
 * a stub here; what it shows is `portal-window-plugin.test.ts`'s subject.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PORTAL_MAX_DEPTH } from '@memry/shared/portal-block'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  notes: new Map<
    string,
    { id: string; path: string; title: string; content: string; emoji: null }
  >(),
  loading: false,
  locked: false,
  window: vi.fn(),
  windowState: undefined as unknown,
  actions: {
    includeParent: vi.fn(() => Promise.resolve(true)),
    hide: vi.fn(() => Promise.resolve(true)),
    show: vi.fn(),
    expandAll: vi.fn(),
    collapse: vi.fn(),
    showAllSiblings: vi.fn()
  }
}))

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNote: (id: string | null) => ({
    note: (id && mocks.notes.get(id)) || null,
    isLoading: mocks.loading
  })
}))
vi.mock('@/lib/vault-locks-store', () => ({ useIsNoteLocked: () => mocks.locked }))
vi.mock('@/contexts/sync-context', () => ({ useSyncOptional: () => null }))
vi.mock('./portal-window', () => ({
  PortalWindow: (props: { editable: boolean }) => {
    mocks.window(props)
    return <div data-testid="portal-window-stub" />
  }
}))
vi.mock('./use-portal-window-view', () => ({
  usePortalWindowState: () => mocks.windowState,
  usePortalInlineMarks: () => {}
}))
vi.mock('./portal-actions', () => ({
  commitPortalPlan: vi.fn(),
  createPortalActions: () => mocks.actions
}))

import { NoteFileUrlProvider } from '../note-file-url-context'
import { PortalAncestryContext } from './portal-context'
import { PortalBlockRenderer } from './portal-block'
import { updatePortalDefinition } from './portal-definition'
import { descendPortalAncestry, ROOT_PORTAL_ANCESTRY, type PortalAncestry } from './portal-state'

function fakeEditor(blockText?: string) {
  let text = blockText
  return {
    isEditable: true,
    focus: vi.fn(),
    removeBlocks: vi.fn(),
    updateBlock: vi.fn((_id: string, update: { content: string }) => {
      text = update.content
    }),
    getBlock: () => (text === undefined ? undefined : { content: [{ type: 'text', text }] }),
    nestBlock: vi.fn(),
    unnestBlock: vi.fn(),
    insertBlocks: vi.fn(),
    setTextCursorPosition: vi.fn(),
    getTextCursorPosition: () => ({ block: { id: 'elsewhere' } }),
    onSelectionChange: () => () => {},
    read: () => text
  }
}

function renderPortal(
  definition: string,
  options: { host?: string; ancestry?: PortalAncestry; editor?: ReturnType<typeof fakeEditor> } = {}
) {
  const editor = options.editor ?? fakeEditor(definition)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <NoteFileUrlProvider resolveFileUrl={async (url) => url} noteId={options.host ?? 'host'}>
        <PortalAncestryContext.Provider value={options.ancestry ?? ROOT_PORTAL_ANCESTRY}>
          <PortalBlockRenderer
            block={{
              id: 'portal-1',
              props: { language: 'memry-portal' },
              content: [{ type: 'text', text: definition, styles: {} }]
            }}
            editor={editor}
            contentRef={() => {}}
          />
        </PortalAncestryContext.Provider>
      </NoteFileUrlProvider>
    </QueryClientProvider>
  )
  return editor
}

function source(id: string, title: string) {
  mocks.notes.set(id, { id, path: `${title}.md`, title, content: '# body', emoji: null })
}

const BLOCKS_FENCE = '{"v":1,"note":"src","blocks":["chl7"]}'

const windowBlock = (blockId: string, text: string) => ({
  blockId,
  anchor: null,
  text,
  depth: 0,
  pos: 0
})

function focusWindow(): void {
  fireEvent.focus(screen.getByTestId('portal-window-stub'))
}

describe('PortalBlockRenderer', () => {
  beforeEach(() => {
    mocks.notes.clear()
    mocks.openSidebarItem.mockReset()
    mocks.window.mockReset()
    for (const action of Object.values(mocks.actions)) action.mockClear()
    mocks.loading = false
    mocks.locked = false
    mocks.windowState = undefined
    source('src', 'Cell Biology')
  })

  it('is the window and nothing else until the caret is inside', () => {
    renderPortal('{"note":"src"}')

    expect(screen.getByTestId('portal-window-stub')).toBeTruthy()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('floats the toolbar in with the caret, and its crumb opens the source', () => {
    renderPortal('{"note":"src"}')
    focusWindow()

    const toolbar = screen.getByRole('toolbar')
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Cell Biology' }))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'src' }),
      undefined
    )
  })

  it('widens the portal to an ancestor from the path, and counts hidden neighbours', () => {
    mocks.windowState = {
      rootFound: true,
      rootText: 'Return of circulation',
      visible: [],
      hiddenSiblings: [windowBlock('h1', 'a'), windowBlock('h2', 'b')],
      hiddenChildren: {},
      ancestors: [windowBlock('p1', 'Cardiac arrest'), windowBlock('p2', '50-year-old patient')]
    }
    renderPortal(BLOCKS_FENCE)
    focusWindow()

    expect(screen.getByRole('button', { name: '2 hidden' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '50-year-old patient' }))

    expect(mocks.actions.includeParent).toHaveBeenCalledWith('p2')
  })

  it('shows the hidden count of a whole-note portal', () => {
    mocks.windowState = {
      rootFound: null,
      rootText: null,
      visible: [],
      hiddenSiblings: [windowBlock('h1', 'a')],
      hiddenChildren: {},
      ancestors: []
    }
    renderPortal('{"note":"src"}')
    focusWindow()

    expect(screen.getByText('1 hidden')).toBeTruthy()
  })

  it('opens the source beside on a Shift press in the content', () => {
    renderPortal('{"note":"src"}')

    fireEvent.mouseDown(screen.getByTestId('portal-window-stub').parentElement!, { shiftKey: true })
    expect(mocks.openSidebarItem).not.toHaveBeenCalled()

    const content = document.createElement('div')
    content.setAttribute('data-portal-window', '')
    screen.getByTestId('portal-window-stub').append(content)
    fireEvent.mouseDown(content, { shiftKey: true })

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(expect.anything(), { toTheSide: true })
  })

  it('makes the window read-only for a locked source and says so in the toolbar', () => {
    mocks.locked = true
    renderPortal('{"note":"src"}')

    expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining({ editable: false }))
    expect(screen.getByText('Cell Biology is locked · read only')).toBeTruthy()
  })

  it('says the source is gone, and removes only the portal', () => {
    mocks.notes.clear()
    const editor = renderPortal('{"note":"gone"}')

    expect(screen.getByText(/source note was deleted/i)).toBeTruthy()
    expect(screen.queryByTestId('portal-window-stub')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(editor.removeBlocks).toHaveBeenCalledWith(['portal-1'])
  })

  it('stops a portal that shows the note it sits in', () => {
    renderPortal('{"note":"src"}', { host: 'src' })

    expect(screen.getByText('This portal leads back to itself.')).toBeTruthy()
    expect(screen.queryByTestId('portal-window-stub')).toBeNull()
  })

  it('stops at the nesting limit', () => {
    let ancestry = ROOT_PORTAL_ANCESTRY
    for (let i = 0; i < PORTAL_MAX_DEPTH; i += 1) {
      ancestry = descendPortalAncestry(ancestry, { kind: 'note', note: `other-${i}`, hide: [] })
    }
    renderPortal('{"note":"src"}', { ancestry })

    expect(
      screen.getByText(`Portals nest ${PORTAL_MAX_DEPTH} deep. This one opens as a link.`)
    ).toBeTruthy()
  })

  it('keeps the bytes of a definition it cannot read, and shows them to fix', () => {
    const editor = renderPortal('{"note": ')

    expect(screen.getByRole('alert').textContent).toContain('not valid JSON')
    expect(screen.queryByTestId('portal-window-stub')).toBeNull()
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  it('draws a plain code block when the language is not a portal', () => {
    const queryClient = new QueryClient()
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <PortalBlockRenderer
          block={{ id: 'c', props: { language: 'typescript' }, content: [] }}
          editor={fakeEditor()}
          contentRef={() => {}}
        />
      </QueryClientProvider>
    )

    expect(container.querySelector('[data-memry-portal]')).toBeNull()
    expect(container.querySelector('pre code')).not.toBeNull()
  })
})

describe('updatePortalDefinition', () => {
  it('rewrites the target and keeps keys a newer build wrote', () => {
    const editor = fakeEditor('{"v":1,"note":"src","blocks":["chl7"],"future":{"a":1}}')

    const ok = updatePortalDefinition(editor, 'p', (current) =>
      current.target.kind === 'blocks'
        ? { ...current, target: { ...current.target, blocks: [...current.target.blocks, 'aaaa'] } }
        : null
    )

    expect(ok).toBe(true)
    expect(JSON.parse(editor.read() ?? '')).toEqual({
      v: 1,
      note: 'src',
      blocks: ['chl7', 'aaaa'],
      future: { a: 1 }
    })
  })

  it('writes nothing when the edit refuses', () => {
    const editor = fakeEditor('{"note":"src"}')

    expect(updatePortalDefinition(editor, 'p', () => null)).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  it('writes nothing for a definition it cannot read', () => {
    const editor = fakeEditor('{"note": ')

    expect(updatePortalDefinition(editor, 'p', (current) => current)).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  it('writes nothing in a read-only editor', () => {
    const editor = { ...fakeEditor('{"note":"src"}'), isEditable: false }

    expect(updatePortalDefinition(editor, 'p', (current) => current)).toBe(false)
  })
})
