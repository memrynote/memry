import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import {
  GroupValueTitle,
  LinkedFilterBar,
  MentionedInSection,
  NewInGroupButton,
  RelationPickerCell,
  TagTableProvider,
  relationGroupUris,
  updateTaskField,
  useTagTable,
  withLinkedFilter
} from './tag-table'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

type Api = {
  tags: Record<string, Mock>
  notes: Record<string, Mock>
  tasks: Record<string, Mock>
  properties: Record<string, Mock>
  folderView: Record<string, Mock>
  onTagsChanged: Mock
  onPropertyDefinitionChanged: Mock
}
const api = window.api as unknown as Api

function field(name: string, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { name, type: 'text', relation: null, definedBy: 'person', ...extra }
}

function makeTag(name: string, fields: ResolvedField[], hasFields = true): ResolvedTag {
  return {
    name,
    key: name.toLowerCase(),
    color: 'blue',
    icon: null,
    editable: true,
    ownFields: fields,
    inherited: [],
    effectiveFields: fields,
    hasFields,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null
  }
}

const person = makeTag('Person', [
  field('Role'),
  field('Employer', {
    type: 'relation',
    relation: { target: 'company', many: false, inverse: null }
  })
])
const company = makeTag('Company', [])
const snapshot: TagSchemaSnapshot = {
  tags: { person, company },
  objects: { n_acme: 'company', n_globex: 'company' },
  presets: [],
  presetStripDismissed: false
}

const ACME = 'memry://note/n_acme'
const GLOBEX = 'memry://note/n_globex'
const TITLES: Record<string, string> = { [ACME]: 'Acme', [GLOBEX]: 'Globex' }

function match(id: string, title: string) {
  return {
    noteId: id,
    title,
    tag: 'company',
    groupTag: 'company',
    viaTag: null,
    subtitle: [],
    modified: '2026-01-01T00:00:00.000Z'
  }
}

beforeEach(() => {
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
  api.tags.searchObjects = vi.fn().mockResolvedValue({
    matches: [match('n_acme', 'Acme'), match('n_globex', 'Globex')],
    complete: true
  })
  api.notes.create = vi
    .fn()
    .mockResolvedValue({ success: true, note: { id: 'n_new', title: 'New Person' } })
  api.tasks.update = vi.fn().mockResolvedValue({ success: true })
  api.properties.resolveRefs = vi.fn().mockImplementation((uris: string[]) =>
    Promise.resolve(
      uris.map((uri) => ({
        uri,
        targetType: 'note',
        targetId: uri.split('/').pop(),
        title: TITLES[uri] ?? 'Unknown',
        exists: true
      }))
    )
  )
  api.folderView = { listWithProperties: vi.fn().mockResolvedValue({ notes: [] }) }
  vi.mocked(toast.error).mockClear()
})

function Probe() {
  const table = useTagTable()
  if (!table) return <p>no table</p>
  return (
    <ul>
      <li>tag {table.tag.name}</li>
      <li>Employer target {String(table.relationTargetOf('Employer'))}</li>
      <li>Role target {String(table.relationTargetOf('Role'))}</li>
      <li>Role is field {String(table.isFieldColumn('Role'))}</li>
      <li>Title is field {String(table.isFieldColumn('Title'))}</li>
    </ul>
  )
}

describe('TagTableProvider', () => {
  it('tells table cells which columns are the tag fields and which relation they target', () => {
    renderWithProviders(
      <TagTableProvider tag={person} onCreated={vi.fn()}>
        <Probe />
      </TagTableProvider>
    )

    expect(screen.getByText('tag Person')).toBeInTheDocument()
    expect(screen.getByText('Employer target company')).toBeInTheDocument()
    expect(screen.getByText('Role target null')).toBeInTheDocument()
    expect(screen.getByText('Role is field true')).toBeInTheDocument()
    expect(screen.getByText('Title is field false')).toBeInTheDocument()
  })

  it('offers no table behaviour for a tag without fields or no tag at all', () => {
    const { unmount } = renderWithProviders(
      <TagTableProvider tag={makeTag('Plain', [], false)} onCreated={vi.fn()}>
        <Probe />
        <NewInGroupButton property="Role" value="CTO" />
      </TagTableProvider>
    )
    expect(screen.getByText('no table')).toBeInTheDocument()
    expect(screen.queryByTestId('new-in-group')).not.toBeInTheDocument()
    unmount()

    renderWithProviders(
      <TagTableProvider tag={null} onCreated={vi.fn()}>
        <Probe />
      </TagTableProvider>
    )
    expect(screen.getByText('no table')).toBeInTheDocument()
  })
})

