import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { useInlineTagObject } from './use-inline-tag-object'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const openSidebarItem = vi.fn()
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem })
}))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  notes: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

const textField = (name: string): ResolvedField => ({
  name,
  type: 'text',
  relation: null,
  definedBy: 'person'
})

const tag = (key: string, fields: ResolvedField[], overrides: Partial<ResolvedTag> = {}) =>
  ({
    name: key,
    key,
    color: 'blue',
    icon: null,
    editable: true,
    ownFields: fields,
    inherited: [],
    effectiveFields: fields,
    hasFields: fields.length > 0,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null,
    ...overrides
  }) satisfies ResolvedTag

const snapshot: TagSchemaSnapshot = {
  tags: {
    person: tag('person', [textField('Role'), textField('Email')], {
      preset: 'person',
      ownPreset: 'person'
    }),
    project: tag('project', [textField('Owner')]),
    idea: tag('idea', [])
  },
  objects: { 'ada-note': 'person', 'alan-note': 'person', 'proj-note': 'project' },
  presets: [],
  presetStripDismissed: false
}

interface FakeView {
  posAtDOM: Fn
  dispatch: Fn
  state: { doc: { nodeAt: Fn }; tr: { delete: Fn } }
}

function fakeEditor(nodeType: string | null): { editor: object; view: FakeView } {
  const tr = { deleted: true }
  const view: FakeView = {
    posAtDOM: vi.fn().mockReturnValue(7),
    dispatch: vi.fn(),
    state: {
      doc: { nodeAt: vi.fn().mockReturnValue(nodeType ? { type: { name: nodeType } } : null) },
      tr: { delete: vi.fn().mockReturnValue(tr) }
    }
  }
  return { editor: { _tiptapEditor: { view } }, view }
}

function Host({
  editor,
  noteId,
  tagName
}: {
  editor: object
  noteId: string | undefined
  tagName: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const { onTagClick, overlay } = useInlineTagObject(editor, ref, noteId)
  const [handled, setHandled] = useState<boolean | null>(null)
  return (
    <div ref={ref} className="relative">
      <span ref={pillRef} data-testid="pill">
        {'#'}
        {tagName}
      </span>
      <button onClick={() => setHandled(onTagClick(tagName, pillRef.current!))}>click pill</button>
      <output data-testid="handled">{String(handled)}</output>
      {overlay}
    </div>
  )
}

function renderHost(opts: {
  tagName?: string
  noteId?: string | undefined
  editor?: object
}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshot)
  render(
    <QueryClientProvider client={client}>
      <Host
        editor={opts.editor ?? fakeEditor('hashTag').editor}
        noteId={'noteId' in opts ? opts.noteId : 'plain-note'}
        tagName={opts.tagName ?? 'person'}
      />
    </QueryClientProvider>
  )
}

async function clickPill(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'click pill' }))
}

const menu = (): HTMLElement => screen.getByRole('menu', { name: '#person in the text' })

beforeEach(() => {
  openSidebarItem.mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.notes.update = vi.fn().mockResolvedValue({ success: true })
})

describe('inline #tag popover', () => {
  it('opens for a tag with fields, marks the pill active, and describes the tag', async () => {
    renderHost({})

    await clickPill()

    expect(screen.getByTestId('handled')).toHaveTextContent('true')
    expect(screen.getByTestId('pill')).toHaveClass('inline-hash-tag--active')
    expect(menu()).toHaveTextContent('2 people · 2 fields')
    expect(menu()).toHaveTextContent('Make this note a Person')
    expect(menu()).toHaveTextContent('Open #person')
    expect(menu()).toHaveTextContent('Remove tag from text')
  })

  it('describes a non-preset tag with generic object counts', async () => {
    renderHost({ tagName: 'project' })

    await clickPill()

    expect(screen.getByRole('menu', { name: '#project in the text' })).toHaveTextContent(
      '1 object · 1 field'
    )
  })

  it.each([
    ['there is no note to attach to', { noteId: undefined, tagName: 'person' }],
    ['the tag has no fields', { noteId: 'plain-note', tagName: 'idea' }],
    ['the tag is unknown', { noteId: 'plain-note', tagName: 'nope' }],
    ['the note is already an object of that tag', { noteId: 'ada-note', tagName: 'person' }]
  ])('leaves the click to the editor when %s', async (_label, opts) => {
    renderHost(opts)

    await clickPill()

    expect(screen.getByTestId('handled')).toHaveTextContent('false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('makes the note an object by adding the tag to its header on Enter', async () => {
    renderHost({ noteId: 'plain-note' })
    await clickPill()

    await userEvent.keyboard('{Enter}')

    await waitFor(() =>
      expect(api.notes.update).toHaveBeenCalledWith({
        id: 'plain-note',
        headerTags: { add: ['person'] }
      })
    )
    expect(toast.success).toHaveBeenCalledWith("Added #person to this note's tags")
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('pill')).not.toHaveClass('inline-hash-tag--active')
  })

  it('tells the user when adding the tag fails', async () => {
    api.notes.update = vi.fn().mockResolvedValue({ success: false, error: 'note is locked' })
    renderHost({})
    await clickPill()

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('note is locked'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('opens the tag page from the second action', async () => {
    renderHost({})
    await clickPill()

    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: /Open #person/ })).toHaveClass('bg-accent')
    await userEvent.keyboard('{Enter}')

    expect(openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'person',
      path: '/tags/person',
      entityId: 'person',
      color: 'blue'
    })
    expect(api.notes.update).not.toHaveBeenCalled()
  })

  it('removes the hashtag node from the text with the third action (ArrowUp wraps)', async () => {
    const { editor, view } = fakeEditor('hashTag')
    renderHost({ editor })
    await clickPill()

    await userEvent.keyboard('{ArrowUp}{Enter}')

    expect(view.posAtDOM).toHaveBeenCalledWith(screen.getByTestId('pill'), 0)
    expect(view.state.tr.delete).toHaveBeenCalledWith(6, 7)
    expect(view.dispatch).toHaveBeenCalledWith({ deleted: true })
  })

  it('leaves the text alone when the node under the pill is not a hashtag', async () => {
    const { editor, view } = fakeEditor('paragraph')
    renderHost({ editor })
    await clickPill()

    await userEvent.keyboard('{ArrowUp}{Enter}')

    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('runs an action by mouse and keeps the editor selection (mousedown prevented)', async () => {
    renderHost({})
    await clickPill()

    const open = screen.getByRole('menuitem', { name: /Open #person/ })
    const notPrevented = fireEvent.mouseDown(open)

    expect(notPrevented).toBe(false)
    expect(openSidebarItem).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on a click outside, but not on a click inside the popover', async () => {
    renderHost({})
    await clickPill()

    fireEvent.mouseDown(screen.getByText(/In the text, a tag is a label/))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('pill')).not.toHaveClass('inline-hash-tag--active')

    await clickPill()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
