import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldType, ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { ImpactResult, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { TagSettingsSheet } from './TagSettingsSheet'

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab: vi.fn() }) }))

function field(name: string, type: FieldType): ResolvedField {
  return { name, type, definedBy: 'person', relation: null }
}

function resolvedTag(key: string, overrides: Partial<ResolvedTag> = {}): ResolvedTag {
  return {
    name: key,
    key,
    color: 'rose',
    icon: null,
    editable: true,
    ownFields: [],
    inherited: [],
    effectiveFields: [],
    hasFields: false,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null,
    ...overrides
  }
}

const personFields = [field('Role', 'text'), field('Birthday', 'date')]
const person = resolvedTag('person', {
  ownFields: personFields,
  effectiveFields: personFields,
  hasFields: true
})
const company = resolvedTag('company')

let snapshot: TagSchemaSnapshot
let noteTags: Array<Record<string, unknown>>
let deleteImpact: ImpactResult

const tagsApi = {
  getSchemaSnapshot: vi.fn(),
  getAllWithCounts: vi.fn(),
  listCategories: vi.fn(),
  previewImpact: vi.fn(),
  editSchema: vi.fn(),
  updateTagColor: vi.fn(),
  updateTagIcon: vi.fn(),
  deleteTag: vi.fn(),
  reorder: vi.fn()
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  snapshot = {
    tags: { person, company },
    objects: {},
    presets: [],
    presetStripDismissed: false
  }
  noteTags = [
    { name: 'person', color: 'rose', count: 9, icon: null, categoryId: 'cat-people', sortOrder: 0 },
    { name: 'company', color: 'blue', count: 4, icon: null, categoryId: null, sortOrder: 0 },
    { name: 'client', color: 'amber', count: 1, icon: null, categoryId: 'cat-work', sortOrder: 0 }
  ]
  deleteImpact = {
    kind: 'delete-tag',
    notes: 9,
    tasks: 2,
    values: 14,
    fields: 2,
    templateName: 'Person template'
  }
  tagsApi.getSchemaSnapshot.mockImplementation(async () => snapshot)
  tagsApi.getAllWithCounts.mockImplementation(async () => ({ tags: noteTags }))
  tagsApi.listCategories.mockResolvedValue({
    success: true,
    categories: [
      { id: 'cat-people', name: 'People', sortOrder: 0, tagCount: 1 },
      { id: 'cat-work', name: 'Work', sortOrder: 1, tagCount: 3 }
    ]
  })
  tagsApi.previewImpact.mockImplementation(async () => deleteImpact)
  tagsApi.editSchema.mockResolvedValue({ snapshot })
  tagsApi.updateTagColor.mockResolvedValue({ success: true })
  tagsApi.updateTagIcon.mockResolvedValue({ success: true })
  tagsApi.deleteTag.mockResolvedValue({ success: true })
  tagsApi.reorder.mockResolvedValue({ success: true })
  Object.assign(window.api.tags, tagsApi)
  Object.assign(window.api, {
    onTagCategoriesChanged: vi.fn(() => () => {}),
    onPropertyDefinitionChanged: vi.fn(() => () => {})
  })
})

