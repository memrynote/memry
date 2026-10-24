import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { LinkedHereGroup } from '@memry/contracts/tag-objects-api'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { ObjectPreviewBody } from './object-preview-card'
import type { ObjectLook } from './object-avatar'

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  properties: Record<string, Fn>
  onNoteUpdated: Fn
  onPropertyDefinitionChanged: Fn
}

const field = (name: string, type: ResolvedField['type'], target?: string): ResolvedField => ({
  name,
  type,
  relation: target ? { target, many: false, inverse: null } : null,
  definedBy: 'person'
})

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

const personFields = [
  field('Job title', 'text'),
  field('Company', 'relation', 'company'),
  field('Email', 'text'),
  field('Phone', 'text'),
  field('Newsletter', 'checkbox')
]

function snapshot(): TagSchemaSnapshot {
  return {
    tags: {
      person: tag('person', {
        preset: 'person',
        ownPreset: 'person',
        effectiveFields: personFields
      }),
      company: tag('company', { preset: 'company', ownPreset: 'company' }),
      meeting: tag('meeting', { preset: 'meeting', ownPreset: 'meeting' })
    },
    objects: { 'company-1': 'company' },
    presets: [],
    presetStripDismissed: false
  }
}

const look: ObjectLook = { tag: 'person', color: 'blue', icon: null, avatar: true }

function renderPreview(onOpen = vi.fn()): { onOpen: Fn } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ObjectPreviewBody noteId="person-1" title="Ada Lovelace" look={look} onOpen={onOpen} />
    </QueryClientProvider>
  )
  return { onOpen }
}

function mockObject(values: Record<string, unknown>, linked: LinkedHereGroup[] = []): void {
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot())
  api.tags.getLinkedHere = vi.fn().mockResolvedValue({ groups: linked })
  api.properties.get = vi
    .fn()
    .mockResolvedValue(
      Object.entries(values).map(([name, value]) => ({ name, value, type: 'text' }))
    )
  api.properties.resolveRefs = vi.fn().mockResolvedValue([
    {
      uri: 'memry://note/company-1',
      targetType: 'note',
      targetId: 'company-1',
      title: 'Acme Corp',
      exists: true
    }
  ])
}

beforeEach(() => {
  api.onNoteUpdated = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
})

describe('ObjectPreviewBody', () => {
  it('summarises the object: first text field at its first relation, then the next two filled fields', async () => {
    mockObject({
      'Job title': 'Mathematician',
      Company: ['memry://note/company-1'],
      Email: 'ada@example.com',
      Phone: '+44 20 7946 0000',
      Newsletter: true
    })
    renderPreview()

    const preview = screen.getByTestId('object-preview')
    expect(within(preview).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(await within(preview).findByText('Mathematician')).toBeInTheDocument()
    expect(within(preview).getByText('at')).toBeInTheDocument()
    expect(await within(preview).findByText('Acme Corp')).toBeInTheDocument()
    expect(within(preview).getByText('ada@example.com')).toBeInTheDocument()
    expect(within(preview).getByText('+44 20 7946 0000')).toBeInTheDocument()
    expect(api.properties.resolveRefs).toHaveBeenCalledWith(['memry://note/company-1'])
  })

  it('lists a second relation as a chip line when the first text and relation are taken', async () => {
    api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue({
      ...snapshot(),
      tags: {
        ...snapshot().tags,
        person: tag('person', {
          preset: 'person',
          effectiveFields: [
            field('Role', 'text'),
            field('Company', 'relation', 'company'),
            field('Tags', 'multiselect'),
            field('Partner', 'relation', 'company')
          ]
        })
      }
    })
    api.tags.getLinkedHere = vi.fn().mockResolvedValue({ groups: [] })
    api.properties.get = vi.fn().mockResolvedValue([
      { name: 'Role', value: 'Analyst', type: 'text' },
      { name: 'Company', value: ['memry://note/company-1'], type: 'relation' },
      { name: 'Tags', value: ['math', 'engines'], type: 'multiselect' },
      { name: 'Partner', value: ['memry://note/company-1'], type: 'relation' }
    ])
    api.properties.resolveRefs = vi.fn().mockResolvedValue([
      {
        uri: 'memry://note/company-1',
        targetType: 'note',
        targetId: 'company-1',
        title: 'Acme Corp',
        exists: true
      },
      {
        uri: 'memry://note/gone',
        targetType: 'note',
        targetId: 'gone',
        title: 'Deleted note',
        exists: false
      }
    ])
    renderPreview()

    expect(await screen.findByText('math, engines')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Acme Corp')).toHaveLength(2))
    expect(screen.queryByText('Deleted note')).not.toBeInTheDocument()
  })

  it('shows last meeting with its date, tasks per field and the mention count', async () => {
    mockObject({ 'Job title': 'Mathematician' }, [
      {
        kind: 'relation',
        sourceTag: 'meeting',
        field: 'Attendees',
        label: 'Meetings',
        total: 4,
        items: [{ noteId: 'm1', title: 'Standup', date: '2026-03-05', snippet: null }],
        filter: 'f'
      },
      {
        kind: 'task-field',
        tag: 'task',
        field: 'Owner',
        total: 2,
        items: [],
        filter: 'f'
      },
      {
        kind: 'mentions',
        total: 3,
        items: []
      }
    ])
    renderPreview()

    expect(await screen.findByText('Last met Mar 5 · Standup')).toBeInTheDocument()
    expect(screen.getByText('2 tasks · Owner')).toBeInTheDocument()
    expect(screen.getByText('Mentioned in 3 notes')).toBeInTheDocument()
  })

  it('falls back to a dateless last-met line when the meeting has no usable date', async () => {
    mockObject({}, [
      {
        kind: 'relation',
        sourceTag: 'meeting',
        field: 'Attendees',
        label: 'Meetings',
        total: 1,
        items: [{ noteId: 'm1', title: 'Kickoff', date: 'not-a-date', snippet: null }],
        filter: 'f'
      }
    ])
    renderPreview()

    expect(await screen.findByText('Last met · Kickoff')).toBeInTheDocument()
    expect(screen.getByText('Mentioned in 0 notes')).toBeInTheDocument()
  })

  it('opens the object from the footer Open button', async () => {
    mockObject({})
    const { onOpen } = renderPreview()

    await userEvent.click(screen.getByRole('button', { name: /open/i }))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('reloads values when the same note is updated elsewhere, and ignores other notes', async () => {
    mockObject({ 'Job title': 'Mathematician' })
    renderPreview()
    expect(await screen.findByText('Mathematician')).toBeInTheDocument()
    const emit = api.onNoteUpdated.mock.calls[0][0] as (event: { id: string }) => void

    api.properties.get.mockResolvedValue([{ name: 'Job title', value: 'Engineer', type: 'text' }])
    act(() => emit({ id: 'someone-else' }))
    expect(api.properties.get).toHaveBeenCalledTimes(1)

    act(() => emit({ id: 'person-1' }))
    expect(await screen.findByText('Engineer')).toBeInTheDocument()
    expect(screen.queryByText('Mathematician')).not.toBeInTheDocument()
  })
})
