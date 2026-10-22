/**
 * The portal block around its window: the states it names, the bytes it keeps,
 * and the edits its own controls make to the definition. The nested editor is
 * a stub here; what it shows is `portal-window-plugin.test.ts`'s subject.
 */

import { fireEvent, render, screen } from '@testing-library/react'
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
  window: vi.fn()
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
  PortalWindow: (props: { hidden: string[]; editable: boolean }) => {
    mocks.window(props)
    return <div data-testid="portal-window-stub" />
  }
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

describe('PortalBlockRenderer', () => {
  beforeEach(() => {
    mocks.notes.clear()
    mocks.openSidebarItem.mockReset()
    mocks.window.mockReset()
    mocks.loading = false
    mocks.locked = false
    source('src', 'Cell Biology')
  })

  it('shows the source name and opens it, in a new tab with Cmd', () => {
    renderPortal('{"note":"src"}')

    expect(screen.getByTestId('portal-window-stub')).toBeTruthy()
    const crumb = screen.getByRole('button', { name: 'Cell Biology' })
    fireEvent.click(crumb)
    fireEvent.click(crumb, { metaKey: true })

    expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'note', entityId: 'src' }),
      undefined
    )
    expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(2, expect.anything(), {
      inNewTab: true
    })
  })

  it('counts hidden blocks and passes them to the window', () => {
    renderPortal('{"note":"src","block":"chl7","hidden":["aaaa","bbbb"]}')

    expect(screen.getByText('2 hidden')).toBeTruthy()
    expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining({ hidden: ['aaaa', 'bbbb'] }))
  })

  it('makes the window read-only for a locked source', () => {
    mocks.locked = true
    renderPortal('{"note":"src"}')

    expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining({ editable: false }))
    expect(screen.getByText('Locked')).toBeTruthy()
  })

  it('says the source is gone, and removes only the portal', () => {
    mocks.notes.clear()
    const editor = renderPortal('{"note":"gone"}')

    expect(screen.getByText('Source note was deleted')).toBeTruthy()
    expect(screen.queryByTestId('portal-window-stub')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove portal' }))

    expect(editor.removeBlocks).toHaveBeenCalledWith(['portal-1'])
  })

  it('stops a portal that shows the note it sits in', () => {
    renderPortal('{"note":"src"}', { host: 'src' })

    expect(screen.getByText('This portal contains itself')).toBeTruthy()
    expect(screen.queryByTestId('portal-window-stub')).toBeNull()
  })

  it('stops at the nesting limit', () => {
    let ancestry = ROOT_PORTAL_ANCESTRY
    for (let i = 0; i < PORTAL_MAX_DEPTH; i += 1) {
      ancestry = descendPortalAncestry(ancestry, { kind: 'note', note: `other-${i}` })
    }
    renderPortal('{"note":"src"}', { ancestry })

    expect(screen.getByText('Portal limit reached')).toBeTruthy()
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
  it('rewrites the hidden list and keeps keys a newer build wrote', () => {
    const editor = fakeEditor('{"note":"src","block":"chl7","future":{"a":1}}')

    const ok = updatePortalDefinition(editor, 'p', (current) => ({
      hidden: [...current.hidden, 'aaaa']
    }))

    expect(ok).toBe(true)
    expect(JSON.parse(editor.read() ?? '')).toEqual({
      note: 'src',
      block: 'chl7',
      hidden: ['aaaa'],
      future: { a: 1 }
    })
  })

  it('writes nothing for a definition it cannot read', () => {
    const editor = fakeEditor('{"note": ')

    expect(updatePortalDefinition(editor, 'p', { hidden: ['aaaa'] })).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  it('writes nothing in a read-only editor', () => {
    const editor = { ...fakeEditor('{"note":"src"}'), isEditable: false }

    expect(updatePortalDefinition(editor, 'p', { hidden: ['aaaa'] })).toBe(false)
  })
})
