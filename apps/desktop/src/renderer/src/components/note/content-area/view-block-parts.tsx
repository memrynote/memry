/**
 * The view block's header pieces and notices, shared by the list body in
 * `view-block.tsx` and the journal chart body in `view-block-chart.tsx`.
 */
import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ViewBlockDefinition, ViewBlockSource } from '@memry/shared/view-block'
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
import type { SidebarItem } from '@/contexts/tabs/types'
import { useNoteFoldersQuery, useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import {
  BookOpen,
  Check,
  ChevronDown,
  Database,
  ExternalLink,
  Folder,
  Globe,
  Hash
} from '@/lib/icons'
import { cn } from '@/lib/utils'

export function sourceLabel(
  source: ViewBlockSource,
  allNotesLabel: string,
  journalLabel = ''
): string {
  if (source.kind === 'vault') return allNotesLabel
  if (source.kind === 'journal') return journalLabel
  if (source.kind === 'folder') {
    return source.path.split('/').filter(Boolean).pop() ?? (source.path || allNotesLabel)
  }
  return [source.tag, ...(source.andTags ?? [])].map((tag) => `#${tag}`).join(' + ')
}

export function SourceIcon({ source }: { source: ViewBlockSource }): React.JSX.Element {
  const Icon =
    source.kind === 'vault'
      ? Globe
      : source.kind === 'journal'
        ? BookOpen
        : source.kind === 'folder'
          ? Folder
          : Hash
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />
}

/**
 * Where the rows come from: the whole vault, a folder or a tag. Changing it
 * drops the saved view, which belonged to the previous source.
 */
export function SourcePicker({
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
            {source
              ? sourceLabel(source, allNotes, t('editor.chart.sourceJournal'))
              : t('editor.viewBlock.chooseSource')}
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
        <DropdownMenuItem className="gap-2" onSelect={() => onChange({ kind: 'journal' })}>
          <BookOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{t('editor.chart.sourceJournal')}</span>
          {source?.kind === 'journal' ? (
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

export type DefinitionPatch = Partial<Record<keyof ViewBlockDefinition, unknown>>

export interface ViewBlockBodyProps {
  definition: ViewBlockDefinition
  editable: boolean
  onChange: (patch: DefinitionPatch) => void
  sourceMenuOpen: boolean
  chartSettingsOpen: boolean
}

/** The journal page, on `date` when given. */
export function journalPageItem(title: string, date?: string): SidebarItem {
  return {
    type: 'journal',
    title,
    icon: 'book-open',
    path: '/journal',
    ...(date ? { viewState: { date } } : {})
  }
}

/** The folder or tag page this block reads, on the same saved view. */
export function sourcePageItem(
  definition: ViewBlockDefinition,
  vaultTitle: string,
  journalTitle: string
): SidebarItem {
  if (definition.source.kind === 'journal') return journalPageItem(journalTitle)
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

/** Picking the journal makes the block a chart: the journal has no list here. */
export function sourcePatch(source: ViewBlockSource): DefinitionPatch {
  return source.kind === 'journal'
    ? { source, view: undefined, layout: 'chart' }
    : { source, view: undefined }
}

/** Opens the source's own page: the folder, the tag, or the journal. */
export function OpenSourceButton({
  definition
}: {
  definition: ViewBlockDefinition
}): React.JSX.Element {
  const { t } = useT('notes')
  const { openSidebarItem } = useSidebarNavigation()
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-muted-foreground"
      onClick={() =>
        openSidebarItem(
          sourcePageItem(
            definition,
            t('editor.viewBlock.sourceVault'),
            t('editor.chart.sourceJournal')
          )
        )
      }
    >
      <ExternalLink />
      {t('editor.viewBlock.openAsTab')}
    </Button>
  )
}

export function ViewBlockNotice({
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

export function ViewBlockSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 py-1" aria-busy="true">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-5 w-3/5" />
    </div>
  )
}
