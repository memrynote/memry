interface OffsetMap {
  sourceToEditor: Array<number | null>
  editorToSource: Array<number | null>
}

export function markdownSourceOffsetToEditorOffset(
  markdown: string,
  sourceOffset: number
): number | null {
  if (sourceOffset < 0 || sourceOffset > markdown.length) return null
  return buildOffsetMap(markdown).sourceToEditor[sourceOffset] ?? null
}

export function editorOffsetToMarkdownSourceOffset(
  markdown: string,
  editorOffset: number
): number | null {
  if (editorOffset < 0) return null
  const map = buildOffsetMap(markdown)
  const trailingSeparatorStart = trailingNewlineRunStart(markdown)
  if (
    trailingSeparatorStart !== null &&
    map.sourceToEditor[trailingSeparatorStart] === editorOffset &&
    map.sourceToEditor[markdown.length] === editorOffset
  ) {
    return trailingSeparatorStart
  }
  return map.editorToSource[editorOffset] ?? null
}

export function proseMirrorDocPosToEditorOffset(doc: any, targetPos: number): number | null {
  const maxPos = proseMirrorDocContentSize(doc)
  if (targetPos < 0 || targetPos > maxPos) return null
  return proseMirrorTextBetween(doc, 0, targetPos).length
}

export function editorOffsetToProseMirrorDocPos(doc: any, editorOffset: number): number | null {
  const maxPos = proseMirrorDocContentSize(doc)
  const fullLength = proseMirrorTextBetween(doc, 0, maxPos).length
  if (editorOffset < 0 || editorOffset > fullLength) return null

  let low = 0
  let high = maxPos
  let best = maxPos

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const length = proseMirrorTextBetween(doc, 0, mid).length
    if (length >= editorOffset) {
      best = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return best
}

export function proseMirrorVisibleText(doc: any): string {
  return proseMirrorTextBetween(doc, 0, proseMirrorDocContentSize(doc))
}

function buildOffsetMap(markdown: string): OffsetMap {
  const sourceToEditor: Array<number | null> = Array(markdown.length + 1).fill(null)
  const editorToSource: Array<number | null> = []

  let source = 0
  let editor = 0
  let atLineStart = true

  const markSource = (index: number): void => {
    if (index >= 0 && index <= markdown.length) sourceToEditor[index] = editor
  }

  const markEditor = (offset: number, index: number): void => {
    editorToSource[offset] = index
  }

  const skipHidden = (length: number): void => {
    for (let offset = 0; offset <= length; offset++) {
      sourceToEditor[source + offset] = editor
    }
    source += length
    markEditor(editor, source)
  }

  const emitVisible = (char: string, sourceIndex: number): void => {
    sourceToEditor[sourceIndex] = editor
    markEditor(editor, sourceIndex)
    editor++
    sourceToEditor[sourceIndex + 1] = editor
    markEditor(editor, sourceIndex + 1)
  }

  markSource(0)
  markEditor(0, 0)

  while (source < markdown.length) {
    if (atLineStart) {
      const prefixLength = markdownLinePrefixLength(markdown.slice(source))
      if (prefixLength > 0) {
        skipHidden(prefixLength)
      }
      atLineStart = false
      if (source >= markdown.length) break
    }

    const wikiLink = readWikiLink(markdown, source)
    if (wikiLink) {
      skipHidden(wikiLink.openLength)
      for (let index = wikiLink.labelStart; index < wikiLink.labelEnd; index++) {
        emitVisible(markdown[index], index)
      }
      source = wikiLink.end
      sourceToEditor[source] = editor
      markEditor(editor, source)
      continue
    }

    const markdownLink = readMarkdownLink(markdown, source)
    if (markdownLink) {
      skipHidden(markdownLink.openLength)
      for (let index = markdownLink.labelStart; index < markdownLink.labelEnd; index++) {
        emitVisible(markdown[index], index)
      }
      source = markdownLink.end
      sourceToEditor[source] = editor
      markEditor(editor, source)
      continue
    }

    const codeSpan = readCodeSpan(markdown, source)
    if (codeSpan) {
      skipHidden(codeSpan.openLength)
      for (let index = codeSpan.contentStart; index < codeSpan.contentEnd; index++) {
        emitVisible(markdown[index], index)
      }
      source = codeSpan.end
      sourceToEditor[source] = editor
      markEditor(editor, source)
      continue
    }

    const char = markdown[source]

    if (char === '\n') {
      const runStart = source
      while (source < markdown.length && markdown[source] === '\n') source++
      const shouldEmit = editor > 0 && source < markdown.length
      sourceToEditor[runStart] = editor
      markEditor(editor, runStart)
      if (shouldEmit) {
        editor++
      }
      for (let index = runStart + 1; index <= source; index++) {
        sourceToEditor[index] = editor
      }
      markEditor(editor, source)
      atLineStart = true
      continue
    }

    if (isInlineFormattingMarker(char)) {
      const runLength = inlineMarkerRunLength(markdown, source)
      skipHidden(runLength)
      continue
    }

    if (markdown.startsWith('<!--', source)) {
      const end = markdown.indexOf('-->', source + 4)
      if (end !== -1) {
        skipHidden(end + 3 - source)
        continue
      }
    }

    emitVisible(char, source)
    source++
  }

  sourceToEditor[markdown.length] = editor
  markEditor(editor, markdown.length)

  return { sourceToEditor, editorToSource }
}

function markdownLinePrefixLength(line: string): number {
  const match = line.match(/^(#{1,6}\s+|>\s?|-\s+\[[ xX]\]\s+|(?:[-*+]|\d+\.)\s+)/)
  return match?.[0].length ?? 0
}

function readWikiLink(
  markdown: string,
  source: number
): { openLength: number; labelStart: number; labelEnd: number; end: number } | null {
  if (!markdown.startsWith('[[', source)) return null
  const close = markdown.indexOf(']]', source + 2)
  if (close === -1) return null
  const pipe = markdown.indexOf('|', source + 2)
  const hasAlias = pipe !== -1 && pipe < close
  return {
    openLength: hasAlias ? pipe + 1 - source : 2,
    labelStart: hasAlias ? pipe + 1 : source + 2,
    labelEnd: close,
    end: close + 2
  }
}

function readMarkdownLink(
  markdown: string,
  source: number
): { openLength: number; labelStart: number; labelEnd: number; end: number } | null {
  const isImage = markdown.startsWith('![', source)
  if (!isImage && markdown[source] !== '[') return null

  const labelStart = source + (isImage ? 2 : 1)
  const labelEnd = markdown.indexOf(']', labelStart)
  if (labelEnd === -1 || markdown[labelEnd + 1] !== '(') return null

  const destinationEnd = markdown.indexOf(')', labelEnd + 2)
  if (destinationEnd === -1) return null

  return {
    openLength: isImage ? 2 : 1,
    labelStart,
    labelEnd,
    end: destinationEnd + 1
  }
}

function readCodeSpan(
  markdown: string,
  source: number
): { openLength: number; contentStart: number; contentEnd: number; end: number } | null {
  if (markdown[source] !== '`') return null

  let tickCount = 0
  while (markdown[source + tickCount] === '`') tickCount++

  const close = markdown.indexOf('`'.repeat(tickCount), source + tickCount)
  if (close === -1) return null

  return {
    openLength: tickCount,
    contentStart: source + tickCount,
    contentEnd: close,
    end: close + tickCount
  }
}

function isInlineFormattingMarker(char: string): boolean {
  return char === '*' || char === '_' || char === '~'
}

function inlineMarkerRunLength(markdown: string, source: number): number {
  const char = markdown[source]
  let length = 0
  while (markdown[source + length] === char && length < 3) length++
  return length
}

function trailingNewlineRunStart(markdown: string): number | null {
  if (!markdown.endsWith('\n')) return null
  let index = markdown.length
  while (index > 0 && markdown[index - 1] === '\n') index--
  return index
}

function proseMirrorDocContentSize(doc: any): number {
  return doc?.content?.size ?? Math.max(0, (doc?.nodeSize ?? 2) - 2)
}

function proseMirrorTextBetween(doc: any, from: number, to: number): string {
  return doc?.textBetween?.(from, to, '\n') ?? ''
}
