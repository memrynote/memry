import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { PresetOffer, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { PresetOfferStrip } from './PresetOfferStrip'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

const offer = (key: PresetOffer['key'], overrides: Partial<PresetOffer> = {}): PresetOffer => ({
  key,
  name: key,
  icon: null,
  color: 'blue',
  fields: [
    { name: 'Alpha', type: 'text', relationTarget: null },
    { name: 'Beta', type: 'date', relationTarget: null }
  ],
  templateSections: [],
  state: 'add',
  existingTag: null,
  alsoAdds: [],
  ...overrides
})

const snapshotOf = (presets: PresetOffer[], presetStripDismissed = false): TagSchemaSnapshot => ({
  tags: {},
  objects: {},
  presets,
  presetStripDismissed
})

function renderStrip(snapshot: TagSchemaSnapshot): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshot)
  render(
    <QueryClientProvider client={client}>
      <PresetOfferStrip />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.previewImpact = vi.fn().mockResolvedValue({ kind: 'become-objects', notes: 3 })
  api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot: snapshotOf([]), tag: 'person' })
})

describe('PresetOfferStrip', () => {
  it('offers each ready-made tag with its field names and how many notes already carry it', () => {
    renderStrip(
      snapshotOf([
        offer('person'),
        offer('company', { state: 'add-fields', existingTag: { key: 'company', usage: 3 } }),
        offer('book', { state: 'add-fields', existingTag: { key: 'book', usage: 1 } }),
        offer('meeting', { state: 'added' })
      ])
    )

    expect(screen.getByRole('heading', { name: 'Ready-made tags' })).toBeInTheDocument()
    expect(screen.getAllByText('Alpha, Beta')).toHaveLength(4)
    expect(screen.getByText('Already on 3 notes')).toBeInTheDocument()
    expect(screen.getByText('Already on 1 note')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Add fields' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Added' })).toBeDisabled()
  })

  it.each([
    ['the user dismissed the strip', snapshotOf([offer('person')], true)],
    ['every preset is already added', snapshotOf([offer('person', { state: 'added' })])]
  ])('renders nothing when %s', (_label, snapshot) => {
    renderStrip(snapshot)

    expect(screen.queryByRole('heading', { name: 'Ready-made tags' })).not.toBeInTheDocument()
  })

  it('adds a preset in one click and confirms with the tag it wrote', async () => {
    renderStrip(snapshotOf([offer('person')]))

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added #person'))
    expect(api.tags.editSchema).toHaveBeenCalledWith({ kind: 'add-preset', preset: 'person' })
  })

  it('shows the error when adding fails and lets the user retry', async () => {
    api.tags.editSchema = vi.fn().mockRejectedValue(new Error('schema is locked'))
    renderStrip(snapshotOf([offer('person')]))

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('schema is locked'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled())
  })

  it('disables every action while one is running', async () => {
    let finish: (value: unknown) => void = () => {}
    api.tags.editSchema = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderStrip(snapshotOf([offer('person'), offer('company')]))

    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0])

    await waitFor(() => expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled())
    for (const button of screen.getAllByRole('button', { name: 'Add' })) {
      expect(button).toBeDisabled()
    }

    finish({
      snapshot: snapshotOf([offer('person', { state: 'added' }), offer('company')]),
      tag: 'person'
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled())
  })

  it('dismisses the strip with Not now', async () => {
    renderStrip(snapshotOf([offer('person')]))

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))

    await waitFor(() =>
      expect(api.tags.editSchema).toHaveBeenCalledWith({ kind: 'dismiss-preset-offer' })
    )
  })

  it('opens the merge dialog for a tag that exists without the preset, and adds the fields from it', async () => {
    const company = offer('company', {
      state: 'add-fields',
      existingTag: { key: 'company', usage: 3 }
    })
    api.tags.editSchema = vi.fn().mockResolvedValue({
      snapshot: snapshotOf([{ ...company, state: 'added' }, offer('person')]),
      tag: 'company'
    })
    renderStrip(snapshotOf([company, offer('person')]))

    await userEvent.click(screen.getByRole('button', { name: 'Add fields' }))

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: 'Add Company fields to #company?' })
    ).toBeInTheDocument()
    expect(api.tags.editSchema).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add fields' }))

    await waitFor(() =>
      expect(api.tags.editSchema).toHaveBeenCalledWith({ kind: 'add-preset', preset: 'company' })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
