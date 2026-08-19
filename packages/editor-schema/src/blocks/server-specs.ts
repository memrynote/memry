/**
 * Headless block implementations for the main process.
 *
 * The main process needs these nodes registered for one reason only: it
 * converts the shared Y.Doc through y-prosemirror, whose response to a node
 * name its schema cannot build is to DELETE the element from the doc. A block
 * missing here is not a blank space in a preview — it is a replicated delete.
 *
 * So these carry the schema (from the shared configs) and the on-disk form
 * (from `./markdown`) — nothing else. `render` is not presentation here: it
 * emits exactly what `toExternalHTML` emits, and it never throws. A throwing
 * render is not a safe assertion, it is a note that silently stops writing
 * back — `blocksToMarkdownLossy` reaches `render` for anything BlockNote
 * serializes without a `toExternalHTML`, and one throw makes `yDocToMarkdown`
 * return null for the whole document.
 *
 * Every DOM below is chosen for what BlockNote's HTML→markdown step turns it
 * into, verified byte-for-byte against the marker each block already has on
 * disk (see blocknote-converter.test.ts):
 *
 *   img[alt=embed]    → `![embed](url)`
 *   img[alt=bookmark] → `![bookmark](url)`
 *   comment node      → `<!-- file:{…} -->`, passed through raw
 *   blockquote        → `> [!type]` + one `> ` per content line
 *   checkbox li       → `- [ ] title {task:id}`
 */

import { createBlockSpec } from '@blocknote/core'
import { serializeTaskBlock, type TaskBlockProps } from '@memry/shared/task-block'
import {
  bookmarkConfig,
  calloutConfig,
  fileBlockConfig,
  taskBlockConfig,
  youtubeEmbedConfig
} from './configs'
import { fileBlockCommentData, type FileBlockProps } from './markdown'
import { assertSpecKeysMatchNodeTypes } from '../spec-keys'

/**
 * A block whose markdown is a plain `![alt](url)` embed. A real `<img>` is what
 * makes the HTML→markdown step emit the marker byte-for-byte; a `<p>` holding
 * the same text would come back escaped (`!\[embed]\(…\)`).
 */
function imageEmbedDom(url: string, alt: string): { dom: HTMLElement } {
  const dom = document.createElement('div')
  const img = document.createElement('img')
  img.setAttribute('src', url)
  img.setAttribute('alt', alt)
  dom.appendChild(img)
  return { dom }
}

function youtubeEmbedDom(block: { props: { videoUrl: string } }): { dom: HTMLElement } {
  return imageEmbedDom(block.props.videoUrl || '', 'embed')
}

function bookmarkDom(block: { props: { url: string } }): { dom: HTMLElement } {
  return imageEmbedDom(block.props.url || '', 'bookmark')
}

/**
 * The file marker is an HTML comment, so it is emitted as a real comment node:
 * the serializer passes comments through as raw HTML and escapes everything
 * else, which is the difference between `<!-- file:{…} -->` reaching the vault
 * file and `\<!-- file:...` doing so.
 */
function fileDom(block: { props: Partial<FileBlockProps> }): { dom: HTMLElement } {
  const props: FileBlockProps = {
    url: block.props.url ?? '',
    name: block.props.name ?? '',
    size: block.props.size ?? 0,
    mimeType: block.props.mimeType ?? '',
    width: block.props.width ?? 0,
    height: block.props.height ?? 0,
    align: block.props.align
  }
  const dom = document.createElement('div')
  dom.appendChild(document.createComment(fileBlockCommentData(props)))
  return { dom }
}

/**
 * `> [!type]` on the first line, then the content — the shape the editor's own
 * save path writes (`serializeCalloutBlock`). The marker and the content share
 * ONE paragraph, separated by a `<br>`: a second `<p>` would serialize as a
 * blank `>` line between them and rewrite every callout on disk.
 */
function calloutDom(block: { props: { type: string } }): {
  dom: HTMLElement
  contentDOM: HTMLElement
} {
  const dom = document.createElement('blockquote')
  const paragraph = document.createElement('p')
  paragraph.appendChild(document.createTextNode(`[!${block.props.type || 'info'}]`))
  paragraph.appendChild(document.createElement('br'))
  const content = document.createElement('span')
  paragraph.appendChild(content)
  dom.appendChild(paragraph)
  return { dom, contentDOM: content }
}

/**
 * A GFM task-list item, which is exactly the `- [ ] title {task:id}` line the
 * vault already holds. Top-level task blocks never reach this — the converter
 * serializes those itself — but a task nested under a list item does, and this
 * spec's `render` used to throw there, taking the whole note's write-back with it.
 */
function taskBlockDom(block: { props: unknown }): { dom: HTMLElement } {
  const props = block.props as TaskBlockProps
  const dom = document.createElement('ul')
  const item = document.createElement('li')
  const checkbox = document.createElement('input')
  checkbox.setAttribute('type', 'checkbox')
  if (props.checked) checkbox.setAttribute('checked', '')
  item.appendChild(checkbox)
  item.appendChild(document.createTextNode(serializeTaskBlock(props).replace(/^- \[[ x]\] /, '')))
  dom.appendChild(item)
  return { dom }
}

/**
 * The keys below are what BlockNote keys its `blockSchema` by; each spec's
 * `config.type` is what ProseMirror builds. Asserted equal rather than assumed
 * — see spec-keys.ts (#1455).
 */
export function createServerBlockSpecs() {
  const registered = {
    taskBlock: createBlockSpec(taskBlockConfig, {
      render: taskBlockDom,
      toExternalHTML: taskBlockDom
    })(),
    callout: createBlockSpec(calloutConfig, {
      render: calloutDom,
      toExternalHTML: calloutDom
    })(),
    file: createBlockSpec(fileBlockConfig, {
      render: fileDom,
      toExternalHTML: fileDom
    })(),
    youtubeEmbed: createBlockSpec(youtubeEmbedConfig, {
      render: youtubeEmbedDom,
      toExternalHTML: youtubeEmbedDom
    })(),
    bookmark: createBlockSpec(bookmarkConfig, {
      render: bookmarkDom,
      toExternalHTML: bookmarkDom
    })()
  }
  assertSpecKeysMatchNodeTypes('blockSpecs (createServerBlockSpecs)', registered)
  return registered
}
