import { createBlockSpecFromTiptapNode, suggestionMarks } from '@blocknote/core'
import { Node } from '@tiptap/core'

/**
 * The `columnList` / `column` nodes, headless.
 *
 * Node names, groups, content expressions and the `width` attribute are
 * `@blocknote/xl-multi-column`'s, byte for byte, so the desktop renderer can
 * swap in that package's `column` spec (resize handles, drag-to-column) while
 * the main process and the mobile WebView build the same ProseMirror node
 * without carrying the package's React. A node one surface cannot build is
 * DELETED from the shared Y.Doc by y-prosemirror, so every surface registers
 * these through `createMemrySchema`.
 *
 * `columnList` adds two attributes the package lacks, `regionId` and
 * `settings`: the Multi-Column Markdown id and settings fence the region was
 * read with (see `columns.ts`). They carry Obsidian's bytes through the
 * document so a Memry edit does not rewrite them.
 */

function stringDataAttribute(key: string, dataName: string) {
  return {
    default: '',
    parseHTML: (element: HTMLElement) => element.getAttribute(dataName) ?? '',
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[key]
      return typeof value === 'string' && value ? { [dataName]: value } : {}
    }
  }
}

function nodeTypeDiv(name: string, className: string, HTMLAttributes: Record<string, unknown>) {
  const dom = document.createElement('div')
  dom.className = className
  dom.setAttribute('data-node-type', name)
  for (const [attribute, value] of Object.entries(HTMLAttributes)) {
    if (value !== undefined && value !== null) dom.setAttribute(attribute, String(value))
  }
  return dom
}

function parseNodeTypeDiv(name: string) {
  return [
    {
      tag: 'div',
      getAttrs: (element: string | HTMLElement) =>
        typeof element !== 'string' && element.getAttribute('data-node-type') === name ? {} : false
    }
  ]
}

export const ColumnListNode = Node.create({
  name: 'columnList',
  group: 'childContainer bnBlock blockGroupChild',
  content: 'column column+',
  priority: 40,
  defining: true,
  marks() {
    return suggestionMarks(this.editor)
  },
  addAttributes() {
    return {
      regionId: stringDataAttribute('regionId', 'data-region-id'),
      settings: stringDataAttribute('settings', 'data-settings')
    }
  },
  parseHTML() {
    return parseNodeTypeDiv(this.name)
  },
  renderHTML({ HTMLAttributes }) {
    const dom = nodeTypeDiv(this.name, 'bn-block-column-list', HTMLAttributes)
    dom.style.display = 'flex'
    return { dom, contentDOM: dom }
  }
})

export const ColumnNode = Node.create({
  name: 'column',
  group: 'bnBlock childContainer',
  content: 'blockContainer+',
  priority: 40,
  defining: true,
  marks() {
    return suggestionMarks(this.editor)
  },
  addAttributes() {
    return {
      width: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const parsed = parseFloat(element.getAttribute('data-width') ?? '')
          return Number.isFinite(parsed) ? parsed : null
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-width': String(attributes.width),
          style: `flex-grow: ${String(attributes.width)};`
        })
      }
    }
  },
  parseHTML() {
    return parseNodeTypeDiv(this.name)
  },
  renderHTML({ HTMLAttributes }) {
    const dom = nodeTypeDiv(this.name, 'bn-block-column', HTMLAttributes)
    return { dom, contentDOM: dom }
  }
})

export function createColumnListBlockSpec() {
  return createBlockSpecFromTiptapNode(
    { node: ColumnListNode, type: 'columnList', content: 'none' },
    { regionId: { default: '' }, settings: { default: '' } }
  )
}

export function createColumnBlockSpec() {
  return createBlockSpecFromTiptapNode(
    { node: ColumnNode, type: 'column', content: 'none' },
    { width: { default: 1 } }
  )
}
