/**
 * Reading and rewriting a portal block's definition. The block is a
 * `codeBlock` whose text is the definition's JSON, so every change is a
 * `updateBlock` of that text: unknown keys a newer build wrote survive
 * (`serializePortalDefinition` keeps `raw`), and a definition this build
 * cannot read is never overwritten.
 *
 * @module note/content-area/portal/portal-definition
 */

import { useMemo } from 'react'
import {
  PORTAL_BLOCK_LANGUAGE,
  parsePortalDefinition,
  serializePortalDefinition,
  type ParsedPortal,
  type PortalDefinition,
  type PortalTarget
} from '@memry/shared/portal-block'

/** The block's plain text: its runs, joined. */
export function portalBlockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((run) =>
      typeof run === 'object' &&
      run !== null &&
      typeof (run as { text?: unknown }).text === 'string'
        ? (run as { text: string }).text
        : ''
    )
    .join('')
}

/** The parsed definition of a portal block, re-read only when its text changes. */
export function usePortalDefinition(content: unknown): ParsedPortal {
  const text = portalBlockText(content)
  return useMemo(() => parsePortalDefinition(text), [text])
}

/** What a portal edit needs from the editor holding the portal block. */
export interface PortalEditorLike {
  isEditable: boolean
  getBlock: (id: string) => { content?: unknown } | undefined
  updateBlock: (id: string, update: { content: string }) => unknown
  removeBlocks: (ids: string[]) => unknown
}

/**
 * Rewrite the portal block `blockId` with the definition `next` computes from
 * the one in the document right now, so two quick edits (hide A, hide B) do not
 * overwrite each other with a stale one. `next` may return null to refuse the
 * edit, or be `{ target }` to retarget the portal. Returns false, writing nothing, when the editor is read-only, the block
 * is gone, its definition does not parse, or `next` refuses.
 */
export function updatePortalDefinition(
  editor: PortalEditorLike,
  blockId: string,
  next: ((current: PortalDefinition) => PortalDefinition | null) | { target: PortalTarget }
): boolean {
  if (!editor.isEditable) return false
  const block = editor.getBlock(blockId)
  if (!block) return false
  const parsed = parsePortalDefinition(portalBlockText(block.content))
  if (!parsed.ok) return false
  const definition =
    typeof next === 'function'
      ? next(parsed.definition)
      : { ...parsed.definition, target: next.target }
  if (!definition) return false
  editor.updateBlock(blockId, { content: serializePortalDefinition(definition) })
  return true
}

/** The block to insert for `definition`: what `insertBlocks` / `insertOrUpdateBlockForSlashMenu` take. */
export function portalBlockInput(definition: PortalDefinition): {
  type: 'codeBlock'
  props: { language: string }
  content: string
} {
  return {
    type: 'codeBlock',
    props: { language: PORTAL_BLOCK_LANGUAGE },
    content: serializePortalDefinition(definition)
  }
}

/** The portal as a fenced block, for the clipboard. */
export function portalFenceText(definition: PortalDefinition): string {
  return `\`\`\`${PORTAL_BLOCK_LANGUAGE}\n${serializePortalDefinition(definition)}\n\`\`\`\n`
}
