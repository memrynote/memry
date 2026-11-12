import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:VaultIconPicker')

// Lazy like `IconPickerButton`: emoji-mart and its data are large and only
// needed once a picker opens.
let emojiPickerLoaded = false
const loadEmojiPicker = async () => {
  const module = await import('@/components/note/note-title/EmojiPicker')
  emojiPickerLoaded = true
  return module
}
const LazyEmojiPicker = lazy(async () => ({
  default: (await loadEmojiPicker()).EmojiPicker
}))

/**
 * Whether the picker's chunk is in. A popover opened before it is has no content to size from:
 * it sits at the unshifted spot for the ~50 ms the chunk takes, then jumps. It opens once the
 * chunk is in (at once on every open after the first). A chunk that fails to load never counts as
 * in: the lazy component below is rendered only once it has, so no render can throw its rejection
 * (nothing here catches one). The picker closes with a toast, and the next open loads it again.
 */
function useEmojiPickerChunk(open: boolean, onLoadFailed: () => void): boolean {
  const [loaded, setLoaded] = useState(emojiPickerLoaded)
  // The caller passes a new callback on every render (the pill re-renders on each swipe step): the
  // load runs once per open, whichever callback is the latest when it fails.
  const onLoadFailedRef = useRef(onLoadFailed)
  useEffect(() => {
    onLoadFailedRef.current = onLoadFailed
  })
  useEffect(() => {
    if (!open || loaded) return undefined
    let live = true
    loadEmojiPicker().then(
      () => {
        if (live) setLoaded(true)
      },
      (err: unknown) => {
        log.error('Emoji picker chunk failed to load', err)
        if (live) onLoadFailedRef.current()
      }
    )
    return () => {
      live = false
    }
  }, [open, loaded])
  return loaded
}

/** Set or reset (null) a vault's icon. The list refreshes on `vault:list-changed`. */
export function useSetVaultIcon(): (path: string, icon: string | null) => void {
  const { t } = useT('common')
  return useCallback(
    (path: string, icon: string | null) => {
      vaultService.setIcon(path, icon).catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('vaultSwipe.iconFailed')))
      })
    },
    [t]
  )
}

interface VaultIconPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vaultPath: string
  /** The vault has its own icon, so the picker offers Remove (back to the default). */
  hasIcon: boolean
  side: 'top' | 'bottom'
  /** The element the picker is anchored to; rendered through `PopoverAnchor asChild`. */
  children: ReactNode
}

/**
 * The emoji and icon picker for one vault, anchored to its glyph. Opened by the
 * header's icon button and by the page indicator's context menu; neither owns a
 * `PopoverTrigger`, since a click on an indicator icon switches vaults.
 */
export function VaultIconPicker({
  open,
  onOpenChange,
  vaultPath,
  hasIcon,
  side,
  children
}: VaultIconPickerProps) {
  const { t } = useT('common')
  const setIcon = useSetVaultIcon()
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const onLoadFailed = useCallback(() => {
    toast.error(t('vaultSwipe.iconPickerFailed'))
    onOpenChange(false)
  }, [onOpenChange, t])
  const ready = useEmojiPickerChunk(open, onLoadFailed)

  // While the chunk is out there is no popover to take Escape: a slow load must not leave the
  // picker open with nothing on screen and no way to dismiss it. The key is this picker's, so it
  // is marked taken (capture runs before the window's other listeners, which check
  // `defaultPrevented`) and does not also go back a level in the sidebar.
  useEffect(() => {
    if (!open || ready) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, ready, close])

  return (
    <Popover open={open && ready} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        sticky="always"
        className="w-auto border-0 bg-transparent p-0 shadow-none"
      >
        {open && (
          <Suspense fallback={null}>
            <LazyEmojiPicker
              isOpen
              embedded
              allowCustom={false}
              hasEmoji={hasIcon}
              onClose={close}
              onSelect={(icon) => {
                setIcon(vaultPath, icon)
                close()
              }}
              onRemove={() => {
                setIcon(vaultPath, null)
                close()
              }}
            />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  )
}
