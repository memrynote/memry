import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TemplateEditorPage,
  mapFromTemplatePropertyType,
  mapToTemplatePropertyType
} from './template-editor'

const getTemplate = vi.fn()
const createTemplate = vi.fn()
const updateTemplate = vi.fn()
const deleteTemplate = vi.fn()
const duplicateTemplate = vi.fn()
const closeTab = vi.fn()
const openTab = vi.fn()
const updateTabTitle = vi.fn()
const setTabModified = vi.fn()
const setTabEntity = vi.fn()
const registerCloseGuard = vi.fn(() => () => {})

let queryData: unknown = null
let queryLoading = false
let activeTab: { id: string } | null = { id: 'tab-1' }

// Only the strings the assertions read are spelled out; everything else falls
// back to the last key segment so unrelated copy stays noise-free.
const TRANSLATIONS: Record<string, string> = {
  'templateEditor.actions.create': 'Create Template',
  'templateEditor.actions.update': 'Update',
  'templateEditor.actions.duplicateAndEdit': 'Duplicate & Edit',
  'templateEditor.title.new': 'New Template'
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => TRANSLATIONS[key] ?? key.split('.').at(-1) ?? key })
}))

const setQueryData = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: queryData, isLoading: queryLoading }),
  useQueryClient: () => ({ setQueryData })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate
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
  useTabs: () => ({
    closeTab,
    openTab,
    updateTabTitle,
    setTabModified,
    setTabEntity,
    registerCloseGuard
  }),
  useActiveTab: () => activeTab
}))

vi.mock('@/hooks/use-note-editor-settings', () => ({
  useNoteEditorSettings: () => ({ settings: { toolbarMode: 'sticky' } })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}))

vi.mock('@/components/note', () => ({
  NoteLayout: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  )
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
    onDeleteProperty
  }: {
    properties: Array<{ id: string; name: string; value: unknown }>
    disabled?: boolean
    onPropertyChange: (id: string, value: unknown) => void
    onDeleteProperty: (id: string) => void
  }) => (
    <div>
      properties {properties.map((prop) => `${prop.name}:${String(prop.value)}`).join(',')}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPropertyChange(properties[0]?.id ?? '', 'changed')}
      >
        change property
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDeleteProperty(properties[0]?.id ?? '')}
      >
        delete property
      </button>
    </div>
  )
}))

