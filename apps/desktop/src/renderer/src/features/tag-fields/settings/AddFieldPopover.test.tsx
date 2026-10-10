import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldType, ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { AddFieldPopover } from './AddFieldPopover'

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

function field(name: string, type: FieldType, definedBy: string): ResolvedField {
  return { name, type, definedBy, relation: null }
}

function resolvedTag(
  key: string,
  ownFields: ResolvedField[],
  inheritedFields: ResolvedField[] = []
): ResolvedTag {
  return {
    name: key,
    key,
    color: '',
    icon: null,
    editable: true,
    ownFields,
    inherited: [],
    effectiveFields: [...inheritedFields, ...ownFields],
    hasFields: ownFields.length + inheritedFields.length > 0,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null
  }
}

const person = resolvedTag(
  'person',
  [field('Role', 'text', 'person')],
  [field('Email', 'url', 'contact')]
)
const company = resolvedTag('company', [field('Stage', 'select', 'company')])
const snapshot: TagSchemaSnapshot = {
  tags: { person, company },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

const api = {
  editSchema: vi.fn(),
  getAllWithCounts: vi.fn(),
  getPropertyDefinitions: vi.fn(),
  getAvailableProperties: vi.fn()
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  api.editSchema.mockResolvedValue({ snapshot })
  api.getAllWithCounts.mockResolvedValue({
    tags: [
      { name: 'company', color: 'blue', count: 4, icon: null },
      { name: 'person', color: 'rose', count: 9, icon: null }
    ]
  })
  api.getPropertyDefinitions.mockResolvedValue([
    { name: 'Stage', type: 'select', options: JSON.stringify([{ value: 'Idea', color: 'blue' }]) },
    { name: 'Score', type: 'rating', options: null },
    { name: 'Mood', type: 'multiselect', options: JSON.stringify(['Calm', 'Busy']) },
    { name: 'Weird', type: 'text', options: '{not json' },
    { name: 'tags', type: 'multiselect', options: null }
  ])
  api.getAvailableProperties.mockResolvedValue({
    builtIn: [],
    properties: [
      { name: 'Stage', type: 'select', usageCount: 12 },
      { name: 'Source', type: 'url', usageCount: 30 },
      { name: 'Aliases', type: 'multiselect', usageCount: 99 }
    ]
  })
  Object.assign(window.api.tags, {
    getAllWithCounts: api.getAllWithCounts,
    editSchema: api.editSchema
  })
  Object.assign(window.api.notes, { getPropertyDefinitions: api.getPropertyDefinitions })
  Object.assign(window.api, { folderView: { getAvailableProperties: api.getAvailableProperties } })
})

function renderPopover(
  props: { tag?: ResolvedTag | null; disabled?: boolean } = {}
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AddFieldPopover
        tagKey="person"
        tag={props.tag === undefined ? person : props.tag}
        snapshot={snapshot}
        disabled={props.disabled}
      />
    </QueryClientProvider>
  )
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Add field' }))
  return screen.findByRole('dialog')
}

const NEW_TYPE_LABELS: Array<[FieldType, string]> = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['date', 'Date'],
  ['url', 'URL'],
  ['status', 'Status'],
  ['select', 'Select'],
  ['multiselect', 'Multi-select'],
  ['checkbox', 'Checkbox']
]

