import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import { TagTemplateSection } from './TagTemplateSection'

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const openTab = vi.hoisted(() => vi.fn())
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab }) }))

function resolvedTag(overrides: Partial<ResolvedTag> = {}): ResolvedTag {
  return {
    name: 'person',
    key: 'person',
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

function template(content: string, name = 'Person template'): Record<string, unknown> {
  return {
    id: 'tpl-1',
    name,
    isBuiltIn: false,
    tags: [],
    properties: [],
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z'
  }
}

const editSchema = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  editSchema.mockResolvedValue({ snapshot: {} })
  Object.assign(window.api.tags, { editSchema })
  vi.mocked(window.api.templates.get).mockResolvedValue(
    template('## Agenda\nTopics to cover\n## Notes\n') as never
  )
  vi.mocked(window.api.templates.create).mockResolvedValue({
    success: true,
    template: template('## Notes\n', 'Person')
  } as never)
})

function renderSection(
  tag: ResolvedTag | null,
  props: { disabled?: boolean } = {}
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TagTemplateSection
        tagKey="person"
        tag={tag}
        disabled={props.disabled ?? false}
        label={<h3>Template</h3>}
      />
    </QueryClientProvider>
  )
}

describe('TagTemplateSection without a template', () => {
  it('invites the user to create a template', () => {
    renderSection(resolvedTag())

    expect(screen.getByText(/No template yet/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit template' })).not.toBeInTheDocument()
  })

  it('creates a template named after the tag, attaches it with autofill on, and opens its editor', async () => {
    const user = userEvent.setup()
    renderSection(resolvedTag())

    await user.click(screen.getByRole('button', { name: 'Create template' }))

    await waitFor(() =>
      expect(window.api.templates.create).toHaveBeenCalledWith({
        name: 'Person',
        content: '## Notes\n'
      })
    )
    await waitFor(() =>
      expect(editSchema).toHaveBeenCalledWith({
        kind: 'set-template',
        tag: 'person',
        template: { id: 'tpl-1', autofill: true }
      })
    )
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'template-editor',
          title: 'Person',
          path: '/templates/tpl-1',
          entityId: 'tpl-1'
        })
      )
    )
  })

  it('reports why creation failed and attaches nothing', async () => {
    vi.mocked(window.api.templates.create).mockResolvedValue({
      success: false,
      error: 'Templates folder is read-only'
    } as never)
    const user = userEvent.setup()
    renderSection(resolvedTag())

    await user.click(screen.getByRole('button', { name: 'Create template' }))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Templates folder is read-only')
    )
    expect(editSchema).not.toHaveBeenCalled()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('reports a failure to attach the new template and does not open the editor', async () => {
    editSchema.mockRejectedValue(new Error('schema locked'))
    const user = userEvent.setup()
    renderSection(resolvedTag())

    await user.click(screen.getByRole('button', { name: 'Create template' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('schema locked'))
    expect(openTab).not.toHaveBeenCalled()
  })

  it('cannot create a template on a read-only tag', () => {
    renderSection(resolvedTag(), { disabled: true })

    expect(screen.getByRole('button', { name: 'Create template' })).toBeDisabled()
  })

  it('offers to create again when the attached template no longer exists', async () => {
    vi.mocked(window.api.templates.get).mockResolvedValue(null)
    renderSection(resolvedTag({ template: { id: 'gone', autofill: true, inheritedFrom: null } }))

    expect(await screen.findByText(/No template yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create template' })).toBeInTheDocument()
  })
})

describe('TagTemplateSection with a template', () => {
  const attached = resolvedTag({ template: { id: 'tpl-1', autofill: true, inheritedFrom: null } })

  it('previews the template headings with the first line under each', async () => {
    renderSection(attached)

    expect(await screen.findByText('Agenda')).toBeInTheDocument()
    expect(screen.getByText('Topics to cover')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('-')).toBeInTheDocument()
    expect(window.api.templates.get).toHaveBeenCalledWith('tpl-1')
  })

  it('shows the template name when it has no headings to preview', async () => {
    vi.mocked(window.api.templates.get).mockResolvedValue(
      template('just text', 'Quick note') as never
    )
    renderSection(attached)

    expect(await screen.findByText('Quick note')).toBeInTheDocument()
  })

  it('opens the template in the template editor', async () => {
    const user = userEvent.setup()
    renderSection(attached)

    await user.click(await screen.findByRole('button', { name: 'Edit template' }))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'template-editor',
        title: 'Person template',
        path: '/templates/tpl-1',
        entityId: 'tpl-1'
      })
    )
  })

  it('turns autofill off for the tag', async () => {
    const user = userEvent.setup()
    renderSection(attached)

    await user.click(await screen.findByRole('switch'))

    await waitFor(() =>
      expect(editSchema).toHaveBeenCalledWith({
        kind: 'set-template',
        tag: 'person',
        template: { id: 'tpl-1', autofill: false }
      })
    )
  })

  it('turns autofill back on', async () => {
    const user = userEvent.setup()
    renderSection(resolvedTag({ template: { id: 'tpl-1', autofill: false, inheritedFrom: null } }))

    const toggle = await screen.findByRole('switch', {
      name: /Fill empty notes when they get #person/
    })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)

    await waitFor(() =>
      expect(editSchema).toHaveBeenCalledWith({
        kind: 'set-template',
        tag: 'person',
        template: { id: 'tpl-1', autofill: true }
      })
    )
  })

  it('reports a failed autofill change', async () => {
    editSchema.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderSection(attached)

    await user.click(await screen.findByRole('switch'))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('offline'))
  })

  it('locks the autofill switch on a read-only tag', async () => {
    renderSection(attached, { disabled: true })

    expect(await screen.findByRole('switch')).toBeDisabled()
  })

  it('shows an inherited template with its source and no autofill switch of its own', async () => {
    renderSection(
      resolvedTag({ template: { id: 'tpl-1', autofill: true, inheritedFrom: 'contact' } })
    )

    expect(await screen.findByText('From #contact')).toBeInTheDocument()
    expect(await screen.findByText('Agenda')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
