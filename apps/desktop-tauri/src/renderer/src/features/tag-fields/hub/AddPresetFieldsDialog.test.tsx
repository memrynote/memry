import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { PresetOffer, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { AddPresetFieldsDialog } from './AddPresetFieldsDialog'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  onTagsChanged: Fn
  onPropertyDefinitionChanged: Fn
}

const companyOffer: PresetOffer = {
  key: 'company',
  name: 'company',
  icon: null,
  color: 'orange',
  fields: [
    { name: 'Website', type: 'url', relationTarget: null },
    { name: 'Industry', type: 'select', relationTarget: null }
  ],
  templateSections: [],
  state: 'add-fields',
  existingTag: { key: 'company', usage: 3 },
  alsoAdds: []
}

const personOffer: PresetOffer = {
  key: 'person',
  name: 'person',
  icon: null,
  color: 'blue',
  fields: [
    { name: 'Role', type: 'text', relationTarget: null },
    { name: 'Employer', type: 'relation', relationTarget: 'company' }
  ],
  templateSections: ['Context', 'Notes'],
  state: 'add-fields',
  existingTag: { key: 'person', usage: 1 },
  alsoAdds: ['company']
}

const snapshotOf = (presets: PresetOffer[]): TagSchemaSnapshot => ({
  tags: {},
  objects: {},
  presets,
  presetStripDismissed: false
})

function renderDialog(
  offer: PresetOffer | null,
  presets = [companyOffer, personOffer]
): { onClose: Fn } {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshotOf(presets))
  render(
    <QueryClientProvider client={client}>
      <AddPresetFieldsDialog offer={offer} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

const dialog = (): HTMLElement => screen.getByRole('dialog')

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.previewImpact = vi.fn().mockResolvedValue({ kind: 'become-objects', notes: 3 })
  api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot: snapshotOf([]), tag: 'company' })
})

describe('AddPresetFieldsDialog', () => {
  it('renders nothing while there is no offer', () => {
    renderDialog(null)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.tags.previewImpact).not.toHaveBeenCalled()
  })

  it('lists the preset fields with their types and the number of notes that will get them', async () => {
    renderDialog(companyOffer)

    expect(
      await screen.findByRole('heading', { name: 'Add Company fields to #company?' })
    ).toBeInTheDocument()
    expect(within(dialog()).getByText('Website')).toBeInTheDocument()
    expect(within(dialog()).getByText('URL')).toBeInTheDocument()
    expect(within(dialog()).getByText('Industry')).toBeInTheDocument()
    expect(within(dialog()).getByText('Select')).toBeInTheDocument()
    expect(api.tags.previewImpact).toHaveBeenCalledWith({ kind: 'become-objects', tag: 'company' })
    expect(await within(dialog()).findByText(/#company is already on 3 notes/)).toBeInTheDocument()
  })

  it('uses the previewed note count over the tag usage, and the singular copy for one note', async () => {
    api.tags.previewImpact = vi.fn().mockResolvedValue({ kind: 'become-objects', notes: 1 })
    renderDialog(companyOffer)

    expect(await within(dialog()).findByText(/#company is already on 1 note\./)).toBeInTheDocument()
  })

  it('falls back to the tag usage when the impact preview is unavailable', async () => {
    api.tags.previewImpact = vi.fn().mockRejectedValue(new Error('offline'))
    renderDialog(companyOffer)

    expect(await within(dialog()).findByText(/#company is already on 3 notes/)).toBeInTheDocument()
  })

  it('shows relation targets, the template sections and the tags the step also adds', async () => {
    renderDialog(personOffer)

    const body = await screen.findByRole('dialog')
    expect(within(body).getByText('Employer')).toBeInTheDocument()
    expect(
      within(body).getByText(/The template \(Context, Notes\) fills only notes that are empty\./)
    ).toBeInTheDocument()
    expect(within(body).getByText(/Also adds/)).toHaveTextContent(
      /Also adds\s*#?company\s*for the Employer field\./
    )
  })

  it('adds the preset fields to the existing tag and closes with a confirmation', async () => {
    const { onClose } = renderDialog(companyOffer)

    await userEvent.click(await screen.findByRole('button', { name: 'Add fields' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.tags.editSchema).toHaveBeenCalledWith({ kind: 'add-preset', preset: 'company' })
    expect(toast.success).toHaveBeenCalledWith('Added Company fields to #company')
  })

  it('lets the user merge into another tag name, only once a name is typed', async () => {
    api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot: snapshotOf([]), tag: 'contact' })
    const { onClose } = renderDialog(personOffer)
    await userEvent.click(await screen.findByRole('button', { name: 'Use another name' }))

    const add = screen.getByRole('button', { name: 'Add fields' })
    expect(add).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Use another name' })).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('New tag name'), '  contact  ')
    expect(add).toBeEnabled()
    await userEvent.click(add)

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.tags.editSchema).toHaveBeenCalledWith({
      kind: 'add-preset',
      preset: 'person',
      tag: 'contact'
    })
    expect(toast.success).toHaveBeenCalledWith('Added Person fields to #contact')
  })

  it('submits the other name with Enter and ignores Enter on an empty name', async () => {
    api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot: snapshotOf([]) })
    renderDialog(personOffer)
    await userEvent.click(await screen.findByRole('button', { name: 'Use another name' }))
    const input = screen.getByLabelText('New tag name')

    await userEvent.type(input, '{Enter}')
    expect(api.tags.editSchema).not.toHaveBeenCalled()

    await userEvent.type(input, 'crew{Enter}')

    await waitFor(() =>
      expect(api.tags.editSchema).toHaveBeenCalledWith({
        kind: 'add-preset',
        preset: 'person',
        tag: 'crew'
      })
    )
    // The command result named no tag, so the toast uses the name the user typed.
    expect(toast.success).toHaveBeenCalledWith('Added Person fields to #crew')
  })

  it('shows the error and stays open when adding fails', async () => {
    api.tags.editSchema = vi.fn().mockRejectedValue(new Error('schema is locked'))
    const { onClose } = renderDialog(companyOffer)

    await userEvent.click(await screen.findByRole('button', { name: 'Add fields' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('schema is locked'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add fields' })).toBeEnabled()
  })

  it('closes without changing anything on Cancel', async () => {
    const { onClose } = renderDialog(companyOffer)

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.tags.editSchema).not.toHaveBeenCalled()
  })

  it('closes when the dialog is dismissed with Escape', async () => {
    const { onClose } = renderDialog(companyOffer)
    await screen.findByRole('dialog')

    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
