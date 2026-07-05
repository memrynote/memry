/**
 * Obsidian-style YAML frontmatter emitter.
 *
 * Emits frontmatter in exactly the style Obsidian itself writes so an
 * Obsidian property-edit of a Memry-written file produces no formatting
 * diff. gray-matter (js-yaml 3) remains the parser; this module owns all
 * frontmatter output.
 *
 * @module vault/frontmatter-emit
 */

import { dump, load, CORE_SCHEMA, type DumpOptions } from 'js-yaml'

const DUMP_OPTIONS: DumpOptions = {
  schema: CORE_SCHEMA, // no YAML 1.1 timestamp resolver — else js-yaml
  //                      quotes the string '2026-07-05' to keep it a string
  indent: 2,
  noArrayIndent: false, // lists indent 2 under the key: `tags:\n  - a`
  flowLevel: -1, //        block style everywhere, never `[a, b]`
  quotingType: '"', //     Obsidian quotes with double quotes
  forceQuotes: false, //   ...and only when syntactically required
  lineWidth: -1, //        default 80 folds long scalars into multi-line
  //                       plain style => ghost diffs on every long value
  noRefs: true, //         never emit anchors/aliases
  noCompatMode: true, //   don't quote YAML 1.1-isms (`yes`, `on`)
  styles: { '!!null': 'empty' } // empty property => `key:` like Obsidian
}

/**
 * gray-matter options that parse frontmatter as YAML 1.2 core — Obsidian's
 * semantics: '2026-07-05' and 'yes' stay strings, never Date/boolean.
 * (gray-matter's bundled js-yaml 3 is YAML 1.1: it turns unquoted dates into
 * JS Date objects, which CORE_SCHEMA dump rejects.) Passing options also
 * bypasses gray-matter's content-keyed cache, so no stale 1.1 results leak.
 */
export const OBSIDIAN_MATTER_OPTIONS = {
  engines: {
    yaml: {
      parse: (src: string): object => {
        const data = load(src, { schema: CORE_SCHEMA })
        return data && typeof data === 'object' ? data : {}
      }
    }
  }
}

/**
 * Date instances (from legacy YAML 1.1 parses or callers passing Dates)
 * normalize to Obsidian's date formats: YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS
 * (no millis, no Z) when there is a time component.
 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19)
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)])
    )
  }
  return value
}

/**
 * Emit a complete `---\n...---\n` frontmatter block from ordered entries.
 *
 * Dumps one key per `dump` call and concatenates: sidesteps JS object
 * integer-key hoisting (a property named `2024` would otherwise jump to
 * the front), so key order is exactly the `entries` order.
 */
export function emitFrontmatterBlock(entries: Array<[string, unknown]>): string {
  const body = entries
    .map(([key, value]) =>
      // js-yaml emits `key: ` (trailing space) for the empty-null style;
      // strings with trailing whitespace always get quoted, so this strip
      // only ever touches that case
      dump({ [key]: normalizeValue(value) }, DUMP_OPTIONS).replace(/[ \t]+$/gm, '')
    )
    .join('')
  return `---\n${body}---\n`
}
