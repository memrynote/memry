export const COVER_FRONTMATTER_KEY = 'cover'

const COVER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']

/**
 * Whether a `cover` value is a cover image rather than prose.
 *
 * A vault may already hold `cover: Hardback` on a book note, written long before
 * this key meant anything. Reserving the key unconditionally would drop that row
 * out of the user's properties list and then delete it from the file on the next
 * property edit, so the value decides: an http(s) URL or an image path is a
 * cover, anything else stays a plain text property.
 */
export function isCoverImageValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (/^https?:\/\//i.test(value)) return true
  const pathPortion = value.split(/[?#]/, 1)[0].toLowerCase()
  return COVER_IMAGE_EXTENSIONS.some((extension) => pathPortion.endsWith(extension))
}
