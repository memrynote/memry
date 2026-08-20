import { z } from 'zod'

import { CustomIconsChannels } from './ipc-channels'
export { CustomIconsChannels }

/**
 * Image formats accepted for a custom icon.
 *
 * Raster formats are re-encoded to PNG and downscaled by the main process, so
 * `ext` on a stored icon is always `png` or `svg`. SVG is kept verbatim and is
 * only ever rendered through `<img src>`, which does not execute script.
 */
export const CUSTOM_ICON_INPUT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const
export type CustomIconInputExtension = (typeof CUSTOM_ICON_INPUT_EXTENSIONS)[number]

/** Ceiling on the bytes the renderer may hand over, before normalization. */
export const CUSTOM_ICON_MAX_INPUT_BYTES = 2 * 1024 * 1024

/** Longest edge kept after downscaling a raster icon. */
export const CUSTOM_ICON_MAX_EDGE_PX = 128

export const CUSTOM_ICON_NAME_MAX_LENGTH = 60

export const CustomIconSchema = z.object({
  id: z.string().min(1),
  /** User-visible label, also what the picker's search matches against. */
  name: z.string().min(1),
  /** Stored file extension — `png` or `svg`. */
  ext: z.string().min(1),
  /** Absolute path of the icon file inside `<vault>/.memry/icons`. */
  path: z.string().min(1),
  createdAt: z.string()
})
export type CustomIcon = z.infer<typeof CustomIconSchema>

export const CustomIconAddSchema = z.object({
  name: z.string().min(1).max(CUSTOM_ICON_NAME_MAX_LENGTH),
  ext: z.enum(CUSTOM_ICON_INPUT_EXTENSIONS),
  /** Base64-encoded file bytes (no data-URL prefix). */
  dataBase64: z.string().min(1)
})
export type CustomIconAddInput = z.infer<typeof CustomIconAddSchema>

export const CustomIconRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(CUSTOM_ICON_NAME_MAX_LENGTH)
})
export type CustomIconRenameInput = z.infer<typeof CustomIconRenameSchema>
