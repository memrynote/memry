/**
 * The user guide, bundled into main so the agent can answer "how do I…" questions
 * about Memry offline. Only pages that explain how to use the app are included;
 * reference pages for the CLI and the agent API are left out because they answer
 * in code, not in steps a user follows.
 *
 * Loaded lazily by the help tools (read-tools.ts) so the markdown stays out of
 * main's startup path.
 */
const RAW_PAGES = import.meta.glob<string>(
  [
    '../../../../../../docs/src/guide/*.md',
    '../../../../../../docs/src/user-guide/**/*.md',
    '!../../../../../../docs/src/user-guide/cli.md',
    '!../../../../../../docs/src/user-guide/cli-reference.md',
    '!../../../../../../docs/src/user-guide/ai/agent-api-reference.md',
    '!../../../../../../docs/src/user-guide/ai/agent-backends.md',
    '!../../../../../../docs/src/user-guide/ai/agent-mcp.md'
  ],
  { query: '?raw', import: 'default', eager: true }
)

export interface HelpSection {
  /** Page path without extension, e.g. "user-guide/notes/properties-tags". */
  page: string
  pageTitle: string
  /** The `##` or `###` heading, or null for the text above the first one. */
  section: string | null
  level: number
  text: string
}

export interface HelpSearchHit {
  page: string
  page_title: string
  section: string | null
  snippet: string
}

const SNIPPET_CHARS = 240
const TITLE_WEIGHT = 3

function clean(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^:::.*$/gm, '')
    .replace(/<\/?kbd>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitPage(page: string, markdown: string): HelpSection[] {
  const body = clean(markdown)
  const pageTitle = /^# (.+)$/m.exec(body)?.[1].trim() ?? page
  const sections: HelpSection[] = []
  let section: string | null = null
  let level = 1
  let lines: string[] = []
  const flush = (): void => {
    const text = lines.join('\n').trim()
    if (text) sections.push({ page, pageTitle, section, level, text })
  }
  let inFence = false
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    const heading = inFence ? null : /^(#{2,3}) (.+)$/.exec(line)
    if (heading) {
      flush()
      level = heading[1].length
      section = heading[2].trim()
      lines = []
    } else {
      lines.push(line)
    }
  }
  flush()
  return sections
}

const STOP_WORDS = new Set(
  'a an and are can do does for how i in is it me my of on or the this to what when where with you your'.split(
    ' '
  )
)

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
}

interface IndexedSection extends HelpSection {
  terms: Map<string, number>
  length: number
}

function buildIndex(pages: Record<string, string>): IndexedSection[] {
  return Object.entries(pages)
    .flatMap(([path, markdown]) =>
      splitPage(path.replace(/^.*\/docs\/src\//, '').replace(/\.md$/, ''), markdown)
    )
    .map((s) => {
      const terms = new Map<string, number>()
      const add = (text: string, weight: number): void => {
        for (const t of tokens(text)) terms.set(t, (terms.get(t) ?? 0) + weight)
      }
      add(s.text, 1)
      add(`${s.pageTitle} ${s.section ?? ''}`, TITLE_WEIGHT)
      let length = 0
      for (const n of terms.values()) length += n
      return { ...s, terms, length }
    })
}

let index: IndexedSection[] | null = null
function getIndex(): IndexedSection[] {
  index ??= buildIndex(RAW_PAGES)
  return index
}

/** BM25 over guide sections; a page title or heading match counts as several body matches. */
export function searchHelp(query: string, limit = 5): HelpSearchHit[] {
  const sections = getIndex()
  const queryTerms = [...new Set(tokens(query))]
  const avgLength = sections.reduce((sum, s) => sum + s.length, 0) / sections.length
  const k1 = 1.2
  const b = 0.75
  const idf = new Map(
    queryTerms.map((t) => {
      const df = sections.filter((s) => s.terms.has(t)).length
      return [t, Math.log(1 + (sections.length - df + 0.5) / (df + 0.5))]
    })
  )
  return sections
    .map((s) => {
      let score = 0
      for (const t of queryTerms) {
        const tf = s.terms.get(t) ?? 0
        if (tf === 0) continue
        score +=
          ((idf.get(t) ?? 0) * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * s.length) / avgLength))
      }
      return { s, score }
    })
    .filter((r) => r.score > 0)
    .toSorted((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ s }) => ({
      page: s.page,
      page_title: s.pageTitle,
      section: s.section,
      snippet: s.text.replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS)
    }))
}

/**
 * One section of a page with its subsections, or the whole page when no section
 * is named. Null when the page or section is absent.
 */
export function readHelp(
  page: string,
  section?: string
): { page: string; page_title: string; section: string | null; text: string } | null {
  let matches = getIndex().filter((s) => s.page === page)
  if (section !== undefined) {
    const start = matches.findIndex((s) => s.section === section)
    if (start === -1) return null
    const end = matches.findIndex((s, i) => i > start && s.level <= matches[start].level)
    matches = matches.slice(start, end === -1 ? undefined : end)
  }
  if (matches.length === 0) return null
  return {
    page,
    page_title: matches[0].pageTitle,
    section: section ?? null,
    text: matches
      .map((s) => (s.section ? `${'#'.repeat(s.level)} ${s.section}\n\n${s.text}` : s.text))
      .join('\n\n')
  }
}

/** Every bundled page path, for "not found" errors. */
export function listHelpPages(): string[] {
  return [...new Set(getIndex().map((s) => s.page))]
}
