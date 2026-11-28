/**
 * How many handled tags the HTML parse holds open, which is what its recursion
 * costs.
 *
 * `tryParseHTMLToBlocks` builds a DOM and ProseMirror walks it, once per level:
 * 4000 unclosed `<b>` took 5 s, 4000 `<ul><li>` 50 s, and 8000 overflowed the
 * stack. So a handled tag opened while `RAW_HTML_MAX_NESTING` are open is read
 * as text, and so is the closing tag that belongs to it.
 *
 * "Open" is what the parse keeps, not what the note spells:
 *
 * - `<li>`, `<td>`, `<th>`, `<tr>`, a table's sections, `<caption>` and a
 *   heading close the one of their kind that is open when the next opens, so a
 *   note of unclosed list items or table rows holds one at a time.
 * - A paragraph, heading or table cell the markdown makes ends the marks
 *   opened in it. A tag that closes the paragraph it is in when it opens
 *   (`<ul>`, `<table>`, `<pre>`, `<blockquote>`, a heading, ...) is outside it
 *   from there, and so is every tag after it up to the blank line, which
 *   therefore stay open past that blank line. So does a tag in an HTML block (a
 *   line that starts with a block tag, up to the blank line after it), which
 *   is in no paragraph.
 * - A formatting element (`<b>`, `<i>`, `<a>`, ...) the paragraph ended is kept
 *   in the parse's list of active formatting elements and made again, nested,
 *   in the next paragraph. The list keeps three of any identical ones
 *   ("Noah's Ark"), so a note of unclosed `<b>` stays at three and one of
 *   `<b data-n=...>` grows with every different one.
 * - A closing tag closes the innermost open tag of its name that its scope
 *   can see: a table, a cell or a caption hides what is outside it from
 *   `</ul>`, as it does in the parse. One that closes nothing is read as
 *   written.
 *
 * The core's seed counts the same way (`markdown_seed/html_nesting.rs`);
 * chapter 12 states the rule.
 */

/** How many handled tags may be open at once. */
export const RAW_HTML_MAX_NESTING = 100

/** The tags the parse keeps in its active formatting list. */
const FORMATTING: ReadonlySet<string> = new Set([
  'a',
  'b',
  'code',
  'em',
  'i',
  's',
  'strike',
  'strong',
  'u'
])

/**
 * The handled tags the parse's "special" category holds: what a `<li>` start tag
 * and `</span>`-like end tags do not look past.
 */
