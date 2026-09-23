/**
 * The value half of `extract-blocks.ts`: how a mark's attributes and a
 * block's props are spelled, so both ports print them identically.
 *
 * Split out along the seam between walking the tree and formatting what it
 * finds; `extract-blocks.ts` owns the walk.
 */

/** The attribute BlockNote stores a string-valued style's value under. */
export const STRING_VALUE_ATTR = 'stringValue'

/**
 * A value as `yrs`'s `Any::Display` renders it, which is what the Rust port's
 * `props_of` records.
 *
 * Not JSON: a string is raw and unquoted, an array is `[a, b]` with a comma
 * and a space, a map is `{k: v}`. Reproduced here rather than improved on,
 * because the two ports must agree and the Rust side is pinned by the vectors.
 */
export function anyDisplay(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return numberDisplay(value)
  if (Array.isArray(value)) return `[${value.map(anyDisplay).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, inner]) => `${key}: ${anyDisplay(inner)}`
    )
    return `{${entries.join(', ')}}`
  }
  return String(value)
}

/** Rust prints a whole `f64` without a fractional part, and so does JS. */
export function numberDisplay(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : Number.isNaN(value) ? 'NaN' : '-inf'
  return String(value)
}

/**
 * One value as `scalar` renders it in the Rust port: a string raw, a structure
 * as JSON, everything else as its display form.
 */
export function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return canonicalJson(value)
  return anyDisplay(value)
}

/** `serde_json`'s output for a map or an array, with map keys in insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * y-prosemirror keys a mark that does not exclude itself as
 * `name--<8 character hash>`, and strips the suffix again when reading.
 */
export function markName(attribute: string): string {
  const match = /^(.+)--([A-Za-z0-9+/=]{8})$/.exec(attribute)
  return match ? match[1] : attribute
}

/** One mark's attribute value, flattened. See the Rust port's `flatten_mark_attrs`. */
export function flattenMarkAttrs(mark: string, value: unknown, out: Record<string, string>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return
    if (entries.length === 1 && entries[0][0] === STRING_VALUE_ATTR) {
      out[mark] = scalar(entries[0][1])
      return
    }
    for (const [key, inner] of entries) {
      // ProseMirror spells "this attribute is not set" as null, and a link's
      // unused `target` and `rel` arrive that way on every link.
      if (inner === null || inner === undefined) continue
      out[`${mark}.${key}`] = scalar(inner)
    }
    return
  }
  out[mark] = scalar(value)
}

/** A link mark's address, which is an attribute rather than the mark's value. */
export function linkTarget(marks: string[], attrs: Record<string, string>): string | null {
  for (const mark of marks) {
    if (mark !== 'link' && mark !== 'href') continue
    const value = attrs[`${mark}.href`] ?? attrs[mark]
    if (value !== undefined) return value
  }
  return null
}
