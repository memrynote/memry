import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldFillProposal, FillFieldsResult } from '@memry/contracts/tag-fill-api'
import type { FieldGroup } from '../build-field-groups'
import { NoteFieldGroups } from '../NoteFieldGroups'
import { useNoteFieldFill } from './use-note-field-fill'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))

function field(name: string, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { name, type: 'text', relation: null, definedBy: 'person', ...extra }
}

function tag(key: string, fields: ResolvedField[]): ResolvedTag {
  return {
    name: key,
    key,
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

const person = tag('person', [field('Company'), field('Role'), field('Email')])
const personGroup: FieldGroup = {
  tag: person,
  via: null,
  slots: [
    { field: person.ownFields[0], value: undefined },
    { field: person.ownFields[1], value: '' },
    { field: person.ownFields[2], value: 'ada@acme.test' }
  ]
}

const SOURCE = 'Ada works at Acme as CTO.'

function proposal(name: string, value: string, extra: Partial<FieldFillProposal> = {}) {
  return { field: name, value, display: value, sourceText: SOURCE, ...extra }
}

const companyProposal = proposal('Company', 'Acme')
const roleProposal = proposal('Role', 'CTO')

function Harness({
  noteId,
  groups = [personGroup],
  disabled = false
}: {
  noteId: string | null
  groups?: FieldGroup[]
  disabled?: boolean
}) {
  const fill = useNoteFieldFill(noteId, disabled)
  return (
    <div>
      <div className="ProseMirror">
        <p>{SOURCE}</p>
      </div>
      <NoteFieldGroups
        groups={groups}
        onFieldChange={vi.fn()}
        renderGroupAction={fill.renderGroupAction}
        renderSlot={fill.renderSlot}
        renderGroupFooter={fill.renderGroupFooter}
      />
    </div>
  )
}

let tagsApi: Record<'getFillStatus' | 'fillFields', Mock>
let propertiesApi: Record<'merge', Mock>
let notesApi: Record<'create', Mock>

function status(over: Partial<{ available: boolean; disclosureAccepted: boolean }> = {}) {
  return { available: true, model: 'gpt-test', local: false, disclosureAccepted: true, ...over }
}

function fillResult(result: FillFieldsResult) {
  tagsApi.fillFields.mockResolvedValue(result)
}

async function clickFill() {
  await userEvent.click(await screen.findByTestId('field-fill-action'))
}

beforeEach(() => {
  tagsApi = window.api.tags as unknown as typeof tagsApi
  propertiesApi = window.api.properties as unknown as typeof propertiesApi
  notesApi = window.api.notes as unknown as typeof notesApi
  tagsApi.getFillStatus = vi.fn().mockResolvedValue(status())
  tagsApi.fillFields = vi.fn()
  propertiesApi.merge = vi.fn().mockResolvedValue({ success: true })
  notesApi.create = vi.fn()
  vi.mocked(toast).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('agent fill for one note', () => {
  it('offers "Fill from note" only while AI is available, enabled and a field is empty', async () => {
    const { unmount } = renderWithProviders(<Harness noteId="n1" />)
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
    unmount()

    tagsApi.getFillStatus.mockResolvedValue(status({ available: false }))
    const unavailable = renderWithProviders(<Harness noteId="n1" />)
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('field-fill-action')).not.toBeInTheDocument()
    unavailable.unmount()

    tagsApi.getFillStatus.mockResolvedValue(status())
    const disabled = renderWithProviders(<Harness noteId="n1" disabled />)
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(3))
    expect(screen.queryByTestId('field-fill-action')).not.toBeInTheDocument()
    disabled.unmount()

    const filled: FieldGroup = {
      ...personGroup,
      slots: personGroup.slots.map((slot) => ({ ...slot, value: 'x' }))
    }
    renderWithProviders(<Harness noteId="n1" groups={[filled]} />)
    await waitFor(() => expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(4))
    expect(screen.queryByTestId('field-fill-action')).not.toBeInTheDocument()
  })

  it('shows a reading indicator, then ghost rows for the empty fields only', async () => {
    let resolve!: (r: FillFieldsResult) => void
    tagsApi.fillFields.mockReturnValue(new Promise<FillFieldsResult>((r) => (resolve = r)))
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    expect(tagsApi.fillFields).toHaveBeenCalledWith({
      noteId: 'n1',
      tag: 'person',
      acceptDisclosure: false
    })
    expect(await screen.findByText('Reading note…')).toBeInTheDocument()
    expect(screen.queryByTestId('field-fill-action')).not.toBeInTheDocument()

    resolve({ kind: 'proposals', proposals: [companyProposal] })

    const rows = await screen.findAllByTestId('field-fill-proposal')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Company')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Acme')).toBeInTheDocument()
    // The empty field the model found nothing for says so; the filled one is untouched.
    expect(screen.getByText('Not in the note')).toBeInTheDocument()
    expect(screen.getByText('· 1 suggestion')).toBeInTheDocument()
  })

  it('accepting one ghost value merges it into the note and keeps the rest for review', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal, roleProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    expect(await screen.findByText('· 2 suggestions')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept Company' }))

    await waitFor(() => expect(propertiesApi.merge).toHaveBeenCalledWith('n1', { Company: 'Acme' }))
    await waitFor(() => expect(screen.getAllByTestId('field-fill-proposal')).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Accept Role' })).toBeInTheDocument()
    expect(screen.getByText('· 1 suggestion')).toBeInTheDocument()
  })

  it('rejecting a ghost value drops it without writing anything', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal, roleProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Company' }))

    expect(screen.queryByRole('button', { name: 'Accept Company' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept Role' })).toBeInTheDocument()
    expect(propertiesApi.merge).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Reject Role' }))
    // Rejecting the last one ends the review and brings the action back.
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
  })

  it('"Accept all" writes every proposal in one merge and ends the review', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal, roleProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await userEvent.click(await screen.findByRole('button', { name: /Accept all/ }))

    await waitFor(() =>
      expect(propertiesApi.merge).toHaveBeenCalledWith('n1', { Company: 'Acme', Role: 'CTO' })
    )
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
    expect(screen.queryByTestId('field-fill-proposal')).not.toBeInTheDocument()
  })

  it('Cmd+Enter accepts all suggestions while reviewing', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    await screen.findByTestId('field-fill-proposal')

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(propertiesApi.merge).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(propertiesApi.merge).toHaveBeenCalledWith('n1', { Company: 'Acme' }))
  })

  it('"Dismiss" closes the review without writing', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    await screen.findByTestId('field-fill-proposal')

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByTestId('field-fill-proposal')).not.toBeInTheDocument()
    expect(propertiesApi.merge).not.toHaveBeenCalled()
  })

  it('keeps the proposals and reports an error when saving fails', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    propertiesApi.merge.mockResolvedValue({ success: false, error: 'disk full' })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await userEvent.click(await screen.findByRole('button', { name: 'Accept Company' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full'))
    expect(screen.getByRole('button', { name: 'Accept Company' })).toBeEnabled()
  })

  it('accepting a relation that matches no object creates the note and stores its link', async () => {
    notesApi.create.mockResolvedValue({ success: true, note: { id: 'n_acme', title: 'Acme' } })
    fillResult({
      kind: 'proposals',
      proposals: [{ ...companyProposal, value: null, create: { title: 'Acme', tag: 'company' } }]
    })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    expect(await screen.findByTitle('Creates a new #company when accepted')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept Company' }))

    await waitFor(() =>
      expect(notesApi.create).toHaveBeenCalledWith({
        title: 'Acme',
        content: '',
        tags: ['company']
      })
    )
    await waitFor(() =>
      expect(propertiesApi.merge).toHaveBeenCalledWith('n1', { Company: ['memry://note/n_acme'] })
    )
  })

  it.each<[string, FillFieldsResult, string]>([
    [
      'nothing found',
      { kind: 'proposals', proposals: [] },
      'Nothing in this note fills the empty fields'
    ],
    ['a failure', { kind: 'failed', message: 'quota' }, 'Could not suggest values. quota']
  ])('reports %s and returns to the idle action', async (_name, result, message) => {
    fillResult(result)
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await waitFor(() => {
      const shown = result.kind === 'failed' ? vi.mocked(toast.error) : vi.mocked(toast)
      expect(shown).toHaveBeenCalledWith(message)
    })
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
  })

  it('reports a thrown IPC error and returns to the idle action', async () => {
    tagsApi.fillFields.mockRejectedValue(new Error('ipc down'))
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ipc down'))
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
  })

  it('re-reads the status and goes idle when the agent became unavailable', async () => {
    fillResult({ kind: 'unavailable' })
    renderWithProviders(<Harness noteId="n1" />)
    const action = await screen.findByTestId('field-fill-action')
    tagsApi.getFillStatus.mockResolvedValue(status({ available: false }))
    await userEvent.click(action)

    await waitFor(() => expect(screen.queryByTestId('field-fill-action')).not.toBeInTheDocument())
    expect(tagsApi.getFillStatus).toHaveBeenCalledTimes(2)
  })

  it('uses the header tag, not an inherited-from parent, to fill an inherited group', async () => {
    const parent = tag('contact', [field('Phone')])
    const child = { ...tag('client', []), hasFields: true }
    const inheritedGroup: FieldGroup = {
      tag: parent,
      via: child,
      slots: [{ field: parent.ownFields[0], value: undefined }]
    }
    fillResult({ kind: 'proposals', proposals: [proposal('Phone', '555')] })
    renderWithProviders(<Harness noteId="n1" groups={[inheritedGroup]} />)
    await clickFill()

    await waitFor(() =>
      expect(tagsApi.fillFields).toHaveBeenCalledWith({
        noteId: 'n1',
        tag: 'client',
        acceptDisclosure: false
      })
    )
  })

  it('drops an in-flight review when the editor switches to another note', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    const { rerender } = renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    await screen.findByTestId('field-fill-proposal')

    rerender(<Harness noteId="n2" />)

    expect(screen.queryByTestId('field-fill-proposal')).not.toBeInTheDocument()
    expect(await screen.findByTestId('field-fill-action')).toBeInTheDocument()
  })

  it('does nothing when no note is open', async () => {
    renderWithProviders(<Harness noteId={null} />)
    await clickFill()
    expect(tagsApi.fillFields).not.toHaveBeenCalled()
  })
})

