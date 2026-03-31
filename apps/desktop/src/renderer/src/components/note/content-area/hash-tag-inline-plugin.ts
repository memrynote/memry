import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

const PLUGIN_KEY = new PluginKey('hashTagInline')
const HASH_TAG_IMMEDIATE = /(^|[\s\ufffc])#([a-zA-Z0-9])$/
const TAG_CHAR_PATTERN = /^[a-zA-Z0-9_\-/]$/
const TRAILING_TAG_CHARS = /\ufffc([a-zA-Z0-9_\-/]+)$/

export function matchHashTagImmediate(text: string): string | null {
  const match = text.match(HASH_TAG_IMMEDIATE)
  return match ? match[2].toLowerCase() : null
}

export function matchTrailingTagChars(text: string): { chars: string; offset: number } | null {
  const match = text.match(TRAILING_TAG_CHARS)
  if (!match) return null
  return { chars: match[1], offset: match.index! }
}

export function isTagChar(char: string): boolean {
  return TAG_CHAR_PATTERN.test(char)
}

export function extendTagName(currentTag: string, chars: string): string {
  return (currentTag + chars).toLowerCase()
}

export function shrinkTagName(currentTag: string): string | null {
  if (currentTag.length <= 1) return null
  return currentTag.slice(0, -1)
}

function getHashTagBeforeCursor(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = state.selection
  if ($from.parentOffset === 0) return null
  const nodeBefore = $from.nodeBefore
  if (nodeBefore?.type.name === 'hashTag') {
    return { node: nodeBefore, pos: $from.pos - nodeBefore.nodeSize }
  }
  return null
}

type GetTagColor = (tag: string) => string

export function createHashTagInlinePlugin(getTagColor: GetTagColor): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,

    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (event.key !== 'Backspace') return false

        const tagInfo = getHashTagBeforeCursor(view.state)
        if (!tagInfo) return false

        const currentTag = tagInfo.node.attrs.tag as string
        const newTag = shrinkTagName(currentTag)

        const hashTagNodeType = view.state.schema.nodes.hashTag
        if (!hashTagNodeType) return false

        if (newTag === null) {
          const tr = view.state.tr.delete(tagInfo.pos, tagInfo.pos + tagInfo.node.nodeSize)
          tr.setMeta(PLUGIN_KEY, true)
          view.dispatch(tr)
          return true
        }

        const color = getTagColor(newTag)
        const newNode = hashTagNodeType.create({ tag: newTag, color })
        const tr = view.state.tr.replaceWith(
          tagInfo.pos,
          tagInfo.pos + tagInfo.node.nodeSize,
          newNode
        )
        tr.setMeta(PLUGIN_KEY, true)
        view.dispatch(tr)
        return true
      }
    },

    appendTransaction(transactions, _oldState, newState) {
      const hasDocChange = transactions.some((tr) => tr.docChanged && !tr.getMeta(PLUGIN_KEY))
      if (!hasDocChange) return null

      const { selection } = newState
      const $from = selection.$from
      const parent = $from.parent

      if (parent.type.spec.code) return null

      const parentOffset = $from.parentOffset
      const textUpToCursor = parent.textBetween(0, parentOffset, undefined, '\ufffc')

      const hashTagNodeType = newState.schema.nodes.hashTag
      if (!hashTagNodeType) return null

      // Pattern 1: Immediate creation — #[letter] → create hashTag node
      const createTag = matchHashTagImmediate(textUpToCursor)
      if (createTag) {
        const endPos = $from.start() + parentOffset
        const leadingMatch = textUpToCursor.match(HASH_TAG_IMMEDIATE)!
        const prefixLen = leadingMatch[1].length
        const hashPos = endPos - 2 - prefixLen

        const color = getTagColor(createTag)
        const hashTagNode = hashTagNodeType.create({ tag: createTag, color })

        const tr = newState.tr.replaceWith(
          hashPos + prefixLen,
          endPos,
          Fragment.from([hashTagNode])
        )
        tr.setMeta(PLUGIN_KEY, true)
        return tr
      }

      // Pattern 2: Extension — hashTag node followed by tag-char text → absorb into tag
      const trailing = matchTrailingTagChars(textUpToCursor)
      if (trailing) {
        const absPos = $from.start() + trailing.offset
        const nodeAtPos = newState.doc.nodeAt(absPos)

        if (nodeAtPos?.type.name !== 'hashTag') return null

        const currentTag = nodeAtPos.attrs.tag as string
        const newTag = extendTagName(currentTag, trailing.chars)
        const color = getTagColor(newTag)
        const newNode = hashTagNodeType.create({ tag: newTag, color })

        const endPos = $from.start() + parentOffset
        const tr = newState.tr.replaceWith(absPos, endPos, Fragment.from([newNode]))
        tr.setMeta(PLUGIN_KEY, true)
        return tr
      }

      return null
    }
  })
}
