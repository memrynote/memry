import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import { isInlineTagName } from '@memry/shared/inline-tags'

const PLUGIN_KEY = new PluginKey('hashTagSpaceComplete')
const HASH_TAG_BEFORE_CURSOR = /(^|[\s\ufffc])#([a-zA-Z0-9_\-/]{2,}) $/

export function matchHashTagBeforeCursor(text: string): string | null {
  const tag = text.match(HASH_TAG_BEFORE_CURSOR)?.[2]
  return tag && isInlineTagName(tag) ? tag : null
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

      const tag = matchHashTagBeforeCursor(textUpToCursor)
      if (!tag) return null

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
