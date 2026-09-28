import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import {
  VIEW_BLOCK_LANGUAGE,
  parseViewBlockDefinition,
  serializeViewBlockDefinition,
  updateViewBlockDefinition,
  viewBlockScope,
  type ParsedViewBlock,
  type ViewBlockDefinition,
  type ViewBlockLayout,
  type ViewBlockSource
} from '@memry/shared/view-block'
import { DEFAULT_COLUMNS, type FilterExpression } from '@memry/contracts/folder-view-api'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FilterBuilder } from '@/components/folder-view/filter-builder'
import { FolderListView } from '@/components/folder-view/folder-list-view'
import { FolderGalleryView } from '@/components/folder-view/folder-gallery-view'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { LayoutToggle } from '@/components/folder-view/layout-toggle'
import type { TagMetaMap } from '@/components/folder-view/note-card-pieces'
import { useFolderView, type NoteWithProperties } from '@/hooks/use-folder-view'
import type { SidebarItem } from '@/contexts/tabs/types'
import { useNoteFoldersQuery, useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { getViewDisplayName } from '@/lib/contract-display-names'
import { evaluateFilter, isFilterEmpty } from '@/lib/filter-evaluator'
import { sidebarItemForRow } from '@/lib/folder-row-navigation'
import { Check, ChevronDown, Database, ExternalLink, Folder, Globe, Hash } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { sortNotes } from '@/lib/sort-notes'
import { cn } from '@/lib/utils'
import type { EditorSchema } from './editor-schema'

const log = createLogger('ViewBlock')

/**
 * The view block (#2488): a live list of notes embedded in a note.
 *
 * It is not a block type of its own. In the document it is a `codeBlock` whose
 * `language` is `memry-view` and whose text is the definition as JSON (see
 * `@memry/shared/view-block`); `createMemrySchema`'s `codeBlockViews` routes
 * that one language here, and every other code block renders as code. So the
 * main process, the phone and any older build hold the block as the code
 * block it is on disk, and nothing but this renderer has to know it exists.
 *
 * The definition text stays in the document as the node's content. It is
 * shown, and editable as JSON, while the caret is in the block; otherwise the
 * header's controls rewrite it and the reader never sees it.
 */

/** Rows a view block will page through before it stops asking for more. */
const MAX_ROWS_SCANNED = 2000

/** What `/view` starts from: the notes touched most recently, a list of ten. */
export const STARTER_VIEW_DEFINITION: ViewBlockDefinition = {
  source: { kind: 'vault' },
  layout: 'list',
  order: [{ property: 'modified', direction: 'desc' }],
  limit: 10
}

/** Blocks this window just inserted with `/view`; they open with the source menu up. */
const freshViewBlocks = new Set<string>()

type TablePropertyTypes = NonNullable<React.ComponentProps<typeof FolderTableView>['propertyTypes']>

interface ViewBlockNode {
  id: string
  props: { language: string }
  content?: unknown
}

interface ViewBlockEditor {
  isEditable: boolean
  updateBlock: (block: string, update: { content: string }) => unknown
  getTextCursorPosition: () => { block: { id: string } }
  onSelectionChange: (callback: () => void) => () => void
}

/** The block's plain text: its runs, joined. */
export function viewBlockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((run) =>
      typeof run === 'object' &&
      run !== null &&
      typeof (run as { text?: unknown }).text === 'string'
        ? (run as { text: string }).text
        : ''
    )
    .join('')
}

function useCaretInBlock(editor: ViewBlockEditor, blockId: string): boolean {
  const read = useCallback((): boolean => {
    try {
      return editor.getTextCursorPosition().block.id === blockId
    } catch {
      return false
    }
  }, [editor, blockId])
  const subscribe = useCallback(
    (onChange: () => void) => editor.onSelectionChange(onChange),
    [editor]
  )
  return useSyncExternalStore(subscribe, read)
}

