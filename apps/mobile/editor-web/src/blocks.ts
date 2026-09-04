import {
  createBlockSpec,
  createToggleListItemBlockSpec,
  createToggleWrapper,
  type ExtensionFactoryInstance
} from '@blocknote/core'
import {
  bookmarkConfig,
  calloutConfig,
  CALLOUT_TYPE_VALUES,
  fileBlockConfig,
  taskBlockConfig,
  toggleListItemConfig,
  youtubeEmbedConfig
} from '@memry/editor-schema/blocks'
import { blockExternalHTML } from '@memry/editor-schema/server'
import { icon, type IconName } from './icons.ts'

/**
 * Touch presentation for Memry's six custom blocks.
 *
 * Every spec here takes its config and its `toExternalHTML` from
 * `@memry/editor-schema` unchanged, so the vault bytes are the ones the main
 * process already writes: `> [!info]`, `- [ ] title {task:id}`,
 * `<!-- file:{…} -->`, `![embed](url)`, `![bookmark](url)`, `<li><p>`. Only
 * `render` is new, and `render` never reaches disk for these blocks — the
 * converter serializes them through `toExternalHTML`.
 *
 * What each one replaces is the main process's SERIALIZATION DOM, which mobile
 * was falling through to: a file block was an HTML comment and therefore
 * invisible, a callout printed a literal `[!info]`, a task block trailed a raw
 * `{task:id}`, and bookmark and embed were `<img src=https://…>` that the
 * WebView's CSP (`img-src data: blob:`) blocks outright.
 *
 * No renderer below emits a remote `<img>` or an `<a href>`. A remote image
 * cannot load under that CSP and would be turned into the 96px pending
 * placeholder by `images.ts`; a tapped `<a href>` navigates the WebView off the
 * editor document, and the guest-to-host protocol has no message that opens a
 * URL externally (see `@memry/contracts/webview-bridge`).
 */

const CALLOUT_ICONS: Record<(typeof CALLOUT_TYPE_VALUES)[number], IconName> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
  success: 'success'
}

function calloutType(value: string): (typeof CALLOUT_TYPE_VALUES)[number] {
  return CALLOUT_TYPE_VALUES.find((known) => known === value) ?? 'info'
}

/**
 * Attachment size for a reader, not for a machine. Local to this file because
 * nothing else in the bundle formats bytes, and a shared helper for one caller
 * is a layer the reader has to walk through to learn what `12.4 KB` means.
 */
