const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

const PREFIX_CHARS = 40
const MIN_PREFIX_CHARS = 12

/**
 * Which editor block holds a folded paragraph: the index into `blockTexts`, or
 * -1. The layers carry plain text and the editor's DOM text can differ in
 * markup-only ways, so an exact match is tried first, then a shared prefix.
 */
export function findParagraphBlock(blockTexts: readonly string[], paragraphText: string): number {
  const target = normalize(paragraphText)
  if (target === '') return -1
  const texts = blockTexts.map(normalize)

  const exact = texts.indexOf(target)
  if (exact !== -1) return exact

  const prefix = target.slice(0, PREFIX_CHARS)
  if (prefix.length < MIN_PREFIX_CHARS) return -1
  return texts.findIndex((text) => text.startsWith(prefix))
}
