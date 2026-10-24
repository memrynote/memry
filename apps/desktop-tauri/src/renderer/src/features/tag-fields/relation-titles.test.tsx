import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { ObjectChip, RelationTitles } from './relation-titles'

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  properties: Record<string, Fn>
  tags: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

const resolvedTag = (key: string, preset: ResolvedTag['preset']): ResolvedTag => ({
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
  preset,
  ownPreset: preset
})

const snapshot: TagSchemaSnapshot = {
  tags: { person: resolvedTag('person', 'person'), company: resolvedTag('company', 'company') },
  objects: { 'ada-1': 'person', 'acme-1': 'company' },
  presets: [],
  presetStripDismissed: false
}

const ref = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  uri: `memry://note/${id}`,
  targetType: 'note',
  targetId: id,
  title,
  exists: true,
  ...extra
})

function renderTitles(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshot)
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
})

describe('RelationTitles', () => {
  it('shows each existing target as a chip with its tag look, and hides deleted targets', async () => {
    api.properties.resolveRefs = vi
      .fn()
      .mockResolvedValue([
        ref('ada-1', 'Ada Lovelace'),
        ref('acme-1', 'Acme', { emoji: '🏢' }),
        ref('gone-1', 'Deleted', { exists: false })
      ])
    renderTitles(
      <RelationTitles uris={['memry://note/ada-1', 'memry://note/acme-1', 'memry://note/gone-1']} />
    )

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('🏢')).toBeInTheDocument()
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument()
    expect(document.querySelector('[data-object-avatar="initials"]')).not.toBeNull()
  })

  it('does not resolve anything for an empty relation', () => {
    api.properties.resolveRefs = vi.fn().mockResolvedValue([])
    renderTitles(<RelationTitles uris={[]} />)

    expect(api.properties.resolveRefs).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-object-chip]')).toHaveLength(0)
  })

  it('shows a task target by title without an object look', async () => {
    api.properties.resolveRefs = vi.fn().mockResolvedValue([
      {
        uri: 'memry://task/t1',
        targetType: 'task',
        targetId: 't1',
        title: 'Send agenda',
        exists: true
      }
    ])
    renderTitles(<RelationTitles uris={['memry://task/t1']} />)

    await waitFor(() => expect(screen.getByText('Send agenda')).toBeInTheDocument())
    expect(document.querySelector('[data-object-avatar]')).toBeNull()
  })
})

describe('ObjectChip', () => {
  it('shows the title with a tinted avatar when the target has a look', () => {
    render(
      <ObjectChip
        look={{ tag: 'company', color: 'orange', icon: null, avatar: false }}
        title="Acme"
      />
    )

    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(document.querySelector('[data-object-avatar="tile"]')).not.toBeNull()
  })

  it('shows only the title on a neutral chip when the target has no look', () => {
    render(<ObjectChip look={null} title="Plain note" />)

    expect(screen.getByText('Plain note')).toBeInTheDocument()
    expect(document.querySelector('[data-object-avatar]')).toBeNull()
  })
})
