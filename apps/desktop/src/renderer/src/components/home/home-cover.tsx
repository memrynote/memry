/**
 * A Home board's banner (#3384): the note cover band and picker, owned by the
 * board.
 *
 * Main stores every picked image in `.memry/home-covers/<boardId>/` and saves
 * the board in the same call, so an image source here only reports the ref;
 * a wash is the one choice saved from `onApply`. Main's `home-pages:updated`
 * broadcast refetches the boards, which is how every change reaches the band.
 *
 * @module components/home/home-cover
 */

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type {
  HomePage,
  HomePageCoverFailure,
  HomePageCoverSource
} from '@memry/contracts/home-page-api'
import type { DownloadAttachmentFromUrlFailure } from '@memry/contracts/notes-api'
import type { UnsplashDownloadFailureReason } from '@memry/contracts/unsplash-api'
import { useT } from '@memry/i18n/renderer'
import {
  DEFAULT_COVER_FRAMING,
  parseCoverValue,
  type CoverFraming
} from '@memry/shared/cover-image'
import { NoteCover } from '@/components/note/note-cover'
import {
  CoverPickerDialog,
  coverPickerAnchorFrom,
  type CoverPickerAnchor
} from '@/components/note/cover-picker-dialog'
import type { CoverImageTarget } from '@/components/note/cover-image-target'
import { useVault } from '@/hooks/use-vault'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { toMemryFileUrl } from '@/lib/memry-file-url'

const logger = createLogger('HomeCover')

const LINK_FAILURES = new Set<string>([
  'not-an-image',
  'too-large',
  'offline',
  'failed',
  'write-failed'
] satisfies DownloadAttachmentFromUrlFailure[])

const UNSPLASH_FAILURES = new Set<string>([
  'not-configured',
  'offline',
  'rate-limited',
  'failed',
  'write-failed'
] satisfies UnsplashDownloadFailureReason[])

/** Main's failure set spans every source; each picker tab names only its own. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter is the caller's assertion about data crossing an untyped boundary (JSON, IPC, mock lookup) or a type-level equality check
function narrowFailure<T extends string>(reason: HomePageCoverFailure, known: Set<string>): T {
  return (known.has(reason) ? reason : 'failed') as T
}

/**
 * A failure throws an empty `Error`, so the picker shows its own translated
 * fallback for the tab, as it does for a note.
 */
function boardCoverImageTarget(boardId: string): CoverImageTarget {
  const set = (source: HomePageCoverSource) => window.api.homePages.setCover(boardId, source)
  const refOf = (page: HomePage) => page.cover?.ref ?? ''
  return {
    key: boardId,
    upload: async (file) => {
      const result = await set({
        kind: 'upload',
        filename: file.name,
        data: await file.arrayBuffer()
      })
      if (!result.ok) throw new Error()
      return refOf(result.page)
    },
    fromVaultImage: async (entry) => {
      const result = await set({
        kind: 'vaultFile',
        ownerNoteId: entry.ownerNoteId,
        filename: entry.filename
      })
      if (!result.ok) throw new Error()
      return refOf(result.page)
    },
    fromUrl: async (url) => {
      const result = await set({ kind: 'url', url })
      return result.ok
        ? { ok: true, ref: refOf(result.page) }
        : { ok: false, reason: narrowFailure(result.reason, LINK_FAILURES) }
    },
    fromUnsplash: async (photo) => {
      const result = await set({ kind: 'unsplash', photo })
      return result.ok
        ? {
            ok: true,
            ref: refOf(result.page),
            credit: { name: photo.authorName, url: photo.htmlUrl }
          }
        : { ok: false, reason: narrowFailure(result.reason, UNSPLASH_FAILURES) }
    }
  }
}

export interface HomeCoverProps {
  board: HomePage
  pickerAnchor: CoverPickerAnchor | null
  onPickerAnchorChange: (anchor: CoverPickerAnchor | null) => void
}

export function HomeCover({ board, pickerAnchor, onPickerAnchorChange }: HomeCoverProps) {
  const { t } = useT('notes')
  const { vaultPath } = useVault()
  const [repositioning, setRepositioning] = useState(false)
  // Bumped once a missing file is fetched, so the band retries the same URL.
  const [loadAttempt, setLoadAttempt] = useState(0)

  const target = useMemo(() => boardCoverImageTarget(board.id), [board.id])

  const stored = board.cover
  const cover = stored ? parseCoverValue(stored.ref) : null
  const framing: CoverFraming = {
    focusX: stored?.focusX ?? DEFAULT_COVER_FRAMING.focusX,
    focusY: stored?.focus ?? DEFAULT_COVER_FRAMING.focusY,
    zoom: stored?.zoom ?? DEFAULT_COVER_FRAMING.zoom,
    height: stored?.height ?? DEFAULT_COVER_FRAMING.height
  }
  const src =
    cover?.kind !== 'image'
      ? null
      : /^https?:\/\//i.test(cover.ref)
        ? cover.ref
        : vaultPath
          ? toMemryFileUrl(`${vaultPath}/${cover.ref}`)
          : null

  const fail = useCallback(
    (message: string, err: unknown) => {
      logger.error(message, err)
      toast.error(extractErrorMessage(err, t('cover.setFailed')))
    },
    [t]
  )

  // A cover synced from another device names a file this one may not have yet.
  const materialize = useCallback(() => {
    if (!stored?.attachmentId) return
    window.api.homePages
      .materializeCover(board.id)
      .then(() => {
        setLoadAttempt((n) => n + 1)
      })
      .catch((err: unknown) => {
        logger.warn('Board cover download failed', err)
      })
  }, [board.id, stored?.attachmentId])

  return (
    <>
      {cover && (
        <NoteCover
          key={`${src ?? ''}#${loadAttempt}`}
          cover={cover}
          src={src}
          washSeed={board.id}
          onImageError={loadAttempt === 0 ? materialize : undefined}
          framing={framing}
          credit={stored?.credit ?? null}
          creditUrl={stored?.creditUrl ?? null}
          onChange={(event) => {
            onPickerAnchorChange(coverPickerAnchorFrom(event))
          }}
          onRemove={() => {
            window.api.homePages.removeCover(board.id).catch((err: unknown) => {
              fail('Failed to remove the board cover', err)
            })
          }}
          onFramingChange={(changes) => {
            window.api.homePages.setCoverFraming(board.id, changes).catch((err: unknown) => {
              fail('Failed to save the board cover position', err)
            })
          }}
          repositioning={repositioning}
          onRepositioningChange={setRepositioning}
        />
      )}
      <CoverPickerDialog
        anchor={pickerAnchor}
        onOpenChange={(open) => {
          if (!open) onPickerAnchorChange(null)
        }}
        target={target}
        onApply={(value, { reposition }) => {
          // Image sources were saved by main already; see the module comment.
          if (value.kind === 'wash') {
            window.api.homePages
              .setCover(board.id, { kind: 'wash', id: value.id })
              .then((result) => {
                if (!result.ok) throw new Error()
              })
              .catch((err: unknown) => {
                fail('Failed to set the board cover', err)
              })
          }
          setRepositioning(reposition)
        }}
      />
    </>
  )
}
