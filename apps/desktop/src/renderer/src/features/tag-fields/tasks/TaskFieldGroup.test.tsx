import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { TaskFieldGroups } from './TaskFieldGroup'

vi.mock('@/hooks/use-calendar-properties', () => ({
  useCalendarProperties: () => ({ isEnabled: () => false, setEnabled: vi.fn() })
}))
vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({ refresh: vi.fn(), getDefinition: () => undefined })
}))
// The relation picker resolves note titles over IPC; the row only hands it the field's config.
vi.mock('@/components/note/info-section/editors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/note/info-section/editors')>()),
  RelationEditor: ({
    value,
    targetTag,
    many,
    onChange
  }: {
    value: string[]
    targetTag?: string | null
    many?: boolean
    onChange: (next: string[]) => void
  }) => (
    <div>
      <span>
        relation target={String(targetTag)} many={String(many)} value={value.join(',')}
      </span>
      <button type="button" onClick={() => onChange([])}>
        clear-relation
      </button>
    </div>
  )
}))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as { tags: Record<string, Fn>; onPropertyDefinitionChanged: Fn }

const field = (
  name: string,
  type: ResolvedField['type'],
  definedBy: string,
  relation: ResolvedField['relation'] = null
): ResolvedField => ({ name, type, relation, definedBy })

const tag = (key: string, overrides: Partial<ResolvedTag> = {}): ResolvedTag => ({
  name: key,
  key,
  color: 'blue',
  icon: null,
  editable: true,
  ownFields: [],
  inherited: [],
  effectiveFields: [],
  hasFields: true,
  extends: null,
  ancestors: [],
  template: null,
  preset: null,
  ownPreset: null,
  ...overrides
})

const role = field('Role', 'text', 'person')
const visits = field('Visits', 'number', 'person')
const vip = field('VIP', 'checkbox', 'person')
const company = field('Company', 'relation', 'person', {
  target: 'company',
  many: false,
  inverse: null
})
const team = field('Team', 'text', 'employee')

const snapshot: TagSchemaSnapshot = {
  tags: {
    person: tag('person', {
      ownFields: [role, visits, vip, company],
      effectiveFields: [role, visits, vip, company]
    }),
    employee: tag('employee', {
      extends: 'person',
      ancestors: ['person'],
      ownFields: [team],
      inherited: [{ from: 'person', fields: [role, visits, vip, company] }],
      effectiveFields: [role, visits, vip, company, team]
    }),
    plain: tag('plain', { hasFields: false })
  },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

type Fields = Record<string, string | number | boolean | string[] | null>

function Harness({
  tags,
  initial,
  onPatch
}: {
  tags: string[]
  initial: Fields
  onPatch: (patch: Fields) => void
}) {
  const [fields, setFields] = useState<Fields>(initial)
  return (
    <TaskFieldGroups
      tags={tags}
      fields={fields}
      onFieldsChange={(patch) => {
        onPatch(patch as Fields)
        setFields((current) => {
          const next = { ...current }
          for (const [name, value] of Object.entries(patch)) {
            if (value === null) delete next[name]
            else next[name] = value as Fields[string]
          }
          return next
        })
      }}
    />
  )
}

function renderGroups(tags: string[], initial: Fields = {}) {
  const onPatch = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <Harness tags={tags} initial={initial} onPatch={onPatch} />
    </QueryClientProvider>
  )
  return { onPatch, ...view }
}

const cardOf = (title: string): HTMLElement =>
  screen.getByText(title).closest('section') as HTMLElement

/** The schema snapshot has loaded and the groups were built from it. */
async function snapshotLoaded(): Promise<void> {
  await vi.waitFor(() => expect(api.tags.getSchemaSnapshot).toHaveBeenCalled())
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
}

beforeEach(() => {
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
})

