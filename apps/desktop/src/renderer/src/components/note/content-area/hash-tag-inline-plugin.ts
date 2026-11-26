import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { isInlineTagName, isInlineTagPrefix, TAG_CHAR } from '@memry/shared/inline-tags'

const PLUGIN_KEY = new PluginKey('hashTagInline')
/** Meta on the transaction that reads the text an input method just committed. */
const RECHECK = 'recheck'
const TAG_RUN = String.raw`(?:${TAG_CHAR}|\/)+`
const HASH_TAG_BEFORE_CURSOR = new RegExp(String.raw`(^|[\s\ufffc])#(${TAG_RUN})$`, 'u')
const TAG_CHAR_PATTERN = new RegExp(String.raw`^(?:${TAG_CHAR}|\/)$`, 'u')
const TRAILING_TAG_CHARS = new RegExp(String.raw`\ufffc(${TAG_RUN})$`, 'u')

/** The whole tag a word-starting `#` holds right before the cursor, if any. */
export function matchHashTagBeforeCursor(text: string): string | null {
  const tag = text.match(HASH_TAG_BEFORE_CURSOR)?.[2]
  return tag && isInlineTagName(tag) ? tag : null
}

export function matchTrailingTagChars(text: string): { chars: string; offset: number } | null {
  const match = text.match(TRAILING_TAG_CHARS)
  if (!match) return null
  return { chars: match[1], offset: match.index! }
}

export function isTagChar(char: string): boolean {
  return TAG_CHAR_PATTERN.test(char)
}

/** The chip's tag with `chars` typed after it, or null when the grammar would not read it back. */
export function extendTagName(currentTag: string, chars: string): string | null {
  const next = currentTag + chars
  return isInlineTagPrefix(next) ? next : null
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
  // An input method (Korean, Japanese, Chinese, accents) edits the doc while it
  // composes, and replacing that text with a chip would tear the composition:
  // `#ㅍ` is half of `#퓨`. Composing transactions are left alone, and once the
  // input method commits, the text before the cursor is read whole. The commit
  // may arrive together with the space or punctuation that ended it.
  let composedSinceRead = false

  return new Plugin({
    key: PLUGIN_KEY,

    props: {
      handleDOMEvents: {
        compositionend(view: EditorView): boolean {
          // After ProseMirror's own handler, which flushes the committed text
          // in a microtask. A new composition (the next Korean syllable) waits
          // for its own end.
          setTimeout(() => {
            if (view.isDestroyed || view.composing) return
            view.dispatch(view.state.tr.setMeta(PLUGIN_KEY, RECHECK))
          })
          return false
        }
      },

      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (event.key !== 'Backspace') return false

        const tagInfo = getHashTagBeforeCursor(view.state)
        if (!tagInfo) return false

        const currentTag: string = tagInfo.node.attrs.tag
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
      if (transactions.some((tr) => tr.getMeta('composition') !== undefined)) {
        composedSinceRead = true
        return null
      }
      const hasDocChange = transactions.some((tr) => tr.docChanged && !tr.getMeta(PLUGIN_KEY))
      const recheck = transactions.some((tr) => tr.getMeta(PLUGIN_KEY) === RECHECK)
      if (!hasDocChange && !recheck) return null
      const afterCommit = composedSinceRead
      composedSinceRead = false

      const { selection } = newState
      const $from = selection.$from
      const parent = $from.parent

      if (parent.type.spec.code) return null

      let textUpToCursor = parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
      if (afterCommit && /\s$/u.test(textUpToCursor)) {
        textUpToCursor = textUpToCursor.slice(0, -1)
      }
      const endPos = $from.start() + textUpToCursor.length

      const hashTagNodeType = newState.schema.nodes.hashTag
      if (!hashTagNodeType) return null

      // Creation: a `#` that starts a word, then a whole tag. Typing makes the
      // chip at its first letter; a commit, a paste or a digit-first tag
      // (`#2024년`) makes it from the whole run.
      const createTag = matchHashTagBeforeCursor(textUpToCursor)
      if (createTag) {
        const hashTagNode = hashTagNodeType.create({
          tag: createTag,
          color: getTagColor(createTag)
        })
        const tr = newState.tr.replaceWith(
          endPos - createTag.length - 1,
          endPos,
          Fragment.from([hashTagNode])
        )
        tr.setMeta(PLUGIN_KEY, true)
        return tr
      }

      // Extension: a chip followed by tag characters absorbs them.
      const trailing = matchTrailingTagChars(textUpToCursor)
      if (trailing) {
        const absPos = $from.start() + trailing.offset
        const nodeAtPos = newState.doc.nodeAt(absPos)

        if (nodeAtPos?.type.name !== 'hashTag') return null

        const currentTag: string = nodeAtPos.attrs.tag
        const newTag = extendTagName(currentTag, trailing.chars)
        if (newTag === null) return null
        const color = getTagColor(newTag)
        const newNode = hashTagNodeType.create({ tag: newTag, color })

        const tr = newState.tr.replaceWith(absPos, endPos, Fragment.from([newNode]))
        tr.setMeta(PLUGIN_KEY, true)
        return tr
      }

      return null
    }
  })
}
