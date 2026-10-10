import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldType, ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { FieldListEditor } from './FieldListEditor'

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const emptySnapshot: TagSchemaSnapshot = {
  tags: {},
  objects: {},
  presets: [],
  presetStripDismissed: false
}

function field(
  name: string,
  type: FieldType,
  definedBy: string,
  relation: ResolvedField['relation'] = null
): ResolvedField {
  return { name, type, definedBy, relation }
}

function resolvedTag(overrides: Partial<ResolvedTag> & Pick<ResolvedTag, 'key'>): ResolvedTag {
  const ownFields = overrides.ownFields ?? []
  const effectiveFields = overrides.effectiveFields ?? ownFields
  return {
    name: overrides.key,
    color: '',
    icon: null,
    editable: true,
    ownFields,
    inherited: [],
    effectiveFields,
    hasFields: effectiveFields.length > 0,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null,
    ...overrides
  }
}

const personTag = resolvedTag({
  key: 'person',
  name: 'person',
  ownFields: [
    field('Role', 'text', 'person'),
    field('Employer', 'relation', 'person', { target: 'company', many: false, inverse: 'People' }),
    field('Friends', 'relation', 'person', { target: null, many: true, inverse: null })
  ],
  effectiveFields: [
    field('Email', 'url', 'contact'),
    field('Phone', 'number', 'contact'),
    field('Role', 'text', 'person'),
    field('Employer', 'relation', 'person', { target: 'company', many: false, inverse: 'People' }),
    field('Friends', 'relation', 'person', { target: null, many: true, inverse: null })
  ]
})

const tagsApi = {
  getAllWithCounts: vi.fn(),
  previewImpact: vi.fn(),
  editSchema: vi.fn()
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  tagsApi.getAllWithCounts.mockResolvedValue({
    tags: [
      { name: 'company', color: 'blue', count: 4, icon: null },
      { name: 'person', color: 'rose', count: 9, icon: null }
    ]
  })
  tagsApi.previewImpact.mockResolvedValue({ kind: 'remove-field', filled: 3, empty: 1 })
  tagsApi.editSchema.mockResolvedValue({ snapshot: emptySnapshot })
  Object.assign(window.api.tags, tagsApi)
})

function renderEditor(tag: ResolvedTag | null = personTag): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FieldListEditor tagKey="person" tag={tag} />
    </QueryClientProvider>
  )
}

async function openFieldMenu(
  user: ReturnType<typeof userEvent.setup>,
  fieldName: string,
  item: string
): Promise<void> {
  await user.click(screen.getByRole('button', { name: `Actions for ${fieldName}` }))
  await user.click(await screen.findByRole('menuitem', { name: item }))
}

describe('FieldListEditor listing', () => {
  it('shows an empty-state hint when the tag has no fields', () => {
    renderEditor(resolvedTag({ key: 'person' }))

    expect(screen.getByText(/No fields yet/)).toBeInTheDocument()
  })

  it('lists inherited fields under their parent without edit actions, and own fields with them', async () => {
    renderEditor()

    expect(screen.getByText('From #contact · edit there')).toBeInTheDocument()
    expect(screen.getByText('Email')).toBeInTheDocument()
    expect(screen.getByText('URL')).toBeInTheDocument()
    expect(screen.getByText('Role')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'Actions for Email' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actions for Role' })).toBeInTheDocument()
  })

  it('describes a relation by its target and inverse, or as linking to any note', async () => {
    renderEditor()

    expect(await screen.findByText('Shown on the company as People')).toBeInTheDocument()
    expect(screen.getByText('Links to any note')).toBeInTheDocument()
  })

  it('offers no actions and a disabled drag handle for a tag a newer version wrote', () => {
    renderEditor({ ...personTag, editable: false })

    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument()
    const handles = screen.getAllByRole('button', { description: /pick up a draggable item/i })
    expect(handles).toHaveLength(personTag.ownFields.length)
    for (const handle of handles) expect(handle).toBeDisabled()
  })

  it('only offers relation settings on relation fields', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.click(screen.getByRole('button', { name: 'Actions for Role' }))
    expect(await screen.findByRole('menuitem', { name: 'Rename…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Relation settings' })).not.toBeInTheDocument()
  })
})

