import { useEffect, useMemo, useRef, useState } from 'react'
import { Focus, ExternalLink, Copy, FilePlus, Link2, Tag, Unlink, ChevronLeft } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type Graph from 'graphology'
import {
  hasTag,
  isEditableGraphNode,
  relationLinksOf,
  type GraphRelationLink
} from '@/lib/graph-edits'
import { isValidTagName, normalizeTagName } from '@/lib/tag-utils'

export interface ContextMenuState {
  nodeId: string
  x: number
  y: number
}

interface GraphContextMenuProps {
  menu: ContextMenuState
  graph: Graph
  onFocusNode: (nodeId: string) => void
  onOpenInTab: (nodeId: string) => void
  onCreateNote?: (title: string) => void
  /** Add `targetId` to `sourceId`'s relation property. */
  onLinkTo?: (sourceId: string, targetId: string) => void
  onAddTag?: (nodeId: string, tag: string) => void
  onUnlink?: (link: GraphRelationLink) => void
  onClose: () => void
}

type MenuMode = 'main' | 'link' | 'tag'

/** Enough to pick from without turning the menu into a second search page. */
const MAX_PICKER_RESULTS = 8

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none transition-colors'

export function GraphContextMenu({
  menu,
  graph,
  onFocusNode,
  onOpenInTab,
  onCreateNote,
  onLinkTo,
  onAddTag,
  onUnlink,
  onClose
}: GraphContextMenuProps): React.JSX.Element {
  const { t } = useT('graph')
  const menuRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<MenuMode>('main')

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  if (!graph.hasNode(menu.nodeId)) return <></>

  const attrs = graph.getNodeAttributes(menu.nodeId)
  const label = (attrs.label as string) || t('context-menu.untitled')
  const isUnresolved = attrs.isUnresolved as boolean
  const editable = isEditableGraphNode(graph, menu.nodeId)
  const relationLinks = onUnlink ? relationLinksOf(graph, menu.nodeId) : []

  return (
    <div
      ref={menuRef}
      className="absolute z-50 min-w-[180px] max-w-[260px] rounded-md border border-border bg-popover p-1 shadow-card animate-in fade-in-0 zoom-in-95"
      style={{ left: menu.x, top: menu.y }}
    >
      {mode === 'link' && onLinkTo ? (
        <LinkPicker
          graph={graph}
          sourceId={menu.nodeId}
          onBack={() => setMode('main')}
          onPick={(targetId) => {
            onLinkTo(menu.nodeId, targetId)
            onClose()
          }}
        />
      ) : mode === 'tag' && onAddTag ? (
        <TagPicker
          graph={graph}
          nodeTags={(attrs.tags as string[] | undefined) ?? []}
          onBack={() => setMode('main')}
          onPick={(tag) => {
            onAddTag(menu.nodeId, tag)
            onClose()
          }}
        />
      ) : (
        <>
          <div className="px-2 py-1.5 mb-0.5">
            <span className="text-xs font-medium text-foreground truncate block max-w-[180px]">
              {label}
            </span>
          </div>

          <button
            type="button"
            className={ITEM_CLASS}
            onClick={() => {
              onFocusNode(menu.nodeId)
              onClose()
            }}
          >
            <Focus className="size-3.5 text-muted-foreground" />
            {t('context-menu.focus-node')}
          </button>

          {!isUnresolved && (
            <button
              type="button"
              className={ITEM_CLASS}
              onClick={() => {
                onOpenInTab(menu.nodeId)
                onClose()
              }}
            >
              <ExternalLink className="size-3.5 text-muted-foreground" />
              {t('context-menu.open-new-tab')}
            </button>
          )}

          {isUnresolved && onCreateNote && (
            <button
              type="button"
              className={ITEM_CLASS}
              onClick={() => {
                onCreateNote(label)
                onClose()
              }}
            >
              <FilePlus className="size-3.5 text-muted-foreground" />
              {t('context-menu.create-note')}
            </button>
          )}

          {editable && onLinkTo && (
            <button type="button" className={ITEM_CLASS} onClick={() => setMode('link')}>
              <Link2 className="size-3.5 text-muted-foreground" />
              {t('context-menu.link-to')}
            </button>
          )}

          {editable && onAddTag && (
            <button type="button" className={ITEM_CLASS} onClick={() => setMode('tag')}>
              <Tag className="size-3.5 text-muted-foreground" />
              {t('context-menu.add-tag')}
            </button>
          )}

          <button
            type="button"
            className={ITEM_CLASS}
            onClick={() => {
              void navigator.clipboard.writeText(label)
              onClose()
            }}
          >
            <Copy className="size-3.5 text-muted-foreground" />
            {t('context-menu.copy-title')}
          </button>

          {relationLinks.length > 0 && onUnlink && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="max-h-40 overflow-y-auto">
                {relationLinks.map((link) => (
                  <button
                    key={`${link.sourceId}-${link.targetId}`}
                    type="button"
                    className={ITEM_CLASS}
                    onClick={() => {
                      onUnlink(link)
                      onClose()
                    }}
                  >
                    <Unlink className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {t('context-menu.remove-link', {
                        title: link.otherLabel || t('context-menu.untitled')
                      })}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

interface PickerShellProps {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBack: () => void
  onSubmit: () => void
  children: React.ReactNode
}

function PickerShell({
  value,
  placeholder,
  onChange,
  onBack,
  onSubmit,
  children
}: PickerShellProps): React.JSX.Element {
  const { t } = useT('graph')
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={t('context-menu.back')}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          onClick={onBack}
        >
          <ChevronLeft className="size-3.5 rtl:rotate-180" />
        </button>
        <input
          // The picker opens from an explicit menu click, so taking focus is expected.
          autoFocus
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            }
          }}
          className="h-6 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-56 overflow-y-auto">{children}</div>
    </div>
  )
}

function LinkPicker({
  graph,
  sourceId,
  onBack,
  onPick
}: {
  graph: Graph
  sourceId: string
  onBack: () => void
  onPick: (targetId: string) => void
}): React.JSX.Element {
  const { t } = useT('graph')
  const [query, setQuery] = useState('')

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const results: Array<{ id: string; label: string }> = []
    graph.forEachNode((id, attrs) => {
      if (results.length >= MAX_PICKER_RESULTS) return
      if (id === sourceId || !isEditableGraphNode(graph, id)) return
      const nodeLabel = (attrs.label as string) ?? ''
      if (needle && !nodeLabel.toLowerCase().includes(needle)) return
      results.push({ id, label: nodeLabel })
    })
    return results
  }, [graph, sourceId, query])

  return (
    <PickerShell
      value={query}
      placeholder={t('context-menu.link-search')}
      onChange={setQuery}
      onBack={onBack}
      onSubmit={() => {
        if (candidates[0]) onPick(candidates[0].id)
      }}
    >
      {candidates.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('context-menu.no-matches')}</p>
      ) : (
        candidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={ITEM_CLASS}
            onClick={() => onPick(candidate.id)}
          >
            <span className="truncate">{candidate.label || t('context-menu.untitled')}</span>
          </button>
        ))
      )}
    </PickerShell>
  )
}

