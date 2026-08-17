/**
 * Reading a note's headings out of its markdown.
 *
 * `[[Note#Heading]]` carries the heading's TEXT, and the click side resolves it
 * by comparing that text against BlockNote's plain text of each heading block
 * (`extractHeadings`). So a heading offered by the `[[` autocomplete has to be
 * written in the SAME form the click side will see, or the link the user just
 * picked lands nowhere.
 *
 * That is the whole reason this file exists rather than a one-line regex. The
 * only heading source available at authoring time is the target note's markdown
 * on disk — there is no heading index in either database — and markdown is not
 * plain text: `## **Kalın** başlık` reads as `**Kalın** başlık` in the file and
 * as `Kalın başlık` in the editor. Offering the raw markdown form would write a
 * link that can never match.
 *
 * Deliberately NOT handled:
 * - Setext headings (`Title` over `===`). `---` is also a thematic break and a
 *   frontmatter fence, so recognising them costs false positives — and a false
 *   positive is a heading the user can pick but the click side will never find,
 *   while a false negative is only a heading missing from a menu.
 * - Block references (`^id`). Memry has no persistent block ids; see
 *   `isBlockReference` in `./wiki-target`.
 */

export interface MarkdownHeading {
  /** The heading's plain text, in the form the click-side matcher compares. */
  text: string
  level: 1 | 2 | 3 | 4 | 5 | 6
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const FENCE = /^ {0,3}(```|~~~)/

/**
 * Every ATX heading in a markdown body, in document order, with inline markdown
 * stripped from each heading's text.
 *
 * Headings that are empty once stripped are dropped, because the click side
 * drops them too: `extractHeadings` only records blocks whose text survives a
 * trim, so a `###` on its own is not a target anything can point at.
 */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  let openFence: string | null = null

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    // A `#` inside a fenced code block is code, not a heading. Only a fence of
    // the same character closes the block, so ``` inside a ~~~ block is text.
    const fence = line.match(FENCE)
    if (fence) {
      if (openFence === null) {
        openFence = fence[1][0]
        continue
      }
      if (fence[1][0] === openFence) {
        openFence = null
      }
      continue
    }
    if (openFence !== null) continue

    const match = line.match(ATX_HEADING)
    if (!match) continue

    // `## Heading ##` — a closing sequence must be preceded by whitespace, so
    // `## C#` keeps its `#`.
    const withoutClosing = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
    const text = stripInlineMarkdown(withoutClosing)
    if (!text) continue

    headings.push({ text, level: match[1].length as MarkdownHeading['level'] })
  }

  return headings
}

/**
 * A single line of markdown reduced to the plain text BlockNote would render.
 *
 * Whitespace is collapsed because the editor's is: markdown reaches BlockNote
 * through HTML, where a run of spaces renders as one.
 */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // image: a heading has no inline image node, so it contributes no text
      .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1') // wiki link w/ alias → alias
      .replace(/\[\[([^\]]+)\]\]/g, '$1') // wiki link → target
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
      .replace(/`+([^`]*)`+/g, '$1') // inline code
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      // Underscore emphasis only at word boundaries: `snake_case` is literal
      // text in GFM and stays literal in the editor, so a blunt strip would
      // write a link text the click side can never match.
      .replace(/(?<![\p{L}\p{N}])_{1,3}(.+?)_{1,3}(?![\p{L}\p{N}])/gu, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
