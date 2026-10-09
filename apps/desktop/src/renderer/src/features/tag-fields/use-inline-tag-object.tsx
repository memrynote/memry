/* eslint-disable @typescript-eslint/no-explicit-any -- the BlockNote editor instance is untyped across content-area hooks */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { ArrowUpRight, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TagGlyph } from './object-avatar'
import { lookOfTag } from './object-look'
import { presetPlural, tagDisplayName } from './tag-display-name'
import { useTagSchemas } from './use-tag-schemas'

interface PopoverState {
  tag: string
  pill: HTMLElement
  position: { x: number; y: number }
  selectedIndex: number
}

const ACTIONS = ['make', 'open', 'remove'] as const
type Action = (typeof ACTIONS)[number]
const ACTIVE_CLASS = 'inline-hash-tag--active'
const POPOVER_WIDTH = 330

export function useInlineTagObject(
  editor: any,
  containerRef: RefObject<HTMLDivElement | null>,
  noteId: string | undefined
) {
  const { t } = useT('notes')
  const { data: snapshot } = useTagSchemas()
  const { openSidebarItem } = useSidebarNavigation()
  const [state, setState] = useState<PopoverState | null>(null)
  const stateRef = useRef<PopoverState | null>(null)

  const update = useCallback((next: PopoverState | null) => {
    stateRef.current?.pill.classList.remove(ACTIVE_CLASS)
    next?.pill.classList.add(ACTIVE_CLASS)
    stateRef.current = next
    setState(next)
  }, [])

  const onTagClick = useCallback(
    (tag: string, pill: HTMLElement): boolean => {
      const resolved = snapshot?.tags[tag.toLowerCase()]
      const container = containerRef.current
      if (!noteId || !resolved?.hasFields || !container) return false
      if (snapshot?.objects[noteId] === resolved.key) return false
      const pillRect = pill.getBoundingClientRect()
      const rect = container.getBoundingClientRect()
      update({
        tag: resolved.key,
        pill,
        position: {
          x: Math.max(0, Math.min(pillRect.left - rect.left, rect.width - POPOVER_WIDTH)),
          y: pillRect.bottom - rect.top + 6
        },
        selectedIndex: 0
      })
      return true
    },
    [snapshot, containerRef, noteId, update]
  )

  const run = useCallback(
    async (action: Action) => {
      const current = stateRef.current
      update(null)
      if (!current || !noteId) return
      const resolved = snapshot?.tags[current.tag]
      const name = resolved?.name ?? current.tag
      if (action === 'open') {
        openSidebarItem({
          type: 'tag',
          title: name,
          path: '/tags/' + current.tag,
          entityId: current.tag,
          color: resolved?.color ?? ''
        })
        return
      }
      if (action === 'remove') {
        const view = editor?._tiptapEditor?.view
        if (!view) return
        const pos = view.posAtDOM(current.pill, 0) - 1
        const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null
        if (node?.type.name === 'hashTag') view.dispatch(view.state.tr.delete(pos, pos + 1))
        return
      }
      try {
        const result = await notesService.update({ id: noteId, headerTags: { add: [name] } })
        if (!result.success) throw new Error(result.error)
        toast.success(t('tagObjects.inline.made', { tag: name }))
      } catch (error) {
        toast.error(extractErrorMessage(error, t('tagObjects.inline.makeFailed')))
      }
    },
    [editor, noteId, openSidebarItem, snapshot, t, update]
  )

  const isOpen = state !== null
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = stateRef.current
      if (!current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const step = event.key === 'ArrowDown' ? 1 : -1
        update({
          ...current,
          selectedIndex: (current.selectedIndex + step + ACTIONS.length) % ACTIONS.length
        })
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void run(ACTIONS[current.selectedIndex])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        update(null)
      }
    }
    const onMouseDown = (event: MouseEvent): void => {
      if ((event.target as HTMLElement | null)?.closest('[data-inline-tag-object]')) return
      update(null)
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('mousedown', onMouseDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('mousedown', onMouseDown, { capture: true })
    }
  }, [isOpen, run, update])

  const resolved = state ? snapshot?.tags[state.tag] : undefined
  const objects = resolved
    ? Object.values(snapshot?.objects ?? {}).filter((tag) => tag === resolved.key).length
    : 0
  const color = resolved ? getTagColors(resolved.color, resolved.key).text : null
  const tagName = resolved?.name ?? state?.tag ?? ''
  const label = tagDisplayName(tagName)
  const plural = resolved
    ? presetPlural(resolved, (preset) => ({
        name: t(`tagFields.presets.${preset}.name`),
        plural: t(`tagFields.presets.${preset}.plural`)
      }))
    : null

  const overlay =
    state && resolved && color ? (
      <div
        data-inline-tag-object
        role="menu"
        aria-label={t('tagObjects.inline.aria', { tag: tagName })}
        className="absolute z-50 w-[330px] rounded-lg border border-border bg-popover p-1 text-[13px] shadow-[var(--shadow-card-hover)] motion-safe:animate-in motion-safe:fade-in-0"
        style={{ left: state.position.x, top: state.position.y }}
      >
        <div className="flex flex-col gap-1.5 border-b border-border px-2.5 pb-2.5 pt-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium"
              style={{ backgroundColor: withAlpha(color, 0.12), color }}
            >
              <TagGlyph look={lookOfTag(resolved)} className="size-3" />
              {tagName}
            </span>
            {plural
              ? t('tagObjects.inline.metaNamed', {
                  count: objects,
                  one: tagName.toLocaleLowerCase(),
                  other: plural.toLocaleLowerCase(),
                  fields: resolved.effectiveFields.length
                })
              : t('tagObjects.inline.meta', {
                  count: objects,
                  fields: resolved.effectiveFields.length
                })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('tagObjects.inline.explain', { tag: tagName })}
          </p>
        </div>
        {ACTIONS.map((action, index) => (
          <button
            key={action}
            type="button"
            role="menuitem"
            onMouseDown={(event) => {
              event.preventDefault()
              void run(action)
            }}
            className={cn(
              'mt-1 flex w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-start',
              index === state.selectedIndex ? 'bg-accent' : 'hover:bg-accent/60'
            )}
          >
            {action === 'make' && <TagGlyph look={lookOfTag(resolved)} />}
            {action === 'open' && <ArrowUpRight className="size-3.5 text-muted-foreground" />}
            {action === 'remove' && <X className="size-3.5 text-muted-foreground" />}
            <span className="flex flex-col">
              <span className="text-foreground">
                {action === 'make'
                  ? t('tagObjects.inline.make', { tag: label })
                  : action === 'open'
                    ? t('tagObjects.inline.open', { tag: tagName })
                    : t('tagObjects.inline.remove')}
              </span>
              {action === 'make' && (
                <span className="text-xs text-muted-foreground">
                  {t('tagObjects.inline.makeHint', { tag: tagName })}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    ) : null

  return { onTagClick, overlay }
}
