/**
 * An image block's crop (#3170), carried in the block's `name`.
 *
 * Cropping never touches the attachment: the full picture stays on disk, and
 * the crop is a display rectangle over it, in percent of the natural image.
 *
 * It rides in `name` as a `|crop=x,y,w,h` suffix, so it reaches the vault file
 * through the alt text the width already uses: `![shot.png|crop=10,5,80,60|320](…)`.
 * The suffix sits BEFORE the width so an older build still claims the width,
 * keeps `shot.png|crop=…` as the image's name, renders the whole picture, and
 * writes the same bytes back. A new prop would not do that: an older build's
 * schema has no slot for it, and y-prosemirror drops attributes a schema does
 * not declare, so the crop would vanish the first time that build touched the
 * block. `name` is a field every build already carries verbatim.
 */

export interface ImageCrop {
  /** Left edge, percent of the natural width. */
  x: number
  /** Top edge, percent of the natural height. */
  y: number
  /** Visible width, percent of the natural width. */
  w: number
  /** Visible height, percent of the natural height. */
  h: number
}

const CROP_SUFFIX = /^(.*)\|crop=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/

const round = (value: number): number => Math.round(value * 10) / 10

/** A rectangle that shows a real part of the picture, or null. */
export function normalizeImageCrop(crop: ImageCrop): ImageCrop | null {
  const x = round(Math.min(Math.max(crop.x, 0), 100))
  const y = round(Math.min(Math.max(crop.y, 0), 100))
  const w = round(Math.min(crop.w, 100 - x))
  const h = round(Math.min(crop.h, 100 - y))
  if (!(w >= 1 && h >= 1)) return null
  // The whole picture is no crop at all.
  if (x === 0 && y === 0 && w === 100 && h === 100) return null
  return { x, y, w, h }
}

/** Splits a stored image name into the name a person sees and its crop. */
export function parseImageCrop(stored: string): { name: string; crop: ImageCrop | null } {
  const match = CROP_SUFFIX.exec(stored)
  if (!match) return { name: stored, crop: null }
  const crop = normalizeImageCrop({
    x: Number(match[2]),
    y: Number(match[3]),
    w: Number(match[4]),
    h: Number(match[5])
  })
  // A suffix that describes no real rectangle is left as part of the name, so
  // it round-trips untouched instead of being rewritten.
  return crop ? { name: match[1], crop } : { name: stored, crop: null }
}

/** The stored name for `name` shown with `crop`; null removes the crop. */
export function withImageCrop(name: string, crop: ImageCrop | null): string {
  const base = parseImageCrop(name).name
  const next = crop ? normalizeImageCrop(crop) : null
  return next ? `${base}|crop=${next.x},${next.y},${next.w},${next.h}` : base
}
