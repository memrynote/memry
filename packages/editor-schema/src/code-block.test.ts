import { describe, expect, it } from 'vitest'
import { codeBlockOptions } from '@blocknote/code-block'
import { memryCodeBlockOptions, memrySyntaxHighlighter } from './code-block'

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

  it('no longer carries a highlighter factory of its own', () => {
    // #given BlockNote 0.51 moved syntax highlighting off the code-block
    // options and into an editor extension. A stale `createHighlighter` here
    // would be silently ignored — the options object is only read for its
    // language map and default — so its absence is the contract.

    // #then
    expect('createHighlighter' in memryCodeBlockOptions).toBe(false)
  })

  it('exports the highlighting extension a surface opts into', () => {
    // #given `extensions: [memrySyntaxHighlighter]` is what turns colour on;
    // a surface that cannot afford shiki's bytes passes nothing and still gets
    // the same node with the same props (#2032).

    // #then
    expect(typeof memrySyntaxHighlighter).toBe('function')
  })
})
