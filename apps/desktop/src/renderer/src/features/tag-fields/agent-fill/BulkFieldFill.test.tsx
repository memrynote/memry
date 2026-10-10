import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldFillProposal, FillFieldsResult } from '@memry/contracts/tag-fill-api'
import { BulkFieldFill, type BulkFillNote } from './BulkFieldFill'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))

function field(name: string, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { name, type: 'text', relation: null, definedBy: 'person', ...extra }
}

function makeTag(fields: ResolvedField[]): ResolvedTag {
  return {
    name: 'person',
    key: 'person',
    color: 'blue',
    icon: null,
    editable: true,
    ownFields: fields,
    inherited: [],
    effectiveFields: fields,
    hasFields: true,
    extends: null,
    ancestors: [],
    template: null,
    preset: null,
    ownPreset: null
  }
}

const person = makeTag([field('Company'), field('Role'), field('Active', { type: 'checkbox' })])

const ada: BulkFillNote = { id: 'n_ada', title: 'Ada Lovelace', properties: {} }
const grace: BulkFillNote = { id: 'n_grace', title: 'Grace Hopper', properties: { Company: '' } }
const filledNote: BulkFillNote = {
  id: 'n_done',
  title: 'Already Done',
  properties: { Company: 'IBM', Role: 'Admiral' }
}

function proposal(name: string, value: string): FieldFillProposal {
  return { field: name, value, display: value, sourceText: '' }
}

let tagsApi: Record<'getFillStatus' | 'fillFields', Mock>
let propertiesApi: Record<'merge', Mock>

function status(over: Partial<{ available: boolean; disclosureAccepted: boolean }> = {}) {
  return { available: true, model: 'gpt-test', local: false, disclosureAccepted: true, ...over }
}

function resultsByNote(results: Record<string, FillFieldsResult>) {
  tagsApi.fillFields.mockImplementation(({ noteId }: { noteId: string }) =>
    Promise.resolve(results[noteId])
  )
}

async function openBulk() {
  await userEvent.click(await screen.findByTestId('bulk-field-fill'))
}

