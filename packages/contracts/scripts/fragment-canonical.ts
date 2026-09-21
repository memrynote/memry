/**
 * The canonical serialisation of a `prosemirror` fragment (N101).
 *
 * **Why this exists.** The write-direction vector class has to compare a
 * document `yrs` produced against one `yjs` produced, and it cannot do that by
 * comparing update bytes: a Yjs update encodes `clientID` and per-client
 * clocks, and struct ordering, origin ids and run-length packing are free
 * choices an implementation may make differently while still converging. Two
 * different updates that converge are *both correct*, so a byte comparison
 * would fail on correct ports and catch nothing extra.
 *
 * So the class compares the **resulting document**, and this is the one
 * textual form both ports emit for it. The Rust half is
 * `crates/memry-core/src/crdt/canonical.rs`; the two are held together by the
 * `note-blocks` and `block-edit` classes.
 *
 * ## The format
 *
 * One line per node, depth-first, in document order. The fragment itself is
 * not emitted; its children start at depth 0. An empty document is the empty
 * string, not a newline.
 *
 *     <depth> <kind> <payload>
 *
 * - `depth` is a decimal integer, `0` for a direct child of the fragment.
 * - `kind` is `element` or `text`.
 * - an element's payload is its tag, then one ` name=<json>` per attribute,
 *   **sorted by name**.
 * - a text chunk's payload is the quoted text, then one ` name=<json>` per
 *   mark, **sorted by name**.
 *
 * Sorting is what makes it canonical: a Yjs map's iteration order is not
 * stable across runs or across ports, so an unsorted rendering would differ
 * from itself. Sorting is by UTF-16 code unit in TypeScript and by byte in
 * Rust; those agree for the ASCII attribute names BlockNote uses, and
 * `canonicalAttributeName` rejects anything outside that range rather than
 * letting the two ports disagree silently.
 *
 * ## What it deliberately does not carry
 *
 * Nothing about *how* the document was built: no clocks, no client ids, no
 * tombstones. Two documents that render the same here are the same document as
 * far as any reader is concerned, which is exactly the equivalence the class
 * wants.
 */
import * as Y from 'yjs'

/** The body fragment, chapter 12 §12.3. */
export const CANONICAL_FRAGMENT = 'prosemirror'

/**
 * A quoted, escaped string.
 *
 * Hand-written rather than `JSON.stringify` because the two ports must agree
 * byte for byte and `JSON.stringify` differs from `serde_json` on lone
 * surrogates. Escape exactly: backslash, quote, the four named control
 * characters, and everything else below `0x20` as `\u00xx` with lowercase hex.
 * Every other code point is emitted as its own UTF-8 bytes.
 */
export function canonicalString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    switch (char) {
      case '\\':
        out += '\\\\'
        break
      case '"':
        out += '\\"'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      default:
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char
    }
  }
  return `${out}"`
}

/**
 * One attribute or mark value.
 *
 * A Yjs attribute holds any JSON value: a string for most block props, an
 * object for a mark's `attrs`, an array for a table cell's `colwidth`. Strings
 * go through {@link canonicalString}; everything else is rendered as canonical
 * JSON with object keys sorted, which is what `Any::to_json` produces on the
 * Rust side once its maps are ordered.
 *
 * `undefined` is rendered as `null`: Yjs round-trips a JavaScript `undefined`
 * inside an array to `undefined`, and `yrs` reads the same slot as
 * `Any::Undefined`. Both spell "this column was never resized", and collapsing
 * them here is what keeps a `colwidth` of `[undefined, 180]` from rendering
 * two different ways.
 */
export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return canonicalString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return canonicalNumber(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => compareNames(left, right))
      .map(([key, inner]) => `${canonicalString(key)}:${canonicalValue(inner)}`)
    return `{${entries.join(',')}}`
  }
  return 'null'
}

/**
 * A number, in the one spelling both ports produce.
 *
 * JavaScript and Rust both print the shortest representation that round-trips
 * a double, so they agree on every value a document realistically carries. The
 * two disagree only at the exponent thresholds — JavaScript switches to `1e+21`
 * where Rust writes the digits out — so a value outside the safe integer range
 * is refused rather than rendered into a difference nobody would find. No block
 * prop in the registry is that large; `colwidth` is a pixel count.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`canonical fragment: ${value} is not a finite number`)
  }
  if (Math.abs(value) >= 1e21) {
    throw new Error(`canonical fragment: ${value} is outside the range both ports agree on`)
  }
  return Number.isInteger(value) ? value.toFixed(0) : String(value)
}

/**
 * Attribute and mark names sort by code point, which matches Rust's byte
 * ordering for ASCII and nothing else.
 *
 * A non-ASCII name is refused rather than sorted into a position the other
 * port would not choose. BlockNote has no such name, so this is a guard
 * against a future one arriving unnoticed rather than a live restriction.
 */
function compareNames(left: string, right: string): number {
  for (const name of [left, right]) {
    // eslint-disable-next-line no-control-regex
    if (/[^\u0020-\u007e]/.test(name)) {
      throw new Error(`canonical fragment: attribute name ${JSON.stringify(name)} is not ASCII`)
    }
  }
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * `name=<value>` pairs, sorted, each prefixed with a space.
 *
 * **An attribute holding null or undefined is omitted, and the two ports had
 * to be made to agree on that.** y-prosemirror skips a `null` attribute when
 * it writes, but it happily writes an `undefined` one — a `numberedListItem`
 * carries `start: undefined` on every item. This port dropped the key and the
 * Rust port rendered `start=null`, so one document rendered two ways.
 * Omitting is the agreement: an attribute with no value says nothing a reader
 * can act on, and the block walk still reports it in `props`.
 */
function renderPairs(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, value]) => ` ${name}=${canonicalValue(value)}`)
    .join('')
}

/**
 * y-prosemirror keys a mark that does not exclude itself as
 * `name--<8 character hash>` so two of them can overlap on one run, and strips
 * the suffix again when reading. A canonical form that kept the hash would
 * encode which *other* marks happened to be present, which is not a fact about
 * this run.
 */
const HASHED_MARK = /^(.+)--[A-Za-z0-9+/=]{8}$/

export function canonicalMarkName(attribute: string): string {
  return HASHED_MARK.exec(attribute)?.[1] ?? attribute
}

function lines(node: Y.XmlFragment | Y.XmlElement, depth: number, out: string[]): void {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const chunk of child.toDelta() as Array<{
        insert: unknown
        attributes?: Record<string, unknown>
      }>) {
        if (typeof chunk.insert !== 'string') continue
        const marks = Object.entries(chunk.attributes ?? {}).map(
          ([name, value]) => [canonicalMarkName(name), value] as [string, unknown]
        )
        out.push(`${depth} text ${canonicalString(chunk.insert)}${renderPairs(marks)}`)
      }
      continue
    }
    if (child instanceof Y.XmlElement) {
      const attrs = Object.entries(child.getAttributes()) as Array<[string, unknown]>
      out.push(`${depth} element ${child.nodeName}${renderPairs(attrs)}`)
      lines(child, depth + 1, out)
      continue
    }
    if (child instanceof Y.XmlFragment) {
      // A bare nested fragment carries no node of its own. `extract_text`
      // skips it for the same reason; recording a line for it would invent
      // structure the document does not have.
      lines(child, depth, out)
    }
  }
}

/** The canonical form of one document's body fragment. */
export function canonicalFragment(doc: Y.Doc): string {
  const out: string[] = []
  lines(doc.getXmlFragment(CANONICAL_FRAGMENT), 0, out)
  return out.join('\n')
}
