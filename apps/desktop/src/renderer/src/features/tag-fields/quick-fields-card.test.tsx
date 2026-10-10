import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import {
  QuickFieldsCard,
  quickFieldValues,
  quickFields,
  type QuickFieldsTarget
} from './quick-fields-card'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

type Api = {
  tags: Record<string, Mock>
  properties: Record<string, Mock>
  onTagsChanged: Mock
  onPropertyDefinitionChanged: Mock
}
const api = window.api as unknown as Api

function field(name: string, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { name, type: 'text', relation: null, definedBy: 'person', ...extra }
}

const company: ResolvedTag = {
  name: 'company',
  key: 'company',
  color: 'green',
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
  ownPreset: null
}
const snapshot: TagSchemaSnapshot = {
  tags: { company },
  objects: { n_acme: 'company' },
  presets: [],
  presetStripDismissed: false
}

function target(fields: ResolvedField[]): QuickFieldsTarget {
  return {
    noteId: 'n_ada',
    title: 'Ada Lovelace',
    tag: 'person',
    tagName: 'Person',
    look: { tag: 'person', color: 'blue', icon: null, avatar: true },
    fields,
    position: { x: 10, y: 20 }
  }
}

function renderCard(fields: ResolvedField[]) {
  const onClose = vi.fn()
  renderWithProviders(<QuickFieldsCard target={target(fields)} onClose={onClose} />)
  return { onClose }
}

beforeEach(() => {
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
  api.tags.searchObjects = vi.fn().mockResolvedValue({
    matches: [
      {
        noteId: 'n_acme',
        title: 'Acme',
        tag: 'company',
        groupTag: 'company',
        viaTag: null,
        subtitle: [],
        modified: '2026-01-01T00:00:00.000Z'
      }
    ],
    complete: true
  })
  api.properties.merge = vi.fn().mockResolvedValue({ success: true })
  api.properties.resolveRefs = vi.fn().mockImplementation((uris: string[]) =>
    Promise.resolve(
      uris.map((uri) => ({
        uri,
        targetType: 'note',
        targetId: uri.split('/').pop(),
        title: 'Acme',
        exists: true
      }))
    )
  )
  vi.mocked(toast.error).mockClear()
})

describe('quickFields', () => {
  it('picks the first two fields a person can type in a glance, skipping other types', () => {
    const picked = quickFields([
      field('Done', { type: 'checkbox' }),
      field('Role'),
      field('Born', { type: 'date' }),
      field('Age', { type: 'number' }),
      field('Site', { type: 'url' })
    ])

    expect(picked.map((f) => f.name)).toEqual(['Role', 'Age'])
  })
})

describe('quickFieldValues', () => {
  const fields = [
    field('Role'),
    field('Age', { type: 'number' }),
    field('Employer', {
      type: 'relation',
      relation: { target: 'company', many: false, inverse: null }
    }),
    field('Clients', {
      type: 'relation',
      relation: { target: 'company', many: true, inverse: null }
    })
  ]

  it('trims text, converts numbers, and leaves blank fields out', () => {
    expect(quickFieldValues(fields, { Role: '  CTO ', Age: '36' })).toEqual({
      Role: 'CTO',
      Age: 36
    })
    expect(quickFieldValues(fields, { Role: '   ', Age: '' })).toEqual({})
  })

  it('keeps every link of a many relation but only the last of a single one', () => {
    const values = {
      Employer: ['memry://note/a', 'memry://note/b'],
      Clients: ['memry://note/a', 'memry://note/b']
    }

    expect(quickFieldValues(fields, values)).toEqual({
      Employer: ['memry://note/b'],
      Clients: ['memry://note/a', 'memry://note/b']
    })
    expect(quickFieldValues(fields, { Employer: [] })).toEqual({})
  })
})

describe('QuickFieldsCard', () => {
  it('opens on the first field and saves what was typed with Enter', async () => {
    const { onClose } = renderCard([field('Role'), field('Age', { type: 'number' })])

    expect(screen.getByRole('dialog', { name: 'First fields of Ada Lovelace' })).toBeInTheDocument()
    expect(screen.getByText('New Person')).toBeInTheDocument()
    const role = screen.getByPlaceholderText('Add role')
    expect(role).toHaveFocus()

    await userEvent.type(role, ' CTO ')
    await userEvent.type(screen.getByPlaceholderText('Add age'), '36{Enter}')

    await waitFor(() =>
      expect(api.properties.merge).toHaveBeenCalledWith('n_ada', { Role: 'CTO', Age: 36 })
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"Done" saves too, and closing with nothing typed writes nothing', async () => {
    const { onClose } = renderCard([field('Role')])

    await userEvent.click(screen.getByRole('button', { name: /Done/ }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.properties.merge).not.toHaveBeenCalled()
  })

  it('Escape and "Later" close without saving what was typed', async () => {
    const { onClose } = renderCard([field('Role')])

    await userEvent.type(screen.getByPlaceholderText('Add role'), 'CTO{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /Later/ }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(api.properties.merge).not.toHaveBeenCalled()
  })

  it('tells the user when saving fails', async () => {
    api.properties.merge.mockResolvedValue({ success: false, error: 'vault locked' })
    renderCard([field('Role')])

    await userEvent.type(screen.getByPlaceholderText('Add role'), 'CTO{Enter}')

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault locked'))
  })

  it('links a related object picked from the relation field and saves it', async () => {
    const { onClose } = renderCard([
      field('Employer', {
        type: 'relation',
        relation: { target: 'company', many: false, inverse: null }
      })
    ])

    console.log(document.body.innerHTML.replace(/<svg.*?<\/svg>/g, ''))
    await userEvent.click(screen.getByRole('button', { name: 'Employer' }))
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }))

    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.queryByText('Add employer')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Done/ }))

    await waitFor(() =>
      expect(api.properties.merge).toHaveBeenCalledWith('n_ada', {
        Employer: ['memry://note/n_acme']
      })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('lets Enter inside the open relation picker belong to the picker, not the card', async () => {
    const { onClose } = renderCard([
      field('Clients', {
        type: 'relation',
        relation: { target: 'company', many: true, inverse: null }
      })
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Clients' }))
    await screen.findByRole('option', { name: /Acme/ })
    await userEvent.keyboard('{Enter}')

    // Enter picked the highlighted object; it did not also submit the card.
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(api.properties.merge).not.toHaveBeenCalled()
  })
})
