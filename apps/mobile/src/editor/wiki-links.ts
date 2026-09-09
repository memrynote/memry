import { resolveIcon } from '@/features/notes/icon-value'
import { normalizeTagKey, readVaultTags } from '@/features/notes/note-ops'
import { readTagStyles } from '@/features/notes/tag-definitions'
import { extractMarkdownHeadings } from '@memry/shared/markdown-headings'
import type { InlineMenuTrigger, WikiCandidate } from '@memry/contracts/webview-bridge'
import type { VaultDb } from '../db/index'

/**
 * The RN half of wiki-links (T067 / FR-014).
 *
 * Both halves of a wiki link resolve against the note TITLE, not a path or an
 * id: that is what the on-disk `[[Target]]` form carries, and what desktop
 * resolves. The displayed text is the alias — a rule the shared spec already
 * owns — so nothing here touches presentation.
 */

/** `Title#Heading` — the heading half is resolved after the note opens. */
export interface WikiTarget {
  title: string
  heading: string | null
}

export function parseWikiTarget(target: string): WikiTarget {
  const hash = target.indexOf('#')
  if (hash === -1) return { title: target.trim(), heading: null }
  return {
    title: target.slice(0, hash).trim(),
    heading: target.slice(hash + 1).trim() || null
  }
}

interface NoteTitleRow {
  id: string
  payload: string | null
}

function titleOf(
  payload: string | null
): { title: string; folderPath: string; icon: string } | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as {
      title?: string
      folderPath?: string | null
      icon?: string | null
    }
    // An empty map on purpose: only a literal emoji survives, because the menu
    // renders in the WebView, which has neither the glyph set behind
    // `icon:<name>` nor the bytes behind `custom:<id>`.
    const resolved = resolveIcon(parsed.icon, new Map())
    return {
      title: parsed.title ?? 'Untitled',
      folderPath: parsed.folderPath ?? '',
      icon: resolved?.kind === 'emoji' ? resolved.text : ''
    }
  } catch {
    return null
  }
}

/**
 * Resolve a tapped link to a note id.
 *
 * Case-insensitive, like every other title match in Memry, and it prefers an
 * exact-case hit so two notes differing only in case still open the one the
 * link actually names.
 */
export async function resolveWikiTarget(db: VaultDb, target: string): Promise<string | null> {
  const { title } = parseWikiTarget(target)
  if (title.length === 0) return null

  const rows = await db.getAllAsync<NoteTitleRow>(
    `SELECT id, payload FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL AND payload_state = 'full'`
  )

  const wanted = title.toLowerCase()
  let caseInsensitive: string | null = null
  for (const row of rows) {
    const parsed = titleOf(row.payload)
    if (!parsed) continue
    if (parsed.title === title) return row.id
    if (caseInsensitive === null && parsed.title.toLowerCase() === wanted) caseInsensitive = row.id
  }
  return caseInsensitive
}

/**
 * Rows for `[[query`, where `query` is everything typed after the brackets.
 *
 * The grammar desktop implements, mirrored here because both halves have to
 * agree on what a link means:
 *
 *   * `[[foo`              — notes whose title matches `foo`.
 *   * `[[Exact Title#`     — that note's headings. `#` only switches modes once
 *                            the note half matches a title EXACTLY, so a note
 *                            genuinely titled `Sprint #4` stays reachable.
 *   * `[[Target|label`     — one row that commits `label` as the chip's text.
 *
 * Parsed fresh on every keystroke, so backspacing over a `#` or a `|` needs no
 * unwinding — the previous mode simply comes back.
 */
export async function queryWikiCandidates(
  db: VaultDb,
  query: string,
  limit = 8
): Promise<WikiCandidate[]> {
  const pipe = query.indexOf('|')
  const targetPart = (pipe === -1 ? query : query.slice(0, pipe)).trim()
  const aliasPart = pipe === -1 ? null : query.slice(pipe + 1)

  const notes = await readNoteTitles(db)
  const exact = notes.find((note) => note.title.toLowerCase() === targetPart.toLowerCase())

  if (aliasPart !== null) {
    const label = aliasPart.trim()
    if (targetPart.length === 0 || label.length === 0) return []
    return [
      {
        kind: 'alias',
        id: exact?.id ?? '',
        title: label,
        subtitle: targetPart,
        icon: exact?.icon ?? '',
        target: targetPart,
        alias: label
      }
    ]
  }

  const hash = targetPart.indexOf('#')
  if (hash !== -1) {
    const notePart = targetPart.slice(0, hash).trim()
    const headingPart = targetPart.slice(hash + 1).trim()
    const owner = notes.find((note) => note.title.toLowerCase() === notePart.toLowerCase())
    if (owner) return headingRows(db, owner, headingPart, limit)
  }

  const rows = noteRows(notes, targetPart, limit)
  // Desktop offers creation whenever the typed target names no existing note.
  // Accepting the row only writes the link; the note itself is created later,
  // from the confirm dialog the broken link raises when it is tapped.
  if (targetPart.length > 0 && !exact) {
    rows.push({
      kind: 'create',
      id: '',
      title: targetPart,
      subtitle: 'Create new note',
      icon: '',
      target: targetPart,
      alias: ''
    })
  }
  return rows
}

/**
 * Notes whose title matches, prefix hits before substring hits.
 *
 * An empty query means "the notes I touched most recently", which is the
 * useful answer the moment `[[` or `@` is typed and nothing else is known yet.
 */
