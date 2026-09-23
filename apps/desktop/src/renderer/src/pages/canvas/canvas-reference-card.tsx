/**
 * Bodies for the cards that reference an item with its own surface: a project
 * and a filed file. Neither is edited inside the card, so the idle card, the
 * level-of-detail summary and the add-card picker all draw from this one file.
 *
 * Everything shown is read live from the entity (use-canvas-entities.ts); the
 * scene only stores the id.
 */

import React, { useState } from 'react'
import { getExtension } from '@memry/shared/file-types'
import { useT } from '@memry/i18n/renderer'
import { AlertCircle, FileType2, Image, Music, Video } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { toMemryFileUrl } from '@/lib/memry-file-url'
import type { FileMetadata } from '@/services/notes-service'
import type { CanvasEntityState } from './use-canvas-entities'

type ProjectState = Extract<CanvasEntityState, { status: 'ready'; kind: 'project' }>
type FileState = Extract<CanvasEntityState, { status: 'ready'; kind: 'file' }>
type FileKind = FileMetadata['fileType']

/** The sidebar's file-type icons and tints (notes-tree-utils.tsx), so a file reads the same here. */
const FILE_ICONS: Record<FileKind, { Icon: AppIcon; tint: string }> = {
  pdf: { Icon: FileType2, tint: 'text-red-500' },
  image: { Icon: Image, tint: 'text-blue-500' },
  audio: { Icon: Music, tint: 'text-green-500' },
  video: { Icon: Video, tint: 'text-purple-500' }
}

export function FileKindIcon({
  fileType,
  className
}: {
  fileType: FileKind
  className?: string
}): React.JSX.Element {
  const { Icon, tint } = FILE_ICONS[fileType]
  return <Icon className={cn('shrink-0', tint, className)} aria-hidden="true" />
}

/** The folder a vault-relative path sits in, or '' at the vault root. */
export function fileFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function ProjectCardView({ state }: { state: ProjectState }): React.JSX.Element {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const percent =
    state.taskCount === 0 ? 0 : Math.round((state.completedCount / state.taskCount) * 100)

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-1.5">
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: state.color }}
          aria-hidden="true"
        />
        <h3 className="truncate text-[13px] font-semibold text-foreground">
          {state.title || tCommon('canvas.card.untitled')}
        </h3>
      </div>
      {state.description ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-snug text-text-secondary">
          {state.description}
        </p>
      ) : null}
      <div className="mt-auto flex flex-col gap-1 text-[11px]">
        {state.taskCount === 0 ? (
          <span className="text-text-tertiary">{tCommon('home.widget.projectNoTasks')}</span>
        ) : (
          <>
            <div className="flex items-baseline justify-between text-text-tertiary">
              <span>
                {t('projectHub.rail.doneOf', {
                  done: state.completedCount,
                  total: state.taskCount
                })}
              </span>
              <span className="tabular-nums">{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('projectHub.rail.progress')}
              className="h-1 w-full overflow-hidden rounded-full bg-surface"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
        {state.overdueCount > 0 ? (
          <span className="flex items-center gap-1 text-destructive">
            <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
            {t('projectHub.rail.overdue')}
            <span className="tabular-nums">{state.overdueCount}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Images and videos show their own first frame; a PDF or audio file shows its
 * type icon, as the sidebar does. `media` is false in the level-of-detail
 * fallback, where loading a picture per card is exactly the cost it avoids.
 */
function FilePreview({ state, media }: { state: FileState; media: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const src = toMemryFileUrl(state.absolutePath)
  const showMedia = media && !failed

  if (showMedia && state.fileType === 'image') {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        onError={() => setFailed(true)}
        className="min-h-0 w-full flex-1 bg-muted object-cover"
      />
    )
  }
  if (showMedia && state.fileType === 'video') {
    return (
      <video
        src={src}
        preload="metadata"
        muted
        onError={() => setFailed(true)}
        className="min-h-0 w-full flex-1 bg-muted object-cover"
      />
    )
  }
  return (
    <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-muted/60">
      <FileKindIcon fileType={state.fileType} className="size-8" />
    </div>
  )
}

/** The full-fidelity body of a project or file card; nothing while it loads or dangles. */
export function ReferenceCardBody({
  state
}: {
  state: CanvasEntityState | undefined
}): React.JSX.Element | null {
  if (state?.status !== 'ready') return null
  if (state.kind === 'project') return <ProjectCardView state={state} />
  if (state.kind === 'file') return <FileCardView state={state} media />
  return null
}

export function FileCardView({
  state,
  media
}: {
  state: FileState
  media: boolean
}): React.JSX.Element {
  const { t } = useT('common')
  const extension = getExtension(state.path).toUpperCase()
  const folder = fileFolder(state.path)

  return (
    <div className="flex h-full flex-col">
      <FilePreview key={state.absolutePath} state={state} media={media} />
      <div className="flex shrink-0 flex-col gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <FileKindIcon fileType={state.fileType} className="size-3.5" />
          <h3 className="truncate text-[13px] font-semibold text-foreground">
            {state.title || t('canvas.card.untitled')}
          </h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
          {extension ? <span className="shrink-0">{extension}</span> : null}
          {state.fileSize ? (
            <span className="shrink-0 tabular-nums">{formatBytes(state.fileSize)}</span>
          ) : null}
          {folder ? <span className="truncate">{folder}</span> : null}
        </div>
      </div>
    </div>
  )
}
