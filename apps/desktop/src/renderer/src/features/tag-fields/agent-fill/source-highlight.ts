const HIGHLIGHT_NAME = 'field-fill-source'

function findRange(root: Element, text: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let joined = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(joined.length)
    joined += node.nodeValue ?? ''
  }
  const at = joined.indexOf(text)
  if (at < 0) return null
  const locate = (offset: number): [Text, number] => {
    let index = starts.length - 1
    while (index > 0 && starts[index] > offset) index--
    return [nodes[index], offset - starts[index]]
  }
  const range = document.createRange()
  range.setStart(...locate(at))
  range.setEnd(...locate(at + text.length))
  return range
}

function editorNear(from: Element): Element | null {
  for (let node: Element | null = from; node; node = node.parentElement) {
    const editor = node.querySelector('.ProseMirror')
    if (editor) return editor
  }
  return null
}

export function highlightSource(from: Element | null, text: string): void {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  CSS.highlights.delete(HIGHLIGHT_NAME)
  if (!from || !text) return
  const editor = editorNear(from)
  const range = editor ? findRange(editor, text) : null
  if (range) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range))
}

export function clearSourceHighlight(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(HIGHLIGHT_NAME)
}