function renderSheet(tag = 'person', onClose = vi.fn()): { onClose: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TagSettingsSheet tag={tag} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

describe('TagSettingsSheet header', () => {
  it('names the tag and counts the notes and tasks it will touch when the tag has fields', async () => {
    renderSheet()

    expect(screen.getByRole('complementary', { name: 'Settings for #person' })).toBeInTheDocument()
    expect(screen.getByText('#person')).toBeInTheDocument()
    expect(await screen.findByText('On 9 notes and 2 tasks')).toBeInTheDocument()
  })

  it('counts only notes for a tag without fields', async () => {
    renderSheet('company')

    expect(await screen.findByText('On 4 notes')).toBeInTheDocument()
    expect(screen.queryByText(/tasks/)).not.toBeInTheDocument()
  })

  it('lists the tag fields under a counted Fields heading', async () => {
    renderSheet()

    expect(await screen.findByRole('heading', { name: 'Fields · 2' })).toBeInTheDocument()
    expect(screen.getByText('Role')).toBeInTheDocument()
    expect(screen.getByText('Birthday')).toBeInTheDocument()
  })

  it('closes from the close button and from Escape', async () => {
    const user = userEvent.setup()
    const { onClose } = renderSheet()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('tells the user to update when a newer version wrote the tag, and locks editing', async () => {
    snapshot.tags.person = { ...person, editable: false }
    renderSheet()

    expect(await screen.findByText(/A newer version of Memry changed this tag/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Extends' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Actions for Role' })).not.toBeInTheDocument()
  })
})

describe('TagSettingsSheet appearance', () => {
  it('shows the current colour and category', async () => {
    renderSheet()

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Colour' })).toHaveTextContent('Rose')
    )
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('People')
    )
  })

  it('shows No category for a tag outside every category', async () => {
    renderSheet('company')

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('No category')
    )
  })

  it('changes the tag colour', async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(await screen.findByRole('combobox', { name: 'Colour' }))
    await user.click(await screen.findByRole('option', { name: 'Sage' }))

    await waitFor(() =>
      expect(tagsApi.updateTagColor).toHaveBeenCalledWith({ tag: 'person', color: 'sage' })
    )
  })

  it('reports why a colour change was refused', async () => {
    tagsApi.updateTagColor.mockResolvedValue({ success: false, error: 'Tag is locked' })
    const user = userEvent.setup()
    renderSheet()

    await user.click(await screen.findByRole('combobox', { name: 'Colour' }))
    await user.click(await screen.findByRole('option', { name: 'Sage' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Tag is locked'))
  })

  it('reports an icon change that fails with a thrown error', async () => {
    tagsApi.updateTagIcon.mockRejectedValue(new Error('icon store offline'))
    noteTags[0].icon = '📚'
    const user = userEvent.setup()
    renderSheet()

    await user.click(await screen.findByRole('button', { name: 'Change icon' }))
    await user.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(tagsApi.updateTagIcon).toHaveBeenCalledWith({ tag: 'person', icon: null })
    )
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('icon store offline'))
  })

  it('moves the tag into another category, after the tags already there', async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(await screen.findByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'Work' }))

    await waitFor(() =>
      expect(tagsApi.reorder).toHaveBeenCalledWith({
        tags: [{ tag: 'person', categoryId: 'cat-work', sortOrder: 1 }]
      })
    )
  })

  it('takes the tag out of its category', async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(await screen.findByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'No category' }))

    await waitFor(() =>
      expect(tagsApi.reorder).toHaveBeenCalledWith({
        tags: [{ tag: 'person', categoryId: null, sortOrder: 0 }]
      })
    )
  })
})

describe('TagSettingsSheet delete tag', () => {
  async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: 'Delete tag' }))
    return screen.findByRole('dialog')
  }

  it('spells out what is lost, including the template, before deleting', async () => {
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)

    expect(within(dialog).getByText('Delete #person?')).toBeInTheDocument()
    expect(
      await within(dialog).findByText(
        '#person will be removed from 9 notes and the tag goes away with its 2 fields and template.'
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByText('notes keep their text')).toBeInTheDocument()
    expect(within(dialog).getByText('14')).toBeInTheDocument()
    expect(within(dialog).getByText('values stay as properties')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Notes that mention #person in their text keep it as plain text.')
    ).toBeInTheDocument()
  })

  it('omits the template from the warning when the tag has none', async () => {
    deleteImpact = {
      ...(deleteImpact as Extract<ImpactResult, { kind: 'delete-tag' }>),
      templateName: null
    }
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)

    expect(
      await within(dialog).findByText(
        '#person will be removed from 9 notes and the tag goes away with its 2 fields.'
      )
    ).toBeInTheDocument()
  })

  it('gives a plain warning and no stats for a tag without fields', async () => {
    deleteImpact = {
      kind: 'delete-tag',
      notes: 4,
      tasks: 0,
      values: 0,
      fields: 0,
      templateName: null
    }
    const user = userEvent.setup()
    renderSheet('company')

    const dialog = await openDeleteDialog(user)

    expect(
      await within(dialog).findByText(
        '#company will be removed from every note that has it in its tags.'
      )
    ).toBeInTheDocument()
    expect(within(dialog).queryByText('notes keep their text')).not.toBeInTheDocument()
  })

  it('cannot be confirmed before the impact is known', async () => {
    tagsApi.previewImpact.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)

    expect(within(dialog).getByRole('button', { name: 'Delete tag' })).toBeDisabled()
  })

  it('deletes nothing when cancelled', async () => {
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(tagsApi.deleteTag).not.toHaveBeenCalled()
  })

  it('deletes the tag, confirms with a toast and closes the dialog', async () => {
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)
    await within(dialog).findByText(/will be removed from 9 notes/)
    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }))

    await waitFor(() => expect(tagsApi.deleteTag).toHaveBeenCalledWith('person'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Deleted #person.'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the dialog open and says why when the delete is refused', async () => {
    tagsApi.deleteTag.mockResolvedValue({ success: false, error: 'Tag is in use by a sync run' })
    const user = userEvent.setup()
    renderSheet()

    const dialog = await openDeleteDialog(user)
    await within(dialog).findByText(/will be removed from 9 notes/)
    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Tag is in use by a sync run'))
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