describe('FieldListEditor reordering', () => {
  const rowOrder = ['Role', 'Employer', 'Friends']
  const realRect = HTMLElement.prototype.getBoundingClientRect

  // jsdom has no layout: give each sortable row a 40px slot in field order so
  // dnd-kit's keyboard sensor can pick the neighbour to drop on.
  beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      const index = rowOrder.findIndex((name) => this.textContent?.startsWith(name))
      const single = this.querySelectorAll('[aria-roledescription]').length === 1
      if (index < 0 || !single) return realRect.call(this)
      return new DOMRect(0, index * 40, 300, 40)
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect
  })

  it('moves a field to the slot it is dropped on and tells main the new index', async () => {
    const user = userEvent.setup()
    renderEditor()

    const [roleHandle] = screen.getAllByRole('button', { description: /pick up a draggable item/i })
    roleHandle.focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard(' ')

    await waitFor(() =>
      expect(tagsApi.editSchema).toHaveBeenCalledWith({
        kind: 'move-field',
        tag: 'person',
        name: 'Role',
        toIndex: 1
      })
    )
  })

  it('reports a failed move', async () => {
    tagsApi.editSchema.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderEditor()

    const [roleHandle] = screen.getAllByRole('button', { description: /pick up a draggable item/i })
    roleHandle.focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard(' ')

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('offline'))
  })

  it('does nothing when a field is dropped where it started', async () => {
    const user = userEvent.setup()
    renderEditor()

    const [roleHandle] = screen.getAllByRole('button', { description: /pick up a draggable item/i })
    roleHandle.focus()
    await user.keyboard(' ')
    await user.keyboard(' ')

    expect(tagsApi.editSchema).not.toHaveBeenCalled()
  })
})

