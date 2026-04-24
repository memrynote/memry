/**
 * Template Editor Page
 *
 * Full-featured editor for creating and editing templates.
 * Reuses note editor components (NoteTitle, TagsRow, InfoSection, ContentArea).
 */

import { useState, useCallback, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, Property, NewProperty, PropertyType } from '@/components/note/info-section'
import { getUniquePropertyName } from '@/lib/property-utils'
import { ContentArea } from '@/components/note/content-area'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Loader2, Save, ArrowLeft, Lock } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { toast } from 'sonner'
import type { Template, TemplateProperty } from '@/services/templates-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:TemplateEditor')

// ============================================================================
// Types
// ============================================================================

interface TemplateEditorPageProps {
  templateId?: string // undefined for new template
}

interface TemplateEditorInitialState {
  name: string
  description: string
  icon: string | null
  tags: string[]
  properties: TemplateProperty[]
  content: string
  isBuiltIn: boolean
}

// Default values for property types
function getDefaultValueForType(type: PropertyType): unknown {
  switch (type) {
    case 'checkbox':
      return false
    case 'number':
      return 0
    case 'date':
      return null
    default:
      return ''
  }
}

// Map PropertyType to TemplatePropertyType
// Note: Templates support more property types than the unified properties system
function mapToTemplatePropertyType(type: PropertyType): TemplateProperty['type'] {
  const typeMap: Record<PropertyType, TemplateProperty['type']> = {
    text: 'text',
    number: 'number',
    date: 'date',
    checkbox: 'checkbox',
    url: 'url',
    status: 'select',
    select: 'select',
    multiselect: 'multiselect'
  }
  return typeMap[type] ?? 'text'
}

// Map TemplatePropertyType to PropertyType
// Unsupported template types fall back to 'text'
function mapFromTemplatePropertyType(type: TemplateProperty['type']): PropertyType {
  const typeMap: Partial<Record<TemplateProperty['type'], PropertyType>> = {
    text: 'text',
    number: 'number',
    checkbox: 'checkbox',
    date: 'date',
    url: 'url'
  }
  return typeMap[type] ?? 'text'
}

// ============================================================================
// Loading State Component
// ============================================================================

function EditorLoadingState() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Loading template...</p>
      </div>
    </div>
  )
}

function getInitialTemplateState(
  template: Template | null | undefined
): TemplateEditorInitialState {
  return {
    name: template?.name ?? '',
    description: template?.description ?? '',
    icon: template?.icon ?? null,
    tags: template?.tags ?? [],
    properties: template?.properties ?? [],
    content: template?.content ?? '',
    isBuiltIn: template?.isBuiltIn ?? false
  }
}

interface TemplateEditorFormProps {
  templateId?: string
  initialTemplate: TemplateEditorInitialState
  allAvailableTags: Array<{ tag: string; color: string }>
  createTemplate: (input: {
    name: string
    description?: string
    icon: string | null
    tags: string[]
    properties: TemplateProperty[]
    content: string
  }) => Promise<Template | null>
  updateTemplate: (input: {
    id: string
    name: string
    description?: string
    icon: string | null
    tags: string[]
    properties: TemplateProperty[]
    content: string
  }) => Promise<Template | null>
  onCloseActiveTab: () => void
  onUpdateActiveTabTitle: (title: string) => void
  isStickyToolbar: boolean
}

// ============================================================================
// Form Component
// ============================================================================