describe('agent fill first-run disclosure', () => {
  beforeEach(() => {
    tagsApi.getFillStatus.mockResolvedValue(status({ disclosureAccepted: false }))
  })

  it('asks before reading the note, and only sends it after "Suggest values"', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    const disclosure = await screen.findByTestId('field-fill-disclosure')
    expect(disclosure).toHaveTextContent('Your agent model (gpt-test) reads this note')
    expect(tagsApi.fillFields).not.toHaveBeenCalled()

    await userEvent.click(within(disclosure).getByRole('button', { name: 'Suggest values' }))

    await waitFor(() =>
      expect(tagsApi.fillFields).toHaveBeenCalledWith({
        noteId: 'n1',
        tag: 'person',
        acceptDisclosure: true
      })
    )
    expect(await screen.findByTestId('field-fill-proposal')).toBeInTheDocument()
  })

  it('"Not now" closes the disclosure without reading the note', async () => {
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await userEvent.click(
      within(await screen.findByTestId('field-fill-disclosure')).getByRole('button', {
        name: 'Not now'
      })
    )

    expect(screen.queryByTestId('field-fill-disclosure')).not.toBeInTheDocument()
    expect(tagsApi.fillFields).not.toHaveBeenCalled()
  })

  it('shows the disclosure when main says it is still required', async () => {
    tagsApi.getFillStatus.mockResolvedValue(status())
    fillResult({ kind: 'disclosure-required', model: 'llama3', local: true })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    expect(await screen.findByTestId('field-fill-disclosure')).toHaveTextContent(
      'Your local model (llama3) reads this note on this device'
    )
  })
})