describe('FieldListEditor remove', () => {
  it('shows how many notes keep the value and removes nothing when cancelled', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Remove…')

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Remove Role from #person?')).toBeInTheDocument()
    expect(await within(dialog).findByText(/Role is filled on 3 notes/)).toBeInTheDocument()
    expect(tagsApi.previewImpact).toHaveBeenCalledWith({
      kind: 'remove-field',
      tag: 'person',
      name: 'Role'
    })

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(tagsApi.editSchema).not.toHaveBeenCalled()
  })

  it('removes the field from the tag and closes the dialog on confirm', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Remove…')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove field' }))

    await waitFor(() =>
      expect(tagsApi.editSchema).toHaveBeenCalledWith({
        kind: 'remove-field',
        tag: 'person',
        name: 'Role'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the dialog open and reports the failure when the removal is rejected', async () => {
    tagsApi.editSchema.mockRejectedValue(new Error('disk full'))
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Remove…')
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove field' })
    )

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('disk full'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('FieldListEditor rename', () => {
  beforeEach(() => {
    tagsApi.previewImpact.mockResolvedValue({
      kind: 'rename-field',
      notes: 7,
      tasks: 0,
      tags: ['person']
    })
  })

  it('previews the impact and keeps Rename disabled until the name actually changes', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/7 notes have a Role value/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled()

    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, 'Job title')

    expect(within(dialog).getByText('Rename Role to Job title')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeEnabled()
  })

  it.each([
    ['a name another field on the tag already uses', 'phone', 'This tag already has phone.'],
    ['a reserved frontmatter key', 'Tags', 'Tags is reserved and cannot be a field.']
  ])('blocks renaming to %s', async (_label, typed, message) => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, typed)

    expect(within(dialog).getByText(message)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled()
  })

  it('renames across the vault, announces the count and closes on confirm', async () => {
    tagsApi.editSchema.mockResolvedValue({
      snapshot: emptySnapshot,
      rename: { notes: 6, tasks: 2, skippedLocked: 0, skippedExisting: 0 }
    })
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, 'Job title{Enter}')

    await waitFor(() => expect(tagsApi.editSchema).toHaveBeenCalledTimes(1))
    expect(tagsApi.editSchema).toHaveBeenCalledWith({
      kind: 'rename-field',
      from: 'Role',
      to: 'Job title',
      runId: expect.any(String)
    })
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Renamed Role to Job title in 8 items.')
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('warns when locked notes or notes that already had the new name were skipped', async () => {
    tagsApi.editSchema.mockResolvedValue({
      snapshot: emptySnapshot,
      rename: { notes: 3, tasks: 0, skippedLocked: 2, skippedExisting: 1 }
    })
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, 'Job title')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1))
    const message = toastMock.warning.mock.calls[0][0] as string
    expect(message).toContain('Renamed Role to Job title in 3 items.')
    expect(message).toContain('2 locked notes finish when they are unlocked.')
    expect(message).toContain('1 note already had Job title and keeps both.')
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('shows live progress for the run and locks the dialog until it finishes', async () => {
    let finish: (value: unknown) => void = () => {}
    tagsApi.editSchema.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    let emit: (event: { runId: string; done: number; total: number }) => void = () => {}
    vi.mocked(window.api.onTagsProgress).mockImplementation((callback) => {
      emit = callback
      return () => {}
    })
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/7 notes have a Role value/)).toBeInTheDocument()
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, 'Job title')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    expect(await within(dialog).findByText('Renaming in notes')).toBeInTheDocument()
    expect(within(dialog).getByText('0 / 7')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(input).toBeDisabled()

    const { runId } = tagsApi.editSchema.mock.calls[0][0] as { runId: string }
    act(() => emit({ runId: 'someone-elses-run', done: 1, total: 99 }))
    expect(within(dialog).getByText('0 / 7')).toBeInTheDocument()
    act(() => emit({ runId, done: 5, total: 7 }))
    expect(within(dialog).getByText('5 / 7')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await act(async () => finish({ snapshot: emptySnapshot, rename: { notes: 7, tasks: 0 } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('reports a failed rename and lets the user retry', async () => {
    tagsApi.editSchema.mockRejectedValue(new Error('vault locked'))
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    await user.clear(input)
    await user.type(input, 'Job title')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('vault locked'))
    expect(within(dialog).queryByText('Renaming in notes')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeEnabled()
  })

  it('closes without renaming when cancelled', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Role', 'Rename…')
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(tagsApi.editSchema).not.toHaveBeenCalled()
  })
})

describe('FieldListEditor relation settings', () => {
  it('prefills the relation and saves the edited target, cardinality and inverse', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Employer', 'Relation settings')

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('combobox', { name: 'Points to notes tagged' })
    ).toHaveTextContent('company')
    expect(within(dialog).getByRole('radio', { name: 'One' })).toBeChecked()

    await user.click(within(dialog).getByRole('radio', { name: 'Many' }))
    const inverse = within(dialog).getByRole('textbox')
    expect(inverse).toHaveValue('People')
    await user.clear(inverse)
    await user.type(inverse, '  Staff  ')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(tagsApi.editSchema).toHaveBeenCalledWith({
        kind: 'set-relation',
        tag: 'person',
        name: 'Employer',
        relation: { target: 'company', many: true, inverse: 'Staff' }
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('repoints the relation to another tag from the picker', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Employer', 'Relation settings')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('combobox', { name: 'Points to notes tagged' }))
    await user.click(await screen.findByRole('option', { name: 'person' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(tagsApi.editSchema).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'set-relation',
          relation: { target: 'person', many: false, inverse: 'People' }
        })
      )
    )
  })

  it('keeps the dialog open and reports the failure when saving the relation fails', async () => {
    tagsApi.editSchema.mockRejectedValue(new Error('conflict'))
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Employer', 'Relation settings')
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' })
    )

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('conflict'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes the relation dialog on Escape without saving', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Employer', 'Relation settings')
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(tagsApi.editSchema).not.toHaveBeenCalled()
  })

  it('cannot save a relation that points nowhere yet, and cancel discards edits', async () => {
    const user = userEvent.setup()
    renderEditor()

    await openFieldMenu(user, 'Friends', 'Relation settings')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('On the linked page, list them as')).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: 'Many' })).toBeChecked()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(tagsApi.editSchema).not.toHaveBeenCalled()
  })
})
