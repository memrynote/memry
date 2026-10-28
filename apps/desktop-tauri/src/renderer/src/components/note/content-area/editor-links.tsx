/**
 * How a BlockNote editor opens what it links to, in every editor of the app.
 *
 * A link click has exactly one opener: the click handler below, which claims the click and opens
 * the address half of the `href` (BBF-112). BlockNote's own opener (`links.onClick`) runs from
 * ProseMirror's mouseup, before the click; the click after it is unclaimed, so
 * `external-link-guard.ts` followed the raw `href` as well: a titled link opened twice, once with
 * its title in the URL. And BlockNote's buttons open with `window.open`, which on macOS opens
 * nothing (#3675), so the file download button is replaced here.
 */

import { blockHasType } from '@blocknote/core'
import {
  FormattingToolbar,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
  type FormattingToolbarProps
} from '@blocknote/react'
import { linkDestination } from '@memry/editor-schema/inline'
import { useEffect, type RefObject } from 'react'
import { openLink } from '@/lib/external-link-guard'
import { Download } from '@/lib/icons'
import { createLogger } from '@/lib/logger'

const log = createLogger('EditorLinks')

/** BlockNote's `links` option for every editor: its mouseup opener never opens. */
export const EDITOR_LINKS = { onClick: (): boolean => true }

/** Opens the clicked link by its address and claims the click, so the guard does not follow it. */
export function openClickedLink(event: MouseEvent, open: (href: string) => void = openLink): void {
  const href =
    event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : undefined
  if (!href || href.startsWith('#')) return
  event.preventDefault()
  open(linkDestination(href))
}

/** [`openClickedLink`] for every click inside `container`, for an editor without its own. */
export function useEditorLinkClicks(container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = container.current
    if (!element) return undefined
    const onClick = (event: MouseEvent): void => openClickedLink(event)
    element.addEventListener('click', onClick)
    return () => element.removeEventListener('click', onClick)
  }, [container])
}

/** BlockNote's `FileDownloadButton`, opening through the shell instead of `window.open`. */
function FileDownloadLinkButton(): React.JSX.Element | null {
  const Components = useComponentsContext()!
  const dict = useDictionary()
  const editor = useBlockNoteEditor()
  const block = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const blocks = current.getSelection()?.blocks ?? [current.getTextCursorPosition().block]
      if (blocks.length !== 1) return undefined
      const [only] = blocks
      return blockHasType(only, current, only.type, { url: 'string' }) ? only : undefined
    }
  })
  if (!block) return null
  const tooltips: Record<string, string> = dict.formatting_toolbar.file_download.tooltip
  const tooltip = tooltips[block.type] ?? tooltips.file
  const download = (): void => {
    editor.focus()
    const url = block.props.url
    Promise.resolve(editor.resolveFileUrl ? editor.resolveFileUrl(url) : url).then(
      openLink,
      (error: unknown) => log.warn('the file to download did not resolve', error)
    )
  }
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={tooltip}
      mainTooltip={tooltip}
      icon={<Download className="size-4" />}
      onClick={download}
    />
  )
}

/** BlockNote's default formatting toolbar, with [`FileDownloadLinkButton`]. */
export function EditorFormattingToolbar(props: FormattingToolbarProps): React.JSX.Element {
  return (
    <FormattingToolbar {...props}>
      {getFormattingToolbarItems(props.blockTypeSelectItems).map((item) =>
        item.key === 'fileDownloadButton' ? <FileDownloadLinkButton key={item.key} /> : item
      )}
    </FormattingToolbar>
  )
}
