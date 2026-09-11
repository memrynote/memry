import { describe, expect, it } from 'vitest'
import { codeBlockOptions } from '@blocknote/code-block'
import { memryCodeBlockOptions } from './code-block'

describe('memryCodeBlockOptions', () => {
  it('adds PowerShell and KQL to the language picker', () => {
    // #when / #then
    expect(memryCodeBlockOptions.supportedLanguages.powershell).toEqual({
      name: 'PowerShell',
      aliases: ['powershell', 'pwsh', 'ps1', 'ps']
    })
    expect(memryCodeBlockOptions.supportedLanguages.kusto).toEqual({
      name: 'KQL (Kusto)',
      aliases: ['kusto', 'kql']
    })
  })

  it('keeps every language BlockNote ships', () => {
    // #given the additions are a spread, not a fork, so BlockNote's future
    // language additions keep flowing through.
    for (const key of Object.keys(codeBlockOptions.supportedLanguages)) {
      // #when / #then
      expect(memryCodeBlockOptions.supportedLanguages).toHaveProperty(key)
    }
    expect(memryCodeBlockOptions.supportedLanguages).toHaveProperty('shellscript')
    expect(memryCodeBlockOptions.supportedLanguages).toHaveProperty('sql')
  })

  it('lists the languages alphabetically, Plain Text first', () => {
    // #given the dropdown renders this map in insertion order.
    const names = Object.values(memryCodeBlockOptions.supportedLanguages).map((l) => l.name)

    // #then
    expect(names[0]).toBe('Plain Text')
    const rest = names.slice(1)
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)))
    expect(rest).toContain('PowerShell')
    expect(rest).toContain('KQL (Kusto)')
  })

  it('keeps BlockNote’s default language, which the prop schema carries', () => {
    // #then a differing default flips the language on a code block written by
    // a surface that skipped the highlighter (see CODE_BLOCK_DEFAULTS).
    expect(memryCodeBlockOptions.defaultLanguage).toBe('javascript')
  })

  it('loads both grammars into the highlighter up front', async () => {
    // #given BlockNote's resolver calls `loadLanguage(key)` for a key it has
    // not loaded, which throws for anything outside its bundle.

    // #when
    const highlighter = await memryCodeBlockOptions.createHighlighter()

    // #then
    expect(highlighter.getLoadedLanguages()).toEqual(
      expect.arrayContaining(['powershell', 'kusto'])
    )
  })

  it.each([
    ['powershell', 'Get-ChildItem | Where-Object { $_.Length -gt 1kb }'],
    ['kusto', 'StormEvents | where State == "TEXAS" | count']
  ])('tokenizes %s, not just registers it', async (lang, code) => {
    // #given registering a grammar name is not the same as having a grammar
    // that produces spans — more than one colour proves it actually tokenized.
    const highlighter = await memryCodeBlockOptions.createHighlighter()

    // #when
    const tokens = highlighter.codeToTokensBase(code, {
      lang: lang as Parameters<typeof highlighter.codeToTokensBase>[1]['lang'],
      theme: 'github-dark'
    })

    // #then
    const colors = new Set(tokens.flat().map((token) => token.color))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('hands BlockNote a parser that emits both themes as CSS variables', async () => {
    // #given BlockNote reuses `globalThis[Symbol.for('blocknote.shikiParser')]`
    // if it is already set, which is how the dual-theme options get in. Without
    // it every token is github-dark, unreadable on the light theme.

    // #when
    await memryCodeBlockOptions.createHighlighter()
    const parser = (globalThis as Record<symbol, unknown>)[
      Symbol.for('blocknote.shikiParser')
    ] as (args: { content: string; language: string; pos: number; size: number }) => {
      type: { attrs?: Record<string, unknown> }
    }[]
    const decorations = parser({
      // powershell, because `createHighlighter` loads it eagerly; BlockNote's
      // own grammars load on demand and are absent here.
      content: 'Get-ChildItem',
      language: 'powershell',
      pos: 0,
      size: 'Get-ChildItem'.length + 2
    })

    // #then
    const styles = decorations
      .map((decoration) => String(decoration.type.attrs?.style ?? ''))
      .join(' ')
    expect(styles).toContain('--shiki-light')
    expect(styles).toContain('--shiki-dark')
  })
})
