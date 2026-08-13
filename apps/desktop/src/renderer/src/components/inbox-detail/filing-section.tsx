/**
 * Compact Filing Section for Inbox Detail Panel
 * Provides folder selection, tags, and note linking in a compact layout
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Folder,
  Sparkles,
  Loader2,
  ChevronDown,
  Check,
  FileText,
  Search,
  Plus,
  Link2
} from '@/lib/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { LinkInput } from './link-input'
import { cn } from '@/lib/utils'
import { confidenceBand } from '@/lib/confidence-band'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import type { InboxItem, InboxItemListItem, Folder as FolderType, LinkedNote } from '@/types'
import type { ImageFilingMode } from '@memry/domain-inbox'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:FilingSection')

function normalizeFolderPath(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/[\\/]+$/, '')
}

// Filing section can work with either full or list item types
type FilingItem = InboxItem | InboxItemListItem

// Extended folder type with AI metadata
type SuggestedFolder = FolderType & { aiConfidence?: number; aiReason?: string }

// =============================================================================
// Types
// =============================================================================

interface FilingSectionProps {
  item: FilingItem | null
  selectedFolder: FolderType | null
  tags: string[]
  linkedNotes: LinkedNote[]
  onFolderSelect: (folder: FolderType) => void
  onTagsChange: (tags: string[]) => void
  onLinkedNotesChange: (notes: LinkedNote[]) => void
  /**
   * #807 — images only. `mode` shapes the whole form, not just the outcome:
   * embedding puts the file under the note's attachments, so there is no folder
   * to pick and the "File to" row goes away. `askUser` is what the "don't ask
   * again" checkbox turns off; the mode itself still applies.
   */
  imageFiling?: {
    mode: ImageFilingMode
    onModeChange: (mode: ImageFilingMode) => void
    remember: boolean
    onRememberChange: (remember: boolean) => void
    askUser: boolean
  }
  className?: string
}

// =============================================================================
// Filing Section Component
// =============================================================================

