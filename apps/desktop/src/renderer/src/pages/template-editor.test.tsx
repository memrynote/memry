import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TemplateEditorPage,
  mapFromTemplatePropertyType,
  mapToTemplatePropertyType
} from './template-editor'

const getTemplate = vi.fn()
const createTemplate = vi.fn()
const updateTemplate = vi.fn()
const closeTab = vi.fn()
const updateTabTitle = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()

let queryData: unknown = null
let queryLoading = false
let activeTab: { id: string } | null = { id: 'tab-1' }

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: queryData, isLoading: queryLoading })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    getTemplate,
    createTemplate,
    updateTemplate
  })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'work', color: 'blue' },
      { tag: 'journal', color: 'green' }
    ]
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ closeTab, updateTabTitle }),
  useActiveTab: () => activeTab
}))

vi.mock('@/hooks/use-note-editor-settings', () => ({
  useNoteEditorSettings: () => ({ settings: { toolbarMode: 'sticky' } })
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args)
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() })
}))

vi.mock('@/components/note/note-title', () => ({
  NoteTitle: ({
    title,
    disabled,
    onTitleChange
  }: {
    title: string
    disabled?: boolean
    onTitleChange: (title: string) => void
  }) => (
    <input
      aria-label="template title"
      value={title}
      disabled={disabled}
      onChange={(event) => onTitleChange(event.target.value)}
    />
  )
}))

vi.mock('@/components/note/tags-row', () => ({
  TagsRow: ({
    tags,
    disabled,
    onAddTag,
    onCreateTag,
    onRemoveTag
  }: {
    tags: Array<{ id: string; name: string }>
    disabled?: boolean
    onAddTag: (tag: string) => void
    onCreateTag: (tag: string, color: string) => void
    onRemoveTag: (tag: string) => void
  }) => (
    <div>
      tags {tags.map((tag) => tag.name).join(',')}
      <button type="button" disabled={disabled} onClick={() => onAddTag('work')}>
        add tag
      </button>
      <button type="button" disabled={disabled} onClick={() => onCreateTag('newtag', 'amber')}>
        create tag
      </button>
      <button type="button" disabled={disabled} onClick={() => onRemoveTag(tags[0]?.id ?? '')}>
        remove tag
      </button>
    </div>
  )
}))

vi.mock('@/components/note/info-section', () => ({
  InfoSection: ({
    properties,
    disabled,
    onPropertyChange,
    onAddProperty,
    onDeleteProperty
  }: {
    properties: Array<{ id: string; name: string; value: unknown }>
    disabled?: boolean
    onPropertyChange: (id: string, value: unknown) => void
    onAddProperty: (property: { name: string; type: 'text' }) => void
    onDeleteProperty: (id: string) => void
  }) => (
    <div>
      properties {properties.map((prop) => `${prop.name}:${String(prop.value)}`).join(',')}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPropertyChange(properties[0]?.id ?? 'prop-0', 'changed')}
      >
        change property
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAddProperty({ name: 'Status', type: 'text' })}
      >
        add property
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDeleteProperty(properties[0]?.id ?? 'prop-0')}
      >
        delete property
      </button>
    </div>
  )
}))

vi.mock('@/components/note/content-area', () => ({
  ContentArea: ({
    initialContent,
    editable,
    onMarkdownChange
  }: {
    initialContent: string
    editable?: boolean
    onMarkdownChange: (content: string) => void
  }) => (
    <textarea
      aria-label="template content"
      defaultValue={initialContent}
      disabled={!editable}
      onChange={(event) => onMarkdownChange(event.target.value)}
    />
  )
}))

describe('property type maps', () => {
  it('round-trips a project property as project, not text', () => {
    const templateType = mapToTemplatePropertyType('project')
    expect(templateType).toBe('project')
    expect(mapFromTemplatePropertyType(templateType)).toBe('project')
  })
})

describe('TemplateEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryData = null
    queryLoading = false
    activeTab = { id: 'tab-1' }
    createTemplate.mockResolvedValue({ id: 'created-template', name: 'Research' })
    updateTemplate.mockResolvedValue({ id: 'template-1', name: 'Renamed' })
  })

  it('renders a loading state while an existing template loads', () => {
    queryLoading = true

    render(<TemplateEditorPage templateId="template-1" />)

    expect(screen.getByText('loadingTemplate')).toBeInTheDocument()
  })

  it('creates a new template and closes the active tab', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Research')
    fireEvent.change(screen.getByLabelText('description'), {
      target: { value: 'Reusable research note' }
    })
    await user.click(screen.getByRole('button', { name: 'add tag' }))
    await user.click(screen.getByRole('button', { name: 'create tag' }))
    await user.click(screen.getByRole('button', { name: 'add property' }))
    fireEvent.change(screen.getByLabelText('template content'), {
      target: { value: '# {{title}}' }
    })
    await user.click(screen.getByRole('button', { name: /Create Template/ }))

    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith({
        name: 'Research',
        description: 'Reusable research note',
        icon: null,
        tags: ['work', 'newtag'],
        properties: [{ name: 'Status', type: 'text', value: '' }],
        content: '# {{title}}'
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith('created')
    expect(closeTab).toHaveBeenCalledWith('tab-1')
  })

  it('updates an existing template, handles property mutation, and renames the tab', async () => {
    const user = userEvent.setup()
    queryData = {
      id: 'template-1',
      name: 'Meeting',
      description: 'Old description',
      icon: '📝',
      tags: ['work'],
      properties: [{ name: 'Owner', type: 'text', value: 'Kaan' }],
      content: 'Old content',
      isBuiltIn: false
    }

    render(<TemplateEditorPage templateId="template-1" />)

    fireEvent.change(screen.getByLabelText('template title'), { target: { value: 'Renamed' } })
    await user.click(screen.getByRole('button', { name: 'change property' }))
    fireEvent.change(screen.getByLabelText('template content'), { target: { value: 'New body' } })
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() =>
      expect(updateTemplate).toHaveBeenCalledWith({
        id: 'template-1',
        name: 'Renamed',
        description: 'Old description',
        icon: '📝',
        tags: ['work'],
        properties: [{ name: 'Owner', type: 'text', value: 'changed' }],
        content: 'New body'
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith('saved')
    expect(updateTabTitle).toHaveBeenCalledWith('tab-1', 'Renamed')
  })

  it('shows validation/save errors and keeps built-in templates read-only', async () => {
    const user = userEvent.setup()

    const { unmount } = render(<TemplateEditorPage />)
    await user.click(screen.getByRole('button', { name: /Create Template/ }))
    expect(toastError).toHaveBeenCalledWith('nameRequired')
    unmount()

    queryData = {
      id: 'builtin-1',
      name: 'Built In',
      description: 'Locked',
      icon: null,
      tags: ['journal'],
      properties: [],
      content: 'Locked body',
      isBuiltIn: true
    }

    render(<TemplateEditorPage templateId="builtin-1" />)

    expect(screen.getByText('view')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save Changes/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('template title')).toBeDisabled()
    expect(screen.getByLabelText('description')).toBeDisabled()
    expect(screen.getByLabelText('template content')).toBeDisabled()
  })
})
