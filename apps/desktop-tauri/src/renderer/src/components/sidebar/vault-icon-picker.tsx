import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'

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
 * chunk is in (at once on every open after the first). A failed load counts as in, so the lazy
 * component reports the failure where it renders.
 */
function useEmojiPickerChunk(open: boolean): boolean {
  const [loaded, setLoaded] = useState(emojiPickerLoaded)
  useEffect(() => {
    if (!open || loaded) return undefined
    let live = true
    const markLoaded = () => {
      if (live) setLoaded(true)
    }
    loadEmojiPicker().then(markLoaded, markLoaded)
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
  const setIcon = useSetVaultIcon()
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const ready = useEmojiPickerChunk(open)

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