function noteRows(notes: NoteTitle[], query: string, limit: number): WikiCandidate[] {
  const needle = query.toLowerCase()
  const prefix: WikiCandidate[] = []
  const contains: WikiCandidate[] = []
  for (const note of notes) {
    const row: WikiCandidate = {
      kind: 'note',
      id: note.id,
      title: note.title,
      subtitle: note.folderPath,
      icon: note.icon,
      target: note.title,
      alias: ''
    }
    const haystack = note.title.toLowerCase()
    if (needle.length === 0 || haystack.startsWith(needle)) prefix.push(row)
    else if (haystack.includes(needle)) contains.push(row)
    if (prefix.length >= limit) break
  }
  return [...prefix, ...contains].slice(0, limit)
}

async function headingRows(
  db: VaultDb,
  owner: NoteTitle,
  filter: string,
  limit: number
): Promise<WikiCandidate[]> {
  const body = await db.getFirstAsync<{ markdown: string }>(
    'SELECT markdown FROM note_bodies WHERE item_id = ?',
    [owner.id]
  )
  const needle = filter.toLowerCase()
  const headings = extractMarkdownHeadings(body?.markdown ?? '').filter(
    (heading) => needle.length === 0 || heading.text.toLowerCase().includes(needle)
  )
  if (headings.length === 0) {
    // A message row, not an empty list: an empty list closes the menu, and the
    // user would lose it mid-word while backspacing a mistyped heading.
    return [
      {
        kind: 'empty',
        id: owner.id,
        title:
          filter.length === 0
            ? `${owner.title} has no headings`
            : `No headings in ${owner.title} match`,
        subtitle: '',
        icon: '',
        target: '',
        alias: ''
      }
    ]
  }
  return headings.slice(0, limit).map((heading) => ({
    kind: 'heading' as const,
    id: owner.id,
    title: heading.text,
    subtitle: '',
    icon: '',
    // The alias is the heading text, so the chip reads as the section name
    // rather than `Note#Section`. Desktop writes exactly this form.
    target: `${owner.title}#${heading.text}`,
    alias: heading.text,
    headingLevel: heading.level
  }))
}

interface NoteTitle {
  id: string
  title: string
  folderPath: string
  icon: string
}

async function readNoteTitles(db: VaultDb): Promise<NoteTitle[]> {
  const rows = await db.getAllAsync<NoteTitleRow>(
    `SELECT id, payload FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL AND payload_state = 'full'
     ORDER BY updated_at DESC`
  )
  const out: NoteTitle[] = []
  for (const row of rows) {
    const parsed = titleOf(row.payload)
    if (parsed) {
      out.push({
        id: row.id,
        title: parsed.title,
        folderPath: parsed.folderPath,
        icon: parsed.icon
      })
    }
  }
  return out
}

/**
 * Rows for `#query` — the vault's tags, plus an inline-create row (#2099).
 *
 * The colour and the emoji travel with the row because the guest writes them
 * straight onto the `hashTag` node it inserts. A tag nobody has coloured gets
 * an empty `color`, which is not a gap: `getTagColors` hashes the name to the
 * same hue every other surface already paints it with, so the chip matches
 * desktop without this device inventing a `tag_definition` row.
 *
 * Case-insensitive, like tag identity everywhere else, and the stored casing
 * wins over the typed one so picking `#Roadmap` never forks the tag.
 */
export async function queryTagCandidates(
  db: VaultDb,
  query: string,
  limit = 8
): Promise<WikiCandidate[]> {
  const typed = query.trim()
  const needle = normalizeTagKey(typed)
  const [tags, styles] = await Promise.all([readVaultTags(db), readTagStyles(db)])

  const prefix: WikiCandidate[] = []
  const contains: WikiCandidate[] = []
  let exact = false
  for (const tag of tags) {
    const key = normalizeTagKey(tag)
    if (key === needle) exact = true
    const style = styles.get(key)
    const row: WikiCandidate = {
      kind: 'tag',
      id: tag,
      title: tag,
      subtitle: '',
      // Verbatim, not filtered to an emoji: it is written onto the node, and a
      // named icon stripped here would erase what desktop stored for the tag.
      icon: style?.icon ?? '',
      target: tag,
      alias: '',
      color: style?.color ?? ''
    }
    if (needle.length === 0 || key.startsWith(needle)) prefix.push(row)
    else if (key.includes(needle)) contains.push(row)
    if (prefix.length >= limit) break
  }

  const rows = [...prefix, ...contains].slice(0, limit)
  // Desktop lets a tag be created by typing it, so an unknown name is never a
  // dead end. The chip is the whole creation: a tag exists because a note
  // carries it, and `tag_definition` only ever records a colour someone picked.
  if (needle.length > 0 && !exact) {
    rows.push({
      kind: 'create',
      id: '',
      title: typed,
      subtitle: 'Create tag',
      icon: '',
      target: typed,
      alias: '',
      color: ''
    })
  }
  return rows
}

/**
 * Rows for `@query` — notes, most recently touched first (#2099).
 *
 * Accepting one writes a WIKI LINK, which is what desktop's `@` menu writes
 * (`use-mention-suggestions.ts`): the chip has to resolve to a note by title on
 * every device, and `linkMention` is the URL-bookmark chip, which carries no
 * note identity at all.
 *
 * No create row, again mirroring desktop: `@` is a pointer at something that
 * exists, and `[[` is the surface that offers to invent one.
 */
export async function queryMentionCandidates(
  db: VaultDb,
  query: string,
  limit = 8
): Promise<WikiCandidate[]> {
  return noteRows(await readNoteTitles(db), query.trim(), limit)
}

/** Route an inline-menu request to the rows its trigger means. */
export async function queryInlineMenuCandidates(
  db: VaultDb,
  query: string,
  trigger: InlineMenuTrigger
): Promise<WikiCandidate[]> {
  if (trigger === 'tag') return queryTagCandidates(db, query)
  if (trigger === 'mention') return queryMentionCandidates(db, query)
  return queryWikiCandidates(db, query)
}
