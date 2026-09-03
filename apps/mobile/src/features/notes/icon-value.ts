/**
 * Icon values, as desktop writes them.
 *
 * One text column carries three different things — a literal emoji, a named
 * glyph (`icon:<name>`), or a user-uploaded image (`custom:<id>`) — so every
 * surface that draws an icon has to parse before it renders. Printing the raw
 * value, which is what the tree did, puts `icon:folder-01` on the row.
 *
 * The desktop half is `note/note-title/emoji-icon-utils.ts`; the prefixes are a
 * cross-device data format, so they are re-declared here rather than imported
 * from a renderer module this app cannot load.
 */

export const ICON_PREFIX = 'icon:'
export const CUSTOM_ICON_PREFIX = 'custom:'

export type ResolvedIcon = { kind: 'emoji'; text: string } | { kind: 'image'; uri: string }

/**
 * `null` means "draw the row's own glyph" — not an error. An icon can be absent,
 * point at a custom icon whose bytes have not synced yet, or name a glyph this
 * app has no drawing for; a row falls back in all three cases.
 */
export function resolveIcon(
  value: string | null | undefined,
  customIcons: ReadonlyMap<string, string>
): ResolvedIcon | null {
  if (!value) return null
  // Desktop's named glyphs are HugeIcons and this app draws lucide, so there is
  // nothing to look the name up in. Falling back to the type glyph is the whole
  // fix; a hand-written name mapping would be a guess per icon.
  if (value.startsWith(ICON_PREFIX)) return null
  if (value.startsWith(CUSTOM_ICON_PREFIX)) {
    const uri = customIcons.get(value.slice(CUSTOM_ICON_PREFIX.length))
    return uri === undefined ? null : { kind: 'image', uri }
  }
  return { kind: 'emoji', text: value }
}

/**
 * `| undefined` is deliberate for the same reason `FILE_TYPE_BY_EXTENSION` in
 * `tree.ts` carries it: without `noUncheckedIndexedAccess` the `??` below reads
 * as dead code to the compiler while still being the live path at runtime.
 */
const MIME_BY_EXT: Record<string, string | undefined> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/**
 * A `custom_icon` row's bytes as something an `<Image>` can take.
 *
 * Main normalizes every upload to PNG except SVG, which it stores verbatim, so
 * an unknown extension is a payload from a build that widened the set — PNG is
 * the safer guess than refusing to draw it.
 */
export function customIconDataUri(ext: unknown, data: string): string {
  const key = typeof ext === 'string' ? ext.toLowerCase() : ''
  return `data:${MIME_BY_EXT[key] ?? 'image/png'};base64,${data}`
}
