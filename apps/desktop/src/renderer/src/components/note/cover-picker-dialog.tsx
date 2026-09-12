/**
 * CoverPickerDialog — the one surface for choosing a note's cover.
 *
 * A command palette rather than a gallery modal, and a non-modal popover opened
 * at the click point rather than a centred sheet: a search row, a tab row, and a
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { toast } from 'sonner'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import type { DownloadAttachmentFromUrlFailure } from '@memry/contracts/notes-api'
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
import { useVault } from '@/hooks/use-vault'
import { toMemryFileUrl } from '@/lib/memry-file-url'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { Link as LinkIcon, Loader2, Search, Upload } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  attachmentKey,
  attachmentKindMatches,
  filterVaultAttachments
} from './content-area/attachment-picker-dialog'

const logger = createLogger('CoverPicker')

/** Unsplash's own mark. Brand glyphs do not live in the icon set. */
function UnsplashMark() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-3 w-3 shrink-0 fill-current">
      <path d="M7 6.5V2h6v4.5zM13 9h5v9H2V9h5v4.5h6z" />
    </svg>
  )
}

/** Long enough that a typed word costs one request, short enough to feel live. */
const PHOTO_SEARCH_DEBOUNCE_MS = 400

/**
 * What the Photos tab shows before anything is typed. An empty tab reads as
 * broken, and Unsplash has no "give me anything" call that the search endpoint
 * can answer, so one of these stands in for it. Picked per open, so the tab
 * looks different each time rather than shipping one fixed wall of photos.
 */
const PHOTO_DEFAULT_QUERIES = [
  'minimal landscape',
  'calm abstract',
  'soft gradient',
  'mountain fog',
  'quiet architecture',
  'ocean texture',
  'desert light',
  'forest canopy'
] as const

function randomDefaultPhotoQuery(): string {
  return PHOTO_DEFAULT_QUERIES[Math.floor(Math.random() * PHOTO_DEFAULT_QUERIES.length)]
}

export type CoverPickerTabId = 'washes' | 'photos' | 'fromNote' | 'link' | 'upload'

interface CoverPickerTab {
  id: CoverPickerTabId
  /** Grid width, so arrow up/down steps a row rather than an item. */
  columns: number
}

/** The tab row, in display order. A new cover source appends here. */
export const COVER_PICKER_TABS: readonly CoverPickerTab[] = [
  { id: 'washes', columns: 4 },
  { id: 'photos', columns: 3 },
  { id: 'fromNote', columns: 3 },
  { id: 'link', columns: 1 },
  { id: 'upload', columns: 1 }
]

/**
 * The Photos tab's search, as one value rather than a loading flag beside a list
 * beside an error, so no render can show a spinner over stale results.
 */
type PhotoSearch =
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
  | { kind: 'link'; url: string }

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
    case 'link':
      return `link:${item.url}`
  }
}

/**
 * Where a listed vault attachment's bytes sit, as a URL the picker can show.
 * The layout is the one `saveAttachment` writes: `attachments/<owner>/<file>`.
 */
function vaultAttachmentUrl(entry: VaultAttachmentEntry, vaultPath: string | null): string | null {
  if (!vaultPath) return null
  return toMemryFileUrl(`${vaultPath}/attachments/${entry.ownerNoteId}/${entry.filename}`)
}