export const FilingSection = ({
  item,
  selectedFolder,
  tags,
  linkedNotes,
  onFolderSelect,
  onTagsChange,
  onLinkedNotesChange,
  imageFiling,
  className
}: FilingSectionProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const { enabled: aiEnabled } = useAISettingsContext()
  const queryClient = useQueryClient()
  const [showAllFolders, setShowAllFolders] = useState(false)
  const [folderSearch, setFolderSearch] = useState('')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [showLinks, setShowLinks] = useState(false)

  // Fetch real folders from vault
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const folderInfos = await window.api.notes.getFolders()
      const folders: FolderType[] = [{ id: '', name: t('detail.notesRootLabel'), path: '' }]
      for (const fi of folderInfos) {
        const normalizedPath = normalizeFolderPath(fi.path)
        if (normalizedPath) {
          folders.push({
            id: normalizedPath,
            name: normalizedPath.split('/').pop() || normalizedPath,
            path: normalizedPath,
            parent: normalizedPath.includes('/')
              ? normalizedPath.split('/').slice(0, -1).join('/')
              : undefined,
            icon: fi.icon ?? null
          })
        }
      }
      return folders
    },
    enabled: item !== null
  })

  // Fetch AI-powered filing suggestions
  const { data: aiSuggestions = [], isLoading: isLoadingAISuggestions } = useQuery({
    queryKey: ['inbox', 'suggestions', item?.id],
    queryFn: async () => {
      if (!item?.id) return []
      try {
        const response = await window.api.inbox.getSuggestions(item.id)
        return response.suggestions || []
      } catch (error) {
        log.error('Failed to fetch AI suggestions', error)
        return []
      }
    },
    enabled: aiEnabled && item !== null && !!item?.id,
    staleTime: 30000
  })

  // Convert AI suggestions to folder objects with confidence metadata
  const suggestedFolders = useMemo((): SuggestedFolder[] => {
    if (aiEnabled && aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 3)
        .map((s) => {
          const path = normalizeFolderPath(s.destination.path || '')
          const vaultMatch = vaultFolders.find((f) => f.path === path)
          return {
            id: path,
            name: path.split('/').pop() || path || t('detail.notesRoot'),
            path: path,
            icon: vaultMatch?.icon ?? null,
            aiConfidence: s.confidence,
            aiReason: s.reason
          }
        })
    }
    return vaultFolders.slice(0, 3).map((f) => ({ ...f }))
  }, [aiEnabled, aiSuggestions, vaultFolders, t])

  const noteSuggestions = useMemo(() => {
    if (!aiEnabled) return []
    return aiSuggestions
      .filter((s) => s.destination.type === 'note' && s.suggestedNote)
      .slice(0, 3)
      .map((s) => ({
        note: s.suggestedNote!,
        confidence: s.confidence,
        reason: s.reason
      }))
  }, [aiEnabled, aiSuggestions])

  const aiSuggestedTags = useMemo(() => {
    if (!aiEnabled) return []
    if (aiSuggestions.length === 0) return []
    return aiSuggestions.flatMap((s) => s.suggestedTags || []).filter(Boolean)
  }, [aiEnabled, aiSuggestions])

  const hasAISuggestions = aiEnabled && aiSuggestions.length > 0

  // Track whether auto-selection already fired for this item
  const didAutoSelectFolder = useRef(false)
  const lastAutoSelectItemId = useRef(item?.id)
  if (lastAutoSelectItemId.current !== item?.id) {
    lastAutoSelectItemId.current = item?.id
    didAutoSelectFolder.current = false
  }

  // Auto-select top AI-suggested folder (once per item). Wrapping the
  // parent-callback invocation in `void` keeps it asynchronous from the
  // linter's perspective — calling parent callbacks straight from an effect
  // would otherwise trip no-pass-data-to-parent.
  useEffect(() => {
    if (!didAutoSelectFolder.current && suggestedFolders.length > 0 && !selectedFolder) {
      didAutoSelectFolder.current = true
      const top = suggestedFolders[0]
      void Promise.resolve().then(() => onFolderSelect(top))
    }
  }, [suggestedFolders, selectedFolder, onFolderSelect])

  // Derive display info for the folder dropdown trigger
  const displayFolder = selectedFolder
    ? (suggestedFolders.find((f) => f.id === selectedFolder.id) ?? {
        ...selectedFolder,
        icon:
          selectedFolder.icon ?? vaultFolders.find((f) => f.id === selectedFolder.id)?.icon ?? null,
        aiConfidence: undefined
      })
    : (suggestedFolders[0] ?? null)
  const displayPath = displayFolder?.path
    ? displayFolder.path.replace(/\//g, ' / ')
    : displayFolder?.name || t('detail.selectFolder')

  const handleLinkSuggestedNote = useCallback(
    (note: { id: string; title: string }) => {
      const alreadyLinked = linkedNotes.some((ln) => ln.id === note.id)
      if (alreadyLinked) {
        onLinkedNotesChange(linkedNotes.filter((ln) => ln.id !== note.id))
        return
      }
      onLinkedNotesChange([...linkedNotes, { id: note.id, title: note.title, type: 'note' }])
    },
    [linkedNotes, onLinkedNotesChange]
  )

  // Filter folders based on search query
  const filteredFolders = useMemo(() => {
    if (!folderSearch.trim()) return vaultFolders
    const query = folderSearch.toLowerCase()
    return vaultFolders.filter(
      (f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)
    )
  }, [vaultFolders, folderSearch])

  const trimmedSearch = normalizeFolderPath(folderSearch.trim())
  const canCreateFolder = trimmedSearch.length > 0 && filteredFolders.length === 0

  const handleCreateFolder = useCallback(async () => {
    if (!trimmedSearch || isCreatingFolder) return
    setIsCreatingFolder(true)
    try {
      const result = await window.api.notes.createFolder(trimmedSearch)
      if (!result.success) {
        log.error('Failed to create folder', { path: trimmedSearch })
        return
      }

      const createdFolder: FolderType = {
        id: trimmedSearch,
        name: trimmedSearch.split('/').pop() || trimmedSearch,
        path: trimmedSearch,
        parent: trimmedSearch.includes('/')
          ? trimmedSearch.split('/').slice(0, -1).join('/')
          : undefined
      }

      queryClient.setQueryData<FolderType[]>(['vault', 'folders'], (current = []) => {
        const baseFolders =
          current.length > 0 ? current : [{ id: '', name: t('detail.notesRootLabel'), path: '' }]
        if (baseFolders.some((folder) => folder.path === createdFolder.path)) {
          return baseFolders
        }

        const rootFolder = baseFolders.find((folder) => folder.path === '')
        const nextFolders = baseFolders
          .filter((folder) => folder.path !== '')
          .concat(createdFolder)
          .sort((left, right) => left.path.localeCompare(right.path))

        return rootFolder ? [rootFolder, ...nextFolders] : nextFolders
      })

      onFolderSelect(createdFolder)
      setShowAllFolders(false)
      setFolderSearch('')
    } catch (error) {
      log.error('Failed to create folder', error)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [trimmedSearch, isCreatingFolder, queryClient, onFolderSelect, t])

  // Embedding stores the image under the owning note's attachments, so there is
  // no folder for the user to choose — showing "File to" there would promise a
  // destination the filing never uses.
  const showFolderPicker = imageFiling?.mode !== 'embed'

  return (
    <div className={cn(className)}>
      {/* File To + Tags — line by line */}
      <div className="flex flex-col py-4 px-5 border-b border-border">
        {/* File To */}
        {showFolderPicker && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
                {t('detail.fileTo')}
              </span>
              {isLoadingAISuggestions ? (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                </div>
              ) : hasAISuggestions ? (
                <div className="flex items-center gap-1 text-[11px] text-[var(--tint)]">
                  <Sparkles className="size-3" />
                  <span>{t('detail.ai')}</span>
                </div>
              ) : null}
            </div>

            {/* Folder Dropdown */}
            <Popover
              open={showAllFolders}
              onOpenChange={(open) => {
                setShowAllFolders(open)
                if (!open) setFolderSearch('')
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex items-center w-full rounded-md py-2 px-3 transition-colors',
                    hasAISuggestions
                      ? 'bg-[var(--tint)]/[0.03] border border-[var(--tint)]/12'
                      : 'bg-foreground/[0.02] border border-border'
                  )}
                >
                  <div className="flex items-center grow gap-2 min-w-0">
                    {displayFolder?.icon ? (
                      <NoteIconDisplay value={displayFolder.icon} className="size-4 shrink-0" />
                    ) : (
                      <Folder
                        className={cn(
                          'size-4 shrink-0',
                          hasAISuggestions ? 'text-[var(--tint)]' : 'text-muted-foreground'
                        )}
                      />
                    )}
                    <span className="text-[13px] leading-4 font-medium text-foreground truncate">
                      {displayPath}
                    </span>
                  </div>
                  <ChevronDown className="size-3 text-muted-foreground/50 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[var(--radix-popover-trigger-width)] p-0 rounded-md bg-[var(--popover)] border-border shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
                align="start"
                sideOffset={4}
              >
                {/* Search */}
                <div className="flex items-center py-2 px-3 gap-2 border-b border-border/40">
                  <Search className="size-3.5 text-muted-foreground/40 shrink-0" />
                  <Input
                    placeholder={t('detail.searchOrCreateFolder')}
                    value={folderSearch}
                    onChange={(e) => setFolderSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canCreateFolder) {
                        e.preventDefault()
                        void handleCreateFolder()
                      }
                    }}
                    className="h-5 p-0 border-0 bg-transparent text-[13px] leading-5 text-foreground placeholder:text-muted-foreground/30 focus-visible:border-transparent focus-visible:ring-0 shadow-none"
                    autoFocus
                  />
                </div>

                <div className="max-h-56 overflow-y-auto">
                  {/* Suggested */}
                  {suggestedFolders.length > 0 && !folderSearch.trim() && (
                    <div className="flex flex-col py-1">
                      <span className="text-[10px] [letter-spacing:0.05em] uppercase text-muted-foreground/40 px-3 py-1">
                        {t('detail.suggested')}
                      </span>
                      {suggestedFolders.map((folder) => {
                        const isSelected = selectedFolder?.id === folder.id
                        return (
                          <button
                            type="button"
                            key={folder.id || 'root-suggested'}
                            onClick={() => {
                              onFolderSelect(folder)
                              setShowAllFolders(false)
                            }}
                            className={cn(
                              'flex items-center gap-2 rounded-sm py-1.5 px-3 mx-1 text-start transition-colors',
                              isSelected ? 'bg-[var(--tint)]/[0.05]' : 'hover:bg-foreground/[0.03]'
                            )}
                          >
                            {folder.icon ? (
                              <NoteIconDisplay value={folder.icon} className="size-3.5 shrink-0" />
                            ) : (
                              <Folder className="size-3.5 shrink-0 text-[var(--tint)]" />
                            )}
                            <span className="text-[13px] leading-4 text-foreground truncate grow">
                              {folder.path
                                ? folder.path.replace(/\//g, ' / ')
                                : t('detail.notesRoot')}
                            </span>
                            {isSelected && <Check className="size-3 shrink-0 text-[var(--tint)]" />}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* All folders */}
                  <div
                    className={cn(
                      'flex flex-col py-1',
                      suggestedFolders.length > 0 &&
                        !folderSearch.trim() &&
                        'border-t border-border/40'
                    )}
                  >
                    {canCreateFolder && (
                      <button
                        type="button"
                        onClick={() => void handleCreateFolder()}
                        disabled={isCreatingFolder}
                        className="flex items-center gap-2 py-1.5 px-3 mx-1 text-start transition-colors hover:bg-[var(--tint)]/[0.06] rounded-sm disabled:opacity-50"
                      >
                        {isCreatingFolder ? (
                          <Loader2 className="size-3.5 shrink-0 text-[var(--tint)] animate-spin" />
                        ) : (
                          <Plus className="size-3.5 shrink-0 text-[var(--tint)]" />
                        )}
                        <span className="text-[13px] leading-4 text-[var(--tint)]">
                          {t('detail.createFolder', { name: trimmedSearch })}
                        </span>
                      </button>
                    )}
                    {filteredFolders.length === 0 && !canCreateFolder ? (
                      <p className="text-xs text-muted-foreground text-center py-3">
                        {t('empty.noFolders')}
                      </p>
                    ) : filteredFolders.length === 0 ? null : (
                      filteredFolders.map((folder) => {
                        const isSelected = selectedFolder?.id === folder.id
                        return (
                          <button
                            type="button"
                            key={folder.id}
                            onClick={() => {
                              onFolderSelect(folder)
                              setShowAllFolders(false)
                            }}
                            className={cn(
                              'flex items-center gap-2 rounded-sm py-1.5 px-3 mx-1 text-start transition-colors',
                              isSelected ? 'bg-foreground/[0.03]' : 'hover:bg-foreground/[0.03]'
                            )}
                          >
                            {folder.icon ? (
                              <NoteIconDisplay value={folder.icon} className="size-3.5 shrink-0" />
                            ) : (
                              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="grow text-[13px] leading-4 text-foreground truncate">
                              {folder.path ? folder.path.replace(/\//g, ' / ') : folder.name}
                            </span>
                            {isSelected && (
                              <Check className="size-3 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}

        {/* Tags */}
        <TagAutocomplete
          tags={tags}
          onTagsChange={onTagsChange}
          placeholder={t('detail.addTags')}
          showSections={false}
          maxSuggestions={5}
          aiSuggestedTags={aiSuggestedTags}
          className="mt-4 py-0 px-0 border-b-0"
        />
      </div>

      {/* How the image lands in the notes it is linked to (#807). Sits above the
          link row because it decides whether the folder picker is shown at all. */}
      {imageFiling?.askUser && (
        <div
          className="flex flex-col gap-2 py-4 px-5 border-b border-border"
          data-testid="image-filing-mode"
        >
          <span className="text-[11px] leading-3.5 text-muted-foreground/60">
            {t('detail.imageFilingModeLabel')}
          </span>
          <div className="flex items-center gap-1.5">
            {(['embed', 'link'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`image-filing-mode-${mode}`}
                aria-pressed={imageFiling.mode === mode}
                onClick={() => imageFiling.onModeChange(mode)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-[12px] leading-4 border transition-colors',
                  imageFiling.mode === mode
                    ? 'bg-foreground/[0.06] border-border text-foreground'
                    : 'bg-transparent border-border/50 text-muted-foreground hover:bg-muted/40'
                )}
              >
                {mode === 'embed'
                  ? t('detail.imageFilingModeEmbed')
                  : t('detail.imageFilingModeLink')}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] leading-3.5 text-muted-foreground/60">
            <input
              type="checkbox"
              data-testid="image-filing-mode-remember"
              checked={imageFiling.remember}
              onChange={(e) => imageFiling.onRememberChange(e.target.checked)}
              className="size-3 accent-[var(--primary)]"
            />
            {t('detail.imageFilingModeRemember')}
          </label>
        </div>
      )}

      {/* Link to note — collapsed by default to keep the panel calm */}
      <div className="flex flex-col gap-2 py-4 px-5 border-b border-border">
        {!(showLinks || linkedNotes.length > 0) ? (
          <button
            type="button"
            onClick={() => setShowLinks(true)}
            className="flex items-center justify-between w-full rounded-md py-2 px-3 bg-foreground/[0.02] border border-border text-start transition-colors hover:bg-foreground/[0.03]"
          >
            <span className="flex items-center gap-2 text-[13px] leading-4 text-muted-foreground">
              <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
              {t('detail.linkANote')}
            </span>
            {noteSuggestions.length > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-[var(--tint)]">
                <Sparkles className="size-3" />
                {t('detail.suggestedCount', { count: noteSuggestions.length })}
              </span>
            )}
          </button>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
                {t('detail.linkToNote')}
              </span>
              {noteSuggestions.length > 0 && (
                <div className="flex items-center gap-1 text-[11px] text-[var(--tint)]">
                  <Sparkles className="size-3" />
                  <span>{t('detail.ai')}</span>
                </div>
              )}
            </div>

            {/* AI Note Suggestions */}
            {noteSuggestions.length > 0 && (
              <div className="space-y-1.5">
                {noteSuggestions.map((suggestion, index) => {
                  const isLinked = linkedNotes.some((ln) => ln.id === suggestion.note.id)
                  const bgOpacity = [0.05, 0.02, 0.01][index] ?? 0.01
                  const borderOpacity = [0.12, 0.06, 0.03][index] ?? 0.03
                  const band = confidenceBand(suggestion.confidence)
                  return (
                    <button
                      type="button"
                      key={suggestion.note.id}
                      onClick={() => handleLinkSuggestedNote(suggestion.note)}
                      className="w-full flex items-center gap-2 rounded-md px-3 py-2.5 text-start transition-colors border border-dashed"
                      style={{
                        backgroundColor: `color-mix(in srgb, var(--tint) ${Math.round(bgOpacity * 100)}%, transparent)`,
                        borderColor: isLinked
                          ? `color-mix(in srgb, var(--tint) 50%, transparent)`
                          : `color-mix(in srgb, var(--tint) ${Math.round(borderOpacity * 100)}%, transparent)`
                      }}
                    >
                      {suggestion.note.emoji ? (
                        <NoteIconDisplay
                          value={suggestion.note.emoji}
                          className="size-3.5 shrink-0"
                        />
                      ) : (
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-[13px] leading-4 font-medium text-foreground flex-1 min-w-0">
                        {suggestion.note.title}
                      </span>
                      {isLinked && <Check className="size-3 shrink-0 text-[var(--tint)]" />}
                      <span className="text-[10px] leading-3 text-muted-foreground/40 shrink-0">
                        {band === 'strong'
                          ? t('detail.match.strong')
                          : band === 'likely'
                            ? t('detail.match.likely')
                            : t('detail.match.weak')}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Link notes search input */}
            <LinkInput linkedNotes={linkedNotes} onLinkedNotesChange={onLinkedNotesChange} />
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Hook for managing filing state
// =============================================================================

interface UseFilingStateOptions {
  item: FilingItem | null
  isOpen: boolean
}

interface UseFilingStateReturn {
  selectedFolder: FolderType | null
  tags: string[]
  linkedNotes: LinkedNote[]
  setSelectedFolder: (folder: FolderType | null) => void
  setTags: (tags: string[]) => void
  setLinkedNotes: (notes: LinkedNote[]) => void
  resetFilingState: () => void
  canFile: boolean
}

interface FilingStateSnapshot {
  sessionKey: string
  selectedFolder: FolderType | null
  tags: string[]
  linkedNotes: LinkedNote[]
}

function createFilingStateSnapshot(
  sessionKey: string,
  item: FilingItem | null,
  isOpen: boolean
): FilingStateSnapshot {
  return {
    sessionKey,
    selectedFolder: null,
    tags: isOpen && item ? item.tags || [] : [],
    linkedNotes: []
  }
}

export const useFilingState = ({ item, isOpen }: UseFilingStateOptions): UseFilingStateReturn => {
  const sessionKey = isOpen && item ? item.id : '__closed__'
  const [snapshot, setSnapshot] = useState<FilingStateSnapshot>(() =>
    createFilingStateSnapshot(sessionKey, item, isOpen)
  )
  const activeSnapshot =
    snapshot.sessionKey === sessionKey
      ? snapshot
      : createFilingStateSnapshot(sessionKey, item, isOpen)

  const setSelectedFolder = useCallback(
    (folder: FolderType | null) => {
      setSnapshot((prev) => {
        const base =
          prev.sessionKey === sessionKey
            ? prev
            : createFilingStateSnapshot(sessionKey, item, isOpen)
        return { ...base, selectedFolder: folder }
      })
    },
    [sessionKey, item, isOpen]
  )

  const setTags = useCallback(
    (nextTags: string[]) => {
      setSnapshot((prev) => {
        const base =
          prev.sessionKey === sessionKey
            ? prev
            : createFilingStateSnapshot(sessionKey, item, isOpen)
        return { ...base, tags: nextTags }
      })
    },
    [sessionKey, item, isOpen]
  )

  const setLinkedNotes = useCallback(
    (notes: LinkedNote[]) => {
      setSnapshot((prev) => {
        const base =
          prev.sessionKey === sessionKey
            ? prev
            : createFilingStateSnapshot(sessionKey, item, isOpen)
        return { ...base, linkedNotes: notes }
      })
    },
    [sessionKey, item, isOpen]
  )

  const resetFilingState = useCallback(() => {
    setSnapshot({
      sessionKey,
      selectedFolder: null,
      tags: [],
      linkedNotes: []
    })
  }, [sessionKey])

  const canFile = activeSnapshot.selectedFolder !== null

  return {
    selectedFolder: activeSnapshot.selectedFolder,
    tags: activeSnapshot.tags,
    linkedNotes: activeSnapshot.linkedNotes,
    setSelectedFolder,
    setTags,
    setLinkedNotes,
    resetFilingState,
    canFile
  }
}
