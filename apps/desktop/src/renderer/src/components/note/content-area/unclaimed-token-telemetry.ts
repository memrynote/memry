/**
 * Counts persistence tokens that failed to parse back into their blocks — the
 * silent half of #1848. A mention or date token the normalize chain left as
 * literal text, or a callout marker that lost its `> ` prefix, used to be
 * invisible until a user emailed a screenshot; this reports it through the
 * existing `app_error_seen` channel the day it ships. Metric only: the user
 * gets no toast, no dialog.
 *
 * Emission is throttled per kind — one event per minute, counts aggregated in
 * between — because the normalize chain runs on every note open and every
 * remote update, and the main-process telemetry path is itself rate-limited.
 */

import { trackTelemetry } from '@/lib/telemetry'

export type UnclaimedTokenKind = 'mention' | 'date' | 'callout_marker'

export type UnclaimedTokenCounts = Partial<Record<UnclaimedTokenKind, number>>

const ORPHANED_CALLOUT_MARKER_REGEX = /^\[!\w+\]/

interface InlineNode {
  type?: string
  text?: string
  content?: unknown
}

function countText(text: string, counts: Required<UnclaimedTokenCounts>): void {
  counts.mention += text.split('((mention:').length - 1
  counts.date += text.split('((date:').length - 1
}

function visitInlineContent(
  content: unknown,
  counts: Required<UnclaimedTokenCounts>,
  isBlockLeadingParagraphRun: boolean
): void {
  if (typeof content === 'string') {
    countText(content, counts)
    if (isBlockLeadingParagraphRun && ORPHANED_CALLOUT_MARKER_REGEX.test(content)) {
      counts.callout_marker += 1
    }
    return
  }
  if (!Array.isArray(content)) return

  content.forEach((item: InlineNode | string, index) => {
    if (typeof item === 'string') {
      visitInlineContent(item, counts, isBlockLeadingParagraphRun && index === 0)
      return
    }
    if (item?.type === 'text' && typeof item.text === 'string') {
      countText(item.text, counts)
      if (
        isBlockLeadingParagraphRun &&
        index === 0 &&
        ORPHANED_CALLOUT_MARKER_REGEX.test(item.text)
      ) {
        counts.callout_marker += 1
      }
      return
    }
    if (item?.content) visitInlineContent(item.content, counts, false)
  })
}

interface WalkableBlock {
  type?: string
  content?: unknown
  children?: unknown
}

function visitBlocks(
  blocks: readonly WalkableBlock[],
  counts: Required<UnclaimedTokenCounts>
): void {
  for (const block of blocks) {
    // A token inside a code block is the author's text, exactly as the
    // normalize passes treat it.
    if (block.type === 'codeBlock') continue

    const content = block.content
    if (
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      (content as { type?: string }).type === 'tableContent'
    ) {
      for (const row of (content as { rows?: Array<{ cells: unknown[] }> }).rows ?? []) {
        for (const cell of row.cells ?? []) {
          const cellContent =
            cell && typeof cell === 'object' && 'content' in cell
              ? (cell as { content: unknown }).content
              : cell
          visitInlineContent(cellContent, counts, false)
        }
      }
    } else {
      visitInlineContent(content, counts, block.type === 'paragraph')
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      visitBlocks(block.children as WalkableBlock[], counts)
    }
  }
}

export function countUnclaimedTokens(blocks: readonly unknown[]): UnclaimedTokenCounts {
  const counts: Required<UnclaimedTokenCounts> = { mention: 0, date: 0, callout_marker: 0 }
  visitBlocks(blocks as WalkableBlock[], counts)
  const found: UnclaimedTokenCounts = {}
  for (const kind of ['mention', 'date', 'callout_marker'] as const) {
    if (counts[kind] > 0) found[kind] = counts[kind]
  }
  return found
}

const FLUSH_INTERVAL_MS = 60_000

const pending = new Map<UnclaimedTokenKind, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastFlushAt = -Infinity

function flush(): void {
  flushTimer = null
  lastFlushAt = Date.now()
  for (const [kind, count] of pending) {
    void trackTelemetry('app_error_seen', {
      surface: 'app',
      action: 'editor_unclaimed_token',
      objectType: 'note',
      source: 'renderer',
      result: 'failed',
      errorCode: `unclaimed_${kind}`,
      metrics: { itemCount: count }
    })
  }
  pending.clear()
}

export function reportUnclaimedTokens(blocks: readonly unknown[]): void {
  const counts = countUnclaimedTokens(blocks)
  const kinds = Object.keys(counts) as UnclaimedTokenKind[]
  if (kinds.length === 0) return

  for (const kind of kinds) {
    pending.set(kind, (pending.get(kind) ?? 0) + (counts[kind] ?? 0))
  }

  const elapsed = Date.now() - lastFlushAt
  if (elapsed >= FLUSH_INTERVAL_MS) {
    flush()
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS - elapsed)
  }
}

export function resetUnclaimedTokenTelemetryForTests(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  lastFlushAt = -Infinity
  pending.clear()
}
