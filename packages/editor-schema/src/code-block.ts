import { codeBlockOptions } from '@blocknote/code-block'
import type { CodeBlockOptions } from '@blocknote/core'

/**
 * BlockNote's code block options plus the languages its shiki bundle lacks.
 *
 * Keys are shiki's grammar names: BlockNote resolves a fence tag or dropdown
 * value to a key through `supportedLanguages`, then highlights only if
 * `getLoadedLanguages()` has that key — otherwise it asks the bundle, which
 * throws for anything outside BlockNote's map. So the extra grammars are loaded
 * here, once, right after BlockNote's factory runs.
 *
 * Kept out of the package root on purpose: mobile must not pull shiki (#2032).
 */

type SupportedLanguages = NonNullable<CodeBlockOptions['supportedLanguages']>

/**
 * The dropdown renders this map in insertion order, and BlockNote's own is not
 * sorted — its later additions (Haskell, C#, Kotlin, Objective C, ...) sit in a
 * tail after TSX. Appending ours would extend that tail, so the whole map is
 * ordered by display name instead, with Plain Text pinned first: it is the
 * "no language" choice, not a language, and belongs at the top of the list.
 */
function sortByDisplayName(languages: SupportedLanguages): SupportedLanguages {
  return Object.fromEntries(
    Object.entries(languages).sort(([keyA, a], [keyB, b]) => {
      if (keyA === 'text') return -1
      if (keyB === 'text') return 1
      return a.name.localeCompare(b.name)
    })
  )
}

export const memryCodeBlockOptions = {
  ...codeBlockOptions,
  supportedLanguages: sortByDisplayName({
    ...codeBlockOptions.supportedLanguages,
    powershell: { name: 'PowerShell', aliases: ['powershell', 'pwsh', 'ps1', 'ps'] },
    kusto: { name: 'KQL (Kusto)', aliases: ['kusto', 'kql'] }
  }),
  createHighlighter: async () => {
    const highlighter = await codeBlockOptions.createHighlighter()
    await highlighter.loadLanguage(
      () => import('@shikijs/langs-precompiled/powershell'),
      () => import('@shikijs/langs-precompiled/kusto')
    )
    return highlighter
  }
} satisfies CodeBlockOptions