function TagPicker({
  graph,
  nodeTags,
  onBack,
  onPick
}: {
  graph: Graph
  nodeTags: string[]
  onBack: () => void
  onPick: (tag: string) => void
}): React.JSX.Element {
  const { t } = useT('graph')
  const [query, setQuery] = useState('')
  const typed = normalizeTagName(query)
  const typedValid = isValidTagName(typed) && !hasTag(nodeTags, typed)

  // Every tag already in the vault graph, so the common case needs no typing.
  const suggestions = useMemo(() => {
    const all = new Set<string>()
    graph.forEachNode((_id, attrs) => {
      for (const tag of (attrs.tags as string[] | undefined) ?? []) all.add(tag)
    })
    return [...all]
      .filter((tag) => !hasTag(nodeTags, tag) && (!typed || tag.toLowerCase().includes(typed)))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PICKER_RESULTS)
  }, [graph, nodeTags, typed])

  const showCreate = typedValid && !suggestions.some((tag) => tag.toLowerCase() === typed)

  return (
    <PickerShell
      value={query}
      placeholder={t('context-menu.tag-search')}
      onChange={setQuery}
      onBack={onBack}
      onSubmit={() => {
        const exact = suggestions.find((tag) => tag.toLowerCase() === typed)
        if (exact) onPick(exact)
        else if (typedValid) onPick(typed)
        else if (suggestions[0]) onPick(suggestions[0])
      }}
    >
      {suggestions.map((tag) => (
        <button key={tag} type="button" className={ITEM_CLASS} onClick={() => onPick(tag)}>
          <span className="truncate">#{tag}</span>
        </button>
      ))}
      {showCreate && (
        <button type="button" className={ITEM_CLASS} onClick={() => onPick(typed)}>
          <Tag className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{t('context-menu.create-tag', { tag: typed })}</span>
        </button>
      )}
      {suggestions.length === 0 && !showCreate && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('context-menu.no-matches')}</p>
      )}
    </PickerShell>
  )
}
