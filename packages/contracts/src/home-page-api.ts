import { z } from 'zod'

import { HomePagesChannels } from './ipc-channels'
import { HomePageCoverSyncSchema } from './sync-payloads'
import { UnsplashPhotoSchema, type UnsplashDownloadFailureReason } from './unsplash-api'
import type { DownloadAttachmentFromUrlFailure } from './notes-api'
export { HomePagesChannels }

export const WidgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  // Free-form grid placement (react-grid-layout units). x/y = top-left cell, w/h = span.
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: z.record(z.string(), z.unknown()).default({})
})
export type WidgetInstance = z.infer<typeof WidgetInstanceSchema>

export const HomePageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0),
  widgets: z.array(WidgetInstanceSchema),
  cover: HomePageCoverSyncSchema.optional()
})
export type HomePage = z.infer<typeof HomePageSchema>

export const HomePageCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0).default(0),
  widgets: z.array(WidgetInstanceSchema).default([])
})

export const HomePageUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  position: z.number().int().min(0).optional(),
  widgets: z.array(WidgetInstanceSchema).optional()
})

export const HomePageReorderSchema = z.object({
  ids: z.array(z.string().min(1))
})

/**
 * Where a board's new cover comes from: the same sources a note cover offers.
 * Every image source is copied into `.memry/home-covers/<boardId>/`, so the
 * board owns its bytes and never depends on a note's attachment.
 */
export const HomePageCoverSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wash'), id: z.string().min(1) }),
  z.object({
    kind: z.literal('upload'),
    filename: z.string().min(1),
    data: z.instanceof(ArrayBuffer)
  }),
  z.object({ kind: z.literal('url'), url: z.string().url() }),
  z.object({ kind: z.literal('unsplash'), photo: UnsplashPhotoSchema }),
  z.object({
    kind: z.literal('vaultFile'),
    ownerNoteId: z.string().min(1),
    filename: z.string().min(1)
  })
])
export type HomePageCoverSource = z.infer<typeof HomePageCoverSourceSchema>

export const HomePageSetCoverSchema = z.object({
  id: z.string().min(1),
  source: HomePageCoverSourceSchema
})

export type HomePageCoverFailure = UnsplashDownloadFailureReason | DownloadAttachmentFromUrlFailure

export type HomePageSetCoverResult =
  | { ok: true; page: HomePage }
  | { ok: false; reason: HomePageCoverFailure }

/** Only the framing fields that changed; see `CoverFraming` in `@memry/shared/cover-image`. */
export const HomePageSetCoverFramingSchema = z.object({
  id: z.string().min(1),
  changes: z
    .object({
      focusX: z.number().min(0).max(100),
      focusY: z.number().min(0).max(100),
      zoom: z.number().min(1).max(3),
      height: z.number().min(120).max(480)
    })
    .partial()
})
