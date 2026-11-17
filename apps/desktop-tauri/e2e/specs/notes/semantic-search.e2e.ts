// Semantic search (#3540): with the local embedding model loaded, a note is found by meaning when
// the query shares no word with it, through `search_query` and the palette. The model is not
// downloaded here: `harness/embedding-model.ts` says why and when the spec runs. Electron has no
// spec of its own for this; the cases come from the #3540 work list.
import { appReady } from '../../harness/app-ready'
import { semanticSkipReason, seedModel } from '../../harness/embedding-model'
import { createNote, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { restart } from '../../harness/tauri-lifecycle'
import { invoke } from '../../harness/vault-commands'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Found {
  groups: Array<{ results: Array<{ id: string; snippet: string }> }>
}

interface ModelStatus {
  loaded: boolean
  error: string | null
}

test('a note is found by meaning with no shared word', async ({ app, page }) => {
  const unavailable = semanticSkipReason()
  test.skip(unavailable !== null, unavailable ?? '')
  test.slow()
  await appReady(page)
  await vaultOpen(page)
  // AI is on by default, so the vault open already asked for the model before it was seeded. A
  // relaunch on the same data loads it from the seeded cache.
  seedModel(app)
  await restart(app)
  await appReady(page)
  await vaultOpen(page)

  const suffix = Math.random().toString(36).slice(2, 8)
  const title = `Evening ${suffix}`
  const note = await createNote(page, {
    title,
    content: 'The little kitten drank its milk and fell asleep on the sofa.'
  })

  // `ai_load_model` waits for the load; its status is the outcome the settings page shows.
  await invoke(page, 'ai_load_model').catch(() => null)
  await expect
    .poll(() => invoke<ModelStatus>(page, 'ai_get_model_status'), { timeout: 120_000 })
    .toMatchObject({ loaded: true, error: null })

  // "cat" is in neither the title nor the body, so only the semantic leg can find the note, and
  // a meaning-only hit carries no snippet.
  const hit = async () => {
    const found = await invoke<Found>(page, 'search_query', {
      input: { text: 'cat', types: ['note'], limit: 30 }
    })
    return found.groups.flatMap((group) => group.results).find((item) => item.id === note.id)
  }
  await expect.poll(async () => (await hit()) !== undefined, { timeout: 120_000 }).toBe(true)
  expect((await hit())?.snippet ?? '').toBe('')

  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(`${MOD}+k`)
  const input = page.locator('[cmdk-input]')
  await expect(input).toBeVisible()
  await input.fill('cat')
  await expect(page.locator('[cmdk-root]').getByText(title, { exact: true }).first()).toBeVisible({
    timeout: 20_000
  })
  await page.keyboard.press('Escape')
})

test.skip('the similar notes list shows a note on the same topic: needs `notes_get_similar` (Electron `notes:getSimilar`), not ported yet', async () => {})

test.skip('a failed model download backs off before the next load: needs a model host override (`MEMRY_MODEL_BASE_URL`); `embedding/worker.rs` always downloads from huggingface.co', async () => {})