const SPECIAL: ReadonlySet<string> = new Set([
  'blockquote',
  'caption',
  'colgroup',
  'details',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'pre',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

/** The handled tags whose start tag closes the paragraph that holds it. */
const CLOSES_PARAGRAPH: ReadonlySet<string> = new Set([
  'blockquote',
  'details',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'pre',
  'table',
  'ul'
])

const HEADINGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const CELLS: ReadonlySet<string> = new Set(['td', 'th'])
const SECTIONS: ReadonlySet<string> = new Set(['tbody', 'thead', 'tfoot'])
/** What `</ul>` and the like cannot see past. */
const SCOPE: ReadonlySet<string> = new Set(['caption', 'table', 'td', 'th'])
const LIST_ITEM_SCOPE: ReadonlySet<string> = new Set([...SCOPE, 'ol', 'ul'])
const TABLE_SCOPE: ReadonlySet<string> = new Set(['table'])
const NO_SCOPE: ReadonlySet<string> = new Set()

/** An open handled tag. */
interface Open {
  name: string
  seq: number
  /** Opened in an HTML block, so no paragraph's end closes it. */
  persistent: boolean
  /** The active-formatting entry that stands for it, if it has one. */
  listed: Listed | null
}

/** An entry of the parse's list of active formatting elements. */
interface Listed {
  name: string
  key: string
  seq: number
  /** Its element while that is open, null once a paragraph has closed it. */
  open: Open | null
}

/** What a closing tag did: closed an open tag, was the text of a capped one, or closed nothing. */
export type CloseResult = 'closed' | 'literal' | 'stray'

export class HtmlNesting {
  /** The handled tags that are open, innermost last. */
  private stack: Open[] = []
  /** The parse's list of active formatting elements, oldest first. */
  private active: Listed[] = []
  /** The entries of `active` whose element a paragraph has closed. */
  private off = 0
  /** For each name, the order of the tags of it that are text, innermost last. */
  private literal = new Map<string, number[]>()
  private seq = 0
  /** Whether the tags that open now are outside any paragraph. */
  private block = false

  /** How many tags the parse holds open. */
  get depth(): number {
    return this.stack.length + this.off
  }

  /** A blank line ends the paragraph, and the HTML block, that is open. */
  blankLine(): void {
    this.endParagraph()
    this.block = false
  }

  /** A line that starts an HTML block interrupts a paragraph. */
  htmlBlockLine(): void {
    if (!this.block) this.startBlock()
  }

  /** A tag that holds nothing, which still closes the paragraph it is in if it is a rule. */
  passes(name: string): void {
    if (CLOSES_PARAGRAPH.has(name)) this.htmlBlockLine()
  }

  /** The end of a paragraph, heading or cell: the marks opened in it are closed. */
  private endParagraph(): void {
    while (this.stack.length > 0 && !this.stack[this.stack.length - 1].persistent) {
      this.popTo(this.stack.length - 1)
    }
  }

  private startBlock(): void {
    this.endParagraph()
    this.block = true
  }

  /**
   * Opens `name`, whose attributes are spelled `key`, and says whether it is
   * within the cap. One that is not is text, and its close is.
   */
  open(name: string, key: string | null): boolean {
    this.closeImplied(name)
    if (this.depth >= RAW_HTML_MAX_NESTING) {
      this.pushLiteral(name)
      return false
    }
    if (CLOSES_PARAGRAPH.has(name)) this.htmlBlockLine()
    const open: Open = { name, seq: ++this.seq, persistent: this.block, listed: null }
    this.stack.push(open)
    // A tag that spells no attributes has none to compare: it is its own kind.
    if (FORMATTING.has(name)) this.list(open, key ?? `?${open.seq}`)
    return true
  }

  /** Counts a tag that is text (a plain `<span>`) so its close is text too. */
  pushLiteral(name: string): void {
    const seqs = this.literal.get(name)
    if (seqs === undefined) this.literal.set(name, [++this.seq])
    else seqs.push(++this.seq)
  }

  /** Closes the innermost open `name`, or says it was text or closed nothing. */
  close(name: string): CloseResult {
    const literal = this.literal.get(name)
    const literalSeq =
      literal !== undefined && literal.length > 0 ? literal[literal.length - 1] : -1
    const formatting = FORMATTING.has(name)
    let listed: Listed | null = null
    let at = -1
    if (formatting) {
      for (let i = this.active.length - 1; i >= 0 && listed === null; i--) {
        if (this.active[i].name === name) listed = this.active[i]
      }
    }
    if (listed === null) at = this.find(name)
    const openSeq = listed !== null ? listed.seq : at >= 0 ? this.stack[at].seq : -1
    if (literalSeq > openSeq) {
      literal?.pop()
      return 'literal'
    }
    if (listed !== null) {
      this.unlist(listed, true)
      return 'closed'
    }
    if (at < 0) return 'stray'
    // A formatting element is taken out of its place and what it held stays; the
    // rest close what is inside them.
    if (formatting) this.removeAt(at)
    else this.popTo(at)
    return 'closed'
  }

  /** Pops the open tags from `index` up, which the parse has closed. */
  private popTo(index: number): void {
    while (this.stack.length > index) {
      const open = this.stack.pop()
      if (open?.listed) {
        open.listed.open = null
        open.listed = null
        this.off++
      }
    }
  }

  /** Takes one open tag out of the stack, and the entry that stands for it with it. */
  private removeAt(index: number): void {
    const [open] = this.stack.splice(index, 1)
    if (open.listed) this.unlist(open.listed, false)
  }

  /**
   * Takes `entry` off the active list. `closeElement` is a close that also
   * removes its element, which a Noah's Ark eviction does not.
   */
  private unlist(entry: Listed, closeElement: boolean): void {
    this.active.splice(this.active.indexOf(entry), 1)
    if (entry.open === null) {
      this.off--
      return
    }
    entry.open.listed = null
    if (closeElement) this.stack.splice(this.stack.indexOf(entry.open), 1)
    entry.open = null
  }

  private list(open: Open, key: string): void {
    if (open.name === 'a') {
      // A second `<a>` closes the first.
      const earlier = this.active.find((entry) => entry.name === 'a')
      if (earlier) {
        this.unlist(earlier, true)
      }
    }
    const same = this.active.filter((entry) => entry.key === key)
    if (same.length >= 3) this.unlist(same[0], false)
    const entry: Listed = { name: open.name, key, seq: open.seq, open }
    open.listed = entry
    this.active.push(entry)
  }

  /** What an opening tag closes by itself, as the parse does. */
  private closeImplied(name: string): void {
    if (HEADINGS.has(name)) {
      const top = this.stack[this.stack.length - 1]
      if (top !== undefined && HEADINGS.has(top.name)) this.popTo(this.stack.length - 1)
    } else if (name === 'li') {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const open = this.stack[i].name
        if (open === 'li') return this.popTo(i)
        if (SPECIAL.has(open)) return
      }
    } else if (CELLS.has(name) || name === 'tr') {
      // A cell closes the cell and a row the row, and what is in them.
      const kind = name === 'tr' ? 'tr' : null
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const open = this.stack[i].name
        if (open === 'table') return
        if (kind === null ? CELLS.has(open) : open === kind) return this.popTo(i)
      }
    } else if (SECTIONS.has(name) || name === 'caption' || name === 'colgroup') {
      // These close the cell, the row and the section: all that is in the table.
      let table = this.stack.length - 1
      while (table >= 0 && this.stack[table].name !== 'table') table--
      if (table >= 0) this.popTo(table + 1)
    }
  }

  /** Where the open tag a closing `name` closes is, or -1. */
  private find(name: string): number {
    const matches = (open: string): boolean =>
      HEADINGS.has(name) ? HEADINGS.has(open) : open === name
    const scope = scopeOf(name)
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const open = this.stack[i].name
      if (matches(open)) return i
      if (scope === null ? SPECIAL.has(open) : scope.has(open)) return -1
    }
    return -1
  }
}

/** The tags a closing `name` cannot see past, or null for the parse's "any other end tag". */
function scopeOf(name: string): ReadonlySet<string> | null {
  if (name === 'li') return LIST_ITEM_SCOPE
  if (name === 'table') return NO_SCOPE
  if (CELLS.has(name) || name === 'tr' || SECTIONS.has(name) || name === 'caption') {
    return TABLE_SCOPE
  }
  if (FORMATTING.has(name) || name === 'span' || name === 'del') return null
  if (name === 'video' || name === 'audio') return null
  return SCOPE
}