describe('AddFieldPopover new fields', () => {
  it('does not open for a read-only tag', async () => {
    const user = userEvent.setup()
    renderPopover({ disabled: true })

    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps every type disabled until a field name is typed', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)

    for (const [, label] of NEW_TYPE_LABELS) {
      expect(within(popover).getByRole('button', { name: label })).toBeDisabled()
    }
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Birthday')
    expect(within(popover).getByRole('button', { name: 'Date' })).toBeEnabled()
  })

  it.each(NEW_TYPE_LABELS)(
    'adds a %s field with the typed name and closes',
    async (type, label) => {
      const user = userEvent.setup()
      renderPopover()

      const popover = await openPopover(user)
      await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), '  Birthday ')
      await user.click(within(popover).getByRole('button', { name: label }))

      await waitFor(() =>
        expect(api.editSchema).toHaveBeenCalledWith({
          kind: 'add-field',
          tag: 'person',
          field: { name: 'Birthday', type }
        })
      )
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
  )

  it('adds a text field when Enter is pressed in the name box', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Nickname{Enter}')

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: { name: 'Nickname', type: 'text' }
      })
    )
  })

  it('ignores Enter on an empty name', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), '{Enter}')

    expect(api.editSchema).not.toHaveBeenCalled()
  })

  it.each([
    ['a reserved frontmatter key', 'Aliases', 'Aliases is reserved and cannot be a field.'],
    ['a field the tag already has', 'role', '#person already has role.'],
    ['a field the tag inherits', 'EMAIL', '#person already has EMAIL.']
  ])('refuses %s', async (_label, typed, message) => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    const input = within(popover).getByRole('textbox', { name: 'Field name' })
    await user.type(input, typed)

    expect(within(popover).getByText(message)).toBeInTheDocument()
    expect(within(popover).getByRole('button', { name: 'Text' })).toBeDisabled()
    await user.type(input, '{Enter}')
    expect(api.editSchema).not.toHaveBeenCalled()
  })

  it('keeps the popover open and reports the failure when adding is rejected', async () => {
    api.editSchema.mockRejectedValue(new Error('schema conflict'))
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Birthday')
    await user.click(within(popover).getByRole('button', { name: 'Date' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('schema conflict'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('forgets the typed name when the popover is closed and reopened', async () => {
    const user = userEvent.setup()
    renderPopover()

    let popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Draft')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    popover = await openPopover(user)
    expect(within(popover).getByRole('textbox', { name: 'Field name' })).toHaveValue('')
  })
})

describe('AddFieldPopover relation fields', () => {
  it('collects target, cardinality and inverse before adding a relation field', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Employer')
    await user.click(within(popover).getByRole('button', { name: /^Relation/ }))

    expect(api.editSchema).not.toHaveBeenCalled()
    const submit = within(popover).getByRole('button', { name: 'Add field' })
    expect(submit).toBeDisabled()

    await user.click(within(popover).getByRole('combobox', { name: 'Points to notes tagged' }))
    await user.click(await screen.findByRole('option', { name: 'company' }))
    await user.click(within(popover).getByRole('radio', { name: 'Many' }))
    await user.type(within(popover).getByRole('textbox'), 'Staff')
    await user.click(submit)

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: {
          name: 'Employer',
          type: 'relation',
          relation: { target: 'company', many: true, inverse: 'Staff' }
        }
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('drops the half-built relation when cancelled', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'Employer')
    await user.click(within(popover).getByRole('button', { name: /^Relation/ }))
    await user.click(within(popover).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.editSchema).not.toHaveBeenCalled()
  })
})

describe('AddFieldPopover reusing vault properties', () => {
  it('suggests matching existing properties with their type and usage, most used first, minus ones the tag has', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'e')

    expect(await within(popover).findByText('Existing properties')).toBeInTheDocument()
    const suggestions = within(popover)
      .getAllByRole('button')
      .filter((button) => /reuse$/.test(button.textContent ?? ''))
      .map((button) => button.textContent)
    expect(suggestions).toEqual([
      'SourceURL · on 30 notes · reuse',
      'StageSelect · on 12 notes · reuse',
      'ScoreNumber · on 0 notes · reuse',
      'WeirdText · on 0 notes · reuse'
    ])
    expect(within(popover).queryByText('Role')).not.toBeInTheDocument()
    expect(within(popover).queryByText('Email')).not.toBeInTheDocument()
  })

  it('never suggests reserved property names', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'a')

    await within(popover).findByText('Existing properties')
    expect(within(popover).queryByText('Aliases')).not.toBeInTheDocument()
    expect(within(popover).queryByText('tags')).not.toBeInTheDocument()
  })

  it('adds the tag field with the existing property name and type in one click', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'sour')
    await user.click(await within(popover).findByRole('button', { name: /^SourceURL/ }))

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: { name: 'Source', type: 'url' }
      })
    )
  })

  it('reuses a legacy rating property as a number field', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), 'scor')
    await user.click(await within(popover).findByRole('button', { name: /^ScoreNumber/ }))

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: { name: 'Score', type: 'number' }
      })
    )
  })

  it('does not load vault properties until the popover opens', async () => {
    renderPopover()

    await Promise.resolve()
    expect(api.getPropertyDefinitions).not.toHaveBeenCalled()
    expect(api.getAvailableProperties).not.toHaveBeenCalled()
  })
})

