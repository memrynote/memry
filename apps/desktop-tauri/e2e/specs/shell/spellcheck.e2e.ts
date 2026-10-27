import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { invoke } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface SpellResult {
  available: boolean
  misspelled: boolean
  suggestions: string[]
}

const check = (page: Page, word: string) => invoke<SpellResult>(page, 'spell_check_word', { word })

// A headless Linux runner may have no Enchant dictionary; `available: false` is then the answer
// and the page shows no suggestions, which the unit tests cover.
test('a misspelled word comes back with suggestions and a correct one does not', async ({
  page
}) => {
  const typo = await check(page, 'teh')
  test.skip(!typo.available, 'no spell dictionary on this machine')
  expect(typo.misspelled).toBe(true)
  expect(typo.suggestions).toContain('the')
  expect(typo.suggestions.length).toBeLessThanOrEqual(8)

  expect(await check(page, 'hello')).toMatchObject({ available: true, misspelled: false })
})

test('a word added to the personal dictionary stops being misspelled', async ({ app, page }) => {
  // Nonsense that no dictionary knows and no word list will ever contain.
  const word = 'memrzqxwv'
  const before = await check(page, word)
  test.skip(!before.available, 'no spell dictionary on this machine')
  expect(before.misspelled).toBe(true)
  try {
    expect(await invoke<boolean>(page, 'spell_add_word', { word })).toBe(true)
    const learned = await pollUntil(
      async () => !(await check(page, word)).misspelled || undefined,
      { timeoutMs: 5_000 }
    )
    expect(learned).toBe(true)
  } finally {
    await invokeTest(app, 'e2e_forget_spelled_word', { word })
  }
})

test('an empty or overlong word is refused without touching the dictionary', async ({ page }) => {
  expect(await invoke<boolean>(page, 'spell_add_word', { word: '   ' })).toBe(false)
  expect(await invoke<boolean>(page, 'spell_add_word', { word: 'a'.repeat(101) })).toBe(false)
})
