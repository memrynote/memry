import type { EditorView } from '@tiptap/pm/view'

interface PasteFallbackEditor {
  pasteHTML: (html: string) => void
  pasteText: (text: string) => boolean
}

/**
 * Paste the system clipboard into the editor from a menu, where there is no
 * paste event to ride on. The clipboard is read through the async Clipboard
 * API and replayed as a `paste` event on the editor DOM, so it runs the same
 * handlers a ⌘V does (BlockNote's paste pipeline, table cells, the link
 * menu, image upload). If nothing handled the event, BlockNote's own paste API
 * inserts the text.
 */
export async function pasteClipboardIntoEditor(
  view: EditorView,
  editor: PasteFallbackEditor
): Promise<void> {
  let html = ''
  let text = ''
  const files: File[] = []
  try {
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        if (type === 'text/html' && !html) {
          html = await (await item.getType(type)).text()
        } else if (type === 'text/plain' && !text) {
          text = await (await item.getType(type)).text()
        } else if (type.startsWith('image/')) {
          // An image on the clipboard reaches the editor the way a ⌘V hands
          // it over: as a file, which BlockNote's paste uploads as a block.
          const blob = await item.getType(type)
          const extension = type.slice('image/'.length).split('+')[0]
          files.push(new File([blob], `pasted-image.${extension}`, { type }))
        }
      }
    }
  } catch {
    // `read()` refuses some clipboard contents outright; plain text may still be there.
    text = await navigator.clipboard.readText()
  }
  if (!html && !text && files.length === 0) return

  const clipboardData = new DataTransfer()
  if (html) clipboardData.setData('text/html', html)
  if (text) clipboardData.setData('text/plain', text)
  for (const file of files) clipboardData.items.add(file)
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
  view.dom.dispatchEvent(event)
  if (event.defaultPrevented) return

  if (html) editor.pasteHTML(html)
  else if (text) editor.pasteText(text)
}
