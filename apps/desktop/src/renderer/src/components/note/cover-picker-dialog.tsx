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
import type {
  UnsplashDownloadFailureReason,
  UnsplashFailureReason,
  UnsplashPhoto
} from '@memry/contracts/unsplash-api'
import { useT } from '@memry/i18n/renderer'
import {
  COVER_WASHES,
  coverWashGradient,
  type CoverValue,
  type CoverWashId
} from '@memry/shared/cover-image'
import { notesService } from '@/services/notes-service'
import { unsplashService } from '@/services/unsplash-service'
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

/** Long enough that a typed word costs one request, short enough to feel live. */
const PHOTO_SEARCH_DEBOUNCE_MS = 400

export type CoverPickerTabId = 'washes' | 'photos' | 'fromNote' | 'upload'

interface CoverPickerTab {
  id: CoverPickerTabId
  /** Grid width, so arrow up/down steps a row rather than an item. */
  columns: number
}

/** The tab row, in display order. A new cover source appends here. */
export const COVER_PICKER_TABS: readonly CoverPickerTab[] = [
  { id: 'washes', columns: 4 },
  { id: 'photos', columns: 3 },
  { id: 'fromNote', columns: 1 },
  { id: 'upload', columns: 1 }
]

/**
 * The Photos tab's search, as one value rather than a loading flag beside a list
 * beside an error, so no render can show a spinner over stale results.
 */
type PhotoSearch =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'photos'; photos: UnsplashPhoto[]; rateLimitRemaining: number | null }
  | { kind: 'error'; reason: UnsplashFailureReason }

type PhotoDownload =
  | { kind: 'none' }
  | { kind: 'running'; photoId: string }
  | { kind: 'failed'; reason: UnsplashDownloadFailureReason }

/** Every way Unsplash can come up empty gets its own line, never a retry spinner. */
const PHOTO_ERROR_KEYS: Record<UnsplashDownloadFailureReason, string> = {
  'not-configured': 'cover.picker.photos.error.notConfigured',
  offline: 'cover.picker.photos.error.offline',
  'rate-limited': 'cover.picker.photos.error.rateLimited',
  failed: 'cover.picker.photos.error.failed',
  'write-failed': 'cover.picker.photos.error.writeFailed'
}

type CoverPickerItem =
  | { kind: 'wash'; id: CoverWashId }
  | { kind: 'upload' }
  | { kind: 'attachment'; entry: VaultAttachmentEntry }
  | { kind: 'photo'; photo: UnsplashPhoto }

function itemKey(item: CoverPickerItem): string {
  switch (item.kind) {
    case 'wash':
      return `wash:${item.id}`
    case 'upload':
      return 'upload'
    case 'attachment':
      return attachmentKey(item.entry)
    case 'photo':
      return `photo:${item.photo.id}`
  }
}

export interface CoverPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The note that will own an uploaded file. */
  noteId: string
  onApply: (
    value: CoverValue,
    opts: { reposition: boolean; credit?: { name: string; url: string } }
  ) => void
}