function sourceLabel(source: ViewBlockSource, allNotesLabel: string): string {
  if (source.kind === 'vault') return allNotesLabel
  if (source.kind === 'folder') {
    return source.path.split('/').filter(Boolean).pop() ?? (source.path || allNotesLabel)
  }
  return [source.tag, ...(source.andTags ?? [])].map((tag) => `#${tag}`).join(' + ')
}

function SourceIcon({ source }: { source: ViewBlockSource }): React.JSX.Element {
  const Icon = source.kind === 'vault' ? Globe : source.kind === 'folder' ? Folder : Hash
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />
}

/**
 * Where the rows come from: the whole vault, a folder or a tag. Changing it
 * drops the saved view, which belonged to the previous source.
 */
function SourcePicker({
  source,
  disabled,
  defaultOpen,
  onChange
}: {
  source: ViewBlockSource | null
  disabled: boolean
  defaultOpen: boolean
  onChange: (source: ViewBlockSource) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const [open, setOpen] = useState(defaultOpen)
  const { folders } = useNoteFoldersQuery({ enabled: open })
  const { tags } = useNoteTagsQuery({ enabled: open })
  const allNotes = t('editor.viewBlock.sourceVault')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid="view-block-source"
          aria-label={t('editor.viewBlock.sourceMenu')}
          className="inline-flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
        >
          {source ? (
            <SourceIcon source={source} />
          ) : (
            <Database className="size-3.5" aria-hidden="true" />
          )}
          <span className="truncate">
            {source ? sourceLabel(source, allNotes) : t('editor.viewBlock.chooseSource')}
          </span>
          {disabled ? null : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem className="gap-2" onSelect={() => onChange({ kind: 'vault' })}>
          <Globe className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{allNotes}</span>
          {source?.kind === 'vault' ? (
            <Check className="ms-auto size-3.5 text-tint" aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <Folder className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t('editor.viewBlock.sourceFolder')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
            {folders.length === 0 ? (
              <DropdownMenuItem disabled>{t('editor.viewBlock.noFolders')}</DropdownMenuItem>
            ) : (
              folders.map((folder) => (
                <DropdownMenuItem
                  key={folder.path}
                  className="gap-2"
                  onSelect={() => onChange({ kind: 'folder', path: folder.path })}
                >
                  <span className="truncate">{folder.path}</span>
                  {source?.kind === 'folder' && source.path === folder.path ? (
                    <Check className="ms-auto size-3.5 text-tint" aria-hidden="true" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <Hash className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t('editor.viewBlock.sourceTag')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
            {tags.length === 0 ? (
              <DropdownMenuItem disabled>{t('editor.viewBlock.noTags')}</DropdownMenuItem>
            ) : (
              tags.map((tag) => (
                <DropdownMenuItem
                  key={tag.tag}
                  className="gap-2"
                  onSelect={() => onChange({ kind: 'tag', tag: tag.tag })}
                >
                  <span className="truncate">#{tag.tag}</span>
                  {source?.kind === 'tag' && source.tag.toLowerCase() === tag.tag.toLowerCase() ? (
                    <Check className="ms-auto size-3.5 text-tint" aria-hidden="true" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type DefinitionPatch = Partial<Record<keyof ViewBlockDefinition, unknown>>

interface ViewBlockBodyProps {
  definition: ViewBlockDefinition
  editable: boolean
  onChange: (patch: DefinitionPatch) => void
  sourceMenuOpen: boolean
}

type FolderViewResult = ReturnType<typeof useFolderView>

/** The source's rows, narrowed by the block's own filters, order and limit. */
function applyDefinition(
  notes: NoteWithProperties[],
  definition: ViewBlockDefinition,
  activeView: FolderViewResult['activeView']
): NoteWithProperties[] {
  let matched = notes
  const filters = definition.filters as FilterExpression | undefined
  if (filters && !isFilterEmpty(filters)) {
    try {
      matched = matched.filter((note) => evaluateFilter(note, filters))
    } catch (err) {
      log.warn('View block filter failed; showing unfiltered rows', err)
    }
  }
  const sorted = sortNotes(matched, definition.order ?? activeView?.order)
  const limit = definition.limit ?? activeView?.limit
  return limit ? sorted.slice(0, limit) : sorted
}

/** The folder or tag page this block reads, on the same saved view. */
function sourcePageItem(definition: ViewBlockDefinition, vaultTitle: string): SidebarItem {
  const viewState = definition.view ? { folderViewName: definition.view } : undefined
  if (definition.source.kind === 'tag') {
    const { tag, andTags } = definition.source
    return {
      type: 'tag',
      title: tag,
      path: '/tags/' + tag,
      entityId: tag,
      viewState: { ...viewState, ...(andTags?.length ? { tagAndTags: andTags } : {}) }
    }
  }
  const path = definition.source.kind === 'folder' ? definition.source.path : ''
  return {
    type: 'folder',
    title: sourceLabel(definition.source, vaultTitle),
    icon: 'folder',
    path: `/folder/${encodeURIComponent(path)}`,
    entityId: path,
    viewState
  }
}

/**
 * A saved view on the source. Picking one clears the block's own layout,
 * filters and order: the saved view brings its own, and the overrides would
 * hide that the pick changed anything.
 */
function SavedViewPicker({
  views,
  selected,
  activeName,
  editable,
  onChange
}: {
  views: FolderViewResult['views']
  selected: string | undefined
  activeName: string | undefined
  editable: boolean
  onChange: (patch: DefinitionPatch) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const shown = selected ?? activeName
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!editable}>
        <button
          type="button"
          data-testid="view-block-saved-view"
          aria-label={t('editor.viewBlock.savedView')}
          className="inline-flex h-7 min-w-0 max-w-[160px] items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="truncate">
            {shown ? getViewDisplayName(shown) : t('editor.viewBlock.savedView')}
          </span>
          {editable ? <ChevronDown className="size-3 shrink-0" aria-hidden="true" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {views.map((view) => (
          <DropdownMenuItem
            key={view.name}
            className="gap-2"
            onSelect={() =>
              onChange({ view: view.name, layout: undefined, order: undefined, filters: undefined })
            }
          >
            <span className="truncate">{getViewDisplayName(view.name)}</span>
            {view.name === selected ? (
              <Check className="ms-auto size-3.5 text-tint" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ViewBlockHeader({
  definition,
  editable,
  onChange,
  sourceMenuOpen,
  folderView,
  layout
}: ViewBlockBodyProps & { folderView: FolderViewResult; layout: ViewBlockLayout }) {
  const { t } = useT('notes')
  const { openSidebarItem } = useSidebarNavigation()
  const { views, activeView, availableProperties, builtInColumns } = folderView
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 pb-1.5">
      <SourcePicker
        source={definition.source}
        disabled={!editable}
        defaultOpen={sourceMenuOpen}
        onChange={(source) => onChange({ source, view: undefined })}
      />
      {views.length > 1 || definition.view ? (
        <SavedViewPicker
          views={views}
          selected={definition.view}
          activeName={activeView?.name}
          editable={editable}
          onChange={onChange}
        />
      ) : null}
      <div className="grow" />
      {editable ? (
        <>
          <FilterBuilder
            filters={definition.filters as FilterExpression | undefined}
            availableProperties={availableProperties}
            builtInColumns={builtInColumns}
            onFiltersChange={(filters) =>
              onChange({ filters: filters && !isFilterEmpty(filters) ? filters : undefined })
            }
            className="h-7"
          />
          <LayoutToggle
            value={layout}
            onChange={(next) => onChange({ layout: next })}
            className="h-7 [&>button]:h-6 [&>button]:w-6"
          />
        </>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-muted-foreground"
        onClick={() =>
          openSidebarItem(sourcePageItem(definition, t('editor.viewBlock.sourceVault')))
        }
      >
        <ExternalLink />
        {t('editor.viewBlock.openAsTab')}
      </Button>
    </div>
  )
}

/** The rows in the block's layout, reusing the folder page's own views. */
function ViewBlockRows({
  rows,
  layout,
  order,
  folderView
}: {
  rows: NoteWithProperties[]
  layout: ViewBlockLayout
  order: ViewBlockDefinition['order']
  folderView: FolderViewResult
}): React.JSX.Element {
  const { openSidebarItem } = useSidebarNavigation()
  const { tags: allTags } = useNoteTagsQuery()
  const { activeView, availableProperties, formulasMap } = folderView

  const tagMetaMap = useMemo<TagMetaMap>(() => {
    const map: TagMetaMap = new Map()
    for (const tag of allTags) {
      map.set(tag.tag.toLowerCase(), { color: tag.color, icon: tag.icon ?? null })
    }
    return map
  }, [allTags])

  const propertyTypes = useMemo(() => {
    const map: TablePropertyTypes = {}
    for (const prop of availableProperties) {
      map[prop.name] = prop.type as TablePropertyTypes[string]
    }
    return map
  }, [availableProperties])

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const open = (id: string): void => {
    const row = rowById.get(id)
    if (row) openSidebarItem(sidebarItemForRow(row), undefined)
  }
  const openInBackground = (id: string): void => {
    const row = rowById.get(id)
    if (row) openSidebarItem(sidebarItemForRow(row), { inNewTab: true, inBackground: true })
  }

  if (layout === 'table') {
    return (
      <FolderTableView
        notes={rows}
        columns={activeView?.columns ?? DEFAULT_COLUMNS}
        formulas={formulasMap}
        propertyTypes={propertyTypes}
        initialSorting={order}
        tagMetaMap={tagMetaMap}
        onNoteOpen={open}
        onOpenInNewTab={openInBackground}
        onOpenInBackgroundTab={openInBackground}
        density="compact"
        className="max-h-[360px]"
      />
    )
  }
  if (layout === 'grid') {
    return (
      <FolderGalleryView
        notes={rows}
        tagMetaMap={tagMetaMap}
        onNoteOpen={open}
        onOpenInBackgroundTab={openInBackground}
        className="h-auto max-h-[360px] p-1"
      />
    )
  }
  return (
    <FolderListView
      notes={rows}
      density="compact"
      tagMetaMap={tagMetaMap}
      onNoteOpen={open}
      onOpenInBackgroundTab={openInBackground}
      className="h-auto max-h-[360px]"
    />
  )
}

/**
 * The live list for one definition. Reads through the folder view's own hook,
 * so a view block is exactly as fresh as a folder tab: note, tag and property
 * changes invalidate the same query everywhere (`useFolderViewEvents`).
 */
export function ViewBlockBody(props: ViewBlockBodyProps): React.JSX.Element {
  const { definition } = props
  const { t } = useT('notes')
  const folderView = useFolderView({
    scope: viewBlockScope(definition.source),
    initialViewName: definition.view
  })
  const { views, activeView, notes, unfilteredCount, hasMore, loadMore, isLoading } = folderView

  // A view is a query over the whole source, not over its first page.
  useEffect(() => {
    if (hasMore && unfilteredCount < MAX_ROWS_SCANNED) void loadMore()
  }, [hasMore, unfilteredCount, loadMore])

  const layout: ViewBlockLayout = definition.layout ?? activeView?.type ?? 'list'
  const rows = useMemo(
    () => applyDefinition(notes, definition, activeView),
    [notes, definition, activeView]
  )
  const savedViewMissing =
    !isLoading && definition.view !== undefined && !views.some((v) => v.name === definition.view)

  let body: React.ReactNode
  if (folderView.folderNotFound) {
    body = <ViewBlockNotice body={t('editor.viewBlock.folderMissing')} />
  } else if (folderView.error) {
    body = <ViewBlockNotice body={t('editor.viewBlock.loadFailed')} destructive />
  } else if (isLoading) {
    body = (
      <div className="flex flex-col gap-1.5 py-1" aria-busy="true">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
      </div>
    )
  } else if (rows.length === 0) {
    body = <ViewBlockNotice body={t('editor.viewBlock.empty')} />
  } else {
    body = (
      <ViewBlockRows
        rows={rows}
        layout={layout}
        order={definition.order ?? activeView?.order}
        folderView={folderView}
      />
    )
  }

  return (
    <>
      <ViewBlockHeader {...props} folderView={folderView} layout={layout} />
      {savedViewMissing ? (
        <p className="pb-1 text-xs text-muted-foreground">
          {t('editor.viewBlock.savedViewMissing', { name: definition.view ?? '' })}
        </p>
      ) : null}
      <div
        className="overflow-hidden rounded-lg border border-border"
        data-view-block-layout={layout}
      >
        {body}
      </div>
    </>
  )
}

function ViewBlockNotice({
  body,
  destructive = false
}: {
  body: string
  destructive?: boolean
}): React.JSX.Element {
  return (
    <p
      className={cn('px-3 py-2.5 text-sm', destructive ? 'text-destructive' : 'text-text-tertiary')}
    >
      {body}
    </p>
  )
}

/**
 * The frame is not the node's content, but the node is a selectable
 * textblock: ProseMirror answers a press anywhere in it by putting the caret
 * in the (hidden) definition, where the next keystroke would edit JSON the
 * reader cannot see. ProseMirror skips an event whose default is prevented
 * (`eventBelongsToView`), so the frame claims its presses that way. Not by
 * stopping propagation: React's handlers, the rows' middle-click among them,
 * listen at the root and would never see the press. Native and on the frame,
 * so it runs before ProseMirror's listener on the editor root.
 */
function useClaimPresses(frameRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const claim = (event: MouseEvent): void => event.preventDefault()
    frame.addEventListener('mousedown', claim)
    return () => frame.removeEventListener('mousedown', claim)
  }, [frameRef])
}

/**
 * The last definition that parsed, so hand-editing the JSON does not blank the
 * list on every half-typed keystroke.
 */
function useLastGoodDefinition(parsed: ParsedViewBlock): ViewBlockDefinition | null {
  const [lastGood, setLastGood] = useState<ViewBlockDefinition | null>(
    parsed.ok ? parsed.definition : null
  )
  const [lastParsed, setLastParsed] = useState(parsed)
  if (lastParsed !== parsed) {
    setLastParsed(parsed)
    if (parsed.ok) setLastGood(parsed.definition)
  }
  return lastGood
}

function problemMessage(parsed: ParsedViewBlock, t: (key: string) => string): string | null {
  if (parsed.ok || parsed.reason === 'empty') return null
  return parsed.reason === 'json'
    ? t('editor.viewBlock.invalidJson')
    : t('editor.viewBlock.invalidShape')
}

export function ViewBlockRenderer({
  block,
  editor,
  contentRef
}: {
  block: ViewBlockNode
  editor: ViewBlockEditor
  contentRef: (node: HTMLElement | null) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const text = viewBlockText(block.content)
  const parsed = useMemo(() => parseViewBlockDefinition(text), [text])
  const caretInside = useCaretInBlock(editor, block.id)
  const editable = editor.isEditable
  const [sourceMenuOpen] = useState(() => freshViewBlocks.has(block.id))
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    freshViewBlocks.delete(block.id)
  }, [block.id])

  useClaimPresses(frameRef)

  const lastGood = useLastGoodDefinition(parsed)

  const write = useCallback(
    (patch: Partial<Record<keyof ViewBlockDefinition, unknown>>) => {
      if (!editor.isEditable) return
      try {
        editor.updateBlock(block.id, { content: updateViewBlockDefinition(parsed.raw, patch) })
      } catch (err) {
        log.error('Failed to update view block definition', err)
      }
    },
    [editor, block.id, parsed]
  )

  // A block whose language was changed out from under a live view (undo, a
  // synced edit) is a plain code block again until the node view is rebuilt.
  if (block.props.language !== VIEW_BLOCK_LANGUAGE) {
    return (
      <pre>
        <code ref={contentRef} />
      </pre>
    )
  }

  const definition = parsed.ok ? parsed.definition : caretInside ? lastGood : null
  const problem = problemMessage(parsed, t)
  const showSource = caretInside || problem !== null

  return (
    <div className="memry-view-block my-1 w-full" data-memry-view="">
      <div ref={frameRef} contentEditable={false} data-marquee-ignore="">
        {definition ? (
          <ViewBlockBody
            definition={definition}
            editable={editable}
            onChange={write}
            sourceMenuOpen={sourceMenuOpen}
          />
        ) : (
          <div className="flex items-center gap-1 pb-1.5">
            <SourcePicker
              source={null}
              disabled={!editable}
              defaultOpen={sourceMenuOpen}
              onChange={(source) => write({ source })}
            />
          </div>
        )}
        {problem ? <ViewBlockNotice body={problem} destructive /> : null}
      </div>
      <div className={cn('memry-view-block-source mt-1.5', !showSource && 'hidden')}>
        <div contentEditable={false} className="pb-1 text-[11px] text-muted-foreground">
          {t('editor.viewBlock.definition')}
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[0.8125rem]">
          <code ref={contentRef} />
        </pre>
      </div>
    </div>
  )
}

/**
 * The spec whose render `codeBlockViews` routes `memry-view` code blocks to
 * (`editor-schema.ts` takes `.implementation.render` from it).
 *
 * The config is the code block's own — same type, same `language` prop — so
 * BlockNote's React wrapper stamps the same `data-content-type` and
 * `data-language` a plain code block gets. Only the render is used; the node,
 * its parse rules and its `toExternalHTML` stay the code block's.
 */
export const createViewBlockSpec = createReactBlockSpec(
  {
    type: 'codeBlock' as const,
    propSchema: {
      language: { default: memryCodeBlockOptions.defaultLanguage ?? 'text' }
    },
    content: 'plain' as const
  },
  {
    render: (props) => (
      <ViewBlockRenderer
        block={props.block as unknown as ViewBlockNode}
        editor={props.editor as unknown as ViewBlockEditor}
        contentRef={props.contentRef}
      />
    )
  }
)

/**
 * `/view`: a view block listing the ten notes touched most recently, with its
 * source menu open so the reader can point it somewhere else at once.
 *
 * The caret is moved past the block. Left inside, the next keystroke would
 * land in the definition's JSON rather than in the note.
 */
export function getViewSlashMenuItem(
  editor: EditorSchema['BlockNoteEditor'],
  labels: { title: string; group: string; subtext: string }
) {
  return {
    title: labels.title,
    onItemClick: () => {
      const inserted = insertOrUpdateBlockForSlashMenu(editor, {
        type: 'codeBlock',
        props: { language: VIEW_BLOCK_LANGUAGE },
        content: serializeViewBlockDefinition({ ...STARTER_VIEW_DEFINITION })
      })
      freshViewBlocks.add(inserted.id)
      const next = editor.getNextBlock(inserted.id)
      const nextIsEmptyParagraph =
        next?.type === 'paragraph' && Array.isArray(next.content) && next.content.length === 0
      const target =
        next && nextIsEmptyParagraph
          ? next
          : editor.insertBlocks([{ type: 'paragraph' }], inserted.id, 'after')[0]
      editor.setTextCursorPosition(target, 'start')
    },
    aliases: ['view', 'query', 'base', 'database', 'saved view', 'embed view'],
    group: labels.group,
    subtext: labels.subtext
  }
}