describe('AddFieldPopover shared property step', () => {
  async function typeExistingName(
    user: ReturnType<typeof userEvent.setup>,
    typed: string,
    typeLabel: string | RegExp
  ): Promise<HTMLElement> {
    const popover = await openPopover(user)
    await user.type(within(popover).getByRole('textbox', { name: 'Field name' }), typed)
    await within(popover).findByText('Existing properties')
    await user.click(within(popover).getByRole('button', { name: typeLabel }))
    return popover
  }

  it('explains that the property exists with its options and which tags share it', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'stage', 'Select')

    expect(within(popover).getByText('New field on #person')).toBeInTheDocument()
    expect(within(popover).getByRole('textbox')).toHaveValue('Stage')
    expect(
      within(popover).getByText(
        'Stage already exists in this vault with Idea. #person will share it with your company notes.'
      )
    ).toBeInTheDocument()
    expect(api.editSchema).not.toHaveBeenCalled()
  })

  it('lists options stored as bare strings, and ignores options that are not valid JSON', async () => {
    const user = userEvent.setup()
    renderPopover()

    const mood = await typeExistingName(user, 'mood', 'Select')
    expect(
      within(mood).getByText(
        'Mood already exists in this vault with Calm and Busy. #person will share it with your other notes.'
      )
    ).toBeInTheDocument()
    await user.click(within(mood).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const weird = await typeExistingName(user, 'weird', 'Select')
    expect(
      within(weird).getByText(
        'Weird already exists in this vault as a Text property. #person will share it with your other notes.'
      )
    ).toBeInTheDocument()
  })

  it('says the property exists as a typed property when it has no options and no other tag owns it', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'source', 'Text')

    expect(
      within(popover).getByText(
        'Source already exists in this vault as a URL property. #person will share it with your other notes.'
      )
    ).toBeInTheDocument()
  })

  it('shares the existing property under its stored name on confirm', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'SOURCE', 'Number')
    await user.click(within(popover).getByRole('button', { name: 'Share Source' }))

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: { name: 'Source', type: 'number' }
      })
    )
  })

  it('offers a tag-prefixed alternative name that becomes a brand-new field', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'stage', 'Select')
    await user.click(within(popover).getByRole('button', { name: 'Use Person stage instead' }))

    expect(within(popover).getByRole('textbox')).toHaveValue('Person stage')
    await user.click(within(popover).getByRole('button', { name: 'Add field' }))

    await waitFor(() =>
      expect(api.editSchema).toHaveBeenCalledWith({
        kind: 'add-field',
        tag: 'person',
        field: { name: 'Person stage', type: 'select' }
      })
    )
  })

  it('routes a shared relation through the relation card', async () => {
    api.getPropertyDefinitions.mockResolvedValue([{ name: 'Owner', type: 'text', options: null }])
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'owner', /^Relation/)
    await user.click(within(popover).getByRole('button', { name: 'Share Owner' }))

    expect(
      await within(popover).findByRole('combobox', { name: 'Points to notes tagged' })
    ).toBeInTheDocument()
    expect(api.editSchema).not.toHaveBeenCalled()
  })

  it('leaves without adding anything when cancelled', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'stage', 'Select')
    await user.click(within(popover).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.editSchema).not.toHaveBeenCalled()
  })

  it('blocks sharing once the edited name collides with a field the tag has', async () => {
    const user = userEvent.setup()
    renderPopover()

    const popover = await typeExistingName(user, 'stage', 'Select')
    const input = within(popover).getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Role')

    expect(within(popover).getByText('#person already has Role.')).toBeInTheDocument()
    expect(within(popover).getByRole('button', { name: 'Add field' })).toBeDisabled()
  })
})