vi.mock('@/components/note/ghost-affordance-row', () => ({
  GhostAffordanceRow: ({
    disabled,
    onAddProperty
  }: {
    disabled?: boolean
    onAddProperty: (property: { name: string; type: 'text' }) => void
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAddProperty({ name: 'Status', type: 'text' })}
    >
      add property
    </button>
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

vi.mock('@/components/icon-picker-button', () => ({
  IconPickerButton: ({
    children,
    ariaLabel,
    onIconChange
  }: {
    children: ReactNode
    ariaLabel: string
    onIconChange: (icon: string | null) => void
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onIconChange('📘')}>
      {children}
    </button>
  )
}))

// Radix-based Picker never opens in jsdom; the ⋯ menu is not under test here.
vi.mock('@/components/ui/picker', () => ({
  Picker: Object.assign(({ children }: { children: ReactNode }) => <>{children}</>, {
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: () => null,
    List: () => null,
    Item: () => null,
    Separator: () => null
  })
}))

describe('TemplateEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryData = null
    queryLoading = false
    activeTab = { id: 'tab-1' }
    createTemplate.mockResolvedValue({ id: 'tpl-1', name: 'Meeting' })
    updateTemplate.mockResolvedValue({ id: 'tpl-1', name: 'Meeting' })
    duplicateTemplate.mockResolvedValue({ id: 'tpl-copy', name: 'Daily copy' })
    deleteTemplate.mockResolvedValue(true)
  })

  it('renders the note surface, not a form header', () => {
    render(<TemplateEditorPage />)

    expect(screen.getByLabelText('template title')).toBeInTheDocument()
    expect(screen.queryByLabelText('description')).not.toBeInTheDocument()
  })

  it('disables Create while the name is blank', () => {
    render(<TemplateEditorPage />)

    expect(screen.getByRole('button', { name: /create template/i })).toBeDisabled()
  })

  it('writes nothing until Create is clicked', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')
    expect(createTemplate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /create template/i }))
    await waitFor(() => expect(createTemplate).toHaveBeenCalledTimes(1))
  })

  it('adopts the new id on the tab and flips the button to Update', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')
    await user.click(screen.getByRole('button', { name: /create template/i }))

    await waitFor(() =>
      expect(setTabEntity).toHaveBeenCalledWith('tab-1', 'tpl-1', '/templates/tpl-1')
    )
    expect(await screen.findByRole('button', { name: /^update$/i })).toBeInTheDocument()
  })

  it('keeps the editor mounted when the tab hands the new id back', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')
    await user.click(screen.getByRole('button', { name: /create template/i }))
    await waitFor(() => expect(setTabEntity).toHaveBeenCalled())

    // The tab adopts the id, so this page re-renders with a templateId it did
    // not open with. Keying the surface off that id would remount it and throw
    // away the editor the user is still typing in.
    queryLoading = true
    rerender(<TemplateEditorPage templateId="tpl-1" />)

    expect(screen.getByLabelText('template title')).toHaveValue('Meeting')
    expect(screen.queryByText('loading')).not.toBeInTheDocument()
  })

  it('drives the tab it was mounted in, not whichever tab is active', async () => {
    const user = userEvent.setup()
    activeTab = { id: 'focused-elsewhere' }
    render(<TemplateEditorPage tabId="tab-1" />)

    await user.type(screen.getByLabelText('template title'), 'M')

    await waitFor(() => expect(updateTabTitle).toHaveBeenCalledWith('tab-1', 'M'))
    expect(registerCloseGuard).toHaveBeenCalledWith('tab-1', expect.any(Object))
  })

  it('tracks the tab title live and marks the tab modified', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'M')

    await waitFor(() => expect(updateTabTitle).toHaveBeenCalledWith('tab-1', 'M'))
    expect(setTabModified).toHaveBeenCalledWith('tab-1', true)
  })

  it('falls back to New Template when the name is cleared', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    const title = screen.getByLabelText('template title')
    await user.type(title, 'M')
    await user.clear(title)

    await waitFor(() => expect(updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'New Template'))
  })

  it('registers a close guard that reports the draft as dirty', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')

    expect(registerCloseGuard).toHaveBeenCalledWith('tab-1', expect.any(Object))
    const guard = registerCloseGuard.mock.calls.at(-1)?.[1] as unknown as {
      isDirty: () => boolean
    }
    expect(guard.isDirty()).toBe(true)
  })

  it('renders a built-in read-only with a Duplicate & Edit action', async () => {
    queryData = {
      id: 'tpl-builtin',
      name: 'Daily',
      isBuiltIn: true,
      tags: [],
      properties: [],
      content: 'body'
    }
    const user = userEvent.setup()
    render(<TemplateEditorPage templateId="tpl-builtin" />)

    expect(screen.getByLabelText('template title')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^update$/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /duplicate & edit/i }))
    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith('tpl-builtin', expect.any(String))
    )
  })

  it('preserves a select property type when only the title is edited', async () => {
    queryData = {
      id: 'tpl-1',
      name: 'Meeting',
      isBuiltIn: false,
      tags: [],
      properties: [{ name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }],
      content: ''
    }
    const user = userEvent.setup()
    render(<TemplateEditorPage templateId="tpl-1" />)

    await user.type(screen.getByLabelText('template title'), ' Notes')
    await user.click(screen.getByRole('button', { name: /^update$/i }))

    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls.at(-1)?.[0].properties).toEqual([
      { name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }
    ])
  })
})
