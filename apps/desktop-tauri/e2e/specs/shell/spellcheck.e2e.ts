import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import type { TauriApp } from '../../harness/tauri-lifecycle'
import { invoke } from '../../harness/vault-commands'
import { pollUntil, readMainLog } from '../../harness/wait'

interface SpellResult {
  available: boolean
  misspelled: boolean
  suggestions: string[]
}

const check = (page: Page, word: string) => invoke<SpellResult>(page, 'spell_check_word', { word })

// The Windows checker loads its dictionary on first use. On a busy runner the load outlasted the
// five seconds a call waits, so the call answered with no suggestions or a failed add (#3888).
// A headless Linux runner may have no Enchant dictionary; there is nothing to load, and the page
// shows no suggestions, which the unit tests cover.
async function dictionary(app: TauriApp): Promise<'loaded' | 'none'> {
  const state = await pollUntil(
    async () => {
      const ready = await invokeTest<boolean | null>(app, 'e2e_spell_ready')
      return ready === null ? ('none' as const) : ready && ('loaded' as const)
    },
    { timeoutMs: 60_000 }
  )
  expect(['loaded', 'none']).toContain(state ?? 'still loading after 60 s')
  return state ?? 'none'
}

test('a misspelled word comes back with suggestions and a correct one does not', async ({
  app,
  page
}) => {
  test.skip((await dictionary(app)) === 'none', 'no spell dictionary on this machine')
  const typo = await check(page, 'teh')
  expect(typo.misspelled).toBe(true)
  expect(typo.suggestions).toContain('the')
  expect(typo.suggestions.length).toBeLessThanOrEqual(8)

  expect(await check(page, 'hello')).toMatchObject({ available: true, misspelled: false })
})

test('a word added to the personal dictionary stops being misspelled', async ({ app, page }) => {
  test.skip((await dictionary(app)) === 'none', 'no spell dictionary on this machine')
  // Nonsense that no dictionary knows and no word list will ever contain, fresh per attempt:
  // Windows and Linux keep an added word for the OS user, so a retry of the same word found it
  // already learned.
  const suffix = Array.from({ length: 6 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26))
  ).join('')
  const word = `memrzqxwv${suffix}`
  const before = await check(page, word)
  expect(before).toMatchObject({ available: true, misspelled: true })
  try {
    const added = await invoke<boolean>(page, 'spell_add_word', { word })
    // A refusal fails with the app's spelling log, which says whether the platform refused or
    // did not answer in time.
    const refusal = readMainLog(app.dirs.logDir)
      .split('\n')
      .filter((line) => line.includes('[Spell]'))
    expect(added ? 'added' : refusal.join('\n')).toBe('added')
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
