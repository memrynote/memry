/**
 * Pure task-block helpers shared between the renderer (BlockNote editor) and
 * the main process (CRDT seed + writeback). Kept dependency-free: blocks are
 * typed structurally so neither side has to pull in `@blocknote/core` here.
 *
 * A task is stored in markdown as a plain checkbox line, e.g. `- [ ] Buy milk`
 * (plus an optional trailing ` ^anchor` when the user explicitly linked the
 * block). The task id is NOT in the file: it lives in the Y.Doc block props and
 * in the `note_task_links` snapshot table. `matchTaskCandidates` re-binds file
 * lines to task ids when seeding a doc from disk; `serializeTaskBlock` renders
 * a `taskBlock` back to its markdown line. The legacy `{task:<id>}` suffix is
 * still parsed (and stripped) as a migration path.
 */

const TASK_BLOCK_SUFFIX_OPEN = '{task:'

const ANCHOR_ID_RE = /^[A-Za-z0-9-]+$/

export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
  parentTaskId?: string
  anchor?: string
}

/**
 * Minimal structural shape both BlockNote `Block` (renderer + server editor)
 * and hand-built block trees satisfy. All fields optional so callers can pass
 * their richer block type unchanged.
 */
export interface TaskNormalizableBlock {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: TaskNormalizableBlock[]
}

/** Last-serialized state of a task line, used to re-bind file lines to ids. */
export interface TaskCandidate {
  taskId: string
  title: string
  checked: boolean
  anchor?: string | null
  parentTaskId?: string | null
}

export interface TaskLineInput {
  /** Raw inline text of the checklist line (may carry anchor/legacy suffix). */
  title: string
  checked: boolean
}

export interface TaskLineBinding {
  taskId: string
  /** Clean title (matched anchor / legacy suffix stripped). */
  title: string
  /** Checked state from the file — the file wins on external toggles. */
  checked: boolean
  anchor?: string
  rule: 'anchor' | 'legacy' | 'title' | 'fuzzy'
}

export interface TaskMatchResult {
  /** One entry per input line; null = stays a plain checkbox. */
  bindings: (TaskLineBinding | null)[]
  /** Candidates whose line was deleted externally. Never delete the task row. */
  orphans: TaskCandidate[]
}

/** Row shape mirrored into the `note_task_links` snapshot after a writeback. */
export interface NoteTaskLink {
  taskId: string
  title: string
  checked: boolean
  position: number
  anchor: string | null
}

export function serializeTaskBlock(props: TaskBlockProps): string {
  const check = props.checked ? 'x' : ' '
  const indent = props.parentTaskId ? '  ' : ''
  const anchor = props.anchor ? ` ^${props.anchor}` : ''
  return `${indent}- [${check}] ${props.title}${anchor}`
}

// Parsed by hand rather than with a regex: the suffix is always the trailing
// `{task:<id>}`, and a greedy-class-plus-end-anchor regex (`\{task:([^}]+)\}$`)
// backtracks quadratically on adversarial note content with many `{task:`
// starts — flagged as polynomial ReDoS on uncontrolled input. String ops keep
// it linear.
export function parseTaskBlockSuffix(text: string): { taskId: string; title: string } | null {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith('}')) return null
  const open = trimmed.lastIndexOf(TASK_BLOCK_SUFFIX_OPEN)
  if (open === -1) return null
  const taskId = trimmed.slice(open + TASK_BLOCK_SUFFIX_OPEN.length, -1)
  if (taskId.length === 0 || taskId.includes('}')) return null
  return { taskId, title: trimmed.slice(0, open).trim() }
}

/**
 * Parse a trailing Obsidian block anchor (` ^id`, id = `[A-Za-z0-9-]+`).
 * Returns null when the line has no valid anchor — including a bare `^id`
 * with no preceding text, which is not a task line.
 */
export function parseTaskAnchor(text: string): { anchor: string; title: string } | null {
  const trimmed = text.trimEnd()
  const caret = trimmed.lastIndexOf(' ^')
  if (caret === -1) return null
  const anchor = trimmed.slice(caret + 2)
  if (anchor.length === 0 || !ANCHOR_ID_RE.test(anchor)) return null
  const title = trimmed.slice(0, caret).trim()
  if (!title) return null
  return { anchor, title }
}