describe('NewInGroupButton', () => {
  function renderButton(property: string, value: unknown) {
    const onCreated = vi.fn()
    renderWithProviders(
      <TagTableProvider tag={person} onCreated={onCreated}>
        <NewInGroupButton property={property} value={value} />
      </TagTableProvider>
    )
    return { onCreated }
  }

  it('creates an object pre-filled with the group value and reports it', async () => {
    const { onCreated } = renderButton('Role', 'CTO')
    const button = await screen.findByRole('button', { name: 'New Person in CTO' })

    await userEvent.click(button)

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith({
        title: 'New Person',
        content: '',
        tags: ['person'],
        properties: { Role: 'CTO' }
      })
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('n_new', 'New Person', false))
  })

  it('opens the new object in a new tab on Cmd-click and on Cmd+Enter', async () => {
    const { onCreated } = renderButton('Role', 'CTO')
    const button = await screen.findByRole('button', { name: 'New Person in CTO' })

    fireEvent.click(button, { metaKey: true })
    await waitFor(() => expect(onCreated).toHaveBeenLastCalledWith('n_new', 'New Person', true))

    fireEvent.keyDown(button, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2))
    expect(onCreated).toHaveBeenLastCalledWith('n_new', 'New Person', true)
    expect(api.notes.create).toHaveBeenCalledTimes(2)
  })

  it('creates an unfiled object in the "no value" group', async () => {
    const { onCreated } = renderButton('Role', null)

    await userEvent.click(await screen.findByRole('button', { name: 'New Person' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(api.notes.create).toHaveBeenCalledWith({
      title: 'New Person',
      content: '',
      tags: ['person']
    })
  })

  it('titles a relation group by the linked objects and pre-fills the links', async () => {
    renderButton('Employer', `${ACME},${GLOBEX}`)

    const button = await screen.findByRole('button', { name: 'New Person in Acme, Globex' })
    await userEvent.click(button)

    await waitFor(() =>
      expect(api.notes.create).toHaveBeenCalledWith({
        title: 'New Person',
        content: '',
        tags: ['person'],
        properties: { Employer: [ACME, GLOBEX] }
      })
    )
  })

  it('joins a multi-value group into the label', async () => {
    renderButton('Role', ['CTO', 'Founder'])

    expect(
      await screen.findByRole('button', { name: 'New Person in CTO, Founder' })
    ).toBeInTheDocument()
  })

  it('tells the user when creating fails', async () => {
    api.notes.create.mockResolvedValue({ success: false, error: 'vault locked' })
    renderButton('Role', 'CTO')

    await userEvent.click(await screen.findByRole('button', { name: 'New Person in CTO' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault locked'))
  })
})

describe('updateTaskField', () => {
  it('writes the field value to the task, and null when cleared', async () => {
    await updateTaskField('t1', 'Effort', 3)
    expect(api.tasks.update).toHaveBeenLastCalledWith({ id: 't1', fields: { Effort: 3 } })

    await updateTaskField('t1', 'Effort', undefined)
    expect(api.tasks.update).toHaveBeenLastCalledWith({ id: 't1', fields: { Effort: null } })
  })

  it('throws the refusal so the cell can report it', async () => {
    api.tasks.update.mockResolvedValue({ success: false, error: 'task is locked' })

    await expect(updateTaskField('t1', 'Effort', 3)).rejects.toThrow('task is locked')
  })
})

describe('RelationPickerCell', () => {
  function renderCell(value: unknown, many: boolean) {
    const onSave = vi.fn()
    const onRowClick = vi.fn()
    const view = renderWithProviders(
      <div onClick={onRowClick}>
        <RelationPickerCell value={value} target="company" many={many} onSave={onSave} />
      </div>
    )
    return { onSave, onRowClick, unmount: view.unmount }
  }

  it('shows a dash when empty and the linked object titles otherwise', async () => {
    const { unmount } = renderCell(undefined, false)
    expect(screen.getByText('—')).toBeInTheDocument()
    unmount()

    renderCell([ACME, GLOBEX], true)
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Globex')).toBeInTheDocument()
  })

  it('picks an object without selecting the table row', async () => {
    const { onSave, onRowClick } = renderCell(undefined, false)

    await userEvent.click(screen.getByTestId('relation-picker-cell'))
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }))

    expect(onSave).toHaveBeenCalledWith([ACME])
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('does not open the row when the cell is double-clicked', async () => {
    const onRowDoubleClick = vi.fn()
    renderWithProviders(
      <div onDoubleClick={onRowDoubleClick}>
        <RelationPickerCell value={undefined} target="company" many={false} onSave={vi.fn()} />
      </div>
    )

    await userEvent.dblClick(screen.getByTestId('relation-picker-cell'))

    expect(onRowDoubleClick).not.toHaveBeenCalled()
  })

  it('adds to the links of a many relation', async () => {
    const many = renderCell([ACME], true)
    await userEvent.click(screen.getByTestId('relation-picker-cell'))
    await userEvent.click(await screen.findByRole('option', { name: /Globex/ }))
    expect(many.onSave).toHaveBeenCalledWith([ACME, GLOBEX])
  })

  it('replaces the existing link when the relation holds one object', async () => {
    const single = renderCell([ACME], false)
    await userEvent.click(screen.getByTestId('relation-picker-cell'))
    await userEvent.click(await screen.findByRole('option', { name: /Globex/ }))
    expect(single.onSave).toHaveBeenCalledWith([GLOBEX])
  })

  it('unlinks an already linked object, clearing the field when it was the last', async () => {
    const { onSave } = renderCell([ACME], true)

    await userEvent.click(screen.getByTestId('relation-picker-cell'))
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }))

    expect(onSave).toHaveBeenCalledWith(undefined)
  })

  it('keeps the other links when one of several is unlinked', async () => {
    const { onSave } = renderCell([ACME, GLOBEX], true)

    await userEvent.click(screen.getByTestId('relation-picker-cell'))
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }))

    expect(onSave).toHaveBeenCalledWith([GLOBEX])
  })
})

