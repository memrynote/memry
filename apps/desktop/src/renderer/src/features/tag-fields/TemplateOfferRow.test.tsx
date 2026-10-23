import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders } from '@tests/utils/render'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { insertTemplateBlocks } from '@/components/note/content-area/insert-template'
import { TemplateOffers } from './TemplateOfferRow'
import { templateOffers } from './template-offers'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/components/note/content-area/insert-template', () => ({
  insertTemplateBlocks: vi.fn()
}))

type Api = {
  tags: Record<string, Mock>
  templates: Record<string, Mock>
  onTagsChanged: Mock
  onPropertyDefinitionChanged: Mock
}
const api = window.api as unknown as Api

const person: ResolvedTag = {
  name: 'Person',
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
  template: { id: 'tpl-person', autofill: false, inheritedFrom: null },
  preset: null,
  ownPreset: null
}
const plain: ResolvedTag = { ...person, name: 'Plain', key: 'plain', template: null }
const snapshot: TagSchemaSnapshot = {
  tags: { person, plain },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

const editorWithBlock = { document: [{ id: 'b1' }, { id: 'b2' }] }
let noteCounter = 0
let noteId: string

function renderOffers(
  props: Partial<React.ComponentProps<typeof TemplateOffers>> = {}
): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <TemplateOffers
      noteId={noteId}
      noteTitle="Ada"
      notePath="people/ada.md"
      headerTags={['person']}
      getEditor={() => editorWithBlock}
      {...props}
    />
  )
}

beforeEach(() => {
  noteId = `note-${++noteCounter}`
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
  api.templates.get = vi.fn().mockResolvedValue({ id: 'tpl-person', content: '## Notes\n' })
  vi.mocked(insertTemplateBlocks).mockReset().mockResolvedValue({ ok: true, insertedBlockIds: [] })
  vi.mocked(toast.error).mockClear()
  act(() => templateOffers.mark(noteId, 'person'))
})

describe('template offer row', () => {
  it('offers the pending tag template and appends it after the last block on Add', async () => {
    renderOffers()

    expect(await screen.findByText('Add the Person template below your text')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(insertTemplateBlocks).toHaveBeenCalledWith({
        editor: editorWithBlock,
        content: '## Notes\n',
        noteTitle: 'Ada',
        referenceBlockId: 'b2',
        placement: 'after',
        notePath: 'people/ada.md'
      })
    )
    expect(api.templates.get).toHaveBeenCalledWith('tpl-person')
    await waitFor(() => expect(screen.queryByTestId('template-offer-row')).not.toBeInTheDocument())
    expect(templateOffers.pending(noteId)).toEqual([])
  })

  it('"Dismiss" removes the offer for good without inserting anything', async () => {
    renderOffers()

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByTestId('template-offer-row')).not.toBeInTheDocument()
    expect(insertTemplateBlocks).not.toHaveBeenCalled()
    expect(templateOffers.pending(noteId)).toEqual([])
  })

  it('keeps the offer and reports an error when the template no longer exists', async () => {
    api.templates.get.mockResolvedValue(null)
    renderOffers()

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Template not found'))
    expect(insertTemplateBlocks).not.toHaveBeenCalled()
    expect(screen.getByTestId('template-offer-row')).toBeInTheDocument()
    expect(templateOffers.pending(noteId)).toEqual(['person'])
  })

  it('keeps the offer and reports an error when the note changed while inserting', async () => {
    vi.mocked(insertTemplateBlocks).mockResolvedValue({ ok: false, reason: 'stale-block' })
    renderOffers()

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The note changed'))
    expect(screen.getByTestId('template-offer-row')).toBeInTheDocument()
  })

  it('resolves the offer when the template has no content to insert', async () => {
    vi.mocked(insertTemplateBlocks).mockResolvedValue({ ok: false, reason: 'empty' })
    renderOffers()

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(screen.queryByTestId('template-offer-row')).not.toBeInTheDocument())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does nothing on Add while the editor has no blocks yet', async () => {
    renderOffers({ getEditor: () => ({ document: [] }) })

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    expect(api.templates.get).not.toHaveBeenCalled()
    expect(screen.getByTestId('template-offer-row')).toBeInTheDocument()
  })

  it('disables Add while the note is read-only', async () => {
    renderOffers({ disabled: true })

    expect(await screen.findByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('offers only tags that have a template, and only while they are on the note header', async () => {
    act(() => templateOffers.mark(noteId, 'plain'))
    const ui = (headerTags: string[]) => (
      <TemplateOffers
        noteId={noteId}
        noteTitle="Ada"
        headerTags={headerTags}
        getEditor={() => editorWithBlock}
      />
    )
    const { rerender } = renderWithProviders(ui(['person', 'plain']))

    // 'plain' is pending and on the header but has no template, so only Person is offered.
    expect(await screen.findAllByTestId('template-offer-row')).toHaveLength(1)
    expect(screen.getByText('Add the Person template below your text')).toBeInTheDocument()

    rerender(ui(['plain']))

    expect(screen.queryByTestId('template-offer-row')).not.toBeInTheDocument()
  })
})
