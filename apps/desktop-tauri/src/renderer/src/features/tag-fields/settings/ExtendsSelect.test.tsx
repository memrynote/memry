import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { ExtendsSelect } from './ExtendsSelect'

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

function resolvedTag(key: string, overrides: Partial<ResolvedTag> = {}): ResolvedTag {
  return {
    name: key,
    key,
    color: '',
    icon: null,
    editable: true,
    ownFields: [],
    inherited: [],
    effectiveFields: [],
    hasFields: false,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null,
    ...overrides
  }
}

const contact = resolvedTag('contact')
const person = resolvedTag('person', { extends: 'contact', ancestors: ['contact'] })
const vip = resolvedTag('vip', { extends: 'person', ancestors: ['person', 'contact'] })
const company = resolvedTag('company')
const snapshot: TagSchemaSnapshot = {
  tags: { contact, person, vip, company },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

const editSchema = vi.fn()

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  editSchema.mockResolvedValue({ snapshot })
  Object.assign(window.api.tags, { editSchema })
})

function renderSelect(
  tagKey: string,
  props: { disabled?: boolean } = {}
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ExtendsSelect
        tagKey={tagKey}
        tag={snapshot.tags[tagKey] ?? null}
        snapshot={snapshot}
        disabled={props.disabled ?? false}
      />
    </QueryClientProvider>
  )
}

describe('ExtendsSelect', () => {
  it('shows Nothing and the generic hint for a tag that extends nothing', () => {
    renderSelect('company')

    expect(screen.getByRole('combobox', { name: 'Extends' })).toHaveTextContent('Nothing')
    expect(
      screen.getByText("Take another tag's fields and show up in its table.")
    ).toBeInTheDocument()
  })

  it('shows the parent and what extending it means for the tag', () => {
    renderSelect('person')

    expect(screen.getByRole('combobox', { name: 'Extends' })).toHaveTextContent('contact')
    expect(
      screen.getByText("Person notes get Contact's fields and appear in the Contact table.")
    ).toBeInTheDocument()
  })

  it('makes the tag extend the picked parent', async () => {
    const user = userEvent.setup()
    renderSelect('company')

    await user.click(screen.getByRole('combobox', { name: 'Extends' }))
    await user.click(await screen.findByRole('option', { name: 'contact' }))

    await waitFor(() =>
      expect(editSchema).toHaveBeenCalledWith({
        kind: 'set-extends',
        tag: 'company',
        parent: 'contact'
      })
    )
  })

  it('stops extending when Nothing is picked', async () => {
    const user = userEvent.setup()
    renderSelect('person')

    await user.click(screen.getByRole('combobox', { name: 'Extends' }))
    await user.click(await screen.findByRole('option', { name: 'Nothing' }))

    await waitFor(() =>
      expect(editSchema).toHaveBeenCalledWith({
        kind: 'set-extends',
        tag: 'person',
        parent: null
      })
    )
  })

  it('does nothing when the current parent is picked again', async () => {
    const user = userEvent.setup()
    renderSelect('person')

    await user.click(screen.getByRole('combobox', { name: 'Extends' }))
    await user.click(await screen.findByRole('option', { name: 'contact' }))

    expect(editSchema).not.toHaveBeenCalled()
  })

  it('never offers the tag itself, and blocks its own descendants to avoid a cycle', async () => {
    const user = userEvent.setup()
    renderSelect('person')

    await user.click(screen.getByRole('combobox', { name: 'Extends' }))

    expect(await screen.findByRole('option', { name: 'company' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByRole('option', { name: 'vip' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('option', { name: 'person' })).not.toBeInTheDocument()
  })

  it('reports a rejected change', async () => {
    editSchema.mockRejectedValue(new Error('cycle detected'))
    const user = userEvent.setup()
    renderSelect('company')

    await user.click(screen.getByRole('combobox', { name: 'Extends' }))
    await user.click(await screen.findByRole('option', { name: 'contact' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('cycle detected'))
  })

  it('cannot be opened for a read-only tag', () => {
    renderSelect('company', { disabled: true })

    expect(screen.getByRole('combobox', { name: 'Extends' })).toBeDisabled()
  })
})
