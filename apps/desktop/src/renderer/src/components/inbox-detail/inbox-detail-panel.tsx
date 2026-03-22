/**
 * Inbox Detail Panel — Redesigned per Paper "Inbox — Detail Panel"
 *
 * Layout (task-detail-drawer pattern):
 * - Header: Type badge icon + label + relative time + close
 * - Scrollable body: Type-specific content + filing controls
 * - Footer: Archive + File buttons
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Archive,
  Folder,
  Sparkles,
  X,
  ChevronDown,
  Check,
  Loader2,
  RotateCcw,
  Trash2
} from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@/lib/utils'

import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import * as VisuallyHidden from '@radix-ui/react-visually-hidden'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

import { ContentSection, ContentSkeleton, TypeIcon } from './content-section'
import { useFilingState } from './filing-section'
import { LinkInput } from './link-input'
import { useRetryTranscription, useUpdateInboxItem } from '@/hooks/use-inbox'
import { isMac, isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import { getTypeAccentColor, getTypeLabel } from './type-accents'
import { useAllTags } from '@/hooks/use-all-tags'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'
import type { InboxItem, InboxItemListItem, Folder as FolderType, LinkedNote } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:InboxDetailPanel')

// ── Constants ────────────────────────────────────

const AI_ACCENT = '#E8A44A'

type DetailItem = InboxItem | InboxItemListItem
type SuggestedFolder = FolderType & { aiConfidence?: number; aiReason?: string }

// ── Tag color helpers ────────────────────────────

function getColorForTag(tagName: string): string {
  let hash = 0
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash)
  }
  return COLOR_NAMES[Math.abs(hash) % COLOR_NAMES.length]
}

function getTagPillStyle(tagName: string): React.CSSProperties {
  const { text } = getTagColors(getColorForTag(tagName))
  return { backgroundColor: `${text}26`, color: text }
}

// ── Shared display components ────────────────────

const SectionLabel = ({
  children,
  right
}: {
  children: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element => (
  <div className="flex items-center justify-between">
    <span className="tracking-[0.04em] uppercase text-text-tertiary font-medium text-[11px] leading-3.5">
      {children}
    </span>
    {right}
  </div>
)

const formatRelativeTime = (date: Date | string): string => {
  const d = date instanceof Date ? date : new Date(date)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'just now'
  if (diffMins === 1) return '1 minute ago'
  if (diffMins < 60) return `${diffMins} minutes ago`
  if (diffHours === 1) return '1 hour ago'
  if (diffHours < 24) return `${diffHours} hours ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Types ────────────────────────────────────────

interface InboxDetailPanelProps {
  isOpen: boolean
  item: DetailItem | null
  isLoading?: boolean
  readOnly?: boolean
  onClose: () => void
  onFile: (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]) => void
  onArchive: (id: string) => void
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}

// ── Main Component ───────────────────────────────

export const InboxDetailPanel = ({
  isOpen,
  item,
  isLoading = false,
  readOnly = false,
  onClose,
  onFile,
  onArchive,
  onRestore,
  onDelete
}: InboxDetailPanelProps): React.JSX.Element => {
  const retryTranscriptionMutation = useRetryTranscription()
  const updateItemMutation = useUpdateInboxItem()

  const { selectedFolder, tags, linkedNotes, setSelectedFolder, setTags, setLinkedNotes, canFile } =
    useFilingState({ item, isOpen })

  const [isFilingLoading, setIsFilingLoading] = useState(false)
  const [showAllFolders, setShowAllFolders] = useState(false)
  const [folderSearch, setFolderSearch] = useState('')

  // ── Tag input state ──────────────────────────

  const [tagInput, setTagInput] = useState('')
  const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false)
  const [tagHighlightIdx, setTagHighlightIdx] = useState(-1)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const tagContainerRef = useRef<HTMLDivElement>(null)

  const { searchTags, getPopularTags } = useAllTags()

  const tagSuggestions = tagInput.trim()
    ? searchTags(tagInput).filter((t) => !tags.includes(t.name))
    : getPopularTags(8).filter((t) => !tags.includes(t.name))

  useEffect(() => {
    setTagHighlightIdx(tagSuggestions.length > 0 ? 0 : -1)
  }, [tagSuggestions.length])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (tagContainerRef.current && !tagContainerRef.current.contains(e.target as Node)) {
        setIsTagDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const addTag = useCallback(
    (tag: string): void => {
      const normalized = tag.trim().toLowerCase()
      if (normalized && !tags.includes(normalized)) {
        setTags([...tags, normalized])
      }
      setTagInput('')
      setIsTagDropdownOpen(false)
      tagInputRef.current?.focus()
    },
    [tags, setTags]
  )

  const removeTag = useCallback(
    (tag: string): void => {
      setTags(tags.filter((t) => t !== tag))
    },
    [tags, setTags]
  )

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isTagDropdownOpen && tagSuggestions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setTagHighlightIdx((prev) => (prev < tagSuggestions.length - 1 ? prev + 1 : 0))
          return
        case 'ArrowUp':
          e.preventDefault()
          setTagHighlightIdx((prev) => (prev > 0 ? prev - 1 : tagSuggestions.length - 1))
          return
        case 'Enter':
          e.preventDefault()
          if (tagHighlightIdx >= 0 && tagHighlightIdx < tagSuggestions.length) {
            addTag(tagSuggestions[tagHighlightIdx].name)
          } else if (tagInput.trim()) {
            addTag(tagInput)
          }
          return
        case 'Escape':
          e.preventDefault()
          setIsTagDropdownOpen(false)
          return
        case 'Tab':
          if (tagHighlightIdx >= 0) {
            e.preventDefault()
            addTag(tagSuggestions[tagHighlightIdx].name)
          }
          return
      }
    }
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault()
      addTag(tagInput)
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  const handleTagInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    if (value.includes(',')) {
      const parts = value.split(',')
      if (parts[0].trim()) addTag(parts[0])
      setTagInput(parts.slice(1).join(','))
    } else {
      setTagInput(value)
      if (value.trim()) setIsTagDropdownOpen(true)
    }
  }

  // ── Data queries ─────────────────────────────

  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const folderInfos = await window.api.notes.getFolders()
      const folders: FolderType[] = [{ id: '', name: 'Notes (root)', path: '' }]
      for (const fi of folderInfos) {
        if (fi.path) {
          folders.push({
            id: fi.path,
            name: fi.path.split('/').pop() || fi.path,
            path: fi.path,
            parent: fi.path.includes('/') ? fi.path.split('/').slice(0, -1).join('/') : undefined
          })
        }
      }
      return folders
    },
    enabled: isOpen && item !== null
  })

  const { data: aiSuggestions = [], isLoading: isLoadingAI } = useQuery({
    queryKey: ['inbox', 'suggestions', item?.id],
    queryFn: async () => {
      if (!item?.id) return []
      try {
        const response = await window.api.inbox.getSuggestions(item.id)
        return response.suggestions || []
      } catch {
        return []
      }
    },
    enabled: isOpen && !!item?.id,
    staleTime: 30000
  })

  // ── Derived state ────────────────────────────

  const suggestedFolders = useMemo((): SuggestedFolder[] => {
    if (aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 5)
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || 'Notes',
            path,
            aiConfidence: s.confidence,
            aiReason: s.reason
          }
        })
    }
    return []
  }, [aiSuggestions])

  const noteSuggestions = useMemo(() => {
    return aiSuggestions
      .filter((s) => s.destination.type === 'note' && s.suggestedNote)
      .slice(0, 3)
      .map((s) => ({
        note: s.suggestedNote!,
        confidence: s.confidence,
        reason: s.reason
      }))
  }, [aiSuggestions])

  const filteredFolders = useMemo(() => {
    if (!folderSearch.trim()) return vaultFolders
    const q = folderSearch.toLowerCase()
    return vaultFolders.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    )
  }, [vaultFolders, folderSearch])

  const accentColor = item ? getTypeAccentColor(item.type) : '#6b7280'
  const modKey = isMac ? '⌘' : 'Ctrl+'
  const hasAI = aiSuggestions.length > 0

  // ── Keyboard shortcuts ───────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      if (isInputFocused()) {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canFile && item) handleFileItem()
        return
      }

      if (/^[1-5]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1
        if (index < suggestedFolders.length) {
          e.preventDefault()
          setSelectedFolder(suggestedFolders[index])
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, canFile, item, suggestedFolders, setSelectedFolder, onClose])

  // ── Handlers ─────────────────────────────────

  const handleFileItem = useCallback(async (): Promise<void> => {
    if (!selectedFolder || !item) return

    setIsFilingLoading(true)

    if (aiSuggestions.length > 0) {
      const top = aiSuggestions[0]
      window.api.inbox
        .trackSuggestion({
          itemId: item.id,
          itemType: item.type,
          suggestedTo: top?.destination?.path || '',
          actualTo: selectedFolder.id,
          confidence: top?.confidence || 0,
          suggestedTags: top?.suggestedTags || [],
          actualTags: tags
        })
        .catch((err) => log.error('Failed to track suggestion', err))
    }

    const folderPath = selectedFolder.path ?? selectedFolder.id ?? ''
    onFile(
      item.id,
      folderPath,
      tags,
      linkedNotes.map((n) => n.id)
    )
    setIsFilingLoading(false)
    onClose()
  }, [selectedFolder, item, tags, linkedNotes, aiSuggestions, onFile, onClose])

  const handleArchive = useCallback((): void => {
    if (item) {
      onArchive(item.id)
      onClose()
    }
  }, [item, onArchive, onClose])

  const handleRetryTranscription = useCallback((): void => {
    if (item) retryTranscriptionMutation.mutate(item.id)
  }, [item, retryTranscriptionMutation])

  const contentChangeTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleContentChange = useCallback(
    (content: string): void => {
      if (!item) return
      if (contentChangeTimerRef.current) clearTimeout(contentChangeTimerRef.current)
      contentChangeTimerRef.current = setTimeout(() => {
        updateItemMutation.mutate({ id: item.id, content })
      }, 500)
    },
    [item, updateItemMutation]
  )

  useEffect(() => {
    return () => {
      if (contentChangeTimerRef.current) clearTimeout(contentChangeTimerRef.current)
    }
  }, [])

  const handleOpenChange = (open: boolean): void => {
    if (!open) onClose()
  }

  // ── Render ───────────────────────────────────

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[380px] sm:max-w-[380px] flex flex-col p-0 h-full overflow-hidden [font-synthesis:none] text-xs/4 antialiased"
        aria-describedby={item ? undefined : 'detail-panel-description'}
      >
        {isLoading ? (
          <>
            <VisuallyHidden.Root>
              <SheetTitle>Loading preview</SheetTitle>
              <SheetDescription id="detail-panel-description">
                Loading item details...
              </SheetDescription>
            </VisuallyHidden.Root>
            <ContentSkeleton />
          </>
        ) : item ? (
          <>
            <VisuallyHidden.Root>
              <SheetTitle>{item.title}</SheetTitle>
            </VisuallyHidden.Root>

            {/* ── Header ── */}
            <div className="flex items-center justify-between shrink-0 py-4 px-5 border-b border-border">
              <div className="flex items-center gap-1.5">
                <TypeIcon
                  type={item.type}
                  variant="badge"
                  className="size-3.5"
                  style={{ color: accentColor }}
                />
                <span className="text-[11px] leading-3.5" style={{ color: accentColor }}>
                  {getTypeLabel(item.type)}
                </span>
                <span className="text-[11px] leading-3.5 text-text-tertiary">
                  · {formatRelativeTime(item.createdAt)}
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Close panel"
              >
                <X size={14} />
              </button>
            </div>

            {/* ── Scrollable Body ── */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
              {/* Content Section */}
              <div className="flex flex-col gap-3.5 border-b border-border p-5">
                <ContentSection
                  item={item}
                  onRetryTranscription={handleRetryTranscription}
                  isRetrying={retryTranscriptionMutation.isPending}
                  onContentChange={readOnly ? undefined : handleContentChange}
                />
              </div>

              {/* Filing Section */}
              {!readOnly && (
                <div className="flex flex-col grow gap-4 p-5">
                  {/* ── File to ── */}
                  <SectionLabel>File to</SectionLabel>
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
                        className="flex items-center rounded-md py-2 px-3 gap-2 bg-foreground/[0.03] border border-border hover:bg-foreground/[0.05] transition-colors"
                      >
                        <Folder className="size-3.5 text-text-secondary" aria-hidden="true" />
                        <span
                          className={cn(
                            'text-xs/4 flex-1 text-left truncate',
                            selectedFolder ? 'text-text-secondary' : 'text-text-secondary'
                          )}
                        >
                          {selectedFolder?.name || 'Select folder...'}
                        </span>
                        <ChevronDown className="size-2.5 text-text-tertiary ml-auto shrink-0" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-[var(--radix-popover-trigger-width)] p-0 rounded-lg border border-border bg-popover shadow-lg"
                      align="start"
                      sideOffset={4}
                    >
                      <div className="p-2 border-b border-border">
                        <Input
                          placeholder="Search folders..."
                          value={folderSearch}
                          onChange={(e) => setFolderSearch(e.target.value)}
                          className="h-7 text-xs border-none bg-foreground/[0.03] focus-visible:ring-0 placeholder:text-text-tertiary"
                          autoFocus
                        />
                      </div>
                      <ScrollArea className="max-h-48 p-1">
                        {filteredFolders.length === 0 ? (
                          <p className="text-xs text-text-tertiary text-center py-3">
                            No folders found
                          </p>
                        ) : (
                          <div className="space-y-0.5">
                            {filteredFolders.map((folder) => (
                              <button
                                key={folder.id}
                                type="button"
                                onClick={() => {
                                  setSelectedFolder(folder)
                                  setShowAllFolders(false)
                                }}
                                className={cn(
                                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md text-left transition-colors',
                                  selectedFolder?.id === folder.id
                                    ? 'bg-foreground/[0.06] text-text-primary'
                                    : 'hover:bg-foreground/[0.04] text-text-secondary'
                                )}
                              >
                                <Folder
                                  className="size-3.5 shrink-0 text-text-tertiary"
                                  aria-hidden="true"
                                />
                                <span className="truncate flex-1">{folder.name}</span>
                                {selectedFolder?.id === folder.id && (
                                  <Check
                                    className="size-3 shrink-0 text-text-primary"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>

                  {/* ── Tags ── */}
                  <div className="flex flex-col gap-2">
                    <SectionLabel>Tags</SectionLabel>
                    <div ref={tagContainerRef} className="relative">
                      <div
                        className="flex items-center flex-wrap rounded-md py-1.5 px-3 gap-1.5 bg-foreground/[0.03] border border-border cursor-text"
                        onClick={() => tagInputRef.current?.focus()}
                      >
                        {tags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeTag(tag)
                            }}
                            className="flex items-center rounded-[10px] py-0.5 px-2 transition-opacity hover:opacity-70"
                            style={getTagPillStyle(tag)}
                            aria-label={`Remove tag ${tag}`}
                          >
                            <span className="text-[11px] leading-3.5">{tag}</span>
                          </button>
                        ))}
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={tagInput}
                          onChange={handleTagInputChange}
                          onKeyDown={handleTagKeyDown}
                          onFocus={() => setIsTagDropdownOpen(true)}
                          placeholder={tags.length === 0 ? 'Add tag...' : ''}
                          className="flex-1 min-w-[60px] bg-transparent outline-none text-xs/4 text-text-primary placeholder:text-text-tertiary py-0.5"
                          aria-label="Add tags"
                          autoComplete="off"
                        />
                        {tags.length > 0 && !tagInput && (
                          <span className="text-xs/4 text-text-tertiary select-none">
                            Add tag...
                          </span>
                        )}
                      </div>

                      {/* Tag dropdown */}
                      {isTagDropdownOpen && tagSuggestions.length > 0 && (
                        <div className="absolute z-50 w-full mt-1 py-1 rounded-lg border border-border bg-popover shadow-lg max-h-48 overflow-y-auto">
                          {tagSuggestions.slice(0, 8).map((tag, index) => (
                            <button
                              key={tag.name}
                              type="button"
                              onClick={() => addTag(tag.name)}
                              onMouseEnter={() => setTagHighlightIdx(index)}
                              className={cn(
                                'w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors',
                                index === tagHighlightIdx
                                  ? 'bg-foreground/[0.06]'
                                  : 'hover:bg-foreground/[0.03]'
                              )}
                            >
                              <span className="flex items-center gap-2 truncate">
                                <span
                                  className="size-2 rounded-full shrink-0"
                                  style={{
                                    backgroundColor: getTagColors(getColorForTag(tag.name)).text
                                  }}
                                  aria-hidden="true"
                                />
                                <span className="text-text-primary truncate">{tag.name}</span>
                              </span>
                              <span className="text-[10px] text-text-tertiary shrink-0 ml-2">
                                {tag.count}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Link to note ── */}
                  <div className="flex flex-col gap-2">
                    <SectionLabel
                      right={
                        hasAI ? (
                          <div className="flex items-center gap-1">
                            <Sparkles
                              className="size-3"
                              style={{ color: AI_ACCENT }}
                              aria-hidden="true"
                            />
                            <span className="text-[11px] leading-3.5" style={{ color: AI_ACCENT }}>
                              AI
                            </span>
                          </div>
                        ) : undefined
                      }
                    >
                      Link to note
                    </SectionLabel>
                    <LinkInput linkedNotes={linkedNotes} onLinkedNotesChange={setLinkedNotes} />
                  </div>

                  {/* ── Suggested ── */}
                  {suggestedFolders.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <SectionLabel>Suggested</SectionLabel>
                      {suggestedFolders.map((folder, index) => (
                        <button
                          key={folder.id || `suggest-${index}`}
                          type="button"
                          onClick={() => setSelectedFolder(folder)}
                          className={cn(
                            'flex items-center rounded-md py-2 px-3 gap-2 transition-colors',
                            selectedFolder?.id === folder.id
                              ? 'bg-foreground/[0.06] border border-border'
                              : 'border border-dashed'
                          )}
                          style={
                            selectedFolder?.id === folder.id
                              ? undefined
                              : {
                                  borderColor: `${AI_ACCENT}40`,
                                  backgroundColor: `${AI_ACCENT}08`
                                }
                          }
                        >
                          <Sparkles
                            className="size-3 shrink-0"
                            style={{ color: AI_ACCENT }}
                            aria-hidden="true"
                          />
                          <span className="text-xs/4 truncate" style={{ color: AI_ACCENT }}>
                            {folder.name}
                            {folder.aiReason ? ` / ${folder.aiReason}` : ''}
                          </span>
                          <span className="ml-auto text-[10px] leading-3.5 text-text-tertiary shrink-0">
                            press {index + 1}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {isLoadingAI && (
                    <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      <span>Analyzing...</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="flex items-center shrink-0 py-4 px-5 gap-2 border-t border-border">
              {readOnly ? (
                <>
                  <button
                    type="button"
                    onClick={() => item && onRestore?.(item.id)}
                    className="flex items-center grow justify-center rounded-md py-[7px] px-3.5 gap-1.5 border border-border text-text-secondary hover:bg-foreground/[0.03] transition-colors"
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    <span className="text-xs/4">Restore</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => item && onDelete?.(item.id)}
                    className="flex items-center grow justify-center rounded-md py-[7px] px-3.5 gap-1.5 border border-border text-red-500 hover:bg-red-500/5 transition-colors"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    <span className="text-xs/4">Delete</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleArchive}
                    className="flex items-center grow justify-center rounded-md py-[7px] px-3.5 gap-1.5 border border-border text-text-secondary hover:bg-foreground/[0.03] transition-colors"
                  >
                    <Archive className="size-3.5" aria-hidden="true" />
                    <span className="text-xs/4 text-text-secondary">Archive</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleFileItem()}
                    disabled={!canFile || isFilingLoading}
                    className={cn(
                      'flex items-center grow justify-center rounded-md py-[7px] px-3.5 gap-1.5 transition-colors',
                      canFile
                        ? 'font-medium'
                        : 'bg-foreground/[0.03] border border-border text-text-tertiary'
                    )}
                    style={canFile ? { backgroundColor: AI_ACCENT, color: '#0E0E10' } : undefined}
                  >
                    {isFilingLoading ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Folder className="size-3.5" aria-hidden="true" />
                    )}
                    <span className="text-xs/4">{isFilingLoading ? 'Filing...' : 'File'}</span>
                    {canFile && (
                      <span className="ml-0.5 text-[10px] leading-3.5 opacity-50">{modKey}F</span>
                    )}
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <VisuallyHidden.Root>
            <SheetTitle>Detail panel</SheetTitle>
            <SheetDescription>No item selected</SheetDescription>
          </VisuallyHidden.Root>
        )}
      </SheetContent>
    </Sheet>
  )
}
