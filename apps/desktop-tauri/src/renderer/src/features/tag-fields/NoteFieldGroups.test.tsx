import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldGroup } from './build-field-groups'
import { NoteFieldGroups } from './NoteFieldGroups'

function field(name: string, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { name, type: 'text', relation: null, definedBy: 'person', ...extra }
}

function makeTag(name: string, fields: ResolvedField[], icon: string | null = null): ResolvedTag {
  return {
    name,
    key: name.toLowerCase(),
    color: 'blue',
    icon,
    editable: true,
    ownFields: fields,
    inherited: [],
    effectiveFields: fields,
    hasFields: true,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null
  }
}

const person = makeTag('Person', [
  field('Company'),
  field('Age', { type: 'number' }),
  field('Email')
])

function groupOf(tag: ResolvedTag, values: unknown[], via: ResolvedTag | null = null): FieldGroup {
  return {
    tag,
    via,
    slots: tag.ownFields.map((f, i) => ({ field: f, value: values[i] }))
  }
}

// PropertyRow loads property definitions on mount; let that settle inside act.
async function renderSettled(ui: React.ReactElement) {
  const view = renderWithProviders(ui)
  await act(async () => {})
  return view
}

describe('NoteFieldGroups', () => {
  it('lists each tag group with its fields and their current values', async () => {
    await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(person, ['Acme', 42, undefined])]}
        onFieldChange={vi.fn()}
      />
    )

    const group = screen.getByTestId('tag-field-group')
    expect(within(group).getByText('Person')).toBeInTheDocument()
    const list = within(group).getByRole('list', { name: 'Person' })
    expect(within(list).getByText('Company')).toBeInTheDocument()
    expect(within(list).getByText('Acme')).toBeInTheDocument()
    expect(within(list).getByText('Age')).toBeInTheDocument()
    expect(within(list).getByText('42')).toBeInTheDocument()
  })

  it('names the tag an inherited group comes through', async () => {
    const client = makeTag('Client', [])
    await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(makeTag('Contact', [field('Phone')]), [undefined], client)]}
        onFieldChange={vi.fn()}
      />
    )

    expect(screen.getByText('via #client')).toBeInTheDocument()
  })

  it('reports an edited empty field with its name, new value and type', async () => {
    const onFieldChange = vi.fn()
    await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(person, [undefined, 42, 'x'])]}
        onFieldChange={onFieldChange}
      />
    )

    await userEvent.click(screen.getByText('Empty'))
    await userEvent.keyboard('Acme{Enter}')

    expect(onFieldChange).toHaveBeenCalledWith('Company', 'Acme', 'text')
  })

  it('opens the tag from the group menu', async () => {
    const onOpenTag = vi.fn()
    await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(person, ['Acme', 1, 'x'])]}
        onFieldChange={vi.fn()}
        onOpenTag={onOpenTag}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Person options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open #person' }))

    expect(onOpenTag).toHaveBeenCalledWith(person)
  })

  it('shows no group menu when the host cannot open tags', async () => {
    await renderSettled(
      <NoteFieldGroups groups={[groupOf(person, ['Acme', 1, 'x'])]} onFieldChange={vi.fn()} />
    )

    expect(screen.queryByRole('button', { name: 'Person options' })).not.toBeInTheDocument()
  })

  it('lets the host replace a slot and add group actions and footers', async () => {
    await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(person, [undefined, undefined, undefined])]}
        onFieldChange={vi.fn()}
        renderGroupAction={(group) => <span>action for {group.tag.name}</span>}
        renderSlot={(_group, slot) =>
          slot.field.name === 'Company' ? <li key={slot.field.name}>custom Company slot</li> : null
        }
        renderGroupFooter={(group) => <p>footer for {group.tag.name}</p>}
      />
    )

    expect(screen.getByText('custom Company slot')).toBeInTheDocument()
    expect(screen.getByText('Age')).toBeInTheDocument()
    expect(screen.getByText('action for Person')).toBeInTheDocument()
    expect(screen.getByText('footer for Person')).toBeInTheDocument()
  })

  it('renders a custom tag icon instead of the default hash glyph', async () => {
    const { container } = await renderSettled(
      <NoteFieldGroups
        groups={[groupOf(makeTag('Book', [field('Author')], '📚'), [undefined])]}
        onFieldChange={vi.fn()}
      />
    )

    expect(container.querySelector('[data-testid="tag-field-group"]')).toHaveTextContent('📚')
  })
})
