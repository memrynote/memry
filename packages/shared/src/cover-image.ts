export const COVER_FRONTMATTER_KEY = 'cover'
export const COVER_FOCUS_FRONTMATTER_KEY = 'coverFocus'
export const COVER_CREDIT_FRONTMATTER_KEY = 'coverCredit'
export const COVER_CREDIT_URL_FRONTMATTER_KEY = 'coverCreditUrl'

const COVER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']

const WASH_PREFIX = 'wash:'

/** A matte pigment pair painted as a diagonal gradient when no photo is set. */
export interface CoverWash {
  id: string
  from: string
  to: string
}

export const COVER_WASHES = [
  { id: 'sage', from: '#dfe7e3', to: '#b9ccc4' },
  { id: 'sand', from: '#efe9dd', to: '#d6c9b0' },
  { id: 'lilac', from: '#e4e2ea', to: '#c2bdd1' },
  { id: 'clay', from: '#ece3e1', to: '#d2b8b2' },
  { id: 'ash', from: '#e8e6df', to: '#bfbcb2' },
  { id: 'fog', from: '#d9e0e6', to: '#9fb0bd' },
  { id: 'wheat', from: '#f0ece2', to: '#c9b98f' },
  { id: 'moss', from: '#dbe3da', to: '#a3b59c' },
  { id: 'slate', from: '#2f3436', to: '#5b6467' },
  { id: 'bark', from: '#e9e4de', to: '#a89b8c' },
  { id: 'mist', from: '#e6e9ea', to: '#b4c2c4' },
  { id: 'plum', from: '#dcd3e0', to: '#84769a' }
] as const satisfies readonly CoverWash[]

export type CoverWashId = (typeof COVER_WASHES)[number]['id']

const WASH_BY_ID = new Map<string, CoverWash>(COVER_WASHES.map((wash) => [wash.id, wash]))

/**
 * A parsed `cover` value. Parsed once at the boundary so no component has to
 * re-decide what a raw frontmatter string means.
 */
export type CoverValue = { kind: 'image'; ref: string } | { kind: 'wash'; id: CoverWashId }

export function isCoverWashId(value: unknown): value is CoverWashId {
  return typeof value === 'string' && WASH_BY_ID.has(value)
}

function isImageRef(value: string): boolean {
  if (value.length === 0) return false
  if (/^https?:\/\//i.test(value)) return true
  const pathPortion = value.split(/[?#]/, 1)[0].toLowerCase()
  return COVER_IMAGE_EXTENSIONS.some((extension) => pathPortion.endsWith(extension))
}

/**
 * Read a raw `cover` frontmatter value.
 *
 * A vault may already hold `cover: Hardback` on a book note, written long before
 * this key meant anything. Claiming the key unconditionally would drop that row
 * out of the user's properties list and then delete it from the file on the next
 * property edit, so the value decides: a known wash id, an http(s) URL or an
 * image path is a cover, anything else stays a plain text property.
 */
export function parseCoverValue(value: unknown): CoverValue | null {
  if (typeof value !== 'string') return null
  if (value.startsWith(WASH_PREFIX)) {
    const id = value.slice(WASH_PREFIX.length)
    return isCoverWashId(id) ? { kind: 'wash', id } : null
  }
  return isImageRef(value) ? { kind: 'image', ref: value } : null
}

/** Whether a `cover` value is a cover rather than prose. */
export function isCoverValue(value: unknown): value is string {
  return parseCoverValue(value) !== null
}

/** The frontmatter string for a wash: `wash:sage`. */
export function coverWashRef(id: CoverWashId): string {
  return `${WASH_PREFIX}${id}`
}

export function coverWashGradient(id: CoverWashId): string {
  const wash = WASH_BY_ID.get(id) ?? COVER_WASHES[0]
  return `linear-gradient(135deg, ${wash.from} 0%, ${wash.to} 100%)`
}

/**
 * A wash picked from a note id, so a note whose image is missing keeps painting
 * the same colour on every device and every reopen instead of flickering.
 */
export function coverWashForSeed(seed: string): CoverWashId {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  return COVER_WASHES[hash % COVER_WASHES.length].id
}

export const DEFAULT_COVER_FOCUS = 50

/** Clamp a vertical focus point onto 0..100, rounded to a whole percent. */
export function clampCoverFocus(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COVER_FOCUS
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * Value gate for `coverFocus`. A pre-existing `coverFocus: "top of the shelf"`
 * stays a user property; only a real 0..100 number is ours.
 */
export function isCoverFocusValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

/** Value gate for `coverCredit`: a non-empty string. */
export function isCoverCreditValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Value gate for `coverCreditUrl`: an http(s) URL. */
export function isCoverCreditUrlValue(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

/** Read `coverFocus` off frontmatter, falling back to the centre. */
export function parseCoverFocus(value: unknown): number {
  return isCoverFocusValue(value) ? clampCoverFocus(value) : DEFAULT_COVER_FOCUS
}
