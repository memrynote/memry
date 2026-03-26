import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

const PLUGIN_KEY = new PluginKey('hashTagInline')
const HASH_TAG_IMMEDIATE = /(^|[\s\ufffc])#([a-zA-Z])$/
const TAG_CHAR_PATTERN = /^[a-zA-Z0-9_-]$/

export function matchHashTagImmediate(text: string): string | null {
  const match = text.match(HASH_TAG_IMMEDIATE)
  return match ? match[2].toLowerCase() : null
}

export function isTagChar(char: string): boolean {
  return TAG_CHAR_PATTERN.test(char)
}

export function extendTagName(currentTag: string, char: string): string {
  return (currentTag + char).toLowerCase()
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
      handleTextInput(view: EditorView, from: number, _to: number, text: string): boolean {
        if (!isTagChar(text)) return false

        const tagInfo = getHashTagBeforeCursor(view.state)
        if (!tagInfo) return false

        const currentTag = tagInfo.node.attrs.tag as string
        const newTag = extendTagName(currentTag, text)
        const color = getTagColor(newTag)

        const hashTagNodeType = view.state.schema.nodes.hashTag
        if (!hashTagNodeType) return false

        const newNode = hashTagNodeType.create({ tag: newTag, color })
        const tr = view.state.tr.replaceWith(tagInfo.pos, from, newNode)
        tr.setMeta(PLUGIN_KEY, true)
        view.dispatch(tr)
        return true
      },

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

      const tag = matchHashTagImmediate(textUpToCursor)
      if (!tag) return null

      const hashTagNodeType = newState.schema.nodes.hashTag
      if (!hashTagNodeType) return null

      const endPos = $from.start() + parentOffset
      const leadingMatch = textUpToCursor.match(HASH_TAG_IMMEDIATE)
      const prefixLen = leadingMatch![1].length
      const hashPos = endPos - 2 - prefixLen

      const color = getTagColor(tag)
      const hashTagNode = hashTagNodeType.create({ tag, color })

      const tr = newState.tr.replaceWith(hashPos + prefixLen, endPos, Fragment.from([hashTagNode]))
      tr.setMeta(PLUGIN_KEY, true)
      return tr
    }
  })
}