export function CoverPickerDialog({ open, onOpenChange, noteId, onApply }: CoverPickerDialogProps) {
  const { t } = useT('notes')
  const [requestedTab, setTab] = useState<CoverPickerTabId>('washes')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [entries, setEntries] = useState<VaultAttachmentEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [photoFetch, setPhotoFetch] = useState<{ query: string; result: PhotoSearch } | null>(null)
  const [photoDownload, setPhotoDownload] = useState<PhotoDownload>({ kind: 'none' })
  const [photosConfigured, setPhotosConfigured] = useState(true)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const photoCache = useRef(new Map<string, PhotoSearch>())

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
      setPhotoFetch(null)
      setPhotoDownload({ kind: 'none' })
      setPhotosConfigured(true)
      photoCache.current.clear()
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

  // The probe can land while the Photos tab is already selected, so the shown tab
  // is derived rather than corrected after the fact.
  const tab = !photosConfigured && requestedTab === 'photos' ? 'washes' : requestedTab

  const trimmedQuery = query.trim()

  const photoSearch = useMemo<PhotoSearch>(() => {
    if (!trimmedQuery) return { kind: 'idle' }
    const cached = photoCache.current.get(trimmedQuery)
    if (cached) return cached
    return photoFetch?.query === trimmedQuery ? photoFetch.result : { kind: 'searching' }
  }, [photoFetch, trimmedQuery])

  // An empty query is answered from the key alone, with no network call and
  // nothing to send, so it is a free capability probe. Asking on open is what
  // lets the real search wait for the Photos tab: the tab's existence is settled
  // before the user can reach it.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void unsplashService
      .search({ query: '' })
      .then((result) => {
        if (!cancelled) setPhotosConfigured(result.ok)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        logger.error('Unsplash availability probe failed', err)
        setPhotosConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Typing only reaches Unsplash while the Photos tab is open. On any other tab
  // the query is a local filter, and a local filter has no business leaving the
  // device or spending the hourly quota.
  useEffect(() => {
    if (!open || !photosConfigured || tab !== 'photos' || !trimmedQuery) return
    if (photoCache.current.has(trimmedQuery)) return
    let cancelled = false
    const timer = setTimeout(() => {
      unsplashService
        .search({ query: trimmedQuery, page: 1 })
        .then((result) => {
          if (cancelled) return
          if (!result.ok) {
            if (result.reason === 'not-configured') {
              setPhotosConfigured(false)
              return
            }
            setPhotoFetch({
              query: trimmedQuery,
              result: { kind: 'error', reason: result.reason }
            })
            return
          }
          const next: PhotoSearch = {
            kind: 'photos',
            photos: result.photos,
            rateLimitRemaining: result.rateLimitRemaining
          }
          photoCache.current.set(trimmedQuery, next)
          setPhotoFetch({ query: trimmedQuery, result: next })
        })
        .catch((err: unknown) => {
          if (cancelled) return
          logger.error('Unsplash search failed', err)
          setPhotoFetch({ query: trimmedQuery, result: { kind: 'error', reason: 'failed' } })
        })
    }, PHOTO_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, photosConfigured, tab, trimmedQuery])

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
      case 'photos':
        return photoSearch.kind === 'photos'
          ? photoSearch.photos.map((photo): CoverPickerItem => ({ kind: 'photo', photo }))
          : []
      case 'upload':
        return [{ kind: 'upload' }]
    }
  }, [entries, photoSearch, query, tab, washName])

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
      if (item.kind === 'photo') {
        setPhotoDownload({ kind: 'running', photoId: item.photo.id })
        try {
          const result = await unsplashService.download({ noteId, photo: item.photo })
          if (!result.ok) {
            setPhotoDownload({ kind: 'failed', reason: result.reason })
            return
          }
          setPhotoDownload({ kind: 'none' })
          onApply({ kind: 'image', ref: result.ref }, { reposition, credit: result.credit })
          onOpenChange(false)
        } catch (err) {
          logger.error('Failed to download an Unsplash cover', err)
          setPhotoDownload({ kind: 'failed', reason: 'failed' })
        }
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

  const visibleTabs = photosConfigured
    ? COVER_PICKER_TABS
    : COVER_PICKER_TABS.filter((entry) => entry.id !== 'photos')
  const rateLimitRemaining = photoSearch.kind === 'photos' ? photoSearch.rateLimitRemaining : null
  const photoErrorReason =
    photoDownload.kind === 'failed'
      ? photoDownload.reason
      : photoSearch.kind === 'error'
        ? photoSearch.reason
        : null

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
          {visibleTabs.map((entry) => (
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
          {photosConfigured && rateLimitRemaining !== null && (
            <span
              className={cn(
                'ms-auto text-[11px] tabular-nums',
                rateLimitRemaining === 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
              data-testid="cover-picker-rate-limit"
            >
              {t('cover.picker.photos.remaining', { count: rateLimitRemaining })}
            </span>
          )}
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
          ) : tab === 'photos' ? (
            <div className="flex flex-col gap-2">
              {photoErrorReason !== null && (
                <p
                  className="px-2 py-2 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-photos-error"
                  data-reason={photoErrorReason}
                >
                  {t(PHOTO_ERROR_KEYS[photoErrorReason])}
                </p>
              )}

              {photoSearch.kind === 'idle' && (
                <p
                  className="px-2 py-5 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-photos-prompt"
                >
                  {t('cover.picker.photos.prompt')}
                </p>
              )}

              {photoSearch.kind === 'searching' && (
                <p
                  className="flex items-center justify-center gap-2 px-2 py-5 text-sm text-muted-foreground"
                  data-testid="cover-picker-photos-searching"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('cover.picker.photos.searching')}
                </p>
              )}

              {photoSearch.kind === 'photos' && items.length === 0 && (
                <p
                  className="px-2 py-5 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-photos-empty"
                >
                  {t('cover.picker.photos.noResults')}
                </p>
              )}

              <div className="grid grid-cols-3 gap-2">
                {items.map((item, index) =>
                  item.kind === 'photo' ? (
                    <button
                      key={itemKey(item)}
                      type="button"
                      onClick={() => void apply(item, false)}
                      aria-selected={index === activeIndex}
                      aria-label={item.photo.authorName}
                      className={cn(
                        'relative h-[76px] overflow-hidden rounded-lg focus-visible:outline-none',
                        index === activeIndex && 'ring-2 ring-ring'
                      )}
                      data-testid="cover-picker-photo"
                    >
                      {/* Hotlinked, as the Unsplash licence requires; never cached to disk. */}
                      <img
                        src={item.photo.thumbUrl}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                      {index === activeIndex && (
                        <span
                          className="absolute bottom-0 start-0 end-0 truncate bg-background/85 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          data-testid="cover-picker-photo-credit"
                        >
                          {t('cover.picker.photos.tileCredit', { name: item.photo.authorName })}
                        </span>
                      )}
                      {photoDownload.kind === 'running' &&
                        photoDownload.photoId === item.photo.id && (
                          <span
                            className="absolute inset-0 flex items-center justify-center bg-background/60"
                            data-testid="cover-picker-photo-downloading"
                          >
                            <Loader2 className="h-4 w-4 animate-spin" />
                          </span>
                        )}
                    </button>
                  ) : null
                )}
              </div>
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
