/**
 * CoverPickerDialog — the one surface for choosing a note's cover.
 *
 * A command palette rather than a gallery modal: a search row, a tab row, and a
 * body whose entries are one flat, arrow-navigable list. Each tab is a row in
 * `COVER_PICKER_TABS`, so a new source (the Unsplash Photos tab) is one entry
 * plus one `items` branch; the switch is exhaustive, so the compiler names the
 * gap if the branch is missed.
 *
 * `/image` keeps using `AttachmentPickerDialog`; this dialog reuses that one's
 * vault calls without touching it, because a cover is not a block.
 *
 * @module components/note/cover-picker-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import { useT } from '@memry/i18n/renderer'
import {
  COVER_WASHES,
  coverWashGradient,
  type CoverValue,
  type CoverWashId
} from '@memry/shared/cover-image'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Image, Loader2, Search, Upload } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  attachmentKey,
  attachmentKindMatches,
  filterVaultAttachments
} from './content-area/attachment-picker-dialog'

const logger = createLogger('CoverPicker')

export type CoverPickerTabId = 'washes' | 'fromNote' | 'upload'

interface CoverPickerTab {
  id: CoverPickerTabId
  /** Grid width, so arrow up/down steps a row rather than an item. */
  columns: number
}

/** The tab row, in display order. A new cover source appends here. */
export const COVER_PICKER_TABS: readonly CoverPickerTab[] = [
  { id: 'washes', columns: 4 },
  { id: 'fromNote', columns: 1 },
  { id: 'upload', columns: 1 }
]

type CoverPickerItem =
  | { kind: 'wash'; id: CoverWashId }
  | { kind: 'upload' }
  | { kind: 'attachment'; entry: VaultAttachmentEntry }

function itemKey(item: CoverPickerItem): string {
  switch (item.kind) {
    case 'wash':
      return `wash:${item.id}`
    case 'upload':
      return 'upload'
    case 'attachment':
      return attachmentKey(item.entry)
  }
}

export interface CoverPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The note that will own an uploaded file. */
  noteId: string
  onApply: (value: CoverValue, opts: { reposition: boolean }) => void
}