/** A link is only offered once it is one Memry can actually fetch. */
function imageLinkFrom(query: string): string | null {
  try {
    const parsed = new URL(query.trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** Every way a linked image can come up empty gets its own line. */
const LINK_ERROR_KEYS: Record<DownloadAttachmentFromUrlFailure, string> = {
  'not-an-image': 'cover.picker.link.error.notAnImage',
  'too-large': 'cover.picker.link.error.tooLarge',
  offline: 'cover.picker.link.error.offline',
  failed: 'cover.picker.link.error.failed',
  'write-failed': 'cover.picker.link.error.writeFailed'
}

/** Where the picker opens: the click's viewport coordinates, not a boolean. */
export interface CoverPickerAnchor {
  x: number
  y: number
}

export function coverPickerAnchorFrom(event: ReactMouseEvent<HTMLElement>): CoverPickerAnchor {
  // Keyboard activation of a button reports a click at 0/0, which would pin the
  // picker to the viewport corner; the button's own centre is the real origin.
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  return { x: event.clientX, y: event.clientY }
}

export interface CoverPickerDialogProps {
  anchor: CoverPickerAnchor | null
  onOpenChange: (open: boolean) => void
  /** The note that will own an uploaded file. */
  noteId: string
  onApply: (
    value: CoverValue,
    opts: { reposition: boolean; credit?: { name: string; url: string } }
  ) => void
}

export function CoverPickerDialog({
  anchor,
  onOpenChange,
  noteId,
  onApply
}: CoverPickerDialogProps) {
  const open = anchor !== null
  const { t } = useT('notes')
  const { vaultPath } = useVault()
  const [requestedTab, setTab] = useState<CoverPickerTabId>('washes')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [entries, setEntries] = useState<VaultAttachmentEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [photoFetch, setPhotoFetch] = useState<{ query: string; result: PhotoSearch } | null>(null)
  const [photoDownload, setPhotoDownload] = useState<PhotoDownload>({ kind: 'none' })
  const [linkDownload, setLinkDownload] = useState<
    | { kind: 'none' }
    | { kind: 'running' }
    | { kind: 'failed'; reason: DownloadAttachmentFromUrlFailure }
  >({ kind: 'none' })
  const [photosConfigured, setPhotosConfigured] = useState(true)
  const [defaultPhotoQuery, setDefaultPhotoQuery] = useState(randomDefaultPhotoQuery)
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
      setLinkDownload({ kind: 'none' })
      setPhotosConfigured(true)
      setDefaultPhotoQuery(randomDefaultPhotoQuery())
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
  /** Never empty: with nothing typed the tab still has something to show. */
  const photoQuery = trimmedQuery || defaultPhotoQuery

  const photoSearch = useMemo<PhotoSearch>(() => {
    const cached = photoCache.current.get(photoQuery)
    if (cached) return cached
    return photoFetch?.query === photoQuery ? photoFetch.result : { kind: 'searching' }
  }, [photoFetch, photoQuery])

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
    if (!open || !photosConfigured || tab !== 'photos') return
    if (photoCache.current.has(photoQuery)) return
    let cancelled = false
    const timer = setTimeout(() => {
      unsplashService
        .search({ query: photoQuery, page: 1 })
        .then((result) => {
          if (cancelled) return
          if (!result.ok) {
            if (result.reason === 'not-configured') {
              setPhotosConfigured(false)
              return
            }
            setPhotoFetch({
              query: photoQuery,
              result: { kind: 'error', reason: result.reason }
            })
            return
          }
          const next: PhotoSearch = {
            kind: 'photos',
            photos: result.photos,
            rateLimitRemaining: result.rateLimitRemaining
          }
          photoCache.current.set(photoQuery, next)
          setPhotoFetch({ query: photoQuery, result: next })
        })
        .catch((err: unknown) => {
          if (cancelled) return
          logger.error('Unsplash search failed', err)
          setPhotoFetch({ query: photoQuery, result: { kind: 'error', reason: 'failed' } })
        })
    }, PHOTO_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, photosConfigured, tab, photoQuery])

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
      case 'link': {
        const url = imageLinkFrom(query)
        return url === null ? [] : [{ kind: 'link', url }]
      }
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
      if (item.kind === 'link') {
        setLinkDownload({ kind: 'running' })
        try {
          const result = await notesService.downloadAttachmentFromUrl(noteId, item.url)
          if (!result.ok) {
            setLinkDownload({ kind: 'failed', reason: result.reason })
            return
          }
          setLinkDownload({ kind: 'none' })
          onApply({ kind: 'image', ref: result.ref }, { reposition })
          onOpenChange(false)
        } catch (err) {
          logger.error('Failed to save a linked image as a cover', err)
          setLinkDownload({ kind: 'failed', reason: 'failed' })
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
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      {anchor !== null && (
        <PopoverAnchor asChild>
          {/* `left` stays physical: clientX is measured from the viewport's left
              edge in both LTR and RTL. */}
          <div
            className="pointer-events-none fixed h-0 w-0"
            style={{ left: anchor.x, top: anchor.y }}
          />
        </PopoverAnchor>
      )}
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-[34rem] gap-0 overflow-hidden p-0"
        data-testid="cover-picker-dialog"
        aria-label={t('cover.picker.title')}
        onKeyDown={handleKeyDown}
        // The search input's own autoFocus is the intended landing spot.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A click outside that never takes focus leaves the picker open; focus
        // leaving and esc still close it.
        onPointerDownOutside={(event) => event.preventDefault()}
      >
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
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium',
                'transition-colors duration-150 motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                entry.id === tab
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {entry.id === 'photos' && <UnsplashMark />}
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
          className="h-[21rem] overflow-y-auto [scrollbar-gutter:stable] p-2"
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
          ) : tab === 'fromNote' ? (
            <div className="grid grid-cols-3 gap-2">
              {items.map((item, index) =>
                item.kind === 'attachment' ? (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg p-0.5 text-start',
                      'focus-visible:outline-none',
                      index === activeIndex && 'ring-2 ring-ring'
                    )}
                    data-testid="cover-picker-row"
                  >
                    <img
                      src={vaultAttachmentUrl(item.entry, vaultPath) ?? undefined}
                      alt=""
                      loading="lazy"
                      className="h-[76px] w-full rounded-md bg-muted object-cover"
                    />
                    <span
                      className="truncate px-1 pb-0.5 text-[11px] text-muted-foreground"
                      title={item.entry.ownerNoteTitle ?? item.entry.displayName}
                    >
                      {item.entry.ownerNoteTitle ?? item.entry.displayName}
                    </span>
                  </button>
                ) : null
              )}

              {!loading && items.length === 0 && (
                <p
                  className="col-span-3 px-2 py-5 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-empty"
                >
                  {query ? t('cover.picker.noMatches') : t('cover.picker.empty')}
                </p>
              )}
            </div>
          ) : tab === 'link' ? (
            <div className="flex flex-col gap-2">
              {linkDownload.kind === 'failed' && (
                <p
                  className="px-2 py-2 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-link-error"
                  data-reason={linkDownload.reason}
                >
                  {t(LINK_ERROR_KEYS[linkDownload.reason])}
                </p>
              )}

              {items.map((item, index) =>
                item.kind === 'link' ? (
                  <button
                    key={itemKey(item)}
                    type="button"
                    onClick={() => void apply(item, false)}
                    aria-selected={index === activeIndex}
                    disabled={linkDownload.kind === 'running'}
                    className={cn(
                      'flex h-9 items-center gap-2.5 rounded-md px-2 text-start text-sm',
                      'focus-visible:outline-none disabled:opacity-60',
                      index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                    )}
                    data-testid="cover-picker-link"
                  >
                    {linkDownload.kind === 'running' ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">
                      {linkDownload.kind === 'running'
                        ? t('cover.picker.link.saving')
                        : t('cover.picker.link.use')}
                    </span>
                  </button>
                ) : null
              )}

              {items.length === 0 && (
                <p
                  className="px-2 py-5 text-center text-sm text-muted-foreground"
                  data-testid="cover-picker-link-prompt"
                >
                  {query ? t('cover.picker.link.invalid') : t('cover.picker.link.prompt')}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              {items.map((item) => (
                <button
                  key={itemKey(item)}
                  type="button"
                  onClick={() => void apply(item, false)}
                  className={cn(
                    'flex h-9 items-center gap-2.5 rounded-md px-2 text-start text-sm',
                    'focus-visible:outline-none hover:bg-muted'
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
              ))}
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
      </PopoverContent>
    </Popover>
  )
}