export function formatFileSize(bytes: unknown): string {
  // Coerced, not trusted: a prop seeded straight into the shared Y.Doc arrives
  // as a STRING, which is the landmine `toWidth` and `toChecked` already exist
  // for in the inline specs. `Number.isFinite('248512')` is false, so a guard
  // that skipped the coercion would print `0 B` for every synced attachment.
  const value = Number(bytes)
  const size = Number.isFinite(value) && value > 0 ? value : 0
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

/** `example.com` from a URL, or `''` when it is not one. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

const defaultToggleSpec = createToggleListItemBlockSpec()

/**
 * `assertSpecKeysMatchNodeTypes` is not reachable from any of this package's
 * public subpaths, so the key-equals-config.type check (#1455) is left where it
 * cannot be routed around: `createMemrySchema` runs it over exactly this map on
 * the way in.
 */
export function createTouchBlockSpecs() {
  return {
    taskBlock: createBlockSpec(taskBlockConfig, {
      render(block, editor) {
        // Read strictly, like desktop's own readers of this prop: the schema
        // declares a boolean default and `props.checked === true` is what
        // mind-map projection and the task reconciler both compare against.
        const checked = block.props.checked === true
        const title = block.props.title

        const dom = document.createElement('div')
        dom.className = 'task-block'
        dom.setAttribute('data-checked', String(checked))
        if (block.props.parentTaskId) dom.setAttribute('data-nested', 'true')

        const check = document.createElement('button')
        check.className = 'task-check'
        check.type = 'button'
        check.setAttribute('role', 'checkbox')
        check.setAttribute('aria-checked', String(checked))
        check.setAttribute('aria-label', title || 'Task')
        check.appendChild(icon(checked ? 'check-circle' : 'circle'))

        const label = span('task-title', title || 'Untitled task')
        if (!title) label.setAttribute('data-empty', 'true')

        dom.append(check, label)

        // Bound to the control, not to the whole row. The row carries the task
        // title, and a reader who taps a line of text to read it must not tick
        // somebody's task off on every synced device.
        const onMouseDown = (event: Event): void => event.preventDefault()
        const onPointerUp = (event: Event): void => {
          event.preventDefault()
          editor.updateBlock(block, { props: { checked: !checked } })
        }
        check.addEventListener('mousedown', onMouseDown)
        check.addEventListener('pointerup', onPointerUp)

        return {
          dom,
          destroy: () => {
            check.removeEventListener('mousedown', onMouseDown)
            check.removeEventListener('pointerup', onPointerUp)
          }
        }
      },
      toExternalHTML: blockExternalHTML.taskBlock
    })(),

    callout: createBlockSpec(calloutConfig, {
      render(block) {
        const type = calloutType(block.props.type)

        const dom = document.createElement('div')
        dom.className = 'callout'
        dom.setAttribute('data-callout-type', type)

        const glyph = span('callout-icon')
        glyph.appendChild(icon(CALLOUT_ICONS[type]))

        const content = document.createElement('div')
        content.className = 'callout-content'

        dom.append(glyph, content)
        return { dom, contentDOM: content }
      },
      toExternalHTML: blockExternalHTML.callout
    })(),

    file: createBlockSpec(fileBlockConfig, {
      render(block) {
        const { url, name, size } = block.props

        const dom = document.createElement('div')
        dom.className = 'file-block'

        const glyph = span('file-icon')
        glyph.appendChild(icon('file'))

        const body = span('file-body')
        body.appendChild(span('file-name', name || url || 'Attachment'))
        if (Number(size) > 0) body.appendChild(span('file-meta', formatFileSize(size)))

        dom.append(glyph, body)
        return { dom }
      },
      toExternalHTML: blockExternalHTML.file
    })(),

    youtubeEmbed: createBlockSpec(youtubeEmbedConfig, {
      render(block) {
        const { videoId, videoUrl } = block.props

        const dom = document.createElement('div')
        dom.className = 'embed-block'
        dom.setAttribute('data-embed', 'youtube')

        const glyph = span('embed-icon')
        glyph.appendChild(icon('play'))

        const body = span('embed-body')
        body.appendChild(span('embed-title', 'YouTube'))
        const target = videoUrl || videoId
        if (target) body.appendChild(span('embed-url', target))

        dom.append(glyph, body)
        return { dom }
      },
      toExternalHTML: blockExternalHTML.youtubeEmbed
    })(),

    bookmark: createBlockSpec(bookmarkConfig, {
      render(block) {
        const { url, domain, title, description, siteName } = block.props
        const hostname = hostnameOf(url)

        const dom = document.createElement('div')
        dom.className = 'bookmark-block'

        const glyph = span('bookmark-icon')
        glyph.appendChild(icon('link'))

        const body = span('bookmark-body')
        body.appendChild(span('bookmark-title', title || hostname || url || 'Bookmark'))
        if (description) body.appendChild(span('bookmark-description', description))
        const site = siteName || domain || hostname
        if (site) body.appendChild(span('bookmark-site', site))

        // `image` and `favicon` are deliberately not drawn. Both are remote
        // http(s) URLs, which the WebView's CSP (`img-src data: blob:`) refuses;
        // an `<img>` pointing at one would be claimed by `images.ts` and shown
        // as a 96px dashed "not downloaded yet" placeholder, which is a worse
        // lie than no picture at all.
        dom.append(glyph, body)
        return { dom }
      },
      toExternalHTML: blockExternalHTML.bookmark
    })(),

    toggleListItem: createBlockSpec(
      toggleListItemConfig,
      {
        // Props-backed rather than BlockNote's `defaultToggledState`, which
        // reads and writes `window.localStorage`. `assertNoWebStorage()` in
        // `bridge.ts` clears web storage outright on every load, so here the
        // prop is not merely the better home for the fold — it is the only one
        // that survives.
        render(block, editor) {
          const paragraph = document.createElement('p')
          const wrapper = createToggleWrapper(block as never, editor as never, paragraph, {
            get: (toggle) =>
              (toggle as unknown as { props: { open?: boolean } }).props.open === true,
            set: (toggle, isToggled) =>
              editor.transact(() => editor.updateBlock(toggle, { props: { open: isToggled } }))
          })

          return { ...wrapper, contentDOM: paragraph }
        },
        toExternalHTML: blockExternalHTML.toggleListItem
      },
      // BlockNote hangs the Enter and Mod-Shift-6 handlers off its own spec, and
      // an override replaces the whole spec object. Reused rather than
      // reimplemented: the handler they call is not public surface.
      defaultToggleSpec.extensions as ExtensionFactoryInstance[] | undefined
    )()
  }
}
