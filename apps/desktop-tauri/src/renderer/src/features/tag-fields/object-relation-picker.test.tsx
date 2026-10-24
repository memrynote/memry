import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ObjectMatch } from '@memry/contracts/tag-objects-api'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { ObjectRelationPicker } from './object-relation-picker'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  notes: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

const person: ResolvedTag = {
  name: 'person',
  key: 'person',
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
  preset: 'person',
  ownPreset: 'person'
}
const snapshot: TagSchemaSnapshot = {
  tags: { person },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

const match = (id: string, title: string, subtitle: string[] = []): ObjectMatch => ({
  noteId: id,
  title,
  tag: 'person',
  groupTag: 'person',
  viaTag: null,
  subtitle,
  modified: '2026-01-01T00:00:00.000Z'
})

function mockSearch(matches: ObjectMatch[]): void {
  api.tags.searchObjects = vi.fn().mockResolvedValue({ matches, complete: true })
}

function renderPicker(selected: string[] = []): { onSelect: Fn } {
  const onSelect = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshot)
  render(
    <QueryClientProvider client={client}>
      <ObjectRelationPicker targetTag="person" selected={selected} onSelect={onSelect} />
    </QueryClientProvider>
  )
  return { onSelect }
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
  api.notes.create = vi.fn().mockResolvedValue({ success: true, note: { id: 'new-1', title: 'x' } })
})

describe('ObjectRelationPicker', () => {
  it('searches the target tag as the user types and picks a result as a note link', async () => {
    mockSearch([match('p1', 'Ada Lovelace', ['Mathematician', 'Acme']), match('p2', 'Alan Turing')])
    const { onSelect } = renderPicker()

    await userEvent.type(screen.getByRole('textbox', { name: 'Search person' }), 'a')

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Mathematician · Acme')).toBeInTheDocument()
    await waitFor(() =>
      expect(api.tags.searchObjects).toHaveBeenLastCalledWith({
        query: 'a',
        limit: 12,
        tag: 'person'
      })
    )

    await userEvent.click(screen.getByRole('option', { name: /Alan Turing/ }))

    expect(onSelect).toHaveBeenCalledWith('memry://note/p2')
  })

  it('marks already selected targets', async () => {
    mockSearch([match('p1', 'Ada Lovelace'), match('p2', 'Alan Turing')])
    renderPicker(['memry://note/p2'])

    const picked = await screen.findByRole('option', { name: /Alan Turing/ })
    const other = screen.getByRole('option', { name: /Ada Lovelace/ })

    expect(picked.querySelector('svg')).not.toBeNull()
    expect(other.querySelector('svg')).toBeNull()
  })

  it('moves the highlight with the arrow keys, wrapping, and selects with Enter', async () => {
    mockSearch([match('p1', 'Ada Lovelace'), match('p2', 'Alan Turing')])
    const { onSelect } = renderPicker()
    await screen.findByText('Alan Turing')
    const input = screen.getByRole('textbox')

    await userEvent.type(input, '{ArrowDown}')
    expect(screen.getByRole('option', { name: /Alan Turing/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await userEvent.type(input, '{ArrowUp}{ArrowUp}')
    // Up from the first result wraps to the "New person" row, which is not an option.
    expect(screen.getByRole('option', { name: /Ada Lovelace/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )

    await userEvent.type(input, '{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenCalledWith('memry://note/p1')
  })

  it('hover moves the highlight to the hovered result', async () => {
    mockSearch([match('p1', 'Ada Lovelace'), match('p2', 'Alan Turing')])
    renderPicker()
    const second = await screen.findByRole('option', { name: /Alan Turing/ })

    await userEvent.hover(second)

    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: /Ada Lovelace/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('hover moves the highlight to the create row', async () => {
    mockSearch([match('p1', 'Ada Lovelace')])
    renderPicker()
    const first = await screen.findByRole('option', { name: /Ada Lovelace/ })
    expect(first).toHaveAttribute('aria-selected', 'true')

    await userEvent.hover(screen.getByRole('button', { name: 'New person' }))

    expect(first).toHaveAttribute('aria-selected', 'false')
  })

  it('creates a tagged note named after the query and selects it', async () => {
    mockSearch([])
    const { onSelect } = renderPicker()

    await userEvent.type(screen.getByRole('textbox'), 'Grace Hopper')
    expect(await screen.findByText('No matches')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /New person “Grace Hopper”/ }))

    expect(api.notes.create).toHaveBeenCalledWith({
      title: 'Grace Hopper',
      content: '',
      tags: ['person']
    })
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('memry://note/new-1'))
  })

  it('creates an untitled object with Enter when nothing matches and the query is empty', async () => {
    mockSearch([])
    const { onSelect } = renderPicker()
    await waitFor(() => expect(api.tags.searchObjects).toHaveBeenCalled())

    await userEvent.type(screen.getByRole('textbox'), '{Enter}')

    expect(api.notes.create).toHaveBeenCalledWith({
      title: 'New person',
      content: '',
      tags: ['person']
    })
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('memry://note/new-1'))
  })

  it('tells the user when creating fails and selects nothing', async () => {
    mockSearch([])
    api.notes.create = vi.fn().mockResolvedValue({ success: false, error: 'vault locked' })
    const { onSelect } = renderPicker()

    await userEvent.click(screen.getByRole('button', { name: /New person/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault locked'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows no results, not a crash, when the search call fails', async () => {
    api.tags.searchObjects = vi.fn().mockRejectedValue(new Error('index offline'))
    renderPicker()

    await userEvent.type(screen.getByRole('textbox'), 'zz')

    expect(await screen.findByText('No matches')).toBeInTheDocument()
  })
})
