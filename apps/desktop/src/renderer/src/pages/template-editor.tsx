/**
 * Template Editor Page
 *
 * A template is authored on the note surface: the same title, tags, properties
 * and content editor a note uses. A new template is an in-memory draft until
 * the Create button is pressed; after that every edit auto-saves, the way a
 * note does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { NoteLayout } from '@/components/note'
import { ContentArea } from '@/components/note/content-area'
import { GhostAffordanceRow } from '@/components/note/ghost-affordance-row'
import { InfoSection, type NewProperty } from '@/components/note/info-section'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, type Tag } from '@/components/note/tags-row'
import { IconPickerButton } from '@/components/icon-picker-button'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { Copy, FileText, Loader2, MoreVertical, Trash2 } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useTemplates } from '@/hooks/use-templates'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useTemplateDraft, type TemplateDraftFields } from '@/hooks/use-template-draft'
import {
  addProperty,
  removeProperty,
  reorderProperties,
  setPropertyName,
  setPropertyValue,
  toEditableProperties,
  toUiProperties,
  TEMPLATE_UNSUPPORTED_PROPERTY_TYPES
} from '@/lib/template-properties'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'
import type { Template } from '@/services/templates-service'

const log = createLogger('Page:TemplateEditor')

interface TemplateEditorPageProps {
  templateId?: string // undefined for a new template
  /**
   * The tab this page is rendered in. Falls back to the active tab when the
   * host does not supply it, but the active tab is the wrong answer in split
   * view: the editor can be mounted in a pane that is not the focused one.
   */
  tabId?: string
}

function EditorLoadingState() {
  const { t } = useT('notes')
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">{t('templateEditor.loading')}</p>
      </div>
    </div>
  )
}

interface TemplateEditorSurfaceProps {
  templateId?: string
  tabId?: string
  initial: TemplateDraftFields
  isBuiltIn: boolean
}

