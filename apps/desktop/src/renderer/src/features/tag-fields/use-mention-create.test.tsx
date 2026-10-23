import { useRef } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { PresetOffer, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { useMentionCreate } from './use-mention-create'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  notes: Record<string, Fn>
  properties: Record<string, Fn>
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

const bookOffer: PresetOffer = {
  key: 'book',
  name: 'book',
  icon: null,
  color: 'green',
  fields: [{ name: 'Author', type: 'text', relationTarget: null }],
  templateSections: [],
  state: 'add',
  existingTag: null,
  alsoAdds: []
}

function snapshot(overrides: Partial<TagSchemaSnapshot> = {}): TagSchemaSnapshot {
  return {
    tags: {
      company: tag('company', [textField('Industry')], { preset: 'company', ownPreset: 'company' }),
      person: tag('person', [textField('Job title')], { preset: 'person', ownPreset: 'person' }),
      plain: tag('plain', [])
    },
    objects: {},
    presets: [bookOffer, { ...bookOffer, key: 'person', name: 'person', state: 'added' }],
    presetStripDismissed: false,
    ...overrides
  }
}

const editor = { insertInlineContent: vi.fn(), focus: vi.fn() }

function Host(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { openCreate, overlay } = useMentionCreate(editor, ref)
  return (
    <div>
      <div ref={ref} className="relative">
        <input aria-label="editor" />
        {overlay}
      </div>
      <button onClick={() => openCreate('Ada Lovelace', { x: 12, y: 34 })}>open menu</button>
      <p>outside</p>
    </div>
  )
}

async function openMenu(snap: TagSchemaSnapshot = snapshot()): Promise<void> {
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snap)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snap)
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: 'open menu' }))
  screen.getByLabelText('editor').focus()
}

const option = (name: RegExp | string): HTMLElement => screen.getByRole('option', { name })

beforeEach(() => {
  localStorage.clear()
  editor.insertInlineContent.mockClear()
  editor.focus.mockClear()
  vi.mocked(toast.error).mockClear()
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.notes.create = vi.fn().mockImplementation(async ({ title }: { title: string }) => ({
    success: true,
    note: { id: 'new-1', title }
  }))
  api.properties.merge = vi.fn().mockResolvedValue({ success: true })
})

describe('mention create menu', () => {
  it('offers tags with fields, ready-made presets not yet added, and a plain note last', async () => {
    await openMenu()

    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels).toHaveLength(4)
    expect(labels[0]).toContain('Person')
    expect(labels[1]).toContain('Company')
    expect(labels[2]).toContain('Book')
    expect(labels[2]).toContain('Ready-made tag')
    expect(labels[3]).toContain('Plain note')
    expect(screen.getByRole('listbox', { name: 'Create Ada Lovelace as' })).toBeInTheDocument()
  })

  it('puts the last used tag first and labels it', async () => {
    localStorage.setItem('memry:mention-create-last-tag', 'company')
    await openMenu()

    const first = screen.getAllByRole('option')[0]
    expect(first).toHaveTextContent('Company')
    expect(first).toHaveTextContent('Last used')
  })

  it('creates the note with the chosen tag on Enter, links it, and remembers the tag', async () => {
    await openMenu()

    await userEvent.keyboard('{Enter}')

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith({
        title: 'Ada Lovelace',
        content: '',
        tags: ['person']
      })
    )
    expect(editor.insertInlineContent).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'wikiLink',
          props: expect.objectContaining({ target: 'Ada Lovelace' })
        }),
        ' '
      ],
      { updateSelection: true }
    )
    expect(localStorage.getItem('memry:mention-create-last-tag')).toBe('person')
    expect(screen.queryByRole('listbox', { name: /Create/ })).not.toBeInTheDocument()
  })

  it('moves the selection with arrows (wrapping) and commits with Tab', async () => {
    await openMenu()

    await userEvent.keyboard('{ArrowDown}')
    expect(option(/Company/)).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(option(/Plain note/)).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Tab}')

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith(expect.objectContaining({ tags: ['company'] }))
    )
  })

  it('creates an untagged note when the user picks Plain note', async () => {
    await openMenu()

    fireEvent.mouseDown(option(/Plain note/))

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith({ title: 'Ada Lovelace', content: '' })
    )
    expect(editor.insertInlineContent).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'wikiLink' }), ' '],
      { updateSelection: true }
    )
    expect(localStorage.getItem('memry:mention-create-last-tag')).toBeNull()
  })

  it('adds the preset first, then creates the note under the tag the preset wrote', async () => {
    await openMenu()
    const updated = snapshot({
      tags: { ...snapshot().tags, book: tag('book', [textField('Author')], { preset: 'book' }) }
    })
    api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot: updated, tag: 'Book' })

    fireEvent.mouseDown(option(/Book/))

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith({
        title: 'Ada Lovelace',
        content: '',
        tags: ['book']
      })
    )
    expect(api.tags.editSchema).toHaveBeenCalledWith({ kind: 'add-preset', preset: 'book' })
    expect(await screen.findByTestId('quick-fields-card')).toBeInTheDocument()
  })

  it('inserts the typed title as plain text on Escape and closes the menu', async () => {
    await openMenu()

    await userEvent.keyboard('{Escape}')

    expect(editor.insertInlineContent).toHaveBeenCalledWith('Ada Lovelace')
    expect(api.notes.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: /Create/ })).not.toBeInTheDocument()
  })

  it('inserts the typed title as plain text when the user clicks elsewhere, but not inside the menu', async () => {
    await openMenu()

    fireEvent.mouseDown(screen.getByText('Ada Lovelace'))
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox', { name: /Create/ })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByText('outside'))
    expect(editor.insertInlineContent).toHaveBeenCalledWith('Ada Lovelace')
    expect(screen.queryByRole('listbox', { name: /Create/ })).not.toBeInTheDocument()
  })

  it('ignores bare modifier keys while the menu is open', async () => {
    await openMenu()

    await userEvent.keyboard('{Shift}')

    expect(screen.getByRole('listbox', { name: /Create/ })).toBeInTheDocument()
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('tells the user when creating fails and inserts no link', async () => {
    api.notes.create = vi.fn().mockResolvedValue({ success: false, error: 'disk full' })
    await openMenu()

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full'))
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('opens a first-fields card for the new object, saves typed values on Enter and returns focus to the editor', async () => {
    await openMenu()

    await userEvent.keyboard('{Enter}')
    const card = await screen.findByTestId('quick-fields-card')
    expect(card).toHaveAccessibleName('First fields of Ada Lovelace')

    const input = screen.getByPlaceholderText('Add job title')
    await userEvent.type(input, '  Mathematician {Enter}')

    await waitFor(() =>
      expect(api.properties.merge).toHaveBeenCalledWith('new-1', { 'Job title': 'Mathematician' })
    )
    expect(screen.queryByTestId('quick-fields-card')).not.toBeInTheDocument()
    expect(editor.focus).toHaveBeenCalled()
  })

  it('does not open the first-fields card for a tag without quick-fillable fields', async () => {
    const snap = snapshot({
      tags: { habit: tag('habit', [{ ...textField('Done'), type: 'checkbox' }]) }
    })
    await openMenu(snap)

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(api.notes.create).toHaveBeenCalled())
    expect(screen.queryByTestId('quick-fields-card')).not.toBeInTheDocument()
  })
})
