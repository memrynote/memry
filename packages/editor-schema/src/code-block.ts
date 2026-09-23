import { codeBlockOptions, syntaxHighlighter } from '@blocknote/code-block'
import type { CodeBlockOptions } from '@blocknote/core'

/**
 * BlockNote's code block options plus the languages its shiki bundle lacks.
 *
 * Keys are shiki's grammar names: BlockNote resolves a fence tag or dropdown
 * value to a key through `supportedLanguages`, then asks the highlighter for
 * that grammar.
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
  })
} satisfies CodeBlockOptions

/**
 * Syntax highlighting, which BlockNote 0.51 moved off `codeBlockOptions` and
 * into an editor extension. A surface that wants colour adds this to
 * `extensions`; one that cannot afford shiki's bytes adds nothing and still
 * gets the same node with the same props.
 *
 * Re-exported rather than rebuilt. Two things we used to hand-roll are now
 * upstream behaviour:
 *
 * - **Dual-theme output.** We used to seed `Symbol.for('blocknote.shikiParser')`
 *   with a parser configured `defaultColor: false` so shiki emitted
 *   `--shiki-light` / `--shiki-dark` CSS variables and a theme toggle needed no
 *   re-highlight. 0.54 does exactly that itself: `pickThemeOptions` reads the
 *   highlighter's loaded themes and, finding a light and a dark one, passes
 *   `{ themes: { light, dark }, defaultColor: false }` to `createParser`. The
 *   stock highlighter loads `github-light` and `github-dark`, so the behaviour
 *   the hack existed for is now the default.
 * - **Grammar loading.** The plugin calls `loadLanguage` lazily per language
 *   instead of us pre-loading at highlighter construction.
 *
 * `powershell` and `kusto` stay in `supportedLanguages` above: the dropdown,
 * the block's `language` prop and the markdown fence are unchanged, so nothing
 * a user has written moves and a fence tagged either way still round-trips.
 * What they lose is colour. BlockNote's precompiled bundle carries neither
 * grammar, and `@blocknote/code-block` exports only `codeBlockOptions` and
 * this extension — not the highlighter it configures — so there is nothing
 * left to call `loadLanguage` on.
 *
 * Restorable, but not cheaply: `SyntaxHighlightingExtension` from
 * `@blocknote/core/extensions` takes a `createHighlighter`, so we could build
 * our own bundled highlighter carrying the two extra grammars. That means
 * restating BlockNote's ~48-language loader map here and keeping it in step
 * with theirs, whose failure mode — a silently stale language list — is worse
 * than the one it fixes. A language the bundle lacks is skipped once and
 * remembered, so today it costs a plain-text render and nothing else.
 */
export const memrySyntaxHighlighter = syntaxHighlighter
