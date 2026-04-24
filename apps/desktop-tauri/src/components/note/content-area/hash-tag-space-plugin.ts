import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'

const PLUGIN_KEY = new PluginKey('hashTagSpaceComplete')
const HASH_TAG_BEFORE_CURSOR = /(^|[\s\ufffc])#([a-zA-Z0-9][a-zA-Z0-9_\-/]*[a-zA-Z0-9_-]) $/

export function matchHashTagBeforeCursor(text: string): string | null {
  const match = text.match(HASH_TAG_BEFORE_CURSOR)
  return match ? match[2].toLowerCase() : null
}

type GetTagColor = (tag: string) => string

export function createHashTagSpacePlugin(getTagColor: GetTagColor): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,

    appendTransaction(transactions, _oldState, newState) {
      const hasDocChange = transactions.some((tr) => tr.docChanged && !tr.getMeta(PLUGIN_KEY))
      if (!hasDocChange) return null

      const { selection } = newState
      const $from = selection.$from
      const parent = $from.parent

      if (parent.type.spec.code) return null

      const parentOffset = $from.parentOffset
      const textUpToCursor = parent.textBetween(0, parentOffset, undefined, '\ufffc')

      const match = textUpToCursor.match(HASH_TAG_BEFORE_CURSOR)
      if (!match) return null

      const tag = match[2].toLowerCase()
      const endPos = $from.start() + parentOffset
      const hashPos = endPos - tag.length - 2

      const hashTagNodeType = newState.schema.nodes.hashTag
      if (!hashTagNodeType) return null

      const color = getTagColor(tag)
      const hashTagNode = hashTagNodeType.create({ tag, color })
      const spaceText = newState.schema.text(' ')

      const tr = newState.tr.replaceWith(hashPos, endPos, Fragment.from([hashTagNode, spaceText]))
      tr.setMeta(PLUGIN_KEY, true)
      return tr
    }
  })
}