function TemplateEditorSurface({
  templateId: initialTemplateId,
  tabId: ownTabId,
  initial,
  isBuiltIn
}: TemplateEditorSurfaceProps) {
  const { t } = useT('notes')
  const queryClient = useQueryClient()
  const { deleteTemplate, duplicateTemplate } = useTemplates({ autoLoad: false })
  const { tags: allAvailableTags } = useNoteTagsQuery()
  const { settings: editorSettings } = useNoteEditorSettings()
  const { closeTab, openTab, updateTabTitle, setTabModified, setTabEntity, registerCloseGuard } =
    useTabs()
  const activeTab = useActiveTab()
  const tabId = ownTabId ?? activeTab?.id

  const handleCreated = useCallback(
    (created: Template) => {
      // Seed the cache before the tab adopts the id: the id reaches this page
      // back through `tab.entityId`, and an unseeded query would flip to
      // loading and tear the whole surface — editor included — down again.
      queryClient.setQueryData(['template-editor', created.id], created)
      if (tabId) setTabEntity(tabId, created.id, `/templates/${created.id}`)
    },
    [tabId, setTabEntity, queryClient]
  )

  const { fields, setFields, state, templateId, isDirty, canSave, save } = useTemplateDraft({
    templateId: initialTemplateId,
    initial,
    onCreated: handleCreated
  })

  // ==========================================================================
  // Tab wiring
  // ==========================================================================

  // The tab title follows the name as it is typed. Driven from the change
  // handler rather than an effect so the tab is updated by the edit itself.
  const handleNameChange = useCallback(
    (name: string) => {
      setFields({ name })
      if (tabId) updateTabTitle(tabId, name.trim() || t('templateEditor.title.new'))
    },
    [setFields, tabId, updateTabTitle, t]
  )

  useEffect(() => {
    if (!tabId) return
    setTabModified(tabId, isDirty)
  }, [tabId, isDirty, setTabModified])

  // Delete closes the tab on purpose; the guard must not then offer to save the
  // template that was just removed.
  const suppressGuardRef = useRef(false)
  // Read through refs so the guard registration stays stable across edits.
  // Synced after commit rather than during render: the guard is only ever
  // consulted from a close action, which happens well after the commit.
  const isDirtyRef = useRef(isDirty)
  const canSaveRef = useRef(canSave)
  const saveRef = useRef(save)
  useEffect(() => {
    isDirtyRef.current = isDirty
    canSaveRef.current = canSave
    saveRef.current = save
  })

  useEffect(() => {
    if (!tabId || isBuiltIn) return
    return registerCloseGuard(tabId, {
      // A nameless draft cannot be persisted; say so rather than let the prompt
      // offer a Save that would silently do nothing.
      canSave: () => canSaveRef.current,
      isDirty: () => !suppressGuardRef.current && isDirtyRef.current,
      save: () => saveRef.current()
    })
  }, [tabId, isBuiltIn, registerCloseGuard])

  // ==========================================================================
  // Tags
  // ==========================================================================

  // A tag created here has no colour in the notes query until the write lands;
  // hold it locally so the chip is not colourless in the meantime.
  const pendingTagColorsRef = useRef<Map<string, string>>(new Map())

  // Keyed lower-case on both sides, as note.tsx does: tag names are
  // case-preserving, so a raw-case lookup would miss the pending colour of a
  // tag the user typed with a capital.
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const tag of allAvailableTags) map.set(tag.tag.toLowerCase(), tag.color)
    for (const key of pendingTagColorsRef.current.keys()) {
      if (map.has(key)) pendingTagColorsRef.current.delete(key)
    }
    return map
  }, [allAvailableTags])

  const templateTags: Tag[] = useMemo(
    () =>
      fields.tags.map((name) => ({
        id: name,
        name,
        color:
          tagColorMap.get(name.toLowerCase()) ??
          pendingTagColorsRef.current.get(name.toLowerCase()) ??
          ''
      })),
    [fields.tags, tagColorMap]
  )

  const availableTags: Tag[] = useMemo(
    () => allAvailableTags.map((tag) => ({ id: tag.tag, name: tag.tag, color: tag.color })),
    [allAvailableTags]
  )

  const handleAddTag = useCallback(
    (tagId: string) => {
      const tag = availableTags.find((candidate) => candidate.id === tagId)
      if (!tag || fields.tags.includes(tag.name)) return
      setFields({ tags: [...fields.tags, tag.name] })
    },
    [availableTags, fields.tags, setFields]
  )

  const handleCreateTag = useCallback(
    (name: string, color: string) => {
      pendingTagColorsRef.current.set(name.toLowerCase(), color)
      if (fields.tags.includes(name)) return
      setFields({ tags: [...fields.tags, name] })
    },
    [fields.tags, setFields]
  )

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      setFields({ tags: fields.tags.filter((tag) => tag !== tagId) })
    },
    [fields.tags, setFields]
  )

  // ==========================================================================
  // Properties
  // ==========================================================================

  const [propertiesExpanded, setPropertiesExpanded] = useState(true)
  const uiProperties = useMemo(() => toUiProperties(fields.properties), [fields.properties])

  const handlePropertyChange = useCallback(
    (propertyId: string, value: unknown) => {
      setFields({ properties: setPropertyValue(fields.properties, propertyId, value) })
    },
    [fields.properties, setFields]
  )

  const handlePropertyNameChange = useCallback(
    (propertyId: string, name: string) => {
      setFields({ properties: setPropertyName(fields.properties, propertyId, name) })
    },
    [fields.properties, setFields]
  )

  const handlePropertyOrderChange = useCallback(
    (orderedIds: string[]) => {
      setFields({ properties: reorderProperties(fields.properties, orderedIds) })
    },
    [fields.properties, setFields]
  )

  const handleAddProperty = useCallback(
    (property: NewProperty) => {
      setPropertiesExpanded(true)
      setFields({ properties: addProperty(fields.properties, property) })
    },
    [fields.properties, setFields]
  )

  const handleDeleteProperty = useCallback(
    (propertyId: string) => {
      setFields({ properties: removeProperty(fields.properties, propertyId) })
    },
    [fields.properties, setFields]
  )

  // ==========================================================================
  // Actions
  // ==========================================================================

  const openTemplateTab = useCallback(
    (template: { id: string; name: string }) => {
      openTab({
        type: 'template-editor',
        title: template.name,
        icon: 'layout-template',
        path: `/templates/${template.id}`,
        entityId: template.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  const handleDuplicate = useCallback(async () => {
    if (!templateId) return
    try {
      const copy = await duplicateTemplate(
        templateId,
        t('templateEditor.copySuffix', { name: fields.name.trim() })
      )
      if (copy) openTemplateTab(copy)
    } catch (err) {
      log.error('Failed to duplicate template:', err)
    }
  }, [templateId, duplicateTemplate, fields.name, t, openTemplateTab])

  const handleDelete = useCallback(async () => {
    if (!templateId) return
    try {
      const deleted = await deleteTemplate(templateId)
      if (!deleted) return
      suppressGuardRef.current = true
      if (tabId) closeTab(tabId)
    } catch (err) {
      log.error('Failed to delete template:', err)
    }
  }, [templateId, deleteTemplate, tabId, closeTab])

  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  const isSaving = state === 'saving'
  const primaryDisabled = !canSave || isSaving || (templateId !== undefined && !isDirty)

  const actions = (
    <div className="flex items-center gap-1.5">
      {isBuiltIn ? (
        <Button size="sm" onClick={() => void handleDuplicate()}>
          {t('templateEditor.actions.duplicateAndEdit')}
        </Button>
      ) : (
        <>
          <Button size="sm" disabled={primaryDisabled} onClick={() => void save()}>
            {isSaving && <Loader2 className="size-3.5 me-1.5 animate-spin" />}
            {templateId === undefined
              ? t('templateEditor.actions.create')
              : t('templateEditor.actions.update')}
          </Button>

          {templateId !== undefined && (
            <Picker
              value={null}
              open={moreMenuOpen}
              onOpenChange={setMoreMenuOpen}
              onValueChange={(action) => {
                setMoreMenuOpen(false)
                if (action === 'duplicate') void handleDuplicate()
                if (action === 'delete') void handleDelete()
              }}
            >
              <Picker.Trigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('templateEditor.actions.more')}
                >
                  <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </Picker.Trigger>
              <Picker.Content align="end">
                <Picker.List>
                  <Picker.Item
                    value="duplicate"
                    label={t('templateEditor.actions.duplicate')}
                    icon={<Copy className="size-4" />}
                  />
                  <Picker.Item
                    value="delete"
                    label={t('templateEditor.actions.delete')}
                    icon={<Trash2 className="size-4" />}
                    destructive
                  />
                </Picker.List>
              </Picker.Content>
            </Picker>
          )}
        </>
      )}
    </div>
  )

  return (
    <NoteLayout actions={actions}>
      <div className="flex flex-col flex-1 mx-auto w-full max-w-4xl">
        <div className="group/metadata flex flex-col gap-2.5 pb-[15px]">
          <div className="flex items-center gap-3">
            <IconPickerButton
              hasIcon={fields.icon !== null}
              onIconChange={(icon) => setFields({ icon })}
              ariaLabel={t('templateEditor.icon.label')}
            >
              {fields.icon ? (
                <NoteIconDisplay value={fields.icon} className="text-[22px] leading-6" />
              ) : (
                <FileText className="size-5 text-muted-foreground/60" />
              )}
            </IconPickerButton>

            <div className="min-w-0 flex-1">
              <NoteTitle
                emoji={null}
                title={fields.name}
                placeholder={t('templateEditor.title.placeholder')}
                onTitleChange={handleNameChange}
                disabled={isBuiltIn}
              />
            </div>
          </div>

          <TagsRow
            tags={templateTags}
            availableTags={availableTags}
            recentTags={availableTags.slice(0, 4)}
            onAddTag={handleAddTag}
            onCreateTag={handleCreateTag}
            onRemoveTag={handleRemoveTag}
            disabled={isBuiltIn}
            hideWhenEmpty
            hideAddButton
          />

          {uiProperties.length > 0 && (
            <InfoSection
              properties={uiProperties}
              isExpanded={propertiesExpanded}
              onToggleExpand={() => setPropertiesExpanded((prev) => !prev)}
              onPropertyChange={handlePropertyChange}
              onPropertyNameChange={handlePropertyNameChange}
              onPropertyOrderChange={handlePropertyOrderChange}
              onAddProperty={handleAddProperty}
              onDeleteProperty={handleDeleteProperty}
              excludeTypes={TEMPLATE_UNSUPPORTED_PROPERTY_TYPES}
              disabled={isBuiltIn}
              variant="embedded"
              hideAddButton
            />
          )}

          <GhostAffordanceRow
            availableTags={availableTags}
            recentTags={availableTags.slice(0, 4)}
            currentTagIds={templateTags.map((tag) => tag.id)}
            onAddTag={handleAddTag}
            onCreateTag={handleCreateTag}
            onAddProperty={handleAddProperty}
            excludeTypes={TEMPLATE_UNSUPPORTED_PROPERTY_TYPES}
            disabled={isBuiltIn}
          />
        </div>

        <div className="editor-click-area flex-1 pb-[30vh] relative">
          <ContentArea
            initialContent={initial.content}
            contentType="markdown"
            placeholder={t('templateEditor.content.placeholder')}
            stickyToolbar={editorSettings.toolbarMode === 'sticky'}
            onMarkdownChange={(markdown) => setFields({ content: markdown })}
            editable={!isBuiltIn}
          />
        </div>
      </div>
    </NoteLayout>
  )
}

function toInitialFields(template: Template | null | undefined): TemplateDraftFields {
  return {
    name: template?.name ?? '',
    icon: template?.icon ?? null,
    tags: template?.tags ?? [],
    properties: toEditableProperties(template?.properties ?? []),
    content: template?.content ?? ''
  }
}

export function TemplateEditorPage({ templateId, tabId }: TemplateEditorPageProps) {
  const { getTemplate } = useTemplates({ autoLoad: false })
  // Pinned to the identity this tab opened with. `templateId` changes once, when
  // a draft adopts its new id, and remounting the surface there would throw away
  // the editor the user is typing in.
  const surfaceKey = useRef(templateId ?? 'new').current

  const { data: template, isLoading } = useQuery({
    queryKey: ['template-editor', templateId],
    queryFn: async () => {
      if (!templateId) return null
      return getTemplate(templateId)
    },
    enabled: !!templateId
  })

  const initial = useMemo(() => toInitialFields(template), [template])

  // Only ever a first-paint state: a tab that opened on a draft has no query to
  // wait for, and by the time it adopts an id the cache is already seeded.
  if (surfaceKey !== 'new' && isLoading) {
    return <EditorLoadingState />
  }

  return (
    <TemplateEditorSurface
      key={surfaceKey}
      templateId={templateId}
      tabId={tabId}
      initial={initial}
      isBuiltIn={template?.isBuiltIn ?? false}
    />
  )
}

export default TemplateEditorPage