export function extractInlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item: unknown) => {
      if (typeof item === 'string') return item
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        (item as Record<string, unknown>).type === 'text'
      ) {
        return ((item as Record<string, unknown>).text as string) || ''
      }
      return ''
    })
    .join('')
}

/**
 * Bind checklist lines (doc order) to task candidates. Each candidate binds at
 * most once. Rules, in priority order:
 *
 * 1. anchor      — line's ` ^id` matches a candidate anchor (strip the anchor)
 * 2. legacy      — line still carries `{task:<id>}`; binds by that id even
 *                  without a candidate (migration path, suffix stripped)
 * 3. title       — exact title, nth line ↔ nth candidate for duplicates
 * 4. fuzzy       — exactly one unmatched line and one unmatched candidate left:
 *                  treat as an external title edit (documented limitation: a
 *                  single delete + single add in one edit session mis-binds)
 * 5. no binding  — the line stays a plain checkbox
 * 6. orphans     — leftover candidates; callers drop the snapshot row but must
 *                  never delete the task row itself
 *
 * A line whose anchor matches no candidate keeps the anchor text verbatim
 * inside its title (it may be a user-authored block id — spec 06).
 */
export function matchTaskCandidates(
  lines: TaskLineInput[],
  candidates: TaskCandidate[]
): TaskMatchResult {
  const bindings: (TaskLineBinding | null)[] = new Array(lines.length).fill(null)
  const used: boolean[] = new Array(candidates.length).fill(false)

  const parsed = lines.map((line) => {
    const legacy = parseTaskBlockSuffix(line.title)
    if (legacy) return { legacy, anchored: null, title: legacy.title, checked: line.checked }
    return {
      legacy: null,
      anchored: parseTaskAnchor(line.title),
      title: line.title.trim(),
      checked: line.checked
    }
  })

  const takeCandidate = (predicate: (c: TaskCandidate) => boolean): number => {
    for (let j = 0; j < candidates.length; j++) {
      if (!used[j] && predicate(candidates[j])) {
        used[j] = true
        return j
      }
    }
    return -1
  }

  // Rule 1: anchors
  parsed.forEach((p, i) => {
    if (!p.anchored) return
    const anchor = p.anchored.anchor
    const j = takeCandidate((c) => Boolean(c.anchor) && c.anchor === anchor)
    if (j === -1) return
    bindings[i] = {
      taskId: candidates[j].taskId,
      title: p.anchored.title,
      checked: p.checked,
      anchor,
      rule: 'anchor'
    }
  })

  // Rule 2: legacy suffix — binds by id even when no candidate carries it
  parsed.forEach((p, i) => {
    if (bindings[i] || !p.legacy) return
    const taskId = p.legacy.taskId
    takeCandidate((c) => c.taskId === taskId)
    bindings[i] = { taskId, title: p.legacy.title, checked: p.checked, rule: 'legacy' }
  })

  // Rule 3: exact title. Greedy first-unused over doc-ordered candidates gives
  // the nth-line ↔ nth-candidate pairing for duplicate titles.
  parsed.forEach((p, i) => {
    if (bindings[i] || p.legacy) return
    const title = p.title
    const j = takeCandidate((c) => c.title === title)
    if (j === -1) return
    bindings[i] = { taskId: candidates[j].taskId, title, checked: p.checked, rule: 'title' }
  })

  // Rule 4: single-leftover fuzzy — an external title edit
  const unboundLines = parsed
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => !bindings[i] && !p.legacy)
  const unusedCandidates = candidates.map((_, j) => j).filter((j) => !used[j])
  if (unboundLines.length === 1 && unusedCandidates.length === 1) {
    const { p, i } = unboundLines[0]
    const j = unusedCandidates[0]
    used[j] = true
    bindings[i] = {
      taskId: candidates[j].taskId,
      title: p.title,
      checked: p.checked,
      rule: 'fuzzy'
    }
  }

  return { bindings, orphans: candidates.filter((_, j) => !used[j]) }
}