beforeEach(() => {
  tagsApi = window.api.tags as unknown as typeof tagsApi
  propertiesApi = window.api.properties as unknown as typeof propertiesApi
  tagsApi.getFillStatus = vi.fn().mockResolvedValue(status())
  tagsApi.fillFields = vi.fn()
  propertiesApi.merge = vi.fn().mockResolvedValue({ success: true })
  vi.mocked(toast).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('bulk agent fill', () => {
  it('offers the action only when AI is available and some note has an empty fillable field', async () => {
    const { unmount } = renderWithProviders(<BulkFieldFill tag={person} notes={[ada]} />)
    expect(await screen.findByTestId('bulk-field-fill')).toBeInTheDocument()
    unmount()

    const noneEmpty = renderWithProviders(<BulkFieldFill tag={person} notes={[filledNote]} />)
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('bulk-field-fill')).not.toBeInTheDocument()
    noneEmpty.unmount()

    // A checkbox is never filled from text, so a tag with only checkboxes has nothing to offer.
    const checkboxOnly = renderWithProviders(
      <BulkFieldFill tag={makeTag([field('Active', { type: 'checkbox' })])} notes={[ada]} />
    )
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(3))
    expect(screen.queryByTestId('bulk-field-fill')).not.toBeInTheDocument()
    checkboxOnly.unmount()

    tagsApi.getFillStatus.mockResolvedValue(status({ available: false }))
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada]} />)
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(4))
    expect(screen.queryByTestId('bulk-field-fill')).not.toBeInTheDocument()
  })

  it('reads only notes with empty fields and lists what it found per note', async () => {
    resultsByNote({
      n_ada: { kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] },
      n_grace: { kind: 'proposals', proposals: [proposal('Role', 'Admiral')] }
    })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, filledNote, grace]} />)
    await openBulk()

    expect(await screen.findByText('2 of 2 notes read')).toBeInTheDocument()
    expect(tagsApi.fillFields).toHaveBeenCalledTimes(2)
    expect(tagsApi.fillFields).toHaveBeenCalledWith({
      noteId: 'n_ada',
      tag: 'person',
      acceptDisclosure: false
    })
    expect(tagsApi.fillFields).not.toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 'n_done' })
    )

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    const adaRow = rows.find((row) => within(row).queryByText('Ada Lovelace'))!
    expect(within(adaRow).getByText('AL')).toBeInTheDocument()
    expect(within(adaRow).getByText('Analytical Engines')).toBeInTheDocument()
    // Role has a value on Grace, so Ada's row says nothing was found for it.
    expect(within(adaRow).getByText('Nothing found')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Company' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Role' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Active' })).not.toBeInTheDocument()
    expect(screen.getByText('2 found')).toBeInTheDocument()
  })

  it('"Accept all" writes every note and reports the totals', async () => {
    resultsByNote({
      n_ada: {
        kind: 'proposals',
        proposals: [proposal('Company', 'Analytical Engines'), proposal('Role', 'Countess')]
      },
      n_grace: { kind: 'proposals', proposals: [proposal('Role', 'Admiral')] }
    })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()
    await screen.findByText('2 of 2 notes read')

    await userEvent.click(screen.getByRole('button', { name: 'Accept all' }))

    await waitFor(() => expect(propertiesApi.merge).toHaveBeenCalledTimes(2))
    expect(propertiesApi.merge).toHaveBeenCalledWith('n_ada', {
      Company: 'Analytical Engines',
      Role: 'Countess'
    })
    expect(propertiesApi.merge).toHaveBeenCalledWith('n_grace', { Role: 'Admiral' })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Filled 3 fields on 2 notes'))
    await waitFor(() => expect(screen.queryAllByRole('row')).toHaveLength(0))
  })

  it('reviews one by one: accepts one note, skips another, writing only the accepted one', async () => {
    resultsByNote({
      n_ada: { kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] },
      n_grace: { kind: 'proposals', proposals: [proposal('Role', 'Admiral')] }
    })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()
    await screen.findByText('2 of 2 notes read')

    await userEvent.click(screen.getByRole('button', { name: 'Review one by one' }))
    expect(screen.queryByRole('button', { name: 'Review one by one' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Skip Grace Hopper' }))
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument()
    expect(propertiesApi.merge).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Accept values for Ada Lovelace' }))

    await waitFor(() =>
      expect(propertiesApi.merge).toHaveBeenCalledWith('n_ada', { Company: 'Analytical Engines' })
    )
    expect(propertiesApi.merge).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryAllByRole('row')).toHaveLength(0))
  })

  it('keeps the unsaved rows and reports an error when a write fails', async () => {
    resultsByNote({
      n_ada: { kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] },
      n_grace: { kind: 'proposals', proposals: [proposal('Role', 'Admiral')] }
    })
    propertiesApi.merge
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'vault locked' })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()
    await screen.findByText('2 of 2 notes read')

    await userEvent.click(screen.getByRole('button', { name: 'Accept all' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vault locked'))
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept all' })).toBeEnabled()
  })

  it('"Stop" ends the run after the note being read', async () => {
    let finishFirst!: (r: FillFieldsResult) => void
    tagsApi.fillFields.mockReturnValueOnce(new Promise<FillFieldsResult>((r) => (finishFirst = r)))
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    finishFirst({ kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] })

    expect(await screen.findByText('1 of 2 notes read')).toBeInTheDocument()
    expect(tagsApi.fillFields).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('stops with an error toast when the agent fails', async () => {
    tagsApi.fillFields.mockResolvedValue({ kind: 'failed', message: 'quota' })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not suggest values. quota'))
    expect(tagsApi.fillFields).toHaveBeenCalledTimes(1)
  })

  it('stops with an error toast when the IPC call throws', async () => {
    tagsApi.fillFields.mockRejectedValue(new Error('ipc down'))
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ipc down'))
    expect(tagsApi.fillFields).toHaveBeenCalledTimes(1)
  })

  it('stops quietly when the agent is no longer available', async () => {
    tagsApi.fillFields.mockResolvedValue({ kind: 'unavailable' })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()

    expect(await screen.findByText('0 of 2 notes read')).toBeInTheDocument()
    expect(tagsApi.fillFields).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('closing the popover discards the findings', async () => {
    resultsByNote({
      n_ada: { kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] },
      n_grace: { kind: 'proposals', proposals: [] }
    })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await openBulk()
    await screen.findByText('Ada Lovelace')

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument())
    expect(propertiesApi.merge).not.toHaveBeenCalled()
  })
})

describe('bulk agent fill first-run disclosure', () => {
  beforeEach(() => {
    tagsApi.getFillStatus.mockResolvedValue(status({ disclosureAccepted: false }))
  })

  it('asks before reading any note and sends the acceptance with the first note only', async () => {
    resultsByNote({
      n_ada: { kind: 'proposals', proposals: [proposal('Company', 'Analytical Engines')] },
      n_grace: { kind: 'proposals', proposals: [] }
    })
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada, grace]} />)
    await userEvent.click(await screen.findByTestId('bulk-field-fill'))

    const disclosure = await screen.findByTestId('field-fill-disclosure')
    expect(disclosure).toHaveTextContent('reads these notes one at a time')
    expect(tagsApi.fillFields).not.toHaveBeenCalled()

    await userEvent.click(within(disclosure).getByRole('button', { name: 'Suggest values' }))

    await screen.findByText('2 of 2 notes read')
    expect(tagsApi.fillFields).toHaveBeenNthCalledWith(1, {
      noteId: 'n_ada',
      tag: 'person',
      acceptDisclosure: true
    })
    expect(tagsApi.fillFields).toHaveBeenNthCalledWith(2, {
      noteId: 'n_grace',
      tag: 'person',
      acceptDisclosure: false
    })
  })

  it('"Not now" closes the popover without reading anything', async () => {
    renderWithProviders(<BulkFieldFill tag={person} notes={[ada]} />)
    await userEvent.click(await screen.findByTestId('bulk-field-fill'))

    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))

    await waitFor(() =>
      expect(screen.queryByTestId('field-fill-disclosure')).not.toBeInTheDocument()
    )
    expect(tagsApi.fillFields).not.toHaveBeenCalled()
  })
})
