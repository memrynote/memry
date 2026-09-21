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
 *   li > p            → `- summary`, for a toggle nested under a list item
 *   p with <br>s      → `$$` / source / `$$`, the math block's three lines
 */

import { addDefaultPropsExternalHTML, createBlockSpec } from '@blocknote/core'
import { serializeTaskBlock, type TaskBlockProps } from '@memry/shared/task-block'
import {
  bookmarkConfig,
  calloutConfig,
  fileBlockConfig,
  mathBlockConfig,
  taskBlockConfig,
  toggleListItemConfig,
  youtubeEmbedConfig
} from './configs'
import { fileBlockCommentData, serializeMathBlock, type FileBlockProps } from './markdown'
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
 *
 * That passthrough is `unified`'s behaviour, not a BlockNote guarantee — the
 * 0.51 serializer rewrite returns "" for every node that is not an element or
 * text. So the vault write-back no longer routes through here: the converter
 * serializes a top-level file block itself (`serializeFileBlock`), exactly as
 * the renderer always has. What still reaches this DOM is a file block nested
 * under a list item and any surface that serializes through BlockNote alone.
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
 *
 * The separator is omitted when the callout is empty. BlockNote 0.51+ turns
 * every `<br>` into a newline in the paragraph's text, so a trailing one on an
 * empty callout serialized as a second, blank quote line: `> [!info]` came
 * back as `> [!info]\n>`, which `serializeCalloutBlock` never writes and which
 * grew a line on the note every time it was opened.
 */
function calloutDom(block: { props: { type: string }; content?: unknown }): {
  dom: HTMLElement
  contentDOM: HTMLElement
} {
  const dom = document.createElement('blockquote')
  const paragraph = document.createElement('p')
  paragraph.appendChild(document.createTextNode(`[!${block.props.type || 'info'}]`))
  if (!Array.isArray(block.content) || block.content.length > 0) {
    paragraph.appendChild(document.createElement('br'))
  }
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
 *
 * The label is wrapped in a `<span>` rather than left as a bare text node. A
 * list-item serializer that reads the item's label from its first ELEMENT child
 * (BlockNote 0.51+ does; 0.47's rehype pipeline reads the text either way)
 * emits `- [x]` and drops a bare text node — the title AND the `{task:id}`
 * suffix, which is what makes the line a task at all. Byte-identical through
 * 0.47 with or without the wrapper; measured both.
 */
function taskBlockDom(block: { props: unknown }): { dom: HTMLElement } {
  const props = block.props as TaskBlockProps
  const dom = document.createElement('ul')
  const item = document.createElement('li')
  const checkbox = document.createElement('input')
  checkbox.setAttribute('type', 'checkbox')
  if (props.checked) checkbox.setAttribute('checked', '')
  item.appendChild(checkbox)
  const label = document.createElement('span')
  label.textContent = serializeTaskBlock(props).replace(/^- \[[ x]\] /, '')
  item.appendChild(label)
  dom.appendChild(item)
  return { dom }
}

/**
 * Byte-for-byte what BlockNote's own `toggleListItem` exports today. Main only
 * registers the block so that ProseMirror declares `open`: `computeAttrs` drops
 * every attribute the schema does not name, so without this spec main's
 * write-back would strip the fold off every toggle on every save. A toggle on a
 * page never reaches here — the converter serializes those as `<details>`
 * itself — but one nested under a list item does, and it must keep coming back
 * as the plain bullet it is on disk today.
 */
function toggleListItemDom(block: { props: Parameters<typeof addDefaultPropsExternalHTML>[0] }): {
  dom: HTMLElement
  contentDOM: HTMLElement
} {
  const li = document.createElement('li')
  const p = document.createElement('p')
  addDefaultPropsExternalHTML(block.props, li)
  li.appendChild(p)
  return { dom: li, contentDOM: p }
}

/**
 * The three `$$` lines as ONE paragraph, separated by `<br>`.
 *
 * Same shape, and the same reason, as the callout's marker line: BlockNote 0.51+
 * turns every `<br>` into a newline in the paragraph's text, so the paragraph
 * serializes to the three lines the vault already holds. A `<pre>` would come
 * back as a fenced code block, and three separate `<p>`s as three paragraphs
 * with blank lines between them — and a blank line inside the fence is exactly
 * what stops the run being read back as a block.
 *
 * Reached only for a math block nested under a list item and by surfaces that
 * serialize through BlockNote alone; a math block on a page is written by the
 * converters' own top-level walk, from `serializeMathBlock` directly.
 */
function mathBlockDom(block: { props: { latex?: string } }): { dom: HTMLElement } {
  const dom = document.createElement('p')
  const lines = serializeMathBlock(block.props.latex ?? '').split('\n')
  for (const [index, line] of lines.entries()) {
    if (index > 0) dom.appendChild(document.createElement('br'))
    dom.appendChild(document.createTextNode(line))
  }
  return { dom }
}

/**
 * The on-disk DOM of every custom block, by node name.
 *
 * Named separately from the specs below because it is not only main's. A
 * surface that supplies its own presentation still owes the vault these exact
 * bytes, and the mobile WebView is that surface: its touch renderers draw
 * cards, and the same block must still serialize to the `> [!info]` /
 * `- [ ] … {task:id}` / `<!-- file:{…} -->` line already sitting in the file.
 * Two implementations that have to agree is the drift this package exists to
 * prevent, so the second surface takes the first one's function rather than a
 * copy of its markup.
 */
export const blockExternalHTML = {
  taskBlock: taskBlockDom,
  callout: calloutDom,
  file: fileDom,
  youtubeEmbed: youtubeEmbedDom,
  bookmark: bookmarkDom,
  toggleListItem: toggleListItemDom,
  mathBlock: mathBlockDom
}

/**
 * The keys below are what BlockNote keys its `blockSchema` by; each spec's
 * `config.type` is what ProseMirror builds. Asserted equal rather than assumed
 * — see spec-keys.ts (#1455).
 */
export function createServerBlockSpecs() {
  const registered = {
    taskBlock: createBlockSpec(taskBlockConfig, {
      render: blockExternalHTML.taskBlock,
      toExternalHTML: blockExternalHTML.taskBlock
    })(),
    callout: createBlockSpec(calloutConfig, {
      render: blockExternalHTML.callout,
      toExternalHTML: blockExternalHTML.callout
    })(),
    file: createBlockSpec(fileBlockConfig, {
      render: blockExternalHTML.file,
      toExternalHTML: blockExternalHTML.file
    })(),
    youtubeEmbed: createBlockSpec(youtubeEmbedConfig, {
      render: blockExternalHTML.youtubeEmbed,
      toExternalHTML: blockExternalHTML.youtubeEmbed
    })(),
    bookmark: createBlockSpec(bookmarkConfig, {
      render: blockExternalHTML.bookmark,
      toExternalHTML: blockExternalHTML.bookmark
    })(),
    toggleListItem: createBlockSpec(toggleListItemConfig, {
      render: blockExternalHTML.toggleListItem,
      toExternalHTML: blockExternalHTML.toggleListItem
    })(),
    mathBlock: createBlockSpec(mathBlockConfig, {
      render: blockExternalHTML.mathBlock,
      toExternalHTML: blockExternalHTML.mathBlock
    })()
  }
  assertSpecKeysMatchNodeTypes('blockSpecs (createServerBlockSpecs)', registered)
  return registered
}
