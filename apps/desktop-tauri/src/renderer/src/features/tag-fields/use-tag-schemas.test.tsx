import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaCommandResult, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import {
  objectIdentityOf,
  resolveTag,
  tagHasFields,
  useEditTagSchema,
  useObjectIdentity,
  useObjectIdentityLookup,
  useResolvedTag,
  useTagSchemas
} from './use-tag-schemas'

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

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

const snapshot = (): TagSchemaSnapshot => ({
  tags: {
    person: tag('person', {
      name: 'Person',
      color: 'sky',
      icon: 'icon:UserIcon',
      preset: 'person'
    }),
    meeting: tag('meeting', { name: 'Meeting' }),
    ünal: tag('ünal', { name: 'Ünal' }),
    plain: tag('plain', { hasFields: false })
  },
  objects: { 'ada-1': 'person', 'standup-1': 'meeting', 'orphan-1': 'deleted-tag' },
  presets: [],
  presetStripDismissed: false
})

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot())
  api.onTagsChanged = vi.fn().mockReturnValue(vi.fn())
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(vi.fn())
})

describe('reading tag schemas', () => {
  it('loads the snapshot once for every consumer', async () => {
    const { result } = renderHook(() => [useTagSchemas(), useTagSchemas()], { wrapper })

    expect(result.current[0].isLoading).toBe(true)
    await waitFor(() => expect(result.current[0].data?.tags.person.name).toBe('Person'))

    expect(result.current[1].data).toBe(result.current[0].data)
    expect(api.tags.getSchemaSnapshot).toHaveBeenCalledTimes(1)
  })

  it('resolves a tag by any spelling, trimmed, and not before the snapshot or without a tag', async () => {
    const { result } = renderHook(
      () => ({
        person: useResolvedTag('  PERSON '),
        unicode: useResolvedTag('ÜNAL'),
        missing: useResolvedTag('nope'),
        empty: useResolvedTag(null)
      }),
      { wrapper }
    )
    expect(result.current.person).toBeNull()

    await waitFor(() => expect(result.current.person?.name).toBe('Person'))
    expect(result.current.unicode?.name).toBe('Ünal')
    expect(result.current.missing).toBeNull()
    expect(result.current.empty).toBeNull()
  })

  it('tells whether a tag has fields, false for a plain or unknown tag', () => {
    const snap = snapshot()

    expect(tagHasFields(snap, 'Person')).toBe(true)
    expect(tagHasFields(snap, 'plain')).toBe(false)
    expect(tagHasFields(snap, 'nope')).toBe(false)
    expect(tagHasFields(undefined, 'person')).toBe(false)
    expect(resolveTag(snap, '')).toBeNull()
  })

  it("names an object's tag look: person objects get an avatar, others do not", async () => {
    const { result } = renderHook(
      () => ({
        ada: useObjectIdentity('ada-1'),
        standup: useObjectIdentity('standup-1'),
        unknown: useObjectIdentity('note-without-object'),
        orphan: useObjectIdentity('orphan-1'),
        none: useObjectIdentity(undefined)
      }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.ada).not.toBeNull())
    expect(result.current.ada).toEqual({
      tag: 'person',
      name: 'Person',
      color: 'sky',
      icon: 'icon:UserIcon',
      avatar: true
    })
    expect(result.current.standup).toMatchObject({ tag: 'meeting', avatar: false })
    expect(result.current.unknown).toBeNull()
    expect(result.current.orphan).toBeNull()
    expect(result.current.none).toBeNull()
  })

  it('looks an object up by note id once the snapshot has loaded', async () => {
    const { result } = renderHook(() => useObjectIdentityLookup(), { wrapper })
    expect(result.current('ada-1')).toBeNull()

    await waitFor(() => expect(result.current('ada-1')?.name).toBe('Person'))
    expect(result.current('nope')).toBeNull()
    expect(objectIdentityOf(undefined, 'ada-1')).toBeNull()
  })
})

describe('editing tag schemas', () => {
  it('sends the command and shows the returned snapshot without a second read', async () => {
    const after = {
      ...snapshot(),
      tags: { ...snapshot().tags, book: tag('book', { name: 'Book' }) }
    }
    api.tags.editSchema = vi
      .fn()
      .mockResolvedValue({ snapshot: after } satisfies TagSchemaCommandResult)
    const { result } = renderHook(() => ({ edit: useEditTagSchema(), schemas: useTagSchemas() }), {
      wrapper
    })
    await waitFor(() => expect(result.current.schemas.data).toBeDefined())
    const command = {
      kind: 'add-field',
      tag: 'book',
      field: { name: 'Author', type: 'text' }
    } as const

    let returned: TagSchemaCommandResult | undefined
    await act(async () => {
      returned = await result.current.edit(command)
    })

    expect(api.tags.editSchema).toHaveBeenCalledWith(command)
    expect(returned?.snapshot).toBe(after)
    await waitFor(() => expect(result.current.schemas.data?.tags.book?.name).toBe('Book'))
    expect(api.tags.getSchemaSnapshot).toHaveBeenCalledTimes(1)
  })

  it('rejects with the failure and keeps the old snapshot when the edit fails', async () => {
    api.tags.editSchema = vi.fn().mockRejectedValue(new Error('refused'))
    const { result } = renderHook(() => ({ edit: useEditTagSchema(), schemas: useTagSchemas() }), {
      wrapper
    })
    await waitFor(() => expect(result.current.schemas.data).toBeDefined())

    await expect(
      act(() => result.current.edit({ kind: 'remove-field', tag: 'person', name: 'Role' }))
    ).rejects.toThrow('refused')
    expect(result.current.schemas.data?.tags.person.name).toBe('Person')
  })
})

describe('keeping the snapshot fresh', () => {
  const changed = (on: 'onTagsChanged' | 'onPropertyDefinitionChanged'): (() => void) =>
    api[on].mock.calls[0][0]

  it.each(['onTagsChanged', 'onPropertyDefinitionChanged'] as const)(
    'reloads after %s, once for a burst of events',
    async (source) => {
      const { result } = renderHook(() => useTagSchemas(), { wrapper })
      await waitFor(() => expect(result.current.data).toBeDefined())
      api.tags.getSchemaSnapshot.mockResolvedValue({
        ...snapshot(),
        tags: { ...snapshot().tags, book: tag('book', { name: 'Book' }) }
      })

      act(() => {
        changed(source)()
        changed(source)()
        changed(source)()
      })

      await waitFor(() => expect(result.current.data?.tags.book?.name).toBe('Book'))
      expect(api.tags.getSchemaSnapshot).toHaveBeenCalledTimes(2)
    }
  )

  it('listens once for all consumers and stops after the last one unmounts', async () => {
    const offTags = vi.fn()
    const offDefinitions = vi.fn()
    api.onTagsChanged.mockReturnValue(offTags)
    api.onPropertyDefinitionChanged.mockReturnValue(offDefinitions)
    const first = renderHook(() => useTagSchemas(), { wrapper })
    const second = renderHook(() => useTagSchemas(), { wrapper })
    await waitFor(() => expect(first.result.current.data).toBeDefined())
    expect(api.onTagsChanged).toHaveBeenCalledTimes(1)
    expect(api.onPropertyDefinitionChanged).toHaveBeenCalledTimes(1)

    first.unmount()
    expect(offTags).not.toHaveBeenCalled()

    second.unmount()
    expect(offTags).toHaveBeenCalledTimes(1)
    expect(offDefinitions).toHaveBeenCalledTimes(1)
  })
})