describe('task field groups', () => {
  it('shows a card per tag with fields, and the inherited fields under "<Parent> via #<tag>"', async () => {
    renderGroups(['employee'])

    expect(await screen.findByText('Employee')).toBeInTheDocument()
    expect(screen.getByText('Person via #employee')).toBeInTheDocument()
    expect(within(cardOf('Employee')).getByText('Team')).toBeInTheDocument()
    const inherited = within(cardOf('Person via #employee'))
    for (const name of ['Role', 'Visits', 'VIP', 'Company']) {
      expect(inherited.getByText(name)).toBeInTheDocument()
    }
  })

  it('renders nothing for a task whose tags have no fields', async () => {
    const { container } = renderGroups(['plain', 'unknown'])

    await snapshotLoaded()
    expect(container).toBeEmptyDOMElement()
  })

  it('passes a relation field its target tag and cardinality, and shows its stored value', async () => {
    renderGroups(['person'], { Company: ['memry://note/acme'] })

    expect(
      await screen.findByText('relation target=company many=false value=memry://note/acme')
    ).toBeInTheDocument()
  })

  it('writes a typed text value as a one-field patch', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'])
    await screen.findByText('Role')

    await user.click(within(cardOf('Person')).getAllByText('Empty')[0])
    await user.keyboard('CTO{Enter}')

    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ Role: 'CTO' })
    expect(await screen.findByText('CTO')).toBeInTheDocument()
  })

  it('writes nothing when a value is left unchanged', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'], { Role: 'CTO' })
    await screen.findByText('Person')

    await user.click(screen.getByText('CTO'))
    expect(screen.getByRole('textbox')).toHaveValue('CTO')
    await user.keyboard('{Enter}')

    expect(onPatch).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('clears a field with a null patch when the user empties it', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'], { Role: 'CTO' })
    await screen.findByText('Person')

    await user.click(screen.getByText('CTO'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')

    expect(onPatch).toHaveBeenCalledWith({ Role: null })
    expect(screen.queryByText('CTO')).not.toBeInTheDocument()
  })

  it('writes nothing when an empty field is blurred still empty', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'])
    await screen.findByText('Role')

    await user.click(within(cardOf('Person')).getAllByText('Empty')[0])
    await user.keyboard('{Enter}')

    expect(onPatch).not.toHaveBeenCalled()
  })

  it('writes a toggled checkbox and a number as typed values', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'])
    await screen.findByText('VIP')

    await user.click(screen.getByRole('checkbox'))
    expect(onPatch).toHaveBeenLastCalledWith({ VIP: true })

    await user.click(within(cardOf('Person')).getAllByText('Empty')[1])
    await user.keyboard('3{Enter}')
    expect(onPatch).toHaveBeenLastCalledWith({ Visits: 3 })
  })

  it('shows values that no tag declares in a "This task" card, typed from the value', async () => {
    renderGroups(['person'], { Budget: 1200, Urgent: true, Note: 'call back', Spare: '' })
    await snapshotLoaded()

    expect(screen.getByText('This task')).toBeInTheDocument()
    const own = within(cardOf('This task'))
    expect(own.getByText('Budget')).toBeInTheDocument()
    expect(own.getByText('1200')).toBeInTheDocument()
    expect(own.getByRole('checkbox')).toBeChecked()
    expect(own.getByText('call back')).toBeInTheDocument()
    expect(own.queryByText('Spare')).not.toBeInTheDocument()
  })

  it('shows relation-shaped leftovers as relations', async () => {
    renderGroups(['person'], { 'Waiting on': ['memry://note/acme'] })
    await snapshotLoaded()

    expect(
      screen.getByText('relation target=undefined many=undefined value=memry://note/acme')
    ).toBeInTheDocument()
  })

  it('writes an edit to a leftover value back under the same name', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'], { Note: 'call back' })
    await snapshotLoaded()

    await user.click(screen.getByText('call back'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('send invoice{Enter}')

    expect(onPatch).toHaveBeenCalledWith({ Note: 'send invoice' })
    expect(screen.getByText('send invoice')).toBeInTheDocument()
  })

  it('lets the user clear a leftover value from its card', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderGroups(['person'], { Budget: 1200 })
    await snapshotLoaded()

    await user.click(screen.getByRole('button', { name: 'Clear Budget' }))

    expect(onPatch).toHaveBeenCalledWith({ Budget: null })
    expect(screen.queryByText('Budget')).not.toBeInTheDocument()
  })

  it('shows only leftover values, without tag cards, when the task has no tagged fields', async () => {
    renderGroups(['plain'], { Budget: 1200 })
    await snapshotLoaded()

    expect(screen.getByText('This task')).toBeInTheDocument()
    expect(screen.queryByText('Plain')).not.toBeInTheDocument()
  })
})