export function CoverPickerDialog({ open, onOpenChange, noteId, onApply }: CoverPickerDialogProps) {
  const { t } = useT('notes')
  const [tab, setTab] = useState<CoverPickerTabId>('washes')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [entries, setEntries] = useState<VaultAttachmentEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Reopening resets the palette during render rather than from an effect, the
  // way AttachmentPickerDialog does.
  const openKey = open ? noteId : null
  const [loadedKey, setLoadedKey] = useState(openKey)
  if (openKey !== loadedKey) {
    setLoadedKey(openKey)
    if (openKey !== null) {
      setLoading(true)
      setQuery('')
      setTab('washes')
      setSelected(0)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    notesService
      .listVaultAttachments()
      .then((rows) => {
        if (!cancelled) setEntries(rows)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntries([])
        logger.error('Failed to list vault attachments for the cover picker', err)
        toast.error(extractErrorMessage(err, t('cover.picker.loadFailed')))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `t` is not identity-stable across renders; the dialog reloads on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const washName = useCallback((id: CoverWashId) => t(`cover.picker.wash.${id}`), [t])

  const items = useMemo<CoverPickerItem[]>(() => {
    const trimmed = query.trim().toLowerCase()
    switch (tab) {
      case 'washes': {
        const washes = COVER_WASHES.filter(
          (wash) => !trimmed || washName(wash.id).toLowerCase().includes(trimmed)
        ).map((wash): CoverPickerItem => ({ kind: 'wash', id: wash.id }))
        return [...washes, { kind: 'upload' }]
      }
      case 'fromNote':
        return filterVaultAttachments(
          entries.filter((entry) => attachmentKindMatches(entry.mimeType, 'image')),
          query
        ).map((entry): CoverPickerItem => ({ kind: 'attachment', entry }))
      case 'upload':
        return [{ kind: 'upload' }]
    }
  }, [entries, query, tab, washName])

  const columns = COVER_PICKER_TABS.find((entry) => entry.id === tab)?.columns ?? 1
  const activeIndex = items.length === 0 ? -1 : Math.min(selected, items.length - 1)

  const apply = useCallback(
    async (item: CoverPickerItem, reposition: boolean) => {
      if (item.kind === 'wash') {
        onApply({ kind: 'wash', id: item.id }, { reposition: false })
        onOpenChange(false)
        return
      }
      if (item.kind === 'upload') {
        fileInputRef.current?.click()
        return
      }
      try {
        const result = await notesService.insertExistingAttachment(
          noteId,
          item.entry.ownerNoteId,
          item.entry.filename
        )
        onApply({ kind: 'image', ref: result.url }, { reposition })
        onOpenChange(false)
      } catch (err) {
        logger.error('Failed to reference a vault image as a cover', err)
        toast.error(extractErrorMessage(err, t('cover.picker.insertFailed')))
      }
    },
    [noteId, onApply, onOpenChange, t]
  )

  const upload = useCallback(
    async (file: File) => {
      setUploading(true)
      try {
        const result = await notesService.uploadAttachment(noteId, file)
        if (!result.success || !result.path) {
          throw new Error(result.error ?? t('cover.picker.uploadFailed'))
        }
        onApply({ kind: 'image', ref: result.path }, { reposition: false })
        onOpenChange(false)
      } catch (err) {
        logger.error('Failed to upload a cover image', err)
        toast.error(extractErrorMessage(err, t('cover.picker.uploadFailed')))
      } finally {
        setUploading(false)
      }
    },
    [noteId, onApply, onOpenChange, t]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowLeft'
            ? -1
            : event.key === 'ArrowDown'
              ? columns
              : event.key === 'ArrowUp'
                ? -columns
                : 0
      if (step !== 0) {
        event.preventDefault()
        setSelected((current) =>
          Math.min(Math.max(current + step, 0), Math.max(items.length - 1, 0))
        )
        return
      }
      if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault()
        void apply(items[activeIndex], event.metaKey || event.ctrlKey)
      }
    },
    [activeIndex, apply, columns, items]
  )

  const selectTab = useCallback((next: CoverPickerTabId) => {
    setTab(next)
    setSelected(0)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0 [&>button]:hidden"
        data-testid="cover-picker-dialog"
        aria-describedby={undefined}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">{t('cover.picker.title')}</DialogTitle>

        <div className="flex items-center gap-2.5 border-b px-3.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            placeholder={t('cover.picker.placeholder')}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="cover-picker-search"
          />
        </div>

        <div role="tablist" className="flex items-center gap-1 border-b px-3 py-2">
          {COVER_PICKER_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              onClick={() => selectTab(entry.id)}
              className={cn(
                'rounded-md px-2 py-1 text-[12.5px] font-medium',
                'transition-colors duration-150 motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                entry.id === tab
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {t(`cover.picker.tab.${entry.id}`)}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          className="max-h-[min(24rem,60vh)] overflow-y-auto p-2"
          data-testid="cover-picker-panel"
          data-tab={tab}
        >
          {tab === 'washes' ? (
            <div className="grid grid-cols-4 gap-2">
              {items.map((item, index) =>
                item.kind === 'upload' ? (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    className={cn(
                      'flex h-[76px] flex-col items-center justify-center gap-1 rounded-lg',
                      'border border-dashed border-border text-[11px] text-muted-foreground',
                      'hover:text-foreground focus-visible:outline-none',
                      index === activeIndex && 'ring-2 ring-ring'
                    )}
                    data-testid="cover-picker-upload"
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    {t('cover.picker.upload')}
                  </button>
                ) : item.kind === 'wash' ? (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    aria-label={washName(item.id)}
                    title={washName(item.id)}
                    style={{ backgroundImage: coverWashGradient(item.id) }}
                    className={cn(
                      'h-[76px] rounded-lg focus-visible:outline-none',
                      index === activeIndex && 'ring-2 ring-ring'
                    )}
                    data-testid="cover-picker-wash"
                  />
                ) : null
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              {items.map((item, index) =>
                item.kind === 'attachment' ? (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    className={cn(
                      'flex h-9 items-center gap-2.5 rounded-md px-2 text-start text-sm',
                      'focus-visible:outline-none',
                      index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                    )}
                    data-testid="cover-picker-row"
                  >
                    <Image className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.entry.displayName}</span>
                  </button>
                ) : (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    className={cn(
                      'flex h-9 items-center gap-2.5 rounded-md px-2 text-start text-sm',
                      'focus-visible:outline-none',
                      index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                    )}
                    data-testid="cover-picker-upload"
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    {uploading ? t('cover.picker.uploading') : t('cover.picker.upload')}
                  </button>
                )
              )}

              {!loading && items.length === 0 && (
                <p
                  className="px-2 py-5 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-empty"
                >
                  {query ? t('cover.picker.noMatches') : t('cover.picker.empty')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-3.5 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>{'↵'}</Kbd>
            {t('cover.picker.hint.apply')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>{'⌘↵'}</Kbd>
            {t('cover.picker.hint.applyReposition')}
          </span>
          <span className="ms-auto flex items-center gap-1.5">
            <Kbd>{'esc'}</Kbd>
            {t('cover.picker.hint.close')}
          </span>
        </div>

        {/* Opened from here so no native "Choose File" widget is ever rendered;
            the platform styles that control three different ways. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          data-testid="cover-picker-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void upload(file)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