describe('ghost row source highlight', () => {
  const highlights = new Map<string, { range: Range }>()

  beforeEach(() => {
    highlights.clear()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class {
        constructor(public range: Range) {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks the sentence a value came from while hovering its row and clears it on leave', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    const row = await screen.findByTestId('field-fill-proposal')

    await userEvent.hover(row)
    expect(highlights.get('field-fill-source')?.range.toString()).toBe(SOURCE)

    await userEvent.unhover(row)
    expect(highlights.has('field-fill-source')).toBe(false)
  })

  it('marks the source on keyboard focus too and clears it on blur', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    await screen.findByTestId('field-fill-proposal')

    const accept = screen.getByRole('button', { name: 'Accept Company' })
    accept.focus()
    expect(highlights.get('field-fill-source')?.range.toString()).toBe(SOURCE)

    accept.blur()
    expect(highlights.has('field-fill-source')).toBe(false)
  })

  it('does not highlight when the model quote is not in the note', async () => {
    fillResult({ kind: 'proposals', proposals: [{ ...companyProposal, sourceText: '' }] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    await userEvent.hover(await screen.findByTestId('field-fill-proposal'))

    expect(highlights.has('field-fill-source')).toBe(false)
  })

  it('removes the highlight when the accepted row disappears without a mouseleave', async () => {
    fillResult({ kind: 'proposals', proposals: [companyProposal] })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()
    await userEvent.hover(await screen.findByTestId('field-fill-proposal'))
    expect(highlights.has('field-fill-source')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Reject Company' }))

    expect(highlights.has('field-fill-source')).toBe(false)
  })
})

describe('ghost value of a link to an existing note', () => {
  it('shows the linked note title in the ghost row and writes the link on accept', async () => {
    fillResult({
      kind: 'proposals',
      proposals: [{ ...companyProposal, value: ['memry://note/n_acme'], display: 'Acme Inc' }]
    })
    renderWithProviders(<Harness noteId="n1" />)
    await clickFill()

    const row = await screen.findByTestId('field-fill-proposal')
    expect(within(row).getByText('Acme Inc')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Accept Company' }))
    await waitFor(() =>
      expect(propertiesApi.merge).toHaveBeenCalledWith('n1', { Company: ['memry://note/n_acme'] })
    )
  })
})
