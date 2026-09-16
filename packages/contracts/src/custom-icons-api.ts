import { z } from 'zod'

import { CustomIconsChannels } from './ipc-channels'
export { CustomIconsChannels }

/**
 * Image formats accepted for a custom icon.
 *
 * Raster formats are re-encoded to PNG and downscaled by the main process, so
 * `ext` on a stored icon is always `png` or `svg`. SVG keeps its markup, but
 * the main process strips script, event handlers, external references and
 * entity declarations from it before storing.
 */
export const CUSTOM_ICON_INPUT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const
export type CustomIconInputExtension = (typeof CUSTOM_ICON_INPUT_EXTENSIONS)[number]

/**
 * Extensions an icon may carry once stored.
 *
 * Normalization only ever produces these two, but a row can also arrive from a
 * peer, so consumers check membership and skip what they do not recognise
 * instead of trusting `ext` blindly.
 */
export const CUSTOM_ICON_STORED_EXTENSIONS = ['png', 'svg'] as const
export type CustomIconStoredExtension = (typeof CUSTOM_ICON_STORED_EXTENSIONS)[number]

export function isCustomIconStoredExtension(ext: string): ext is CustomIconStoredExtension {
  return (CUSTOM_ICON_STORED_EXTENSIONS as readonly string[]).includes(ext)
}

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
  ext: z.enum(CUSTOM_ICON_STORED_EXTENSIONS),
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

/**
 * Add an icon by downloading it from a URL.
 *
 * The URL is fetched once, in the main process, and only its bytes are kept —
 * nothing about the icon stays remote, so rendering it never touches the
 * network and the record that syncs is the same local-bytes record an upload
 * produces.
 */
export const CustomIconAddFromUrlSchema = z.object({
  url: z.string().min(1).max(2048),
  /** Optional label; the file name in the URL is used when omitted. */
  name: z.string().min(1).max(CUSTOM_ICON_NAME_MAX_LENGTH).optional()
})
export type CustomIconAddFromUrlInput = z.infer<typeof CustomIconAddFromUrlSchema>

export const CustomIconRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(CUSTOM_ICON_NAME_MAX_LENGTH)
})
export type CustomIconRenameInput = z.infer<typeof CustomIconRenameSchema>
