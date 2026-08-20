import { useCallback, useMemo, useRef, useState } from 'react'
import {
  CUSTOM_ICON_INPUT_EXTENSIONS,
  CUSTOM_ICON_NAME_MAX_LENGTH,
  type CustomIconInputExtension
} from '@memry/contracts/custom-icons-api'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { refreshCustomIcons, useCustomIcons } from '@/lib/custom-icons-store'
import { ArrowRight, Check, Link, Loader2, Pencil, Trash2, Upload, X } from '@/lib/icons'

const log = createLogger('CustomIconGrid')

const ACCEPT = CUSTOM_ICON_INPUT_EXTENSIONS.map((ext) => `.${ext}`).join(',')

function extensionOf(fileName: string): CustomIconInputExtension | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return (CUSTOM_ICON_INPUT_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as CustomIconInputExtension)
    : null
}

function defaultNameFor(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '').trim()
  return (withoutExt || fileName).slice(0, CUSTOM_ICON_NAME_MAX_LENGTH)
}

/**
 * FileReader rather than `arrayBuffer()` + `btoa`: spreading a 2 MB byte array
 * into `String.fromCharCode` overflows the call stack.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

interface CustomIconGridProps {
  onSelect: (iconId: string) => void
}

/**
 * The picker's third tab: the vault's own icon library.
 *
 * Icons arrive by drop, file picker or link, keep a user-editable name, and
 * stay listed until deleted — the library is the point, not a one-shot upload.
 *
 * A pasted link is downloaded by the main process and stored like any other
 * icon; nothing here ever renders from a remote address.
 */
export function CustomIconGrid({ onSelect }: CustomIconGridProps): React.JSX.Element {
  const { t } = useT('notes')
  const icons = useCustomIcons()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return icons
    return icons.filter((icon) => icon.name.toLowerCase().includes(query))
  }, [icons, search])

  const addFiles = useCallback(
    async (files: File[]) => {
      const api = window.api?.customIcons
      if (!api || files.length === 0) return

      setIsAdding(true)
      setError(null)
      try {
        for (const file of files) {
          const ext = extensionOf(file.name)
          if (!ext) {
            setError(t('menus.emoji.custom.unsupportedFile', { name: file.name }))
            continue
          }
          await api.add({
            name: defaultNameFor(file.name),
            ext,
            dataBase64: await readAsBase64(file)
          })
        }
        await refreshCustomIcons()
      } catch (err) {
        log.warn('Failed to add custom icon', err)
        setError(extractErrorMessage(err, t('menus.emoji.custom.addFailed')))
      } finally {
        setIsAdding(false)
      }
    },
    [t]
  )

  const addFromUrl = useCallback(
    async (link: string) => {
      const api = window.api?.customIcons
      const trimmed = link.trim()
      if (!api || !trimmed) return

      setIsDownloading(true)
      setError(null)
      try {
        await api.addFromUrl({ url: trimmed })
        await refreshCustomIcons()
        setUrl('')
      } catch (err) {
        log.warn('Failed to add custom icon from URL', err)
        setError(extractErrorMessage(err, t('menus.emoji.custom.addUrlFailed')))
      } finally {
        setIsDownloading(false)
      }
    },
    [t]
  )

  /**
   * An image dragged out of a browser arrives as a link, not a file, so the
   * same drop target takes both.
   */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        void addFiles(files)
        return
      }
      const dropped = (
        event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
      )
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^https?:\/\//i.test(line))
      if (dropped) void addFromUrl(dropped)
    },
    [addFiles, addFromUrl]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await window.api?.customIcons.delete(id)
        await refreshCustomIcons()
      } catch (err) {
        log.warn('Failed to delete custom icon', err)
        setError(extractErrorMessage(err, t('menus.emoji.custom.deleteFailed')))
      }
    },
    [t]
  )

  const commitRename = useCallback(async () => {
    const id = renamingId
    const name = renameDraft.trim()
    setRenamingId(null)
    if (!id || !name) return
    try {
      await window.api?.customIcons.rename({ id, name })
      await refreshCustomIcons()
    } catch (err) {
      log.warn('Failed to rename custom icon', err)
      setError(extractErrorMessage(err, t('menus.emoji.custom.renameFailed')))
    }
  }, [renamingId, renameDraft, t])

  return (
    <div
      className="flex h-full w-full flex-col"
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <div className="shrink-0 space-y-2 p-3">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('menus.emoji.custom.searchPlaceholder')}
          aria-label={t('menus.emoji.custom.searchPlaceholder')}
          className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm outline-none focus:border-foreground/40"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isAdding}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3',
            'text-sm text-muted-foreground transition-colors',
            'hover:border-foreground/40 hover:text-foreground disabled:opacity-60',
            isDragging ? 'border-foreground/60 bg-muted/60 text-foreground' : 'border-border'
          )}
        >
          <Upload className="h-4 w-4" />
          {isAdding ? t('menus.emoji.custom.adding') : t('menus.emoji.custom.dropHint')}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => {
            void addFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />

        <div
          className={cn(
            'flex items-center gap-2 rounded-md border border-border px-2',
            'transition-colors focus-within:border-foreground/40'
          )}
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Link className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void addFromUrl(url)
              }
            }}
            disabled={isDownloading}
            placeholder={
              isDownloading
                ? t('menus.emoji.custom.downloading')
                : t('menus.emoji.custom.urlPlaceholder')
            }
            aria-label={t('menus.emoji.custom.urlLabel')}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-60"
          />
          {url.trim() && !isDownloading && (
            <button
              type="button"
              onClick={() => void addFromUrl(url)}
              aria-label={t('menus.emoji.custom.urlSubmit')}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            {icons.length === 0 ? t('menus.emoji.custom.empty') : t('menus.emoji.custom.noMatches')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((icon) => (
              <li key={icon.id} className="group flex items-center gap-2 rounded-md px-1">
                {renamingId === icon.id ? (
                  <>
                    <img
                      src={icon.url}
                      alt=""
                      className="h-6 w-6 shrink-0 object-contain"
                      draggable={false}
                    />
                    <input
                      autoFocus
                      value={renameDraft}
                      maxLength={CUSTOM_ICON_NAME_MAX_LENGTH}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename()
                        if (event.key === 'Escape') setRenamingId(null)
                      }}
                      aria-label={t('menus.emoji.custom.renameLabel')}
                      className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-sm outline-none focus:border-foreground/40"
                    />
                    <button
                      type="button"
                      onClick={() => void commitRename()}
                      aria-label={t('menus.emoji.custom.saveName')}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      aria-label={t('menus.emoji.custom.cancelRename')}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onSelect(icon.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-start hover:bg-muted"
                    >
                      <img
                        src={icon.url}
                        alt=""
                        className="h-6 w-6 shrink-0 object-contain"
                        draggable={false}
                      />
                      <span className="truncate text-sm">{icon.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(icon.id)
                        setRenameDraft(icon.name)
                      }}
                      aria-label={t('menus.emoji.custom.rename', { name: icon.name })}
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(icon.id)}
                      aria-label={t('menus.emoji.custom.delete', { name: icon.name })}
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