function TemplateEditorForm({
  templateId,
  initialTemplate,
  allAvailableTags,
  createTemplate,
  updateTemplate,
  onCloseActiveTab,
  onUpdateActiveTabTitle,
  isStickyToolbar
}: TemplateEditorFormProps) {
  const isNew = !templateId
  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        name: initialTemplate.name,
        description: initialTemplate.description,
        icon: initialTemplate.icon,
        tags: initialTemplate.tags,
        properties: initialTemplate.properties,
        content: initialTemplate.content
      }),
    [initialTemplate]
  )

  const [isSaving, setIsSaving] = useState(false)
  const isBuiltIn = initialTemplate.isBuiltIn

  // Form state
  const [name, setName] = useState(initialTemplate.name)
  const [description, setDescription] = useState(initialTemplate.description)
  const icon = initialTemplate.icon
  const [tags, setTags] = useState<string[]>(() => [...initialTemplate.tags])
  const [properties, setProperties] = useState<TemplateProperty[]>(() => [
    ...initialTemplate.properties
  ])
  const [content, setContent] = useState(initialTemplate.content)

  // Track if modified
  const initialStateRef = useRef<string>(initialSnapshot)
  const isModified = useMemo(() => {
    const currentState = JSON.stringify({ name, description, icon, tags, properties, content })
    return currentState !== initialStateRef.current
  }, [name, description, icon, tags, properties, content])

  // Convert tags to UI format
  const pendingTagColorsRef = useRef(new Map<string, string>())

  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag, t.color)
    }
    for (const key of pendingTagColorsRef.current.keys()) {
      if (map.has(key)) pendingTagColorsRef.current.delete(key)
    }
    return map
  }, [allAvailableTags])

  const templateTags: Tag[] = useMemo(() => {
    return tags.map((tagName) => ({
      id: tagName,
      name: tagName,
      color: tagColorMap.get(tagName) ?? pendingTagColorsRef.current.get(tagName) ?? 'stone'
    }))
  }, [tags, tagColorMap])

  const availableTags: Tag[] = useMemo(() => {
    return allAvailableTags.map((t) => ({
      id: t.tag,
      name: t.tag,
      color: t.color
    }))
  }, [allAvailableTags])

  // Convert properties to UI format
  const uiProperties: Property[] = useMemo(() => {
    return properties.map((prop, index) => ({
      id: `prop-${index}`,
      name: prop.name,
      type: mapFromTemplatePropertyType(prop.type),
      value: prop.value,
      isCustom: true,
      options: prop.options
    }))
  }, [properties])

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast.error('Template name is required')
      return
    }

    setIsSaving(true)
    try {
      if (isNew) {
        const result = await createTemplate({
          name: name.trim(),
          description: description.trim() || undefined,
          icon,
          tags,
          properties,
          content
        })
        if (result) {
          toast.success('Template created')
          // Update initial state to mark as saved
          initialStateRef.current = JSON.stringify({
            name,
            description,
            icon,
            tags,
            properties,
            content
          })
          // Close the tab or navigate to the new template
          onCloseActiveTab()
        } else {
          toast.error('Failed to create template')
        }
      } else {
        const result = await updateTemplate({
          id: templateId,
          name: name.trim(),
          description: description.trim() || undefined,
          icon,
          tags,
          properties,
          content
        })
        if (result) {
          toast.success('Template saved')
          onUpdateActiveTabTitle(name.trim())
          initialStateRef.current = JSON.stringify({
            name,
            description,
            icon,
            tags,
            properties,
            content
          })
        } else {
          toast.error('Failed to save template')
        }
      }
    } catch (err) {
      log.error('Failed to save template:', err)
      toast.error('Failed to save template')
    } finally {
      setIsSaving(false)
    }
  }, [
    isNew,
    name,
    description,
    icon,
    tags,
    properties,
    content,
    createTemplate,
    updateTemplate,
    templateId,
    onCloseActiveTab,
    onUpdateActiveTabTitle
  ])

  const handleNameChange = useCallback(
    (newName: string) => {
      if (isBuiltIn) return
      setName(newName)
    },
    [isBuiltIn]
  )

  const handleAddTag = useCallback(
    (tagId: string) => {
      if (isBuiltIn) return
      const tagToAdd = availableTags.find((t) => t.id === tagId)
      if (tagToAdd && !tags.includes(tagToAdd.name)) {
        setTags([...tags, tagToAdd.name])
      }
    },
    [tags, availableTags, isBuiltIn]
  )

  const handleCreateTag = useCallback(
    (tagName: string, color: string) => {
      if (isBuiltIn) return
      pendingTagColorsRef.current.set(tagName.toLowerCase(), color)
      if (!tags.includes(tagName)) {
        setTags([...tags, tagName])
      }
    },
    [tags, isBuiltIn]
  )

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      if (isBuiltIn) return
      setTags(tags.filter((t) => t !== tagId))
    },
    [tags, isBuiltIn]
  )

  const handlePropertyChange = useCallback(
    (propertyId: string, value: unknown) => {
      if (isBuiltIn) return
      const index = parseInt(propertyId.replace('prop-', ''), 10)
      setProperties((prev) => {
        const updated = [...prev]
        if (updated[index]) {
          updated[index] = { ...updated[index], value }
        }
        return updated
      })
    },
    [isBuiltIn]
  )

  const handleAddProperty = useCallback(
    (newProp: NewProperty) => {
      if (isBuiltIn) return
      const defaultValue = getDefaultValueForType(newProp.type)
      setProperties((prev) => {
        const existingNames = prev.map((p) => p.name)
        const uniqueName = getUniquePropertyName(newProp.name, existingNames)
        return [
          ...prev,
          {
            name: uniqueName,
            type: mapToTemplatePropertyType(newProp.type),
            value: defaultValue
          }
        ]
      })
    },
    [isBuiltIn]
  )

  const handleDeleteProperty = useCallback(
    (propertyId: string) => {
      if (isBuiltIn) return
      const index = parseInt(propertyId.replace('prop-', ''), 10)
      setProperties((prev) => prev.filter((_, i) => i !== index))
    },
    [isBuiltIn]
  )

  const handleContentChange = useCallback((markdown: string) => {
    // Note: isBuiltIn check is handled by ContentArea's editable prop
    setContent(markdown)
  }, [])

  const handleBack = useCallback(() => {
    onCloseActiveTab()
  }, [onCloseActiveTab])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="font-semibold">
              {isNew ? 'New Template' : isBuiltIn ? 'View Template' : 'Edit Template'}
            </h1>
            {isBuiltIn && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Lock className="w-3 h-3" />
                Built-in templates cannot be modified
              </p>
            )}
          </div>
        </div>
        {!isBuiltIn && (
          <Button onClick={handleSave} disabled={isSaving || (!isNew && !isModified)}>
            {isSaving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {isNew ? 'Create Template' : 'Save Changes'}
          </Button>
        )}
      </div>

      {/* Editor content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto p-6 space-y-6">
          {/* Template metadata */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => !isBuiltIn && setDescription(e.target.value)}
                placeholder="Brief description of this template..."
                className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                rows={2}
                disabled={isBuiltIn}
              />
            </div>
          </div>

          <Separator />

          {/* Note preview section */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-4">Template Content</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Use <code className="bg-muted px-1 rounded">{'{{title}}'}</code> to insert the note
              title when creating a note.
            </p>

            {/* Title with emoji */}
            <div className="space-y-4">
              <NoteTitle
                emoji={icon}
                title={name}
                placeholder="Template Name"
                onTitleChange={handleNameChange}
                disabled={isBuiltIn}
              />

              {/* Tags */}
              <TagsRow
                tags={templateTags}
                availableTags={availableTags}
                recentTags={availableTags.slice(0, 4)}
                onAddTag={handleAddTag}
                onCreateTag={handleCreateTag}
                onRemoveTag={handleRemoveTag}
                disabled={isBuiltIn}
              />

              {/* Properties */}
              <InfoSection
                properties={uiProperties}
                isExpanded={true}
                onToggleExpand={() => {}}
                onPropertyChange={handlePropertyChange}
                onAddProperty={handleAddProperty}
                onDeleteProperty={handleDeleteProperty}
                disabled={isBuiltIn}
              />
            </div>

            <Separator className="my-6" />

            {/* Content editor */}
            <div className="min-h-[300px] border rounded-md p-4 bg-card">
              <ContentArea
                key={templateId || 'new'}
                initialContent={content}
                contentType="markdown"
                placeholder="Default content for notes created from this template..."
                stickyToolbar={isStickyToolbar}
                onMarkdownChange={handleContentChange}
                editable={!isBuiltIn}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function TemplateEditorPage({ templateId }: TemplateEditorPageProps) {
  const { getTemplate, createTemplate, updateTemplate } = useTemplates({ autoLoad: false })
  const { tags: allAvailableTags } = useNoteTagsQuery()
  const { closeTab, updateTabTitle } = useTabs()
  const activeTab = useActiveTab()
  const { settings: editorSettings } = useNoteEditorSettings()

  const { data: template, isLoading } = useQuery({
    queryKey: ['template-editor', templateId],
    queryFn: async () => {
      if (!templateId) return null
      return getTemplate(templateId)
    },
    enabled: !!templateId
  })

  const initialTemplate = useMemo(() => getInitialTemplateState(template), [template])

  const handleCloseActiveTab = useCallback(() => {
    if (activeTab) {
      closeTab(activeTab.id)
    }
  }, [activeTab, closeTab])

  const handleUpdateActiveTabTitle = useCallback(
    (title: string) => {
      if (activeTab) {
        updateTabTitle(activeTab.id, title)
      }
    },
    [activeTab, updateTabTitle]
  )

  if (templateId && isLoading) {
    return <EditorLoadingState />
  }

  return (
    <TemplateEditorForm
      key={templateId || 'new'}
      templateId={templateId}
      initialTemplate={initialTemplate}
      allAvailableTags={allAvailableTags}
      createTemplate={createTemplate}
      updateTemplate={updateTemplate}
      onCloseActiveTab={handleCloseActiveTab}
      onUpdateActiveTabTitle={handleUpdateActiveTabTitle}
      isStickyToolbar={editorSettings.toolbarMode === 'sticky'}
    />
  )
}

export default TemplateEditorPage