describe('relationGroupUris', () => {
  it('reads a comma-joined group key and a stored link list, and refuses anything else', () => {
    expect(relationGroupUris(`${ACME},${GLOBEX}`)).toEqual([ACME, GLOBEX])
    expect(relationGroupUris([ACME])).toEqual([ACME])
    expect(relationGroupUris(`${ACME},not-a-link`)).toBeNull()
    expect(relationGroupUris('CTO')).toBeNull()
    expect(relationGroupUris(['CTO'])).toBeNull()
    expect(relationGroupUris([])).toBeNull()
    expect(relationGroupUris(42)).toBeNull()
  })
})

describe('GroupValueTitle', () => {
  it('shows the objects a relation group stands for', async () => {
    renderWithProviders(<GroupValueTitle uris={[ACME, GLOBEX]} />)

    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Globex')).toBeInTheDocument()
  })
})

describe('LinkedFilterBar', () => {
  it('describes the "field contains object" filter and lets the user drop or save it', async () => {
    const onRemove = vi.fn()
    const onSave = vi.fn()
    renderWithProviders(
      <LinkedFilterBar
        filter={`Employer contains "${ACME}"`}
        onRemove={onRemove}
        onSave={onSave}
        shown={3}
        total={10}
      />
    )

    expect(screen.getByText(/Employer includes/)).toBeInTheDocument()
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('3 of 10')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('falls back to the raw filter text when it is not a "contains" filter', () => {
    renderWithProviders(
      <LinkedFilterBar filter="Role" onRemove={vi.fn()} onSave={vi.fn()} shown={1} total={1} />
    )

    expect(screen.getByText(/Role includes/)).toBeInTheDocument()
    expect(api.properties.resolveRefs).not.toHaveBeenCalled()
  })
})

describe('withLinkedFilter', () => {
  it('uses the linked filter alone, or ANDs it with the view filter', () => {
    expect(withLinkedFilter(undefined, 'Employer contains "x"')).toBe('Employer contains "x"')
    expect(withLinkedFilter('Role = CTO', 'Employer contains "x"')).toEqual({
      and: ['Role = CTO', 'Employer contains "x"']
    })
  })
})

describe('MentionedInSection', () => {
  const note = (id: string, title: string) => ({ id, title })

  it('lists notes that mention the tag in their text and opens one on click', async () => {
    api.folderView.listWithProperties.mockResolvedValue({
      notes: [note('n1', 'Standup'), note('n2', 'Retro')]
    })
    const onOpen = vi.fn()
    renderWithProviders(<MentionedInSection tag={person} onOpen={onOpen} />)

    const toggle = await screen.findByRole('button', { name: /Mentioned in/ })
    expect(toggle).toHaveTextContent('2 notes with #Person in their text')
    expect(api.folderView.listWithProperties).toHaveBeenCalledWith({
      scope: { kind: 'tag', tag: 'person' },
      rows: 'mentions',
      limit: 200,
      offset: 0
    })
    // Collapsed until the user opens it.
    expect(screen.queryByText('Standup')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: 'Retro' }))
    expect(onOpen).toHaveBeenCalledWith('n2', 'Retro')

    await userEvent.click(toggle)
    expect(screen.queryByText('Standup')).not.toBeInTheDocument()
  })

  it('renders nothing when no note mentions the tag', async () => {
    renderWithProviders(<MentionedInSection tag={person} onOpen={vi.fn()} />)

    await waitFor(() => expect(api.folderView.listWithProperties).toHaveBeenCalled())
    expect(screen.queryByTestId('mentioned-in')).not.toBeInTheDocument()
  })
})
