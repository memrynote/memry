const cache = new Map<string, Intl.Segmenter>()

/** Cached `Intl.Segmenter` for a script-based language tag ('und' falls back to English). */
export function segmenter(language: string, granularity: 'sentence' | 'word'): Intl.Segmenter {
  const key = `${language}:${granularity}`
  let seg = cache.get(key)
  if (!seg) {
    seg = new Intl.Segmenter(language === 'und' ? 'en' : language, { granularity })
    cache.set(key, seg)
  }
  return seg
}