/**
 * Upgrade checkbox blocks to `taskBlock` nodes by binding them against
 * candidates (see `matchTaskCandidates`). Without candidates only legacy
 * `{task:<id>}` lines upgrade — unchanged behavior for the renderer load path.
 * Returns the bound lines and orphaned candidates so the watcher can apply
 * external checked/title changes through the tasks domain.
 */
export function normalizeTaskBlocks<T extends TaskNormalizableBlock>(
  blocks: T[],
  candidates: TaskCandidate[] = []
): { blocks: T[]; didChange: boolean; bindings: TaskLineBinding[]; orphans: TaskCandidate[] } {
  if (candidates.length === 0 && !JSON.stringify(blocks).includes(TASK_BLOCK_SUFFIX_OPEN)) {
    return { blocks, didChange: false, bindings: [], orphans: [] }
  }

  // Collect checklist lines in doc order, descending only through checkbox /
  // taskBlock chains (a checkbox nested under e.g. a bullet item is not a task
  // line today either). Existing taskBlocks keep their ids out of the pool.
  const lines: TaskLineInput[] = []
  const existingIds = new Set<string>()
  const collect = (list: TaskNormalizableBlock[]): void => {
    for (const block of list) {
      if (block.type === 'taskBlock') {
        const taskId = (block.props as Record<string, unknown> | undefined)?.taskId
        if (typeof taskId === 'string') existingIds.add(taskId)
        if (block.children?.length) collect(block.children)
      } else if (block.type === 'checkListItem') {
        lines.push({
          title: extractInlineText(block.content),
          checked: Boolean(block.props?.checked ?? block.props?.isChecked ?? false)
        })
        if (block.children?.length) collect(block.children)
      }
    }
  }
  collect(blocks)

  const pool = candidates.filter((c) => !existingIds.has(c.taskId))
  const { bindings, orphans } = matchTaskCandidates(lines, pool)

  let index = 0
  let didChange = false
  const bound: TaskLineBinding[] = []

  const rebuild = (list: T[], parentTaskId: string): T[] =>
    list.map((block) => {
      if (block.type === 'taskBlock') {
        const taskId = ((block.props as Record<string, unknown> | undefined)?.taskId ??
          '') as string
        if (!block.children?.length) return block
        const children = rebuild(block.children as T[], taskId)
        if (children === block.children) return block
        return { ...block, children } as T
      }
      if (block.type !== 'checkListItem') return block

      const binding = bindings[index++]
      if (!binding) {
        if (!block.children?.length) return block
        const children = rebuild(block.children as T[], parentTaskId)
        if (children === block.children) return block
        return { ...block, children } as T
      }

      didChange = true
      bound.push(binding)
      const children = block.children?.length ? rebuild(block.children as T[], binding.taskId) : []
      const props: Record<string, unknown> = {
        taskId: binding.taskId,
        title: binding.title,
        checked: binding.checked,
        parentTaskId
      }
      if (binding.anchor) props.anchor = binding.anchor
      return {
        type: 'taskBlock',
        props,
        content: undefined,
        children,
        id: block.id
      } as unknown as T
    })

  const nextBlocks = rebuild(blocks, '')
  return { blocks: didChange ? nextBlocks : blocks, didChange, bindings: bound, orphans }
}

/**
 * Snapshot the task lines of a serialized doc, in doc order. Called after a
 * successful writeback so `note_task_links` always mirrors the file bytes.
 */
export function collectTaskLinks(blocks: TaskNormalizableBlock[]): NoteTaskLink[] {
  const links: NoteTaskLink[] = []
  const walk = (list: TaskNormalizableBlock[]): void => {
    for (const block of list) {
      if (block.type === 'taskBlock' && block.props) {
        const props = block.props as Record<string, unknown>
        links.push({
          taskId: String(props.taskId ?? ''),
          title: String(props.title ?? ''),
          checked: Boolean(props.checked),
          position: links.length,
          anchor: typeof props.anchor === 'string' && props.anchor ? props.anchor : null
        })
      }
      if (block.children?.length) walk(block.children)
    }
  }
  walk(blocks)
  return links
}
